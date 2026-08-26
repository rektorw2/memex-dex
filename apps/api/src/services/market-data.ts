import type { Chain } from '@prisma/client';
import { tokenDisplaySymbol } from '@memex/core';
import { logger } from '../lib/logger.js';

/**
 * Рыночные данные из GeckoTerminal.
 *
 * Почему именно он: бесплатно, без ключа, покрывает Solana и EVM-сети,
 * и главное — отдаёт готовые свечи OHLCV. У DexScreener свечей в публичном
 * API нет, у Birdeye они за ключом. Строить свечи самим из тиков цены
 * означало бы ждать сутки, прежде чем на графике появится хоть что-то.
 *
 * Ограничение бесплатного тарифа — 30 запросов в минуту на IP. Это мало,
 * поэтому все обращения проходят через общий лимитер, а свечи обновляются
 * по очереди, а не для всех токенов сразу.
 */

const API = 'https://api.geckoterminal.com/api/v2';

/**
 * Идентификаторы сетей в GeckoTerminal.
 * null означает, что сеть не поддерживается — импорт для неё пропускается
 * без ошибки. Robinhood Chain запущен в июле 2026, агрегаторы данных
 * подключают такие сети с задержкой в несколько месяцев.
 */
const NETWORK: Record<Chain, string | null> = {
  SOLANA: 'solana',
  BNB: 'bsc',
  BASE: 'base',
  ETHEREUM: 'eth',
  ROBINHOOD: null,
};

export function isMarketDataSupported(chain: Chain): boolean {
  return NETWORK[chain] !== null;
}

// ─────────────────────────── Ограничитель частоты ───────────────────────────

/**
 * Token bucket на 25 запросов в минуту — с запасом к лимиту в 30.
 * Без него импортёр и построитель свечей начнут получать 429 и молча
 * оставят витрину пустой.
 */
export class PacedRateLimiter {
  private nextAt = 0;
  private blockedUntil = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly spacingMs: number;

  constructor(capacity: number, perMs: number) {
    this.spacingMs = Math.ceil(perMs / capacity);
  }

  /**
   * Выдать следующий слот без залпа.
   *
   * Прежний token bucket разрешал первые 25 запросов в одну
   * миллисекунду. Формально минутный бюджет не превышался, но
   * GeckoTerminal ограничивает и короткие всплески — именно поэтому
   * в Render четыре OHLCV-запроса одновременно получили 429.
   */
  take(): Promise<void> {
    const ticket = this.tail.then(async () => {
      for (;;) {
        const now = Date.now();
        const target = Math.max(this.nextAt, this.blockedUntil);
        if (target <= now) break;
        await new Promise((resolve) => setTimeout(resolve, target - now));
      }
      this.nextAt = Date.now() + this.spacingMs;
    });

    // Ошибка одного ожидающего не должна навсегда закрыть очередь.
    this.tail = ticket.catch(() => undefined);
    return ticket;
  }

  /** Остановить всю очередь после ответа 429. */
  backoff(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.max(0, ms));
  }
}

/*
 * Двадцать равномерных запросов в минуту вместо залпа из двадцати пяти.
 * Запас нужен, потому что на Render лимит считается по исходящему IP,
 * а во время деплоя старый и новый экземпляры могут коротко пересекаться.
 */
const limiter = new PacedRateLimiter(20, 60_000);

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function get<T>(path: string): Promise<T | null> {
  await limiter.take();
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json;version=20230302' },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 429) {
      const waitMs = Math.max(60_000, retryAfterMs(res.headers.get('retry-after')) ?? 0);
      limiter.backoff(waitMs);
      logger.warn({ path, retryAfterMs: waitMs }, 'GeckoTerminal: превышен лимит запросов');
      return null;
    }
    if (!res.ok) {
      logger.debug({ path, status: res.status }, 'GeckoTerminal: запрос не удался');
      return null;
    }
    return (await res.json()) as T;
  } catch (e: any) {
    logger.debug({ path, err: e?.message }, 'GeckoTerminal: ошибка сети');
    return null;
  }
}

// ───────────────────────────── Пулы и токены ────────────────────────────────

export interface PoolToken {
  chain: Chain;
  logoUrl?: string | null;
  /** Адрес самого токена (mint для Solana, contract для EVM). */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Адрес пула — по нему запрашиваются свечи. */
  poolAddress: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24h: number | null;
  fdvUsd: number | null;
  poolCreatedAt: Date | null;
}

interface GeckoPool {
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    reserve_in_usd: string | null;
    fdv_usd: string | null;
    pool_created_at: string | null;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h24?: string };
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
  };
}

interface GeckoIncluded {
  id: string;
  type: string;
  attributes: {
    image_url?: string | null; address: string; name: string; symbol: string; decimals?: number };
}

const num = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Топ пулов сети по объёму за 24 часа.
 *
 * Берём именно пулы, а не «топ токенов»: у токена может не быть
 * ликвидного рынка, и торговать им нельзя. Пул с объёмом — гарантия,
 * что сделка вообще исполнится.
 */
