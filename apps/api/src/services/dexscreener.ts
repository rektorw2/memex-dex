import type { Chain } from '@prisma/client';
import { logger } from '../lib/logger.js';

/**
 * DexScreener: счётчики сделок и социальные ссылки.
 *
 * Добавлен рядом с GeckoTerminal, а не вместо него, потому что даёт то,
 * чего у того нет: раздельные счётчики покупок и продаж за период.
 * Это единственный доступный признак ханипота, который виден без вызова
 * контракта — токен, у которого четыре сотни покупок и ни одной продажи,
 * подозрителен независимо от того, что показала проверка контракта.
 *
 * Второе отличие: у DexScreener лимит порядка 300 запросов в минуту
 * против 25 у GeckoTerminal, и он не требует ключа. Поэтому проверять
 * им можно каждый токен, а не выборочно.
 *
 * Один токен обычно торгуется в нескольких пулах. Берём самый ликвидный:
 * счётчики сделок из мелкого пула ничего не говорят о токене в целом.
 */

const API = 'https://api.dexscreener.com/latest/dex';

/** Идентификаторы сетей у DexScreener. */
const NETWORK: Record<Chain, string | null> = {
  SOLANA: 'solana',
  BNB: 'bsc',
  BASE: 'base',
  ETHEREUM: 'ethereum',
  // Robinhood Chain запущен недавно, агрегаторы подключают такие сети
  // с задержкой в несколько месяцев.
  ROBINHOOD: null,
};

export function isDexScreenerSupported(chain: Chain): boolean {
  return NETWORK[chain] !== null;
}

export interface DexScreenerPair {
  chain: Chain;
  pairAddress: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  pairCreatedAt: Date | null;
  logoUrl: string | null;
  websites: string[];
  socials: Array<{ type: string; url: string }>;
  /** Продвижение за деньги. Не признак качества, но факт о токене. */
  boosts: number | null;
}

interface RawPair {
  chainId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
  marketCap?: number;
  priceChange?: { h24?: number };
  txns?: {
    h24?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
  boosts?: { active?: number };
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.status === 429) {
      logger.warn({ path }, 'DexScreener: превышен лимит запросов');
      return null;
    }
    if (!res.ok) {
      logger.debug({ path, status: res.status }, 'DexScreener: запрос не удался');
      return null;
    }
    return (await res.json()) as T;
  } catch (e: any) {
    logger.debug({ path, err: e?.message }, 'DexScreener: ошибка сети');
    return null;
  }
}

function toPair(raw: RawPair, chain: Chain): DexScreenerPair | null {
  if (!raw?.pairAddress) return null;

  return {
    chain,
    pairAddress: raw.pairAddress,
    priceUsd: num(raw.priceUsd),
    liquidityUsd: num(raw.liquidity?.usd),
    volume24hUsd: num(raw.volume?.h24),
    // fdv и marketCap у DexScreener расходятся для токенов с заблокированным
    // предложением. Берём fdv для сопоставимости с GeckoTerminal.
    fdvUsd: num(raw.fdv) ?? num(raw.marketCap),
    priceChange24h: num(raw.priceChange?.h24),
    buys24h: num(raw.txns?.h24?.buys),
    sells24h: num(raw.txns?.h24?.sells),
    buys1h: num(raw.txns?.h1?.buys),
    sells1h: num(raw.txns?.h1?.sells),
    pairCreatedAt: raw.pairCreatedAt ? new Date(raw.pairCreatedAt) : null,
    logoUrl: raw.info?.imageUrl ?? null,
    websites: (raw.info?.websites ?? [])
      .map((w) => w?.url)
      .filter((u): u is string => typeof u === 'string'),
    socials: (raw.info?.socials ?? [])
      .filter((s): s is { type: string; url: string } =>
        typeof s?.type === 'string' && typeof s?.url === 'string',
      )
      .map((s) => ({ type: s.type, url: s.url })),
    boosts: num(raw.boosts?.active),
  };
}

/**
 * Самый ликвидный пул токена.
 *
 * Один токен торгуется в нескольких пулах, и брать первый попавшийся
 * нельзя: счётчики сделок из пула с ликвидностью в двести долларов
 * ничего не говорят о токене.
 */
export async function fetchTokenPair(
  chain: Chain,
  tokenAddress: string,
): Promise<DexScreenerPair | null> {
  const network = NETWORK[chain];
  if (!network) return null;

  const data = await get<{ pairs: RawPair[] | null }>(`/tokens/${tokenAddress}`);
  if (!data?.pairs?.length) return null;

  const pairs = data.pairs
    .filter((p) => p?.chainId === network)
    .map((p) => toPair(p, chain))
    .filter((p): p is DexScreenerPair => p !== null);

  if (pairs.length === 0) return null;

  return pairs.reduce((best, p) =>
    (p.liquidityUsd ?? 0) > (best.liquidityUsd ?? 0) ? p : best,
  );
}

/**
 * Пакетная выборка: до 30 адресов за один запрос.
 *
 * Существенно для импортёра — иначе на сотню токенов уходит сотня
 * запросов, и даже щедрый лимит DexScreener кончается за пару минут.
 */
export async function fetchTokenPairs(
  chain: Chain,
  addresses: string[],
): Promise<Map<string, DexScreenerPair>> {
  const network = NETWORK[chain];
  const out = new Map<string, DexScreenerPair>();
  if (!network || addresses.length === 0) return out;

  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const data = await get<{ pairs: RawPair[] | null }>(`/tokens/${batch.join(',')}`);
    if (!data?.pairs?.length) continue;

    for (const raw of data.pairs) {
      if (raw?.chainId !== network) continue;
      const pair = toPair(raw, chain);
      if (!pair) continue;

      // Ответ не говорит, какому из запрошенных адресов принадлежит пара,
      // поэтому сопоставляем по базовому токену из самого ответа.
      const base = (raw as RawPair & { baseToken?: { address?: string } }).baseToken?.address;
      if (!base) continue;

      const key = base.toLowerCase();
      const prev = out.get(key);
      // Оставляем самый ликвидный пул токена.
      if (!prev || (pair.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) {
        out.set(key, pair);
      }
    }
  }

  return out;
}
