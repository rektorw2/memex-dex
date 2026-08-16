/**
 * Внутренняя модель токена и перевод в неё ответов OKX.
 *
 * Смысл отдельного слоя в том, чтобы формат чужого ответа не расползался
 * по проекту. Если завтра OKX переименует volume в volume24H, чинить
 * придётся один файл, а не терминал, импортёр и проверку разом.
 *
 * Второе — числа. OKX отдаёт их строками, и среди строк встречаются
 * пустые, «0», «null» и просто отсутствующие поля. Разница между нулём
 * и неизвестностью здесь существенна: ликвидность 0 означает, что пул
 * пуст, а неизвестная ликвидность означает, что мы не спросили. Первое
 * блокирует токен, второе — нет. Поэтому парсер возвращает null,
 * а не подставляет ноль.
 */

// ─────────────────────────────── Сети ───────────────────────────────────────

// Сеть и правила нормализации адреса берутся из реестра, а не заводятся
// заново: два определения «что такое адрес токена» неизбежно разойдутся,
// и разойдутся молча.
import { type ChainKey, normalizeAddress } from './token-registry.js';

export type { ChainKey };

/**
 * chainIndex в терминологии OKX.
 *
 * Robinhood Chain у OKX отсутствует — это не ошибка конфигурации,
 * а факт: сеть запущена недавно, и агрегаторы подключают такие
 * с задержкой. null здесь означает «не спрашивать», а не «спросить
 * и получить пусто».
 */
export const OKX_CHAIN_INDEX: Record<ChainKey, string | null> = {
  ETHEREUM: '1',
  BNB: '56',
  BASE: '8453',
  SOLANA: '501',
  ROBINHOOD: null,
};

export const CHAIN_BY_INDEX: Record<string, ChainKey> = {
  '1': 'ETHEREUM',
  '56': 'BNB',
  '8453': 'BASE',
  '501': 'SOLANA',
};

export function chainFromIndex(index: string | number | null | undefined): ChainKey | null {
  if (index == null) return null;
  return CHAIN_BY_INDEX[String(index)] ?? null;
}

export function isOkxChain(chain: ChainKey): boolean {
  return OKX_CHAIN_INDEX[chain] !== null;
}

// ──────────────────────────── Разбор чисел ──────────────────────────────────

/**
 * Строка OKX → число или null.
 *
 * Пустая строка, «null», «NaN», отсутствие поля и нечисловой мусор дают
 * null. Ноль остаётся нулём: это осмысленное значение, и подменять его
 * неизвестностью так же неверно, как наоборот.
 */
export function okxNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;

  const s = v.trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'NaN' || s === '-') return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Целое число или null. Дробные округляются вниз. */
export function okxInt(v: unknown): number | null {
  const n = okxNum(v);
  return n == null ? null : Math.floor(n);
}

/**
 * Момент времени из ответа OKX.
 *
 * Встречаются и секунды, и миллисекунды. Отличаем по порядку величины:
 * значение меньше 10^12 не может быть миллисекундами разумной даты
 * (это 1970 год), значит это секунды.
 */
export function okxTime(v: unknown): Date | null {
  const n = okxNum(v);
  if (n == null || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Строка непустая или null. Обрезает по длине, чтобы не ломать БД. */
export function okxStr(v: unknown, maxLen = 120): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s.slice(0, maxLen);
}

export function okxBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return null;
}

// ───────────────────────────── Адреса токенов ───────────────────────────────

/** Похоже ли на адрес контракта, а не на тикер. Для разбора строки поиска. */
export function looksLikeAddress(q: string): boolean {
  const s = q.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return true;
  // Solana: base58 без 0, O, I, l. Длина mint-адреса 32–44 символа.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return true;
  return false;
}

// ─────────────────────── Нормализованный токен ──────────────────────────────

/**
 * Токен в терминах проекта, а не поставщика.
 *
 * Все поля необязательны кроме сети и адреса: любое из них может
 * отсутствовать в ответе, и подставлять вместо него ноль означало бы
 * выдумывать данные.
 */
export interface NormalizedToken {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number | null;
  logoUrl: string | null;

  priceUsd: number | null;
  priceChange24h: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;

  firstTradeAt: Date | null;
  holders: number | null;
  uniqueTraders: number | null;
  txs24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  inflowUsd: number | null;

  /** Уровень риска по мнению OKX, 0–5. Наше мнение считается отдельно. */
  okxRiskLevel: number | null;
  devHoldPct: number | null;
  top10HoldPct: number | null;
  insiderHoldPct: number | null;
  bundleHoldPct: number | null;

  vibeScore: number | null;
  mentionsCount: number | null;
}

