/**
 * Кошельковые разделы OKX Onchain OS.
 *
 * Слой между сырым клиентом и приложением. Наружу отдаёт только
 * нормализованные модели из ядра — ни один компонент интерфейса
 * не должен знать, как называются поля у OKX.
 *
 * Разделение обязанностей здесь такое: okx-client отвечает
 * за подпись, повторы и лимиты; okx-wallet-model в ядре — за разбор
 * ответа; этот модуль — за то, какие вопросы вообще задавать.
 * Третье — предметное решение, и держать его вместе с транспортом
 * значило бы смешать «как спросить» с «что спросить».
 */

import {
  unwrapOkx,
  parseLeaderboardRow,
  parsePortfolioOverview,
  parseTopTrader,
  parseTradeEvent,
  dedupeTrades,
  isListableWalletType,
  OKX_CHAIN_INDEX,
  OKX_TIMEFRAME,
  OKX_SORT,
  OKX_WALLET_TYPE,
  LISTABLE_TAGS,
  type ChainKey,
  type OkxTimeframe,
  type OkxSort,
  type WalletCandidate,
  type WalletTimeframeMetrics,
  type WalletTradeEvent,
  type WalletTokenPosition,
} from '@memex/core';
import { okxCached, isOkxWalletConfigured } from './okx-client.js';
import { logger } from '../lib/logger.js';

const EP = {
  leaderboard: '/api/v6/dex/market/leaderboard/list',
  overview: '/api/v6/dex/market/portfolio/overview',
  topTrader: '/api/v6/dex/market/token/top-trader',
  trades: '/api/v6/dex/market/address-tracker/trades',
} as const;

/** Сроки хранения. Подобраны по скорости изменения самих величин. */
const TTL = {
  leaderboard: 5 * 60_000,
  overview: 5 * 60_000,
  topTrader: 10 * 60_000,
  // Лента живёт секундами: она и нужна для того, чтобы видеть
  // сделку вскоре после подтверждения.
  trades: 20_000,
} as const;

export { isOkxWalletConfigured };

// ────────────────────────────── Лидерборд ───────────────────────────────────

export interface LeaderboardQuery {
  chain: ChainKey;
  timeFrame: OkxTimeframe;
  sortBy: OkxSort;
  walletType?: number;
  minRealizedPnlUsd?: number;
  minWinRatePercent?: number;
  minTxs?: number;
}

/**
 * Лидеры сети за период.
 *
 * OKX отдаёт не больше двадцати записей, и это не ограничение
 * запроса, а свойство эндпоинта: просить больше бессмысленно.
 * Широта покрытия достигается не размером страницы, а числом
 * сочетаний периода и способа сортировки.
 */
export async function fetchLeaderboard(q: LeaderboardQuery): Promise<WalletCandidate[]> {
  const chainIndex = OKX_CHAIN_INDEX[q.chain];
  if (!chainIndex || !isOkxWalletConfigured()) return [];

  const params = new URLSearchParams({
    chainIndex,
    timeFrame: String(q.timeFrame),
    sortBy: String(q.sortBy),
  });

  if (q.walletType != null) params.set('walletType', String(q.walletType));
  if (q.minRealizedPnlUsd != null) params.set('minRealizedPnlUsd', String(q.minRealizedPnlUsd));
  if (q.minWinRatePercent != null) params.set('minWinRatePercent', String(q.minWinRatePercent));
  if (q.minTxs != null) params.set('minTxs', String(q.minTxs));

  const path = `${EP.leaderboard}?${params.toString()}`;

  const hit = await okxCached<unknown>(
    `okx:lb:${params.toString()}`,
    path,
    TTL.leaderboard,
    { label: 'leaderboard' },
  );
  if (!hit) return [];

  let rows: unknown;
  try {
    rows = unwrapOkx<unknown>(hit.value, EP.leaderboard);
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'OKX лидерборд: ответ отклонён');
    return [];
  }

  const list = Array.isArray(rows) ? rows : [];

  return list
    .map((raw, i) =>
      parseLeaderboardRow(raw, {
        chain: q.chain,
        rank: i + 1,
        sortBy: q.sortBy,
        timeFrame: q.timeFrame,
      }),
    )
    .filter((c): c is WalletCandidate => c !== null)
    // Разработчики, инсайдеры, фишинг и связанные кошельки в общий
    // список не попадают. Их результаты настоящие — и именно поэтому
    // опасны: без исключения они возглавили бы рейтинг.
    .filter((c) => isListableWalletType(c.walletType));
}

