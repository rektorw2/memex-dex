/**
 * Модели кошельков OKX Onchain OS и разбор ответов.
 *
 * Чистая часть интеграции: здесь нет сети, только преобразование
 * чужого формата в наш. Вынесено в ядро намеренно — это позволяет
 * проверить разбор тестами по образцам ответов, не имея ни ключей,
 * ни доступа наружу.
 *
 * Правило, которое здесь соблюдается везде: пустая строка становится
 * null, а не нулём. У OKX отсутствующее значение приходит пустой
 * строкой, и превращение её в ноль означало бы утверждение —
 * «прибыль равна нулю» вместо «прибыль неизвестна». На странице
 * кошельков это разница между «торговал в ноль» и «мы не знаем,
 * как он торговал».
 *
 * Второе правило: мнение OKX сохраняется как мнение OKX. Их winRate
 * и realizedPnl кладутся в отдельные поля с пометкой источника
 * и не подменяют собственный расчёт. Иначе мы бы показывали чужое
 * число под своим именем и не смогли бы объяснить, откуда оно.
 */

import type { ChainKey } from './token-registry.js';
import { normalizeAddress } from './token-registry.js';
import { chainFromIndex, OKX_CHAIN_INDEX, okxNum, okxInt, okxStr } from './okx-model.js';

// ──────────────────────────── Перечисления ──────────────────────────────────

/** Периоды, которые принимает OKX. */
export const OKX_TIMEFRAME = { d1: 1, d3: 2, d7: 3, m1: 4, m3: 5 } as const;
export type OkxTimeframe = (typeof OKX_TIMEFRAME)[keyof typeof OKX_TIMEFRAME];

export const TIMEFRAME_LABELS: Record<OkxTimeframe, string> = {
  1: '1D',
  2: '3D',
  3: '7D',
  4: '1M',
  5: '3M',
};

/** Способы сортировки лидеров. */
export const OKX_SORT = { pnl: 1, winRate: 2, txs: 3, volume: 4, roi: 5 } as const;
export type OkxSort = (typeof OKX_SORT)[keyof typeof OKX_SORT];

/**
 * Типы кошельков в терминологии OKX.
 *
 * Числа заданы их API, названия — наши. Держать их рядом важно:
 * в коде должно быть видно, что «9» — это связанный кошелёк,
 * а не просто девятка.
 */
export const OKX_WALLET_TYPE = {
  kol: 1,
  developer: 2,
  smartMoney: 3,
  whale: 4,
  newWallet: 5,
  insider: 6,
  sniper: 7,
  phishing: 8,
  bundled: 9,
  pumpSmartMoney: 10,
} as const;

export type OkxWalletType = (typeof OKX_WALLET_TYPE)[keyof typeof OKX_WALLET_TYPE];

export const WALLET_TYPE_LABELS: Record<number, string> = {
  1: 'KOL',
  2: 'Разработчик',
  3: 'Smart Money',
  4: 'Кит',
  5: 'Новый кошелёк',
  6: 'Инсайдер',
  7: 'Снайпер',
  8: 'Подозрение на фишинг',
  9: 'Связанный кошелёк',
  10: 'Pump Smart Money',
};

/**
 * Типы, которым не место в обычном рейтинге торговцев.
 *
 * Разработчик и инсайдер зарабатывают на знании, которого нет
 * у остальных; связанный кошелёк — часть схемы, а не самостоятельный
 * участник; фишинг — просто кража. Их результаты настоящие, и именно
 * поэтому опасны: без исключения они возглавили бы список.
 */
export const EXCLUDED_WALLET_TYPES: number[] = [
  OKX_WALLET_TYPE.developer,
  OKX_WALLET_TYPE.insider,
  OKX_WALLET_TYPE.phishing,
  OKX_WALLET_TYPE.bundled,
];

/**
 * Типы, которые хранятся отдельно и не смешиваются с общим списком.
 *
 * Снайпер торгует по-настоящему и может быть очень прибыльным, но
 * повторить его нельзя: он входит в первом блоке. Прятать его целиком
 * неверно — это существующее явление, — но и ставить рядом с теми,
 * за кем можно следовать, значит вводить в заблуждение.
 */
export const SEPARATE_WALLET_TYPES: number[] = [OKX_WALLET_TYPE.sniper, OKX_WALLET_TYPE.kol];

export function isListableWalletType(type: number | null): boolean {
  if (type == null) return true;
  return !EXCLUDED_WALLET_TYPES.includes(type);
}

