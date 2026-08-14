import { createHmac } from 'node:crypto';
import type { Chain } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Клиент официального Web3 API OKX.
 *
 * Почему официальный API, а не разбор запросов страницы Signal/Radar:
 * внутренние эндпоинты интерфейса не документированы, меняются без
 * предупреждения и их использование прямо запрещено пользовательским
 * соглашением. Радар, который ломается при каждом обновлении чужого
 * фронтенда, — это не функция, а источник ложной тишины: уведомления
 * просто перестанут приходить, и заметить это будет нечем.
 *
 * Каждый запрос подписывается HMAC-SHA256 по схеме OKX:
 * подпись считается от строки timestamp + METHOD + path + body.
 */

const BASE = 'https://web3.okx.com';

/** Идентификаторы сетей в OKX. Robinhood Chain пока не поддерживается. */
const OKX_CHAIN: Record<Chain, string | null> = {
  ETHEREUM: '1',
  BNB: '56',
  BASE: '8453',
  SOLANA: '501',
  ROBINHOOD: null,
};

export function isOkxConfigured(): boolean {
  return Boolean(env.OKX_API_KEY && env.OKX_API_SECRET && env.OKX_PASSPHRASE);
}

export function isOkxSupported(chain: Chain): boolean {
  return OKX_CHAIN[chain] !== null;
}

function sign(timestamp: string, method: string, path: string, body = ''): string {
  return createHmac('sha256', env.OKX_API_SECRET ?? '')
    .update(timestamp + method.toUpperCase() + path + body)
    .digest('base64');
}

async function request<T>(path: string): Promise<T | null> {
  if (!isOkxConfigured()) return null;

  const timestamp = new Date().toISOString();

  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        'OK-ACCESS-KEY': env.OKX_API_KEY!,
        'OK-ACCESS-SIGN': sign(timestamp, 'GET', path),
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': env.OKX_PASSPHRASE!,
        ...(env.OKX_PROJECT_ID ? { 'OK-ACCESS-PROJECT': env.OKX_PROJECT_ID } : {}),
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      logger.debug({ path, status: res.status }, 'OKX: запрос отклонён');
      return null;
    }

    const json: any = await res.json();
    // OKX отвечает кодом внутри тела: HTTP 200 не означает успех.
    if (json.code && json.code !== '0') {
      logger.warn({ path, code: json.code, msg: json.msg }, 'OKX вернул ошибку');
      return null;
    }
    return json.data as T;
  } catch (e: any) {
    logger.debug({ path, err: e?.message }, 'OKX недоступен');
    return null;
  }
}

export interface OkxToken {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  logoUrl: string | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Список токенов сети из агрегатора OKX.
 *
 * Это не «новые токены» — это перечень того, что OKX считает торгуемым.
 * Новизна определяется на нашей стороне: адрес, которого мы раньше
 * не видели, и есть новый токен. Такой подход честнее, чем доверять
 * чужому определению «нового», и не зависит от того, какие поля
 * поставщик решит отдавать завтра.
 */
export async function fetchOkxTokens(chain: Chain): Promise<OkxToken[]> {
  const chainId = OKX_CHAIN[chain];
  if (!chainId) return [];

  const data = await request<any[]>(
    `/api/v5/dex/aggregator/all-tokens?chainIndex=${chainId}`,
  );
  if (!Array.isArray(data)) return [];

  return data
    .filter((t) => t?.tokenContractAddress)
    .map((t) => ({
      chain,
      address: String(t.tokenContractAddress),
      symbol: String(t.tokenSymbol ?? '???').slice(0, 20),
      name: String(t.tokenName ?? t.tokenSymbol ?? 'Unknown').slice(0, 80),
      decimals: Number(t.decimals) || (chain === 'SOLANA' ? 9 : 18),
      priceUsd: num(t.tokenUnitPrice),
      liquidityUsd: null,
      volume24hUsd: null,
      fdvUsd: null,
      logoUrl: typeof t.tokenLogoUrl === 'string' ? t.tokenLogoUrl : null,
    }));
}

/** Подробности по конкретному токену: цена, объём, ликвидность. */
export async function fetchOkxTokenDetail(
  chain: Chain,
  address: string,
): Promise<Partial<OkxToken> | null> {
  const chainId = OKX_CHAIN[chain];
  if (!chainId) return null;

  const data = await request<any[]>(
    `/api/v5/dex/market/price-info?chainIndex=${chainId}&tokenContractAddress=${address}`,
  );
  const d = Array.isArray(data) ? data[0] : null;
  if (!d) return null;

  return {
    priceUsd: num(d.price),
    volume24hUsd: num(d.volume24H),
    fdvUsd: num(d.marketCap),
  };
}
