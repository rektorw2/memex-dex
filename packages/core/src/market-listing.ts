import { REGISTRY, normalizeAddress, tokenKey, type ChainKey } from './token-registry.js';

/**
 * Правила витрины «Рынок».
 *
 * Три вопроса, на которые здесь даются единственные ответы: показывать
 * ли токен в списке, каково его изменение цены за сутки и была ли
 * у него рыночная активность за эти сутки.
 *
 * Все три раньше решались по месту — в SQL, в JSX и в нормализаторе
 * провайдера, — и расходились. Ответ, написанный в разметке, нельзя
 * проверить тестом и нельзя переиспользовать на сервере; ответ,
 * написанный в SQL, невидим интерфейсу.
 */

// ──────────────────────────── Стейблкоины ───────────────────────────────────

/**
 * Адреса стейблкоинов, подтверждённые вручную.
 *
 * Берутся из общего реестра по метке, а не переписываются рядом.
 * Второй список тех же адресов разошёлся бы с первым при добавлении
 * сети, и разошёлся бы молча.
 */
const STABLECOIN_KEYS = new Set(
  REGISTRY.filter((e) => e.tags.includes('stablecoin')).map((e) =>
    tokenKey(e.chain, e.address),
  ),
);

/**
 * Настоящий ли это стейблкоин.
 *
 * ─── Почему не по символу ───────────────────────────────────────────
 *
 * «USDC» на Solana может выпустить кто угодно за пять минут, и именно
 * так делают подделки: символ настоящего актива внушает доверие
 * и снимает вопросы. Исключать по совпадению текста значит прятать
 * подделку из списка вместе с оригиналом — то есть избавлять
 * мошенника от единственного места, где его токен видно рядом
 * с проверенными.
 *
 * Поэтому решает адрес. Подделка с символом `USDC` стейблкоином
 * не считается и остаётся в списке — со своим уровнем риска
 * и предупреждением.
 *
 * ─── Почему `isQuote` тоже участвует ────────────────────────────────
 *
 * Это поле уже отмечает валюту котировки в нашей базе — то, за что
 * покупают. Оно шире реестра: сеть может быть подключена раньше,
 * чем её стейблкоин попадёт в ручной список.
 */
export function isStablecoinAsset(token: {
  chain: string;
  address: string;
  isQuote?: boolean | null;
}): boolean {
  if (token.isQuote === true) return true;

  const chain = token.chain as ChainKey;
  return STABLECOIN_KEYS.has(`${chain}:${normalizeAddress(chain, token.address)}`);
}

/**
 * Показывать ли токен в списке «Рынок».
 *
 * Только про список. Токен остаётся в базе, в портфеле, в кошельках
 * и продолжает работать валютой котировки: скрыть строку в витрине
 * и удалить актив — разные действия, и путать их нельзя.
 *
 * Причина скрытия проста: человек приходит на витрину искать, во что
 * зайти. Доллар в списке «во что зайти» — шум, который занимает
 * первые строки по объёму и ликвидности именно потому, что он доллар.
 */
export function belongsInMarketList(token: {
  chain: string;
  address: string;
  isQuote?: boolean | null;
}): boolean {
  return !isStablecoinAsset(token);
}

// ─────────────────────── Изменение цены за 24 часа ──────────────────────────

/**
 * Насколько устаревшей может быть котировка, чтобы её изменение
 * ещё считалось суточным.
 *
 * Шесть часов — компромисс между двумя способами соврать. Слишком
 * строгий порог превращает в «—» половину живого рынка, где котировка
 * обновляется раз в несколько часов. Слишком мягкий выдаёт за суточное
 * изменение число трёхдневной давности.
 */
export const PRICE_CHANGE_MAX_STALENESS_MS = 6 * 3_600_000;

/**
 * Изменение цены за сутки в процентах.
 *
 * ─── Что здесь важно ────────────────────────────────────────────────
 *
 * `null` вместо нуля. Ноль — это утверждение «цена не изменилась»,
 * и подставлять его вместо «мы не знаем» нельзя: на витрине они
 * выглядят одинаково, а означают противоположное.
 *
 * Устаревшая котировка тоже даёт `null`. Число, посчитанное три дня
 * назад, суточным изменением не является, как бы точно оно тогда
 * ни считалось.
 *
 * Роста «за всё время» здесь нет и быть не может: он приходит из
 * другого поля и отвечает на другой вопрос. Подставлять его в колонку
 * «24ч» — то же самое, что показать годовую доходность под подписью
 * «за сегодня».
 */
export function priceChange24h(input: {
  /** Готовое поле провайдера, проценты. */
  priceChange24h: string | number | null | undefined;
  /** Когда котировка была подтверждена. */
  priceUpdatedAt: string | Date | null | undefined;
  now: number;
  maxStalenessMs?: number;
}): number | null {
  const raw = input.priceChange24h;
  if (raw == null || raw === '') return null;

  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;

  /*
   * Свежесть проверяется по времени котировки.
   *
   * Без этого «+42%» висело бы на экране неделю после того, как
   * провайдер перестал отдавать по токену данные, и выглядело бы
   * живым.
   */
  const at = input.priceUpdatedAt;
  if (at == null) return null;

  const stamp = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(stamp)) return null;

  const age = input.now - stamp;
  if (age < 0) {
    // Время из будущего: часы разошлись. Считать такое свежим
    // безопаснее, чем прятать, — но только в пределах допуска.
    if (-age > (input.maxStalenessMs ?? PRICE_CHANGE_MAX_STALENESS_MS)) return null;
    return value;
  }

  if (age > (input.maxStalenessMs ?? PRICE_CHANGE_MAX_STALENESS_MS)) return null;

  return value;
}