/** Метки в выдаче по конкретному токену. Нумерация своя, не как у типов. */
export const OKX_TAG = {
  kol: 1,
  developer: 2,
  smartMoney: 3,
  whale: 4,
  newWallet: 5,
  suspicious: 6,
  sniper: 7,
  phishing: 8,
  bundle: 9,
} as const;

/** Метки, кошельки с которыми попадают в общий список. */
export const LISTABLE_TAGS: number[] = [OKX_TAG.smartMoney, OKX_TAG.whale];

// ─────────────────────────── Оболочка ответа ────────────────────────────────

export interface OkxEnvelope<T> {
  code: string;
  msg?: string;
  data?: T;
}

export class OkxResponseError extends Error {
  constructor(
    readonly code: string,
    readonly okxMessage: string,
    readonly endpoint: string,
  ) {
    super(`OKX ${endpoint}: код ${code}${okxMessage ? ` — ${okxMessage}` : ''}`);
    this.name = 'OkxResponseError';
  }
}

/**
 * Разбор оболочки ответа.
 *
 * Пустой data — законный результат: у кошелька может не быть сделок,
 * а у сети — лидеров за период. Отличать его от ошибки обязательно,
 * иначе пустой список читался бы как сбой и вызывал бы повторы.
 */
export function unwrapOkx<T>(raw: unknown, endpoint: string): T | null {
  if (raw == null || typeof raw !== 'object') {
    throw new OkxResponseError('malformed', 'ответ не является объектом', endpoint);
  }

  const env = raw as OkxEnvelope<T>;
  const code = String(env.code ?? '');

  if (code !== '0') {
    throw new OkxResponseError(code || 'unknown', String(env.msg ?? ''), endpoint);
  }

  return env.data ?? null;
}

// ──────────────────────── Нормализованные модели ────────────────────────────

/**
 * Источник значения.
 *
 * Хранится рядом с каждой чужой метрикой. Без этого через месяц
 * невозможно ответить на вопрос, почему наше число расходится
 * с числом на сайте OKX: непонятно даже, за какой период оно взято.
 */
export interface Provenance {
  source: 'okx';
  endpoint: string;
  timeFrame: OkxTimeframe | null;
  fetchedAt: number;
  /** Насколько полон ответ: доля непустых обязательных полей. */
  confidence: number;
}

/** Кандидат из лидерборда. */
export interface WalletCandidate {
  chain: ChainKey;
  /** Нормализованный адрес: EVM в нижнем регистре, Solana как есть. */
  address: string;
  /** Ключ дедупликации между источниками и запусками. */
  key: string;

  walletType: number | null;
  /** Место в выдаче — оно само по себе сведение о кошельке. */
  sourceRank: number;
  sortCategory: OkxSort;
  timeFrame: OkxTimeframe;

  /** Метрики OKX. Не подменяют собственный расчёт. */
  provider: WalletProviderMetrics;
  topTokens: WalletTopToken[];
  lastActiveAt: number | null;
  provenance: Provenance;
}

export interface WalletProviderMetrics {
  realizedPnlUsd: number | null;
  realizedPnlPercent: number | null;
  winRatePercent: number | null;
  avgBuyValueUsd: number | null;
  txVolumeUsd: number | null;
  txs: number | null;
}

export interface WalletTopToken {
  tokenAddress: string;
  symbol: string | null;
  pnlUsd: number | null;
  pnlPercent: number | null;
}

/** Сводка портфеля за период. */
export interface WalletTimeframeMetrics {
  timeFrame: OkxTimeframe;
  realizedPnlUsd: number | null;
  top3PnlSumUsd: number | null;
  top3PnlPercent: number | null;
  winRatePercent: number | null;

  /** Распределение позиций по итогу. */
  tokensOver500Pct: number | null;
  tokensZeroTo500Pct: number | null;
  tokensZeroToMinus50Pct: number | null;
  tokensOverMinus50Pct: number | null;

  buyTxCount: number | null;
  buyTxVolumeUsd: number | null;
  sellTxCount: number | null;
  sellTxVolumeUsd: number | null;
  avgBuyValueUsd: number | null;
  preferredMarketCap: number | null;
  topTokens: WalletTopToken[];
  provenance: Provenance;
}

/** Сделка из ленты отслеживания. */
export interface WalletTradeEvent {
  chain: ChainKey;
  wallet: string;
  txHash: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  side: 'BUY' | 'SELL';
  priceUsd: number | null;
  marketCapUsd: number | null;
  /** Заполняется только для продаж: у покупки результата ещё нет. */
  realizedPnlUsd: number | null;
  tradedAt: number;
  /** Ключ дедупликации: повторный запрос не должен создавать дубли. */
  dedupeKey: string;
}

