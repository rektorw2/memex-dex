import type { Chain } from '@prisma/client';
import { env } from '../lib/env.js';
import type { ChainAdapter, QuoteRequest, QuoteResponse, ExecuteRequest, ExecuteResult } from './types.js';

interface EvmChainConfig {
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  /** Поддерживается ли 0x на этой сети. Если нет — нужен свой роутер/Odos. */
  zeroExSupported: boolean;
}

/**
 * Единый адаптер для всех EVM-сетей: BNB Chain, Robinhood Chain, Ethereum, Base.
 *
 * Robinhood Chain — это Arbitrum Orbit L2 (mainnet с 1 июля 2026), то есть
 * обычный EVM. Отдельный адаптер не нужен: меняется только chainId, RPC и
 * набор доступных агрегаторов. Если 0x там ещё не поднят — ставим
 * zeroExSupported: false и подключаем прямой роутер DEX этой сети.
 */
export class EvmAdapter implements ChainAdapter {
  readonly chain: Chain;
  readonly nativeSymbol: string;
  private cfg: EvmChainConfig;

  constructor(cfg: EvmChainConfig) {
    this.cfg = cfg;
    this.chain = cfg.chain;
    this.nativeSymbol = cfg.nativeSymbol;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    if (!this.cfg.zeroExSupported) {
      throw new Error(
        `Агрегатор для сети ${this.chain} не подключён. ` +
          `Реализуйте прямой вызов роутера DEX или дождитесь поддержки 0x/Odos.`,
      );
    }

    const url = new URL(`${env.ZEROX_API_URL}/swap/permit2/quote`);
    url.searchParams.set('chainId', String(this.cfg.chainId));
    url.searchParams.set('sellToken', req.tokenIn);
    url.searchParams.set('buyToken', req.tokenOut);
    url.searchParams.set('sellAmount', req.amountIn.toString());
    url.searchParams.set('slippageBps', String(req.slippageBps));
    if (req.userAddress) url.searchParams.set('taker', req.userAddress);

    const res = await fetch(url, {
      headers: {
        '0x-api-key': env.ZEROX_API_KEY ?? '',
        '0x-version': 'v2',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`0x quote failed: ${res.status} ${await res.text().catch(() => '')}`);
    const data: any = await res.json();

    const amountOut = BigInt(data.buyAmount);
    const minAmountOut = BigInt(data.minBuyAmount ?? data.buyAmount);
    const priceImpactBps = data.totalNetworkFee
      ? Math.round(Number(data.estimatedPriceImpact ?? 0) * 100)
      : 0;

    return {
      amountIn: req.amountIn,
      amountOut,
      minAmountOut,
      priceImpactBps,
      aggregator: '0x',
      route: data.route,
      estimatedNetworkFeeUsd: Number(data.totalNetworkFeeUsd ?? 0.3),
      raw: data,
    };
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (env.EXECUTION_MODE === 'paper') {
      return {
        txSignature: `paper-${this.chain.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        amountIn: req.quote.amountIn,
        amountOut: req.quote.minAmountOut,
        networkFeeUsd: req.quote.estimatedNetworkFeeUsd,
        status: 'CONFIRMED',
      };
    }

    // TODO(prod): полный путь — approve/Permit2 → сборка tx из quote.transaction
    //   → подпись через withPrivateKey → eth_sendRawTransaction → ожидание receipt.
    //   Отдельно: nonce-менеджер на общий кошелёк, иначе параллельные сделки
    //   будут вытеснять друг друга.
    throw new Error('EvmAdapter.execute: live-режим требует подключения viem и nonce-менеджера');
  }

  async getPriceUsd(tokenAddress: string): Promise<number | null> {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return null;
      const json: any = await res.json();
      const pair = json?.pairs?.[0];
      return pair?.priceUsd ? Number(pair.priceUsd) : null;
    } catch {
      return null;
    }
  }

  async getBalance(address: string, tokenAddress: string): Promise<bigint> {
    const isNative = tokenAddress === '0x0000000000000000000000000000000000000000';
    const body = isNative
      ? { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }
      : {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [
            {
              to: tokenAddress,
              // balanceOf(address)
              data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`,
            },
            'latest',
          ],
        };

    const res = await fetch(this.cfg.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const json: any = await res.json();
    if (json.error) throw new Error(json.error.message);
    return BigInt(json.result ?? '0x0');
  }

  isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
}