/**
 * Изменение по двум ценам, если готового поля нет.
 *
 * Отдельно от деления в вызывающем коде ради одного случая: цена
 * сутки назад может быть нулём или отсутствовать. Деление на ноль
 * даёт `Infinity`, и на витрине это превращается в «+∞%» либо
 * в выдуманное число с десятью нулями.
 */
export function priceChangeFrom(previous: number | null | undefined, current: number | null | undefined): number | null {
  if (previous == null || current == null) return null;
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;

  // Ноль в знаменателе — не «бесконечный рост», а отсутствие базы
  // для сравнения. Честный ответ здесь «неизвестно».
  if (previous <= 0) return null;

  const change = ((current - previous) / previous) * 100;
  return Number.isFinite(change) ? change : null;
}

// ────────────────────── Активность за последние сутки ───────────────────────

/**
 * Минимальный суточный объём, при котором рынок считается живым.
 *
 * Не ноль: у мёртвого пула объём бывает копеечным из-за одной
 * случайной сделки, и «активным» его называть неправильно.
 */
export const ACTIVE_MIN_VOLUME_USD = 1_000;

/**
 * Была ли у токена рыночная активность за последние сутки.
 *
 * ─── Чего здесь нет ─────────────────────────────────────────────────
 *
 * Времени запуска импортёра и времени проверки риска. Оба говорят
 * о нашей работе, а не о рынке: импортёр может обойти токен, у которого
 * год не было ни одной сделки, и записать свежую отметку. Фильтр,
 * построенный на них, показывал бы «активные за сутки» списком того,
 * что мы недавно трогали.
 *
 * Считается только то, что произошло на рынке: сделки и объём.
 * Свежесть котировки — необходимое условие, но не достаточное:
 * цена обновляется и у пула, где сутки никто не торговал.
 */
export function hasRecentMarketActivity(input: {
  volume24hUsd: string | number | null | undefined;
  buys24h?: number | null;
  sells24h?: number | null;
  /** Момент подтверждения рыночных данных. */
  priceUpdatedAt: string | Date | null | undefined;
  now: number;
  maxStalenessMs?: number;
  minVolumeUsd?: number;
}): boolean {
  const at = input.priceUpdatedAt;
  if (at == null) return false;

  const stamp = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(stamp)) return false;

  // Данные старше суток о сегодняшнем рынке не говорят ничего.
  const maxAge = input.maxStalenessMs ?? 24 * 3_600_000;
  if (input.now - stamp > maxAge) return false;

  const trades = (input.buys24h ?? 0) + (input.sells24h ?? 0);
  if (trades > 0) return true;

  const volume = Number(input.volume24hUsd ?? 0);
  if (!Number.isFinite(volume)) return false;

  return volume >= (input.minVolumeUsd ?? ACTIVE_MIN_VOLUME_USD);
}

// ──────────────────── Подпись токена без метаданных ─────────────────────────

/**
 * Как назвать токен, у которого не удалось получить символ.
 *
 * `???` не годится: три вопросительных знака выглядят как поломка
 * интерфейса, а не как отсутствие сведений у провайдера, и по ним
 * невозможно отличить один такой токен от другого. Сокращённый адрес
 * решает обе задачи — он честен и уникален.
 */
export function tokenDisplaySymbol(input: {
  symbol?: string | null;
  address: string;
}): string {
  const symbol = input.symbol?.trim();
  if (symbol) return symbol;

  const a = input.address.trim();
  if (!a) return 'Без адреса';

  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Годится ли запись провайдера для показа вообще. */
export function isDisplayableToken(input: {
  chain?: string | null;
  address?: string | null;
}): boolean {
  // Без сети или адреса токен не идентифицируется: две разные монеты
  // с одинаковым символом слились бы в одну строку.
  return Boolean(input.chain?.trim()) && Boolean(input.address?.trim());
}

/**
 * Одна строка на токен: лучшая пара по ликвидности.
 *
 * У одного токена бывает несколько пар — с разными валютами котировки
 * и на разных площадках. Каждая приходит от провайдера отдельной
 * записью, и без свёртки один и тот же токен занимает в списке
 * три строки с разной ценой. Выбирается пара с наибольшей
 * ликвидностью: она же и определяет цену, по которой реально можно
 * купить.
 */
export function bestPairPerToken<
  T extends { chain: string; address: string; liquidityUsd?: number | null },
>(pairs: readonly T[]): T[] {
  const best = new Map<string, T>();

  for (const pair of pairs) {
    if (!isDisplayableToken(pair)) continue;

    const chain = pair.chain as ChainKey;
    const key = `${chain}:${normalizeAddress(chain, pair.address)}`;
    const current = best.get(key);

    if (current == null || (pair.liquidityUsd ?? 0) > (current.liquidityUsd ?? 0)) {
      best.set(key, pair);
    }
  }

  return [...best.values()];
}
