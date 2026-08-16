/**
 * Симуляция продажи через Honeypot.is.
 *
 * Смысл этой проверки в том, что она не спрашивает мнения. GoPlus
 * читает код контракта и делает вывод; Honeypot.is проводит покупку
 * и продажу в форке сети и смотрит, что получилось. Второе сильнее:
 * ловушку можно спрятать от статического анализа, но нельзя спрятать
 * от факта неудавшейся продажи.
 *
 * Ограничение — только EVM. Для Solana такой симуляции нет, там роль
 * этой проверки играет замер круга через агрегатор и данные RugCheck.
 *
 * Ключ не нужен, ограничения щедрые, но не бесконечные — отсюда кеш
 * и ограничение частоты. Недоступность сервиса не считается хорошей
 * новостью: результат null означает «не проверили», и вызывающая
 * сторона обязана обращаться с ним именно так.
 */

import type { ChainKey } from '@memex/core';
import { logger } from '../lib/logger.js';
import { cached, withRetry, RateLimit } from '../lib/cache.js';

const API = 'https://api.honeypot.is/v2';

/** Идентификаторы сетей. Solana отсутствует у сервиса, не у нас. */
const CHAIN_ID: Record<ChainKey, number | null> = {
  ETHEREUM: 1,
  BNB: 56,
  BASE: 8453,
  SOLANA: null,
  ROBINHOOD: null,
};

const limiter = new RateLimit(10, 1_000);

export function isHoneypotSupported(chain: ChainKey): boolean {
  return CHAIN_ID[chain] !== null;
}

export interface HoneypotResult {
  /** Симуляция признала токен ловушкой. */
  isHoneypot: boolean;
  /** Симуляция продажи не удалась. Отличается от isHoneypot причиной. */
  sellFailed: boolean;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  transferTaxPct: number | null;
  /** Пояснение сервиса, если оно есть. */
  reason: string | null;
  /** Удалось ли вообще провести симуляцию. */
  simulated: boolean;
}

export async function checkHoneypot(
  chain: ChainKey,
  address: string,
): Promise<HoneypotResult | null> {
  const chainId = CHAIN_ID[chain];
  if (!chainId) return null;

  const url = `${API}/IsHoneypot?address=${encodeURIComponent(address)}&chainID=${chainId}`;

  const hit = await cached(
    `honeypot:${chain}:${address}`,
    async () => {
      await limiter.take();

      return withRetry(
        async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) {
            const err: any = new Error(`Honeypot.is ${res.status}`);
            err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
            throw err;
          }
          return parseHoneypot(await res.json());
        },
        { label: 'honeypot.is', attempts: 2 },
      );
    },
    { ttlMs: 20 * 60_000, staleMs: 2 * 3_600_000 },
  ).catch((e) => {
    logger.debug({ chain, address, err: e?.message }, 'Honeypot.is недоступен');
    return null;
  });

  return hit?.value ?? null;
}

export function parseHoneypot(json: any): HoneypotResult {
  const hp = json?.honeypotResult ?? {};
  const sim = json?.simulationResult ?? {};
  const success = json?.simulationSuccess;

  // Различаем два разных исхода. «Сервис сказал: это ловушка» и
  // «симуляция не прошла» — не одно и то же: второе может означать
  // и ловушку, и отсутствие ликвидности на момент проверки.
  const isHoneypot = hp?.isHoneypot === true;
  const sellFailed = success === false && !isHoneypot;

  return {
    isHoneypot,
    sellFailed,
    buyTaxPct: num(sim?.buyTax),
    sellTaxPct: num(sim?.sellTax),
    transferTaxPct: num(sim?.transferTax),
    reason: typeof hp?.honeypotReason === 'string' ? hp.honeypotReason : null,
    simulated: success === true || isHoneypot,
  };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
