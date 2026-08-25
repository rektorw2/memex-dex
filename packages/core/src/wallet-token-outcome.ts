/**
 * Один токен — один оцениваемый исход.
 *
 * ─── Что было сломано ───────────────────────────────────────────────
 *
 * `rescoreWallets` кормил `scoreWallet` списком покупок: по строке
 * на каждую BUY. А `tokensBought` считался по уникальным токенам.
 * Знаменатели разошлись, и дальше `serializeWallet` делил одно
 * на другое:
 *
 *     hitRate = wins2x / tokensBought
 *
 * Кошелёк, купивший один токен десять раз, получал до десяти побед
 * при одном купленном токене — то есть «доля попаданий» больше
 * единицы. На экране это и есть «данные противоречивы» рядом
 * со Smart Score 100/100 при двух настоящих сделках.
 *
 * ─── Почему именно так ──────────────────────────────────────────────
 *
 * Smart Score отвечает на вопрос «умеет ли кошелёк находить токены».
 * Умение найти проявляется один раз — в момент первого входа.
 * Докупки говорят об уверенности и размере ставки, но не о втором
 * удачном выборе: токен тот же самый.
 *
 * Поэтому исход считается по токену, а не по транзакции. Отдельные
 * покупки при этом никуда не деваются — они остаются историей
 * и дают объём; просто десять покупок одного токена перестают быть
 * десятью независимыми успехами.
 */

import { normalizeAddress, type ChainKey } from './token-registry.js';

/** Наблюдаемая покупка. Одна строка `WalletTrade`. */
export interface WalletBuyObservation {
  chain: ChainKey;
  tokenAddress: string;
  amountUsd: number;
  /** Возраст пула на момент входа. */
  poolAgeHours: number | null;
  tradedAt: number;
  /** Кратность после этого входа. null — ещё не подведён. */
  outcomeMultiple: number | null;
  /** Капитализация в момент сделки: база кратности. */
  mcapAtTradeUsd: number | null;

  // ─── Независимая пара цена/капитализация ────────────────────────────
  //
  // Нужна, чтобы отличить настоящий ранний вход от ошибки единиц
  // измерения, не полагаясь на один лишь абсолютный порог.
  // Подробности — у `SUPPLY_DISAGREEMENT_FACTOR`.

  /** Цена токена в момент сделки. */
  priceUsd?: number | null;
  /** Цена того же токена по независимому наблюдению (находка радара). */
  referencePriceUsd?: number | null;
  /** Капитализация того же токена по тому же независимому наблюдению. */
  referenceMcapUsd?: number | null;
}

export type OutcomeStatus =
  /** Исход подведён и годится для оценки. */
  | 'scorable'
  /** Наблюдений после входа ещё не хватает. Не проигрыш. */
  | 'pending'
  /** Число получено, но верить ему нельзя. В оценку не идёт. */
  | 'ambiguous';

export interface WalletTokenOutcome {
  chain: ChainKey;
  tokenAddress: string;
  /** Первая покупка: она и есть момент «нашёл токен». */
  firstBuyAt: number;
  /** Сколько покупок этого токена наблюдалось. */
  buyCount: number;
  /** Суммарный объём всех покупок токена. */
  buyVolumeUsd: number;
  /** Возраст пула на момент первого входа. */
  entryHours: number | null;
  /** Кратность после первого входа. */
  peakMultiple: number | null;
  status: OutcomeStatus;
  reason: string | null;
}

