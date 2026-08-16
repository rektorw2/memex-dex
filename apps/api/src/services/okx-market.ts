/**
 * Рыночные данные OKX Onchain OS.
 *
 * Основной источник списка токенов. От прежнего клиента (okx.ts,
 * агрегатор v5) отличается назначением: тот отвечал на вопрос «можно ли
 * обменять», этот — «что вообще торгуется и на что это похоже».
 *
 * Два правила, которые здесь соблюдаются жёстко.
 *
 * Первое: ключи не покидают сервер. Подпись считается здесь, наружу
 * уходит только нормализованный токен без единого поля, по которому
 * можно было бы восстановить учётные данные. Клиент про OKX не знает
 * ничего, кроме подписи «Рыночные данные: OKX Onchain OS».
 *
 * Второе: ответ поставщика не течёт в приложение. Всё, что возвращают
 * функции этого модуля, — NormalizedToken и подобные структуры в наших
 * терминах. Если OKX переименует поле, чинить придётся здесь.
 *
 * Про надёжность разбора. Ответы v6 не проверялись живьём — доступа
 * к сети при написании не было. Поэтому разбор устроен так, чтобы
 * незнакомая форма ответа давала пустой список, а не исключение,
 * и чтобы отсутствие поля давало null, а не ноль. Молчаливое
 * превращение неизвестной ликвидности в нулевую было бы хуже отказа:
 * ноль блокирует токен, и блокировка выглядела бы обоснованной.
 */

import { createHmac } from 'node:crypto';
import {
  OKX_CHAIN_INDEX,
  chainFromIndex,
  parseHotToken,
  parseRwaEntry,
  okxNum,
  okxInt,
  okxStr,
  okxTime,
  normalizePct,
  normalizeChange,
  dedupeByAddress,
  RwaRegistry,
  EMPTY_RWA_REGISTRY,
  type NormalizedToken,
  type ChainKey,
} from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { cached, withRetry, Concurrency, RateLimit } from '../lib/cache.js';

const BASE = 'https://web3.okx.com';

/** Подпись «источник данных» для интерфейса. */
export const MARKET_DATA_SOURCE = 'OKX Onchain OS';

// ────────────────────────────── Сроки хранения ──────────────────────────────

/**
 * Сроки подобраны по скорости изменения самих величин, а не по
 * удобству. Цена мем-коина меняется ежесекундно, состав списка
 * подтверждённых RWA — раз в недели.
 */
const TTL = {
  hotTokens: 20_000,
  priceInfo: 20_000,
  basicInfo: 3 * 3_600_000,
  advancedInfo: 15 * 60_000,
  rwaList: 3 * 3_600_000,
  search: 30_000,
  topLiquidity: 5 * 60_000,
} as const;

// ─────────────────────────── Ограничения обращений ──────────────────────────

/**
 * Двадцать запросов в секунду и не больше шести одновременно.
 *
 * Точный лимит OKX зависит от тарифа и здесь неизвестен, поэтому взято
 * заведомо консервативное значение. Ошибиться в эту сторону дёшево:
 * список обновится на секунду позже. Ошибиться в другую — получить
 * временную блокировку ключа и пустой терминал.
 */
const limiter = new RateLimit(20, 1_000);
const pool = new Concurrency(6);

export function isOkxConfigured(): boolean {
  return Boolean(env.OKX_API_KEY && env.OKX_API_SECRET && env.OKX_PASSPHRASE);
}

export function isOkxSupported(chain: ChainKey): boolean {
  return OKX_CHAIN_INDEX[chain] !== null;
}

// ──────────────────────────────── Транспорт ─────────────────────────────────

function sign(timestamp: string, method: string, path: string, body = ''): string {
  return createHmac('sha256', env.OKX_API_SECRET ?? '')
    .update(timestamp + method.toUpperCase() + path + body)
    .digest('base64');
}

interface OkxError extends Error {
  permanent?: boolean;
}