/**
 * Источники списков пулов.
 *
 * Разделение существенное, и раньше его не было — сканер брал только
 * `top`, то есть пулы, отсортированные по суточному объёму. Это список
 * уже состоявшихся токенов: свежий пул с небольшой ликвидностью в него
 * физически не попадает, сколько страниц ни листай. Радар из-за этого
 * находил вчерашние новости.
 *
 *  new      — недавно созданные пулы. Основной источник для радара.
 *  trending — пулы с растущей активностью прямо сейчас.
 *  top      — крупнейшие по обороту. Нужен витрине, но не поиску нового.
 */
export type PoolFeed = 'new' | 'trending' | 'top';

const FEED_PATH: Record<PoolFeed, (net: string) => string> = {
  new: (net) => `/networks/${net}/new_pools`,
  trending: (net) => `/networks/${net}/trending_pools`,
  top: (net) => `/networks/${net}/pools?sort=h24_volume_usd_desc`,
};

export async function fetchPools(
  chain: Chain,
  feed: PoolFeed = 'top',
  pages = 1,
): Promise<PoolToken[]> {
  const network = NETWORK[chain];
  if (!network) return [];

  const result: PoolToken[] = [];
  const base = FEED_PATH[feed](network);
  const sep = base.includes('?') ? '&' : '?';

  for (let page = 1; page <= pages; page++) {
    const data = await get<{ data: GeckoPool[]; included: GeckoIncluded[] }>(
      `${base}${sep}page=${page}&include=base_token,quote_token`,
    );
    if (!data?.data?.length) break;

    // included содержит развёрнутые токены — собираем словарь по id
    const tokens = new Map<string, GeckoIncluded>();
    for (const item of data.included ?? []) {
      if (item.type === 'token') tokens.set(item.id, item);
    }

    for (const pool of data.data) {
      const baseId = pool.relationships?.base_token?.data?.id;
      const base = baseId ? tokens.get(baseId) : undefined;
      if (!base?.attributes?.address) continue;

      result.push({
        chain,
        address: base.attributes.address,
        // Сокращённый адрес вместо `???`: три знака вопроса
        // записывались в базу как символ и доезжали до экрана
        // по обычному пути, мимо всех подстановок.
        symbol: (
          base.attributes.symbol ||
          tokenDisplaySymbol({ symbol: null, address: base.attributes.address })
        ).slice(0, 20),
        name: (base.attributes.name || base.attributes.symbol || 'Unknown').slice(0, 80),
        // GeckoTerminal не всегда отдаёт decimals; для Solana обычно 6 или 9,
        // для EVM — 18. Уточняется при первой сделке через адаптер сети.
        decimals: base.attributes.decimals ?? (chain === 'SOLANA' ? 9 : 18),
        // Логотип есть не у всех токенов, и у свежих мем-коинов его нет
        // почти никогда. Отсутствие — норма, интерфейс рисует буквы тикера.
        logoUrl: base.attributes.image_url ?? null,
        poolAddress: pool.attributes.address,
        priceUsd: num(pool.attributes.base_token_price_usd),
        liquidityUsd: num(pool.attributes.reserve_in_usd),
        volume24hUsd: num(pool.attributes.volume_usd?.h24),
        priceChange24h: num(pool.attributes.price_change_percentage?.h24),
        fdvUsd: num(pool.attributes.fdv_usd),
        poolCreatedAt: pool.attributes.pool_created_at
          ? new Date(pool.attributes.pool_created_at)
          : null,
      });
    }
  }

  return result;
}

/**
 * Совместимость с прежним вызовом. Оставлено намеренно: витрине и
 * импортёру нужен именно список по обороту, а радару — новые пулы,
 * и путать эти два запроса не следует.
 */
export async function fetchTopPools(chain: Chain, pages = 2): Promise<PoolToken[]> {
  return fetchPools(chain, 'top', pages);
}

/** Данные одного пула — для точечного добавления токена админом. */
export async function fetchPoolForToken(
  chain: Chain,
  tokenAddress: string,
): Promise<PoolToken | null> {
  const network = NETWORK[chain];
  if (!network) return null;

  const data = await get<{ data: GeckoPool[]; included: GeckoIncluded[] }>(
    `/networks/${network}/tokens/${tokenAddress}/pools?include=base_token&page=1`,
  );
  if (!data?.data?.length) return null;

  const tokens = new Map<string, GeckoIncluded>();
  for (const item of data.included ?? []) {
    if (item.type === 'token') tokens.set(item.id, item);
  }

  // Самый ликвидный пул: цена в мелком пуле не отражает рынок.
  const best = [...data.data].sort(
    (a, b) => (num(b.attributes.reserve_in_usd) ?? 0) - (num(a.attributes.reserve_in_usd) ?? 0),
  )[0];
  if (!best) return null;

  const base = tokens.get(best.relationships?.base_token?.data?.id ?? '');

  return {
    chain,
    address: tokenAddress,
    symbol: (
      base?.attributes?.symbol || tokenDisplaySymbol({ symbol: null, address: tokenAddress })
    ).slice(0, 20),
    name: (base?.attributes?.name || 'Unknown').slice(0, 80),
    decimals: base?.attributes?.decimals ?? (chain === 'SOLANA' ? 9 : 18),
    poolAddress: best.attributes.address,
    priceUsd: num(best.attributes.base_token_price_usd),
    liquidityUsd: num(best.attributes.reserve_in_usd),
    volume24hUsd: num(best.attributes.volume_usd?.h24),
    priceChange24h: num(best.attributes.price_change_percentage?.h24),
    fdvUsd: num(best.attributes.fdv_usd),
    poolCreatedAt: best.attributes.pool_created_at
      ? new Date(best.attributes.pool_created_at)
      : null,
  };
}