/** Разбор одной записи hot-token. Возвращает null, если записи нет сути. */
export function parseHotToken(raw: unknown): NormalizedToken | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const chain = chainFromIndex(r.chainIndex as string);
  const address = okxStr(r.tokenContractAddress, 128);
  if (!chain || !address) return null;

  const symbol = okxStr(r.tokenSymbol, 32) ?? '???';

  return {
    chain,
    address: normalizeAddress(chain, address),
    symbol,
    name: okxStr(r.tokenName, 120) ?? symbol,
    decimals: okxInt(r.decimals),
    logoUrl: okxStr(r.tokenLogoUrl, 500),

    priceUsd: okxNum(r.price),
    // OKX отдаёт change долей (0.15), а не процентами. Проверить это
    // без обращения к сети нельзя, поэтому нормализация вынесена
    // в отдельную функцию с явным правилом — см. normalizeChange.
    priceChange24h: normalizeChange(okxNum(r.change)),
    volume24hUsd: okxNum(r.volume),
    liquidityUsd: okxNum(r.liquidity),
    marketCapUsd: okxNum(r.marketCap),

    firstTradeAt: okxTime(r.firstTradeTime),
    holders: okxInt(r.holders),
    uniqueTraders: okxInt(r.uniqueTraders),
    txs24h: okxInt(r.txs),
    buys24h: okxInt(r.txsBuy),
    sells24h: okxInt(r.txsSell),
    inflowUsd: okxNum(r.inflowUsd),

    okxRiskLevel: okxInt(r.riskLevelControl),
    devHoldPct: normalizePct(okxNum(r.devHoldPercent)),
    top10HoldPct: normalizePct(okxNum(r.top10HoldPercent)),
    insiderHoldPct: normalizePct(okxNum(r.insiderHoldPercent)),
    bundleHoldPct: normalizePct(okxNum(r.bundleHoldPercent)),

    vibeScore: okxNum(r.vibeScore),
    mentionsCount: okxInt(r.mentionsCount),
  };
}

/**
 * Приведение доли к процентам.
 *
 * Поставщики расходятся: одни отдают 0.65, другие 65. Различить их
 * можно по диапазону — доля владения не бывает больше единицы, если
 * это доля, и не бывает меньше единицы осмысленно часто, если это
 * проценты. Граница проведена по 1: значение 0.65 читается как 65%,
 * значение 65 остаётся 65%.
 *
 * Единственный случай, который эта эвристика испортит, — настоящие
 * 0.65% владения, которые станут 65%. Ошибка в безопасную сторону:
 * токен получит замечание, которого не заслужил, но не наоборот.
 */
export function normalizePct(v: number | null): number | null {
  if (v == null) return null;
  if (v < 0) return null;
  if (v <= 1) return v * 100;
  if (v > 100) return 100;
  return v;
}

/**
 * Изменение цены в процентах.
 *
 * Здесь эвристика диапазона не годится: рост мем-коина на 250%
 * встречается постоянно, и «доля больше единицы» ничего не значит.
 * Поэтому правило простое и явное: значение трактуется как доля
 * и умножается на сто. Если окажется, что OKX отдаёт проценты,
 * менять надо здесь — одна строка и один тест.
 */
export function normalizeChange(v: number | null): number | null {
  if (v == null) return null;
  return v * 100;
}

// ──────────────────── Уровень риска OKX → наш уровень ───────────────────────

/**
 * Что означают числа riskLevelControl.
 *
 * Ноль трактуется как «проверок не проводилось», а не как «чисто».
 * Это важнее, чем кажется: ноль по умолчанию стоит и у токена,
 * до которого у OKX не дошли руки, и принять это за одобрение значит
 * пропустить в витрину непроверенное под видом безопасного.
 */
export type OkxRiskBand = 'unknown' | 'clean' | 'caution' | 'danger';

export function okxRiskBand(level: number | null): OkxRiskBand {
  if (level == null) return 'unknown';
  if (level <= 0) return 'unknown';
  if (level === 1) return 'clean';
  if (level === 2) return 'caution';
  return 'danger'; // 3, 4, 5
}

/** Уровень 3 и выше — полное скрытие из выдачи. */
export function isOkxHardBlock(level: number | null): boolean {
  return level != null && level >= 3;
}

// ───────────────────────────── Теги advanced-info ───────────────────────────

/**
 * Теги, встречающиеся в tokenTags.
 *
 * Часть из них — свидетельство опасности, часть — признак внимания
 * рынка, и путать их нельзя. Оплаченное продвижение в DexScreener
 * и число упоминаний в соцсетях говорят о бюджете на маркетинг,
 * а не о свойствах контракта: скам с бюджетом покупает и то и другое
 * в первый же день.
 */
export const DANGER_TAGS = new Set(['honeypot', 'lowLiquidity', 'devHoldingStatusSellAll']);

export const CAUTION_TAGS = new Set(['devHoldingStatusSell']);

/** Признаки внимания рынка. Ни один из них не является доказательством безопасности. */
export const ATTENTION_TAGS = new Set([
  'smartMoneyBuy',
  'dexScreenerPaid',
  'dexBoost',
  'dexScreenerTokenCommunityTakeOver',
]);

/** Признание сообществом. Учитывается, но не отменяет проверок контракта. */
export const RECOGNITION_TAGS = new Set(['communityRecognized']);

/** Метки токенизированных реальных активов. */
export const RWA_TAGS = new Set(['rwa', 'xStocks', 'xstocks', 'ondo', 'stock', 'tokenizedStock']);

export function hasRwaTag(tags: string[]): boolean {
  return tags.some((t) => RWA_TAGS.has(t) || RWA_TAGS.has(t.toLowerCase()));
}