/**
 * Сочетания, которыми обходится сеть при поиске кандидатов.
 *
 * Разные способы сортировки находят разных людей: по прибыли —
 * крупных, по доходности — мелких и удачливых, по доле удачных —
 * осторожных. Один способ дал бы однобокую выборку, в которой
 * кошелёк с сотней долларов и двадцатью попаданиями подряд
 * никогда бы не показался.
 */
export const DISCOVERY_SWEEPS: Array<{ timeFrame: OkxTimeframe; sortBy: OkxSort }> = [
  { timeFrame: OKX_TIMEFRAME.d7, sortBy: OKX_SORT.pnl },
  { timeFrame: OKX_TIMEFRAME.m1, sortBy: OKX_SORT.pnl },
  { timeFrame: OKX_TIMEFRAME.m3, sortBy: OKX_SORT.pnl },
  { timeFrame: OKX_TIMEFRAME.d7, sortBy: OKX_SORT.roi },
  { timeFrame: OKX_TIMEFRAME.m1, sortBy: OKX_SORT.roi },
  { timeFrame: OKX_TIMEFRAME.m3, sortBy: OKX_SORT.roi },
  { timeFrame: OKX_TIMEFRAME.m1, sortBy: OKX_SORT.winRate },
  { timeFrame: OKX_TIMEFRAME.m3, sortBy: OKX_SORT.winRate },
];

/** Полный обход одной сети: все сочетания плюс отдельные типы. */
export async function discoverCandidates(chain: ChainKey): Promise<WalletCandidate[]> {
  const queries: LeaderboardQuery[] = [
    ...DISCOVERY_SWEEPS.map((s) => ({ chain, ...s })),
    { chain, timeFrame: OKX_TIMEFRAME.m1, sortBy: OKX_SORT.pnl, walletType: OKX_WALLET_TYPE.smartMoney },
    { chain, timeFrame: OKX_TIMEFRAME.m1, sortBy: OKX_SORT.pnl, walletType: OKX_WALLET_TYPE.pumpSmartMoney },
  ];

  const lists = await Promise.all(queries.map((q) => fetchLeaderboard(q)));

  // Дедупликация по ключу. Один кошелёк попадает в несколько выборок,
  // и это само по себе сведение о нём: чем в большем числе срезов
  // он есть, тем меньше вероятность совпадения. Поэтому сохраняем
  // первое вхождение, но считаем, сколько их было.
  const byKey = new Map<string, WalletCandidate>();
  const hits = new Map<string, number>();

  for (const c of lists.flat()) {
    hits.set(c.key, (hits.get(c.key) ?? 0) + 1);
    if (!byKey.has(c.key)) byKey.set(c.key, c);
  }

  return [...byKey.values()];
}

// ─────────────────────────── Сводка портфеля ────────────────────────────────

export async function fetchOverview(
  chain: ChainKey,
  wallet: string,
  timeFrame: OkxTimeframe,
): Promise<WalletTimeframeMetrics | null> {
  const chainIndex = OKX_CHAIN_INDEX[chain];
  if (!chainIndex || !isOkxWalletConfigured()) return null;

  const params = new URLSearchParams({
    chainIndex,
    walletAddress: wallet,
    timeFrame: String(timeFrame),
  });

  const hit = await okxCached<unknown>(
    `okx:ov:${chain}:${wallet}:${timeFrame}`,
    `${EP.overview}?${params.toString()}`,
    TTL.overview,
    { label: 'overview' },
  );
  if (!hit) return null;

  try {
    const data = unwrapOkx<unknown>(hit.value, EP.overview);
    return parsePortfolioOverview(data, timeFrame);
  } catch {
    return null;
  }
}

// ──────────────────────── Держатели конкретного токена ──────────────────────

