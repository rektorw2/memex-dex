import type { Chain } from '@prisma/client';
import { env } from '../lib/env.js';
import type { ChainAdapter, QuoteRequest, QuoteResponse, ExecuteRequest, ExecuteResult } from './types.js';

/**
 * Solana через агрегатор Jupiter.
 *
 * Почему Jupiter, а не прямой вызов Raydium/Orca: маршрут через десятки пулов
 * даёт заметно лучшую цену на мем-коинах, а split-route снижает price impact.
 * Свой роутер здесь — это месяцы работы ради худшего исполнения.
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chain: Chain = 'SOLANA';
  readonly nativeSymbol = 'SOL';

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const url = new URL(`${env.JUPITER_API_URL}/quote`);
    url.searchParams.set('inputMint', req.tokenIn);
    url.searchParams.set('outputMint', req.tokenOut);
    url.searchParams.set('amount', req.amountIn.toString());
    url.searchParams.set('slippageBps', String(req.slippageBps));
    url.searchParams.set('onlyDirectRoutes', 'false');
    // Мем-коины часто торгуются только в AMM — не отсекаем маршруты.
    url.searchParams.set('asLegacyTransaction', 'false');

    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      throw new Error(`Jupiter quote failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const data: any = await res.json();

    const amountOut = BigInt(data.outAmount);
    const minAmountOut = BigInt(data.otherAmountThreshold ?? data.outAmount);
    const priceImpactBps = Math.round(Number(data.priceImpactPct ?? 0) * 10_000);

    return {
      amountIn: req.amountIn,
      amountOut,
      minAmountOut,
      priceImpactBps,
      aggregator: 'jupiter',
      route: data.routePlan,
      estimatedNetworkFeeUsd: 0.002, // приоритетная комиссия учитывается при сборке tx
      raw: data,
    };
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (env.EXECUTION_MODE === 'paper') return this.paperFill(req);
    // The former branch called sendTransaction and immediately returned
    // CONFIRMED from the RPC signature. A signature is not confirmation and
    // the quote is not the actual fill. Phase 4 uses the explicit persisted
    // orchestrator; until a production transport is implemented, this legacy
    // entry point is a hard stop.
    throw new Error('LIVE_SOLANA_EXECUTION_NOT_IMPLEMENTED');
  }

  /** Paper-режим: считаем исполнение по котировке без отправки в сеть. */
  private paperFill(req: ExecuteRequest): ExecuteResult {
    return {
      txSignature: `paper-sol-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      amountIn: req.quote.amountIn,
      amountOut: req.quote.minAmountOut, // консервативно: худший разрешённый исход
      networkFeeUsd: req.quote.estimatedNetworkFeeUsd,
      status: 'CONFIRMED',
    };
  }

  async getPriceUsd(tokenAddress: string): Promise<number | null> {
    try {
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${tokenAddress}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const json: any = await res.json();
      const price = json?.data?.[tokenAddress]?.price;
      return price ? Number(price) : null;
    } catch {
      return null;
    }
  }

  async getBalance(address: string, tokenAddress: string): Promise<bigint> {
    const body =
      tokenAddress === 'So11111111111111111111111111111111111111112'
        ? { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }
        : {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [address, { mint: tokenAddress }, { encoding: 'jsonParsed' }],
          };

    const res = await fetch(env.SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const json: any = await res.json();
    if (json.error) throw new Error(json.error.message);

    if (body.method === 'getBalance') return BigInt(json.result.value ?? 0);
    const acc = json.result?.value?.[0];
    const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
    return amount ? BigInt(amount) : 0n;
  }

  isValidAddress(address: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
}