/** Держатель токена с разбором его позиции. */
export interface WalletTokenPosition {
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  holdAmount: number | null;
  holdPercent: number | null;
  boughtAmount: number | null;
  avgBuyPrice: number | null;
  soldAmount: number | null;
  avgSellPrice: number | null;
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  fundingSource: string | null;
  tag: number | null;
}

// ──────────────────────────── Разбор ответов ────────────────────────────────

export function walletKey(chain: ChainKey, address: string): string {
  return `${OKX_CHAIN_INDEX[chain] ?? chain}:${normalizeAddress(chain, address)}`;
}

/**
 * Момент времени из ответа.
 *
 * OKX отдаёт миллисекунды строкой. Проверка на разумность нужна,
 * потому что нулевая или мусорная отметка превращается в 1970 год,
 * и такой кошелёк уезжает в конец любой сортировки по активности,
 * выглядя при этом законно.
 */
export function okxMillis(v: unknown): number | null {
  const n = okxNum(v);
  if (n == null || n <= 0) return null;
  // Отсекаем заведомо невозможное: до 2001 года и дальше 2100-го.
  if (n < 1_000_000_000_000 || n > 4_102_444_800_000) return null;
  return n;
}

function provenanceOf(
  endpoint: string,
  timeFrame: OkxTimeframe | null,
  present: number,
  total: number,
): Provenance {
  return {
    source: 'okx',
    endpoint,
    timeFrame,
    fetchedAt: Date.now(),
    confidence: total > 0 ? present / total : 0,
  };
}

/** Разбор одной записи лидерборда. */
export function parseLeaderboardRow(
  raw: unknown,
  ctx: { chain: ChainKey; rank: number; sortBy: OkxSort; timeFrame: OkxTimeframe },
): WalletCandidate | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const address = okxStr(r.walletAddress, 128);
  if (!address) return null;

  const provider: WalletProviderMetrics = {
    realizedPnlUsd: okxNum(r.realizedPnlUsd),
    realizedPnlPercent: okxNum(r.realizedPnlPercent),
    winRatePercent: okxNum(r.winRatePercent),
    avgBuyValueUsd: okxNum(r.avgBuyValueUsd),
    txVolumeUsd: okxNum(r.txVolume),
    txs: okxInt(r.txs),
  };

  const filled = Object.values(provider).filter((v) => v != null).length;

  return {
    chain: ctx.chain,
    address: normalizeAddress(ctx.chain, address),
    key: walletKey(ctx.chain, address),
    walletType: okxInt(r.walletType),
    sourceRank: ctx.rank,
    sortCategory: ctx.sortBy,
    timeFrame: ctx.timeFrame,
    provider,
    topTokens: parseTopTokens(r.topPnlTokenList),
    lastActiveAt: okxMillis(r.lastActiveTimestamp),
    provenance: provenanceOf(
      '/api/v6/dex/market/leaderboard/list',
      ctx.timeFrame,
      filled,
      Object.keys(provider).length,
    ),
  };
}

function parseTopTokens(raw: unknown): WalletTopToken[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item): WalletTopToken | null => {
      if (item == null || typeof item !== 'object') return null;
      const t = item as Record<string, unknown>;
      const addr = okxStr(t.tokenContractAddress, 128);
      if (!addr) return null;

      return {
        tokenAddress: addr,
        symbol: okxStr(t.tokenSymbol, 32),
        pnlUsd: okxNum(t.tokenPnlUsd),
        pnlPercent: okxNum(t.tokenPnlPercent),
      };
    })
    .filter((t): t is WalletTopToken => t !== null);
}

