import type { Chain } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { cached } from '../lib/cache.js';

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
  /**
   * Символ и название базового токена пары.
   *
   * Нужны для продвигаемых токенов, которых ещё нет в нашей базе:
   * список продвижения отдаёт только сеть, адрес, значок и описание,
   * а символ живёт в ответе о парах. Без них интерфейс показывал
   * `???` — три знака, по которым нельзя отличить один такой токен
   * от другого.
   */
  baseSymbol: string | null;
  baseName: string | null;
  baseAddress: string | null;
}

interface RawPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
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
    baseSymbol: raw.baseToken?.symbol?.trim() || null,
    baseName: raw.baseToken?.name?.trim() || null,
    baseAddress: raw.baseToken?.address ?? null,
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
      const base = raw.baseToken?.address;
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

// ────────────────────── Продвигаемые токены DexScreener ─────────────────────

/**
 * Список продвигаемых токенов.
 *
 * Важно понимать, что это за список, потому что название вводит
 * в заблуждение. «Boosted» у DexScreener означает не «выбранный
 * редакцией» и не «показавший рост», а «за размещение заплатили».
 * Это рекламный блок с прозрачным ценником: любой может купить себе
 * место, и мошенник покупает его в первый же день, потому что
 * окупается быстрее всего.
 *
 * Поэтому список берётся как источник кандидатов, а не как готовая
 * витрина. Что с ними делать дальше, решает наша проверка риска,
 * и оплаченное продвижение в ней не участвует ни в плюс, ни в минус.
 *
 * Интерфейс обязан называть вещи своими именами: не «рекомендуемые»,
 * а «продвигаемые».
 */
export interface BoostedToken {
  chain: Chain;
  address: string;
  /** Сколько раз проплачено продвижение. Факт о бюджете, не о токене. */
  boostAmount: number | null;
  description: string | null;
  iconUrl: string | null;
}

const BOOST_API = 'https://api.dexscreener.com/token-boosts';

/** Обратное соответствие сетей: из строки DexScreener в нашу. */
const CHAIN_BY_NETWORK: Record<string, Chain> = {
  solana: 'SOLANA' as Chain,
  bsc: 'BNB' as Chain,
  base: 'BASE' as Chain,
  ethereum: 'ETHEREUM' as Chain,
};

/**
 * Продвигаемые сейчас токены.
 *
 * Лимит у этого раздела ниже, чем у остального DexScreener —
 * порядка шестидесяти запросов в минуту, — поэтому ответ кешируется
 * и обновляется не чаще раза в минуту. Состав такого списка меняется
 * медленно: покупают продвижение на часы и дни, а не на секунды.
 */
export async function fetchBoostedTokens(): Promise<BoostedToken[]> {
  const hit = await cached(
    'dexscreener:boosts',
    async () => {
      const res = await fetch(`${BOOST_API}/top/v1`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        logger.debug({ status: res.status }, 'DexScreener: список продвижения недоступен');
        return [];
      }
      return (await res.json()) as unknown;
    },
    { ttlMs: 60_000, staleMs: 10 * 60_000 },
  ).catch(() => null);

  const raw = hit?.value;
  if (!Array.isArray(raw)) return [];

  const out: BoostedToken[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;

    const chain = typeof r.chainId === 'string' ? CHAIN_BY_NETWORK[r.chainId] : undefined;
    const address = typeof r.tokenAddress === 'string' ? r.tokenAddress.trim() : '';
    if (!chain || !address) continue;

    // Один токен встречается в списке несколько раз: продвижение
    // покупают порциями, и каждая покупка отдельная запись.
    const key = `${chain}:${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      chain,
      address,
      boostAmount: typeof r.totalAmount === 'number' ? r.totalAmount : null,
      description: typeof r.description === 'string' ? r.description.slice(0, 300) : null,
      iconUrl: typeof r.icon === 'string' ? r.icon : null,
    });
  }

  return out;
}