/**
 * Один запрос к OKX.
 *
 * Ошибки делятся на временные и постоянные. Постоянные — неверная
 * подпись, отсутствие прав, кривой запрос — помечаются и не повторяются:
 * второй такой же запрос не станет успешным, а лимит израсходует.
 */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
  if (!isOkxConfigured()) return null;

  await limiter.take();

  const payload = body == null ? '' : JSON.stringify(body);
  const timestamp = new Date().toISOString();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'OK-ACCESS-KEY': env.OKX_API_KEY!,
      'OK-ACCESS-SIGN': sign(timestamp, method, path, payload),
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': env.OKX_PASSPHRASE!,
      ...(env.OKX_PROJECT_ID ? { 'OK-ACCESS-PROJECT': env.OKX_PROJECT_ID } : {}),
      'content-type': 'application/json',
    },
    ...(payload ? { body: payload } : {}),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const err: OkxError = new Error(`OKX ${res.status}`);
    // 4xx кроме 429 повторять бессмысленно.
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    // В журнал идёт путь и код, но не заголовки: там ключ.
    logger.debug({ path, status: res.status }, 'OKX: запрос отклонён');
    throw err;
  }

  const json: any = await res.json().catch(() => null);
  if (!json) return null;

  // OKX сообщает об ошибке кодом внутри тела: HTTP 200 не означает успех.
  if (json.code != null && String(json.code) !== '0') {
    logger.warn({ path, code: json.code, msg: json.msg }, 'OKX вернул ошибку');
    return null;
  }

  return json.data as T;
}

/**
 * Запрос с повторами. Возвращает null вместо исключения.
 *
 * Экспортируется, чтобы security-провайдер мог ходить теми же
 * подписью, лимитом и очередью. Заводить второй транспорт значило бы
 * завести и второй лимит, и вместе они превысили бы настоящий.
 */
export async function safeCall<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T | null> {
  try {
    return await pool.run(() =>
      withRetry(() => call<T>(method, path, body), { label: path, attempts: 3 }),
    );
  } catch (e: any) {
    logger.debug({ path, err: e?.message }, 'OKX недоступен');
    return null;
  }
}

/** Массив из ответа, каким бы он ни пришёл. */
function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    // Встречается обёртка вида { list: [...] } или { tokens: [...] }.
    for (const key of ['list', 'tokens', 'data', 'records', 'items']) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

// ─────────────────────────────── Hot Tokens ─────────────────────────────────

export interface HotTokenOptions {
  /** Способ ранжирования. По умолчанию 4 — как в задании. */
  rankingType?: number;
  rankingTimeFrame?: number;
  liquidityMin?: number;
  limit?: number;
  /** Сортировка на стороне OKX: 5 — по объёму. */
  rankBy?: number;
}

/**
 * Токены одной сети.
 *
 * Про фильтры isMint, isFreeze и isLpBurnt: они здесь не передаются.
 * Их семантика по документации неоднозначна — неясно, означает
 * isMint=true «эмиссия отозвана» или «эмиссия активна». Ошибка
 * в трактовке даёт ровно обратный результат: вместо безопасных
 * токенов в витрину попадут те, у кого эмиссия открыта, и выглядеть
 * это будет как исправная фильтрация. Пока значение не подтверждено
 * ответом живого API, эти свойства проверяются нашими средствами
 * через GoPlus и advanced-info, где смысл полей однозначен.
 */
