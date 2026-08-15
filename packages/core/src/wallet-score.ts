/**
 * Оценка торгового кошелька по его наблюдаемой истории.
 *
 * Задача: отличить кошелёк, который системно заходит в токены до роста, от
 * кошелька, которому один раз повезло. Это единственное, что делает метку
 * «смарт-мани» полезной — без этого различия она просто украшение.
 *
 * Главная ловушка здесь — малая выборка. Кошелёк с тремя удачными покупками
 * показывает 100% попаданий, и наивная сортировка по доле побед выносит
 * наверх именно таких — их много, и среди них почти нет умелых. Поэтому
 * вместо самой доли используется нижняя граница доверительного интервала
 * Уилсона: она отвечает не на вопрос «сколько попаданий получилось», а
 * «какую долю можно уверенно ожидать дальше». При 3 из 3 она даёт около
 * 0.44, при 30 из 30 — около 0.89. Разница между удачей и навыком именно
 * такая.
 */

/** Ниже этого числа сделок оценка не выставляется вовсе. */
export const MIN_TRADES_FOR_SCORE = 5;

/** Рост вдвое считаем попаданием: это порог, окупающий типичный промах. */
export const WIN_MULTIPLE = 2;
export const BIG_WIN_MULTIPLE = 5;

/** Падение капитализации более чем на 80% от точки входа. */
export const RUG_MULTIPLE = 0.2;

export interface WalletTradeOutcome {
  /** Сумма покупки в долларах. */
  amountUsd: number;
  /**
   * Во сколько раз выросла капитализация после этой покупки.
   * null — исход ещё не определён, такая сделка в оценке не участвует.
   */
  outcomeMultiple: number | null;
  /** Возраст пула на момент покупки, часы. */
  poolAgeHours: number | null;
}

export interface WalletScore {
  /** Сделок с известным исходом. */
  settled: number;
  wins2x: number;
  wins5x: number;
  rugs: number;
  /** Сырая доля попаданий — показывается рядом с оценкой, но не заменяет её. */
  hitRate: number;
  /** Нижняя граница доверительного интервала для доли попаданий. */
  hitRateLower: number;
  /** Средняя кратность, взвешенная по размеру покупки. */
  avgMultiple: number;
  medianEntryHours: number | null;
  volumeUsd: number;
  /** 0-100. null означает «данных недостаточно», а не «плохой кошелёк». */
  score: number | null;
  label: WalletLabel;
  /** Причина итоговой метки — чтобы её можно было объяснить пользователю. */
  reason: string;
}

export type WalletLabel = 'smart' | 'whale' | 'early' | 'none';

/**
 * Нижняя граница доверительного интервала Уилсона для доли успехов.
 * z = 1.96 соответствует уровню доверия 95%.
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;

  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);

  return Math.max(0, (centre - margin) / denom);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Порог «кита» в долларах совокупного объёма.
 *
 * Кит — это не оценка качества, а размер: крупная покупка двигает цену
 * независимо от того, умён покупатель или нет. Поэтому метка ставится по
 * объёму и не требует истории исходов.
 */
export const WHALE_VOLUME_USD = 50_000;

/** Вход в первые часы жизни пула. */
export const EARLY_ENTRY_HOURS = 6;

/**
 * Ниже этой оценки метка «ранний вход» не ставится.
 * Ранний вход — это обещание, а не заслуга; при плохом подтверждённом
 * результате обещание уже опровергнуто.
 */
export const EARLY_MIN_SCORE = 35;