/** Разбор сводки портфеля. */
export function parsePortfolioOverview(
  raw: unknown,
  timeFrame: OkxTimeframe,
): WalletTimeframeMetrics | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (row == null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  const counts = (r.tokenCountByPnlPercent ?? {}) as Record<string, unknown>;

  const m: WalletTimeframeMetrics = {
    timeFrame,
    realizedPnlUsd: okxNum(r.realizedPnlUsd),
    top3PnlSumUsd: okxNum(r.top3PnlTokenSumUsd),
    top3PnlPercent: okxNum(r.top3PnlTokenPercent),
    winRatePercent: okxNum(r.winRate),
    tokensOver500Pct: okxInt(counts.over500Percent),
    tokensZeroTo500Pct: okxInt(counts.zeroTo500Percent),
    tokensZeroToMinus50Pct: okxInt(counts.zeroToMinus50Percent),
    tokensOverMinus50Pct: okxInt(counts.overMinus50Percent),
    buyTxCount: okxInt(r.buyTxCount),
    buyTxVolumeUsd: okxNum(r.buyTxVolume),
    sellTxCount: okxInt(r.sellTxCount),
    sellTxVolumeUsd: okxNum(r.sellTxVolume),
    avgBuyValueUsd: okxNum(r.avgBuyValueUsd),
    preferredMarketCap: okxInt(r.preferredMarketCap),
    topTokens: parseTopTokens(r.topPnlTokenList),
    provenance: provenanceOf('/api/v6/dex/market/portfolio/overview', timeFrame, 0, 1),
  };

  // Полнота считается по тем полям, которые действительно пришли.
  const checked = [
    m.realizedPnlUsd,
    m.winRatePercent,
    m.buyTxCount,
    m.sellTxCount,
    m.avgBuyValueUsd,
  ];
  m.provenance.confidence = checked.filter((v) => v != null).length / checked.length;

  return m;
}

/** Разбор строки из выдачи по токену. */
export function parseTopTrader(
  raw: unknown,
  ctx: { chain: ChainKey; tokenAddress: string; tag?: number | null },
): WalletTokenPosition | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const wallet = okxStr(r.holderWalletAddress, 128);
  if (!wallet) return null;

  return {
    chain: ctx.chain,
    wallet: normalizeAddress(ctx.chain, wallet),
    tokenAddress: ctx.tokenAddress,
    holdAmount: okxNum(r.holdAmount),
    holdPercent: okxNum(r.holdPercent),
    boughtAmount: okxNum(r.boughtAmount),
    avgBuyPrice: okxNum(r.avgBuyPrice),
    soldAmount: okxNum(r.soldAmount),
    avgSellPrice: okxNum(r.avgSellPrice),
    totalPnlUsd: okxNum(r.totalPnlUsd),
    realizedPnlUsd: okxNum(r.realizedPnlUsd),
    unrealizedPnlUsd: okxNum(r.unrealizedPnlUsd),
    fundingSource: okxStr(r.fundingSource, 128),
    tag: ctx.tag ?? null,
  };
}

/**
 * Разбор сделки из ленты отслеживания.
 *
 * tradeType у OKX: 1 — покупка, 2 — продажа. Значение вне этого
 * набора означает, что формат изменился, и такую запись честнее
 * отбросить, чем угадать направление: перепутанное направление
 * испортит весь учёт позиций.
 */
export function parseTradeEvent(raw: unknown): WalletTradeEvent | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const chain = chainFromIndex(r.chainIndex as string);
  const wallet = okxStr(r.walletAddress, 128);
  const token = okxStr(r.tokenContractAddress, 128);
  const txHash = okxStr(r.txHash, 160);
  const tradedAt = okxMillis(r.tradeTime);

  if (!chain || !wallet || !token || !txHash || tradedAt == null) return null;

  const rawType = okxInt(r.tradeType);
  if (rawType !== 1 && rawType !== 2) return null;
  const side: 'BUY' | 'SELL' = rawType === 1 ? 'BUY' : 'SELL';

  const normWallet = normalizeAddress(chain, wallet);
  const normToken = normalizeAddress(chain, token);

  return {
    chain,
    wallet: normWallet,
    txHash,
    tokenAddress: normToken,
    tokenSymbol: okxStr(r.tokenSymbol, 32),
    quoteSymbol: okxStr(r.quoteTokenSymbol, 32),
    quoteAmount: okxNum(r.quoteTokenAmount),
    side,
    priceUsd: okxNum(r.tokenPrice),
    marketCapUsd: okxNum(r.marketCap),
    // У покупки зафиксированного результата не бывает: он появится
    // при продаже. Ноль здесь означал бы «продал в ноль».
    realizedPnlUsd: side === 'SELL' ? okxNum(r.realizedPnlUsd) : null,
    tradedAt,
    dedupeKey: [OKX_CHAIN_INDEX[chain], txHash, normWallet, normToken, side].join('|'),
  };
}

/**
 * Дедупликация сделок.
 *
 * Повторный запрос к ленте возвращает те же последние сделки, и без
 * этого каждая из них попадала бы в учёт заново — с каждым проходом
 * удваивая объём кошелька.
 */
export function dedupeTrades(events: WalletTradeEvent[]): WalletTradeEvent[] {
  const seen = new Set<string>();
  const out: WalletTradeEvent[] = [];

  for (const e of events) {
    if (seen.has(e.dedupeKey)) continue;
    seen.add(e.dedupeKey);
    out.push(e);
  }

  return out;
}