export async function fetchHotTokens(
  chain: ChainKey,
  opts: HotTokenOptions = {},
): Promise<NormalizedToken[]> {
  const chainIndex = OKX_CHAIN_INDEX[chain];
  if (!chainIndex || !isOkxConfigured()) return [];

  const params = new URLSearchParams({
    chainIndex,
    rankingType: String(opts.rankingType ?? 4),
    rankingTimeFrame: String(opts.rankingTimeFrame ?? 4),
    // Фильтр риска на стороне OKX — первый уровень отсева, но не
    // единственный: свою проверку он не заменяет.
    riskFilter: 'true',
    stableTokenFilter: 'true',
    liquidityMin: String(opts.liquidityMin ?? env.MIN_LIQUIDITY_USD ?? 25_000),
    limit: String(opts.limit ?? 100),
    ...(opts.rankBy != null ? { rankBy: String(opts.rankBy) } : {}),
  });

  const path = `/api/v6/dex/market/token/hot-token?${params.toString()}`;

  const hit = await cached(
    `okx:hot:${chain}:${params.toString()}`,
    async () => {
      const data = await safeCall<unknown>('GET', path);
      const rows = asArray(data);

      const tokens = rows
        .map((r) => parseHotToken(withChain(r, chainIndex)))
        .filter((t): t is NormalizedToken => t !== null);

      // Дедупликация по адресу: один токен может прийти из нескольких
      // пулов, и в списке он должен быть один.
      return dedupeByAddress(tokens);
    },
    { ttlMs: TTL.hotTokens, staleMs: 5 * 60_000 },
  ).catch(() => null);

  return hit?.value ?? [];
}

/**
 * Подстановка chainIndex в запись.
 *
 * Ответ на запрос по одной сети может не содержать chainIndex в каждой
 * записи — он и так известен из запроса. Разбор без него вернул бы null
 * для всего списка.
 */
function withChain(raw: unknown, chainIndex: string): unknown {
  if (raw == null || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  return r.chainIndex == null ? { ...r, chainIndex } : r;
}

/** Токены всех поддерживаемых сетей. Сети опрашиваются параллельно. */
export async function fetchHotTokensAllChains(
  chains: ChainKey[],
  opts: HotTokenOptions = {},
): Promise<NormalizedToken[]> {
  const supported = chains.filter(isOkxSupported);
  const lists = await Promise.all(supported.map((c) => fetchHotTokens(c, opts)));
  return dedupeByAddress(lists.flat());
}

// ──────────────────────────────── Поиск ─────────────────────────────────────

/**
 * Поиск по тикеру, названию или адресу.
 *
 * Точный адрес обрабатывается отдельно от текста: по адресу ответ
 * должен быть однозначным, и выдавать вместе с ним «похожие» токены
 * значит воспроизводить ровно ту путаницу, от которой поиск по адресу
 * и спасает.
 */
export async function searchTokens(query: string, chain?: ChainKey): Promise<NormalizedToken[]> {
  const q = query.trim();
  if (!q || !isOkxConfigured()) return [];

  const params = new URLSearchParams({ keyword: q });
  const chainIndex = chain ? OKX_CHAIN_INDEX[chain] : null;
  if (chainIndex) params.set('chainIndex', chainIndex);

  const path = `/api/v6/dex/market/token/search?${params.toString()}`;

  const hit = await cached(
    `okx:search:${chain ?? 'all'}:${q.toLowerCase()}`,
    async () => {
      const data = await safeCall<unknown>('GET', path);
      const rows = asArray(data);
      const tokens = rows
        .map((r) => parseHotToken(r))
        .filter((t): t is NormalizedToken => t !== null);
      return dedupeByAddress(tokens);
    },
    { ttlMs: TTL.search, staleMs: 2 * 60_000 },
  ).catch(() => null);

  return hit?.value ?? [];
}

// ───────────────────────────── Основные сведения ────────────────────────────

export interface TokenBasicInfo {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number | null;
  logoUrl: string | null;
  communityRecognized: boolean | null;
}

/**
 * Пакетный запрос основных сведений.
 *
 * OKX принимает до ста токенов за раз, и это единственная причина
 * разбивать список: сто первых обойдутся одним запросом вместо ста.
 */
export async function fetchBasicInfo(
  tokens: Array<{ chain: ChainKey; address: string }>,
): Promise<Map<string, TokenBasicInfo>> {
  const out = new Map<string, TokenBasicInfo>();
  if (!isOkxConfigured() || tokens.length === 0) return out;

  const supported = tokens.filter((t) => isOkxSupported(t.chain));

  for (let i = 0; i < supported.length; i += 100) {
    const batch = supported.slice(i, i + 100);
    const body = {
      tokens: batch.map((t) => ({
        chainIndex: OKX_CHAIN_INDEX[t.chain],
        tokenContractAddress: t.address,
      })),
    };

    const key = `okx:basic:${batch.map((t) => `${t.chain}:${t.address}`).join(',')}`;

    const hit = await cached(
      key,
      async () => {
        const data = await safeCall<unknown>('POST', '/api/v6/dex/market/token/basic-info', body);
        return asArray(data);
      },
      { ttlMs: TTL.basicInfo, staleMs: 12 * 3_600_000 },
    ).catch(() => null);

    for (const raw of hit?.value ?? []) {
      const info = parseBasicInfo(raw);
      if (info) out.set(`${info.chain}:${info.address}`, info);
    }
  }

  return out;
}

function parseBasicInfo(raw: unknown): TokenBasicInfo | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const chain = chainFromIndex(r.chainIndex as string);
  const address = okxStr(r.tokenContractAddress, 128);
  if (!chain || !address) return null;

  const symbol = okxStr(r.tokenSymbol, 32) ?? '???';

  return {
    chain,
    address,
    symbol,
    name: okxStr(r.tokenName, 120) ?? symbol,
    decimals: okxInt(r.decimals),
    logoUrl: okxStr(r.tokenLogoUrl, 500),
    communityRecognized:
      typeof r.communityRecognized === 'boolean' ? r.communityRecognized : null,
  };
}

