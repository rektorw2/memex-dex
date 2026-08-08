import type { Chain } from '@prisma/client';

export interface QuoteRequest {
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  /** Сумма в минимальных единицах tokenIn (lamports/wei). */
  amountIn: bigint;
  slippageBps: number;
  userAddress?: string;
}

export interface QuoteResponse {
  amountIn: bigint;
  amountOut: bigint;
  /** Гарантированный минимум с учётом проскальзывания. */
  minAmountOut: bigint;
  priceImpactBps: number;
  aggregator: string;
  route: unknown;
  /** Оценка сетевой комиссии в USD. */
  estimatedNetworkFeeUsd: number;
  /** Сырой ответ агрегатора — нужен для построения транзакции. */
  raw: unknown;
}

export interface ExecuteRequest {
  quote: QuoteResponse;
  /** Адрес кошелька-отправителя. */
  fromAddress: string;
  /** Подписывающая функция: получает сырую транзакцию, возвращает подписанную. */
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
}

export interface ExecuteResult {
  txSignature: string;
  amountIn: bigint;
  amountOut: bigint;
  blockNumber?: bigint;
  networkFeeUsd: number;
  status: 'CONFIRMED' | 'FAILED';
  error?: string;
}

export interface ChainAdapter {
  readonly chain: Chain;
  readonly nativeSymbol: string;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  execute(req: ExecuteRequest): Promise<ExecuteResult>;
  getPriceUsd(tokenAddress: string): Promise<number | null>;
  getBalance(address: string, tokenAddress: string): Promise<bigint>;
  isValidAddress(address: string): boolean;
}