/**
 * ─── Как определяется недостоверная база ────────────────────────────
 *
 * Кратность считается как `пик / база`, где база — капитализация
 * в момент входа. При базе в десятки долларов обычный рост даёт
 * тысячи иксов: на живой странице так и появились 4130× и 4175×.
 *
 * Вопрос в том, как отличить настоящий ранний вход от ошибки единиц
 * измерения. Абсолютный порог отвечает на него плохо: он одинаково
 * подозревает и ошибку, и честную покупку в первую минуту жизни пула.
 * Поэтому сначала используется проверка, не требующая угадывать
 * величину, — сверка подразумеваемого предложения.
 *
 * ─── Что было рассмотрено и почему отвергнуто ───────────────────────
 *
 * Ликвидность и объём находятся в `RadarEvent`, но относятся
 * к моменту обнаружения, а не сделки: сравнивать их с базой входа
 * значит подмешивать разницу во времени к разнице в единицах.
 *
 * Точки графика (`pricePoints`) хранят пары цены и капитализации,
 * но только для наблюдаемых радаром токенов и не глубже начала
 * наблюдения; для сделок вне радара их нет вовсе.
 *
 * Соседние наблюдения других кошельков по тому же токену выглядят
 * привлекательно, но требуют запроса на каждый токен и вносят
 * круговую зависимость: если у половины кошельков база испорчена
 * одинаково, «согласие соседей» подтвердит ошибку.
 *
 * Сверка предложения свободна от всего этого.
 */

/**
 * Во сколько раз может разойтись подразумеваемое предложение,
 * прежде чем база считается недостоверной.
 *
 * `предложение = капитализация / цена`. Для одного токена оно почти
 * постоянно: memecoin выпускается один раз и обычно не сжигается
 * на порядки. Значит, две независимые пары «цена и капитализация»
 * обязаны давать близкое предложение — и дают, если обе посчитаны
 * в одних единицах.
 *
 * Расхождение в сто раз одной постоянной величиной объясняться уже
 * не может. Зато оно ровно так и выглядит, когда одна сторона взяла
 * количество в минимальных единицах, а другая — с учётом десятичных
 * знаков.
 *
 * Свойство этой проверки в том, что она не зависит от времени входа:
 * покупка в первую минуту жизни пула её проходит, потому что цена
 * и капитализация падают вместе, а их отношение остаётся прежним.
 */
export const SUPPLY_DISAGREEMENT_FACTOR = 100;

/**
 * Абсолютный порог доверия к базе. Запасное правило.
 *
 * Работает там, где независимого наблюдения нет: сделка не связана
 * с находкой радара либо у одной из сторон нет цены. Тогда сверять
 * предложение не с чем, и остаётся правило качества данных: базу
 * ниже тысячи долларов мы не считаем измеренной.
 *
 * Это не потолок кратности и не способ спрятать выброс. Настоящая
 * тысячекратная кратность на достоверной базе сохраняется как есть
 * и попадает в оценку — на это есть отдельный тест.
 *
 * Величина выбрана по свойству рынка, а не по виду данных:
 * капитализация ниже тысячи долларов означает пул, в котором
 * невозможна ни одна из наблюдаемых нами сделок — их размеры
 * начинаются от десятков долларов и сдвинули бы такую
 * капитализацию на десятки процентов одной покупкой.
 */
export const MIN_TRUSTWORTHY_MCAP_USD = 1_000;

/**
 * Расходятся ли две пары «цена и капитализация» в единицах.
 *
 * `null` означает «сверить не с чем» — это не признак исправности
 * и не признак поломки, и вызывающий обязан перейти к запасному
 * правилу, а не считать базу проверенной.
 */
export function supplyDisagreement(input: {
  mcapUsd: number | null | undefined;
  priceUsd: number | null | undefined;
  referenceMcapUsd: number | null | undefined;
  referencePriceUsd: number | null | undefined;
}): { ratio: number; disagrees: boolean } | null {
  const positive = (v: number | null | undefined): v is number =>
    v != null && Number.isFinite(v) && v > 0;

  if (
    !positive(input.mcapUsd) ||
    !positive(input.priceUsd) ||
    !positive(input.referenceMcapUsd) ||
    !positive(input.referencePriceUsd)
  ) {
    return null;
  }

  const supply = input.mcapUsd / input.priceUsd;
  const referenceSupply = input.referenceMcapUsd / input.referencePriceUsd;

  // Отношение берётся в большую сторону: расхождение симметрично,
  // и какая из двух сторон ошиблась, здесь неизвестно.
  const ratio = Math.max(supply / referenceSupply, referenceSupply / supply);

  return { ratio, disagrees: ratio >= SUPPLY_DISAGREEMENT_FACTOR };
}