// ─────────────────────────── Торговая информация ────────────────────────────

export interface PriceInfo {
  chain: ChainKey;
  address: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  change: { m5: number | null; h1: number | null; h4: number | null; h24: number | null };
  volume: { m5: number | null; h1: number | null; h4: number | null; h24: number | null };
  txs24h: number | null;
}

/** Подробности для страницы токена. Пакетный запрос до ста адресов. */
export async function fetchPriceInfo(
  tokens: Array<{ chain: ChainKey; address: string }>,
): Promise<Map<string, PriceInfo>> {
  const out = new Map<string, PriceInfo>();
  if (!isOkxConfigured() || tokens.length === 0) return out;

  const supported = tokens.filter((t) => isOkxSupported(t.chain));

  for (let i = 0; i < supported.length; i += 100) {
    const batch = supported.slice(i, i + 100);
    const body = {
      tokens: batch.map((t) => ({
        chainIndex: OKX_CHAIN_INDEX[t.chain],
        tokenContractAddress: t.address,
      })),
    };

    const key = `okx:price:${batch.map((t) => `${t.chain}:${t.address}`).join(',')}`;

    const hit = await cached(
      key,
      async () => {
        const data = await safeCall<unknown>('POST', '/api/v6/dex/market/price-info', body);
        return asArray(data);
      },
      { ttlMs: TTL.priceInfo, staleMs: 5 * 60_000 },
    ).catch(() => null);

    for (const raw of hit?.value ?? []) {
      const info = parsePriceInfo(raw);
      if (info) out.set(`${info.chain}:${info.address}`, info);
    }
  }

  return out;
}

function parsePriceInfo(raw: unknown): PriceInfo | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const chain = chainFromIndex(r.chainIndex as string);
  const address = okxStr(r.tokenContractAddress, 128);
  if (!chain || !address) return null;

  return {
    chain,
    address,
    priceUsd: okxNum(r.price),
    marketCapUsd: okxNum(r.marketCap),
    liquidityUsd: okxNum(r.liquidity),
    holders: okxInt(r.holders),
    totalSupply: okxNum(r.totalSupply ?? r.supply),
    change: {
      m5: normalizeChange(okxNum(r.change5M ?? r.priceChange5M)),
      h1: normalizeChange(okxNum(r.change1H ?? r.priceChange1H)),
      h4: normalizeChange(okxNum(r.change4H ?? r.priceChange4H)),
      h24: normalizeChange(okxNum(r.change24H ?? r.priceChange24H ?? r.change)),
    },
    volume: {
      m5: okxNum(r.volume5M),
      h1: okxNum(r.volume1H),
      h4: okxNum(r.volume4H),
      h24: okxNum(r.volume24H ?? r.volume),
    },
    txs24h: okxInt(r.txs24H ?? r.txs),
  };
}