// ──────────────────────────────── Свечи ─────────────────────────────────────

export interface Ohlcv {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

/** Соответствие наших интервалов параметрам GeckoTerminal. */
const TIMEFRAME: Record<string, { unit: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '1m': { unit: 'minute', aggregate: 1 },
  '5m': { unit: 'minute', aggregate: 5 },
  '15m': { unit: 'minute', aggregate: 15 },
  '1h': { unit: 'hour', aggregate: 1 },
  '4h': { unit: 'hour', aggregate: 4 },
  '1d': { unit: 'day', aggregate: 1 },
};

export const SUPPORTED_INTERVALS = Object.keys(TIMEFRAME);

export async function fetchOhlcv(
  chain: Chain,
  poolAddress: string,
  interval: string,
  limit = 300,
): Promise<Ohlcv[]> {
  const network = NETWORK[chain];
  const tf = TIMEFRAME[interval];
  if (!network || !tf) return [];

  const data = await get<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/${network}/pools/${poolAddress}/ohlcv/${tf.unit}` +
      `?aggregate=${tf.aggregate}&limit=${Math.min(limit, 1000)}&currency=usd`,
  );

  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];

  // Формат ответа: [timestamp, open, high, low, close, volume].
  // Приходит от новых к старым — разворачиваем, график ждёт хронологию.
  return list
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .map((row) => ({
      openTime: new Date(row[0]! * 1000),
      open: row[1]!,
      high: row[2]!,
      low: row[3]!,
      close: row[4]!,
      volumeUsd: row[5]!,
    }))
    .filter((c) => Number.isFinite(c.open) && c.open > 0)
    .reverse();
}

// ─────────────────────────────── Сделки пула ────────────────────────────────

export interface PoolTrade {
  /** Адрес кошелька, инициировавшего сделку. */
  wallet: string;
  side: 'BUY' | 'SELL';
  amountUsd: number;
  priceUsd: number | null;
  txHash: string | null;
  tradedAt: Date;
}

/**
 * Последние сделки по пулу.
 *
 * Это единственный бесплатный источник, отдающий адрес контрагента вместе
 * с суммой: именно из него строится всё, что мы знаем о кошельках. Глубина
 * ограничена примерно тремя сотнями последних сделок и суммой в долларах,
 * поэтому пул нужно опрашивать регулярно, а не разово — история задним
 * числом недоступна.
 *
 * Направление определяется по стороне базового токена: покупка базового
 * токена за котировочный — это BUY. Поле kind в ответе для части сетей
 * отсутствует, поэтому опираемся на знак изменения объёмов, а не на него.
 */
export async function fetchPoolTrades(
  chain: Chain,
  poolAddress: string,
  minUsd = 100,
): Promise<PoolTrade[]> {
  const network = NETWORK[chain];
  if (!network) return [];

  const data = await get<{
    data: Array<{
      attributes: {
        block_timestamp?: string;
        tx_hash?: string;
        tx_from_address?: string;
        from_token_amount?: string;
        to_token_amount?: string;
        price_to_in_usd?: string;
        price_from_in_usd?: string;
        volume_in_usd?: string;
        kind?: string;
      };
    }>;
  }>(`/networks/${network}/pools/${poolAddress}/trades?trade_volume_in_usd_greater_than=${minUsd}`);

  if (!Array.isArray(data?.data)) return [];

  const out: PoolTrade[] = [];

  for (const row of data.data) {
    const a = row?.attributes;
    if (!a) continue;

    const wallet = a.tx_from_address?.trim();
    if (!wallet) continue;

    const amountUsd = Number(a.volume_in_usd);
    if (!Number.isFinite(amountUsd) || amountUsd < minUsd) continue;

    const ts = a.block_timestamp ? new Date(a.block_timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;

    // kind = 'buy' | 'sell' относительно базового токена пула.
    const side = a.kind === 'sell' ? 'SELL' : 'BUY';

    const price = Number(side === 'BUY' ? a.price_to_in_usd : a.price_from_in_usd);

    out.push({
      wallet,
      side,
      amountUsd,
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      txHash: a.tx_hash?.trim() || null,
      tradedAt: ts,
    });
  }

  return out;
}