export function scoreWallet(trades: WalletTradeOutcome[]): WalletScore {
  const volumeUsd = trades.reduce((s, t) => s + (Number.isFinite(t.amountUsd) ? t.amountUsd : 0), 0);

  const entryHours = trades
    .map((t) => t.poolAgeHours)
    .filter((h): h is number => h != null && Number.isFinite(h) && h >= 0);
  const medianEntryHours = median(entryHours);

  // В оценке участвуют только сделки с известным исходом. Незакрытые
  // наблюдения нельзя считать ни успехом, ни провалом: включив их как
  // неудачи, мы бы штрафовали за свежие покупки, включив как успехи —
  // завышали бы оценку тем, кто просто купил недавно.
  const settledTrades = trades.filter(
    (t): t is WalletTradeOutcome & { outcomeMultiple: number } =>
      t.outcomeMultiple != null && Number.isFinite(t.outcomeMultiple) && t.outcomeMultiple > 0,
  );

  const settled = settledTrades.length;
  const wins2x = settledTrades.filter((t) => t.outcomeMultiple >= WIN_MULTIPLE).length;
  const wins5x = settledTrades.filter((t) => t.outcomeMultiple >= BIG_WIN_MULTIPLE).length;
  const rugs = settledTrades.filter((t) => t.outcomeMultiple <= RUG_MULTIPLE).length;

  const hitRate = settled > 0 ? wins2x / settled : 0;
  const hitRateLower = wilsonLowerBound(wins2x, settled);

  // Взвешивание по размеру покупки: кошелёк, заходящий крупно именно
  // в удачные токены, отличается от того, кто ставит одинаково везде
  // и попадает случайно.
  const weightTotal = settledTrades.reduce((s, t) => s + Math.max(t.amountUsd, 1), 0);
  const avgMultiple =
    weightTotal > 0
      ? settledTrades.reduce((s, t) => s + t.outcomeMultiple * Math.max(t.amountUsd, 1), 0) /
        weightTotal
      : 0;

  const isWhale = volumeUsd >= WHALE_VOLUME_USD;
  const isEarly =
    medianEntryHours != null && medianEntryHours <= EARLY_ENTRY_HOURS && trades.length >= 3;

  if (settled < MIN_TRADES_FOR_SCORE) {
    return {
      settled,
      wins2x,
      wins5x,
      rugs,
      hitRate,
      hitRateLower,
      avgMultiple,
      medianEntryHours,
      volumeUsd,
      // Оценка сознательно не выставляется: на такой выборке любое число
      // было бы выдумкой. Отсутствие оценки — тоже информация.
      score: null,
      label: isWhale ? 'whale' : isEarly ? 'early' : 'none',
      reason: `Сделок с известным исходом: ${settled} из ${MIN_TRADES_FOR_SCORE} необходимых`,
    };
  }

  // ─── Составляющие оценки ────────────────────────────────────────────
  // Доля попаданий (0-55). Берётся нижняя граница, а не сырая доля.
  const hitPart = Math.min(hitRateLower / 0.6, 1) * 55;

  // Средняя кратность (0-25). Логарифм: разница между 1x и 3x важнее,
  // чем между 20x и 40x — вторая чаще означает один выброс в выборке.
  const multiplePart = Math.min(Math.log10(Math.max(avgMultiple, 1)) / Math.log10(10), 1) * 25;

  // Ранний вход (0-20). Покупка через сутки после запуска — это уже
  // следование за толпой, а не опережение.
  const earlyPart =
    medianEntryHours == null
      ? 0
      : Math.max(0, 1 - medianEntryHours / 24) * 20;

  // Штраф за провалы. Кошелёк, у которого каждая вторая покупка
  // обнуляется, опасен для повторения даже при высокой средней кратности.
  const rugRate = rugs / settled;
  const penalty = rugRate * 30;

  const score = Math.round(Math.max(0, Math.min(100, hitPart + multiplePart + earlyPart - penalty)));

  let label: WalletLabel = 'none';
  let reason: string;

  if (score >= 60) {
    label = 'smart';
    reason =
      `${wins2x} из ${settled} покупок выросли вдвое и более` +
      (medianEntryHours != null ? `, обычный вход — ${medianEntryHours.toFixed(1)} ч от запуска` : '');
  } else if (isWhale) {
    label = 'whale';
    reason = `Крупный объём: $${Math.round(volumeUsd).toLocaleString('ru-RU')} при доле попаданий ${(hitRate * 100).toFixed(0)}%`;
  } else if (isEarly && score >= EARLY_MIN_SCORE) {
    // Метка «ранний вход» означает «результат ещё не подтверждён».
    // Ставить её кошельку с низкой оценкой нельзя: у такого результат
    // как раз подтверждён — и он плохой. Иначе метка читалась бы как
    // достоинство там, где перед нами системно убыточный кошелёк.
    label = 'early';
    reason = `Заходит рано (медиана ${medianEntryHours!.toFixed(1)} ч), но устойчивого результата пока не видно`;
  } else {
    reason = `Доля попаданий ${(hitRate * 100).toFixed(0)}% на ${settled} сделках — не выделяется`;
  }

  return {
    settled,
    wins2x,
    wins5x,
    rugs,
    hitRate,
    hitRateLower,
    avgMultiple,
    medianEntryHours,
    volumeUsd,
    score,
    label,
    reason,
  };
}

// ─────────────────────── Сигнал по конкретному токену ───────────────────────

export interface TokenWalletActivity {
  label: WalletLabel;
  score: number | null;
  amountUsd: number;
  /** Часов назад совершена покупка. */
  hoursAgo: number;
}

export interface WalletSignal {
  /** Кошельков с меткой smart, купивших токен. */
  smartCount: number;
  whaleCount: number;
  earlyCount: number;
  /** Совокупная сумма покупок помеченных кошельков. */
  smartVolumeUsd: number;
  /** 0-100: насколько сильно поведение кошельков говорит за вход. */
  strength: number;
  verdict: string;
}

/**
 * Свод по кошелькам для одного токена.
 *
 * Сознательно учитывается давность: покупка смарт-кошелька трёхдневной
 * давности почти ничего не говорит о входе сегодня — к этому моменту цена
 * уже отразила её. Вес спадает вдвое каждые 12 часов.
 */
export function summarizeWalletSignal(activity: TokenWalletActivity[]): WalletSignal {
  const smart = activity.filter((a) => a.label === 'smart');
  const whales = activity.filter((a) => a.label === 'whale');
  const early = activity.filter((a) => a.label === 'early');

  const smartVolumeUsd = smart.reduce((s, a) => s + a.amountUsd, 0);

  const decay = (hoursAgo: number) => Math.pow(0.5, Math.max(hoursAgo, 0) / 12);

  // Вклад кошелька: его оценка, приглушённая давностью покупки.
  const weighted = smart.reduce((s, a) => s + ((a.score ?? 60) / 100) * decay(a.hoursAgo), 0);
  const whaleWeighted = whales.reduce((s, a) => s + 0.4 * decay(a.hoursAgo), 0);

  // Насыщение: пятый смарт-кошелёк добавляет меньше, чем второй.
  const strength = Math.round(Math.min(100, (1 - Math.exp(-(weighted + whaleWeighted) / 2)) * 100));

  let verdict: string;
  if (smart.length === 0 && whales.length === 0) {
    verdict = 'Кошельков с историей среди покупателей не замечено';
  } else if (smart.length === 0) {
    verdict = `Крупные покупки есть (${whales.length}), но кошельков с подтверждённой историей нет`;
  } else {
    verdict =
      `${smart.length} ${plural(smart.length, 'кошелёк', 'кошелька', 'кошельков')} с историей ` +
      `${plural(smart.length, 'купил', 'купили', 'купили')} на $${Math.round(smartVolumeUsd).toLocaleString('ru-RU')}`;
  }

  return {
    smartCount: smart.length,
    whaleCount: whales.length,
    earlyCount: early.length,
    smartVolumeUsd,
    strength,
    verdict,
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