// ─────────────────────────── Пулы ликвидности ───────────────────────────────

export interface LiquidityPool {
  poolAddress: string | null;
  protocol: string | null;
  liquidityUsd: number | null;
  feePct: number | null;
}

export async function fetchTopLiquidity(
  chain: ChainKey,
  address: string,
): Promise<LiquidityPool[]> {
  const chainIndex = OKX_CHAIN_INDEX[chain];
  if (!chainIndex || !isOkxConfigured()) return [];

  const path =
    `/api/v6/dex/market/token/top-liquidity?chainIndex=${chainIndex}` +
    `&tokenContractAddress=${encodeURIComponent(address)}`;

  const hit = await cached(
    `okx:pools:${chain}:${address}`,
    async () => {
      const data = await safeCall<unknown>('GET', path);
      return asArray(data)
        .map((raw): LiquidityPool | null => {
          if (raw == null || typeof raw !== 'object') return null;
          const r = raw as Record<string, unknown>;
          return {
            poolAddress: okxStr(r.poolAddress ?? r.pairAddress, 128),
            protocol: okxStr(r.protocol ?? r.dexName ?? r.protocolName, 60),
            liquidityUsd: okxNum(r.liquidity ?? r.liquidityUsd),
            feePct: normalizePct(okxNum(r.lpFee ?? r.feeRate)),
          };
        })
        .filter((p): p is LiquidityPool => p !== null);
    },
    { ttlMs: TTL.topLiquidity, staleMs: 30 * 60_000 },
  ).catch(() => null);

  return hit?.value ?? [];
}

// ────────────────────────── Реестр подтверждённых RWA ───────────────────────

/**
 * Список токенизированных акций от OKX.
 *
 * Единственный способ отличить настоящий токенизированный NVDA
 * от подделки. Кешируется надолго: состав такого списка меняется
 * не чаще нескольких раз в месяц, а обращаться к нему приходится
 * при каждой проверке токена.
 *
 * При недоступности источника возвращается пустой реестр, и это
 * сознательно отличается от «в реестре нет такого адреса». Пустой
 * реестр переводит подозрительные токены в «не определено», а не
 * блокирует их: заблокировать настоящий Ondo из-за того, что список
 * не загрузился, было бы хуже, чем на время пропустить подделку
 * в раздел с предупреждением.
 */
export async function fetchRwaRegistry(): Promise<RwaRegistry> {
  if (!isOkxConfigured()) return EMPTY_RWA_REGISTRY;

  const hit = await cached(
    'okx:rwa:all',
    async () => {
      const data = await safeCall<unknown>('GET', '/api/v6/dex/market/rwa/tokens');
      const entries = asArray(data)
        .map((r) => parseRwaEntry(r, (i) => chainFromIndex(i as string)))
        .filter((e): e is NonNullable<typeof e> => e !== null);

      if (entries.length === 0) {
        logger.warn('OKX: список подтверждённых RWA пуст — подделки под акции проверить нечем');
      } else {
        logger.info({ count: entries.length }, 'список подтверждённых RWA обновлён');
      }

      return entries;
    },
    { ttlMs: TTL.rwaList, staleMs: 24 * 3_600_000 },
  ).catch(() => null);

  if (!hit || hit.value.length === 0) return EMPTY_RWA_REGISTRY;
  return new RwaRegistry(hit.value, new Date(Date.now() - hit.ageMs));
}