/**
 * Свернуть покупки в исходы по токенам.
 *
 * Порядок внутри токена определяется временем: первая покупка
 * задаёт и точку входа, и кратность. Брать максимум по всем
 * покупкам нельзя — тогда докупка на дне превращала бы неудачный
 * вход в удачный.
 */
export function foldTokenOutcomes(buys: WalletBuyObservation[]): WalletTokenOutcome[] {
  const groups = new Map<string, WalletBuyObservation[]>();

  for (const b of buys) {
    const key = `${b.chain}|${normalizeAddress(b.chain, b.tokenAddress)}`;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }

  const outcomes: WalletTokenOutcome[] = [];

  for (const [, list] of groups) {
    const ordered = [...list].sort((a, b) => a.tradedAt - b.tradedAt);
    const first = ordered[0]!;

    const buyVolumeUsd = ordered.reduce(
      (s, b) => s + (Number.isFinite(b.amountUsd) ? b.amountUsd : 0),
      0,
    );

    const base: Omit<WalletTokenOutcome, 'status' | 'reason' | 'peakMultiple'> = {
      chain: first.chain,
      tokenAddress: normalizeAddress(first.chain, first.tokenAddress),
      firstBuyAt: first.tradedAt,
      buyCount: ordered.length,
      buyVolumeUsd,
      entryHours: first.poolAgeHours,
    };

    const multiple = first.outcomeMultiple;

    /*
     * Исход ещё не подведён.
     *
     * Это не проигрыш и не ноль. Считать свежую покупку неудачей
     * значило бы штрафовать кошелёк за то, что он купил недавно.
     */
    if (multiple == null || !Number.isFinite(multiple) || multiple <= 0) {
      outcomes.push({
        ...base,
        peakMultiple: null,
        status: 'pending',
        reason: 'AWAITING_OBSERVATIONS',
      });
      continue;
    }

    /*
     * База кратности недостоверна.
     *
     * Число сохраняется — прятать его нельзя, — но в оценку
     * не идёт и несёт причину. Иначе один вход с базой
     * в несколько долларов делает кошелёк лучшим в списке.
     */
    const mcap = first.mcapAtTradeUsd;

    if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) {
      outcomes.push({
        ...base,
        peakMultiple: multiple,
        status: 'ambiguous',
        reason: 'UNKNOWN_MCAP_BASE',
      });
      continue;
    }

    /*
     * Сверка подразумеваемого предложения идёт первой.
     *
     * Она сильнее абсолютного порога: опирается на два независимых
     * наблюдения одного токена, а не на выбранную нами величину.
     * Её вердикт окончателен в обе стороны — база, прошедшая сверку,
     * считается измеренной, даже если она мала. Именно так честный
     * вход в первую минуту жизни пула перестаёт выглядеть ошибкой.
     */
    const disagreement = supplyDisagreement({
      mcapUsd: mcap,
      priceUsd: first.priceUsd,
      referenceMcapUsd: first.referenceMcapUsd,
      referencePriceUsd: first.referencePriceUsd,
    });

    if (disagreement != null) {
      outcomes.push(
        disagreement.disagrees
          ? {
              ...base,
              peakMultiple: multiple,
              status: 'ambiguous',
              reason: 'MCAP_BASE_UNITS_DISAGREE',
            }
          : { ...base, peakMultiple: multiple, status: 'scorable', reason: null },
      );
      continue;
    }

    /*
     * Сверить не с чем — работает запасное правило качества данных.
     *
     * Отсутствие независимого наблюдения не делает базу проверенной,
     * поэтому пропустить проверку нельзя.
     */
    if (mcap < MIN_TRUSTWORTHY_MCAP_USD) {
      outcomes.push({
        ...base,
        peakMultiple: multiple,
        status: 'ambiguous',
        reason: 'IMPLAUSIBLE_MCAP_BASE',
      });
      continue;
    }

    outcomes.push({ ...base, peakMultiple: multiple, status: 'scorable', reason: null });
  }

  return outcomes.sort((a, b) => a.firstBuyAt - b.firstBuyAt);
}