export async function fetchTopTraders(
  chain: ChainKey,
  tokenAddress: string,
  opts: { tag?: number; limit?: number } = {},
): Promise<WalletTokenPosition[]> {
  const chainIndex = OKX_CHAIN_INDEX[chain];
  if (!chainIndex || !isOkxWalletConfigured()) return [];

  const params = new URLSearchParams({
    chainIndex,
    tokenContractAddress: tokenAddress,
    limit: String(Math.min(opts.limit ?? 50, 100)),
  });
  if (opts.tag != null) params.set('tagFilter', String(opts.tag));

  const hit = await okxCached<unknown>(
    `okx:tt:${chain}:${tokenAddress}:${opts.tag ?? 'all'}`,
    `${EP.topTrader}?${params.toString()}`,
    TTL.topTrader,
    { label: 'top-trader' },
  );
  if (!hit) return [];

  try {
    const data = unwrapOkx<unknown>(hit.value, EP.topTrader);
    const rows = Array.isArray(data) ? data : [];

    return rows
      .map((raw) => parseTopTrader(raw, { chain, tokenAddress, tag: opts.tag ?? null }))
      .filter((p): p is WalletTokenPosition => p !== null);
  } catch {
    return [];
  }
}

/** Метки, кошельки с которыми идут в общий список. */
export { LISTABLE_TAGS };

// ────────────────────────────── Лента сделок ────────────────────────────────

export interface TradesQuery {
  /** 1 — Smart Money OKX, 2 — топ-100 KOL, 3 — конкретные адреса. */
  trackerType: 1 | 2 | 3;
  /** Обязателен при trackerType=3. До двадцати адресов за запрос. */
  wallets?: string[];
  chain?: ChainKey;
  /** 0 — все, 1 — покупки, 2 — продажи. */
  tradeType?: 0 | 1 | 2;
  minVolumeUsd?: number;
  minLiquidityUsd?: number;
  minMarketCapUsd?: number;
}

export const MAX_TRACKED_ADDRESSES = 20;

/**
 * Последние сделки отслеживаемых кошельков.
 *
 * Одно обращение принимает до двадцати адресов. Больше — не ошибка
 * запроса, а тихое усечение на стороне провайдера: лишние адреса
 * просто не попадут в выдачу, и обнаружится это как «кошелёк
 * перестал торговать». Поэтому список режется здесь и явно.
 */
export async function fetchTrades(q: TradesQuery): Promise<WalletTradeEvent[]> {
  if (!isOkxWalletConfigured()) return [];

  if (q.trackerType === 3 && (!q.wallets || q.wallets.length === 0)) {
    logger.warn('OKX лента: trackerType=3 без адресов');
    return [];
  }

  const params = new URLSearchParams({ trackerType: String(q.trackerType) });

  if (q.wallets?.length) {
    params.set('walletAddress', q.wallets.slice(0, MAX_TRACKED_ADDRESSES).join(','));
  }
  if (q.chain && OKX_CHAIN_INDEX[q.chain]) {
    params.set('chainIndex', OKX_CHAIN_INDEX[q.chain]!);
  }
  if (q.tradeType != null) params.set('tradeType', String(q.tradeType));
  if (q.minVolumeUsd != null) params.set('minVolume', String(q.minVolumeUsd));
  if (q.minLiquidityUsd != null) params.set('minLiquidity', String(q.minLiquidityUsd));
  if (q.minMarketCapUsd != null) params.set('minMarketCap', String(q.minMarketCapUsd));

  const hit = await okxCached<unknown>(
    `okx:tr:${params.toString()}`,
    `${EP.trades}?${params.toString()}`,
    TTL.trades,
    { label: 'trades' },
  );
  if (!hit) return [];

  try {
    const data = unwrapOkx<any>(hit.value, EP.trades);
    const rows = Array.isArray(data?.trades) ? data.trades : Array.isArray(data) ? data : [];

    const events = rows
      .map((raw: unknown) => parseTradeEvent(raw))
      .filter((e: WalletTradeEvent | null): e is WalletTradeEvent => e !== null);

    // Дедупликация обязательна: повторный запрос возвращает те же
    // последние сделки, и без неё каждый проход удваивал бы объём
    // кошелька в учёте.
    return dedupeTrades(events).sort((a, b) => b.tradedAt - a.tradedAt);
  } catch {
    return [];
  }
}
