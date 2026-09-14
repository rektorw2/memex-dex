import { CHAIN_IDS, normalizeAgentNetwork, type ChainKey } from '@memex/core';

export interface PositionOperation {
  id: string; kind: 'OPEN' | 'PARTIAL_EXIT' | 'CLOSE'; at: string | null;
  executionPriceUsd: number | null; targetPriceUsd: number | null;
  quantity: number | null; pnlUsd: number | null; netUsd: number | null;
  sellPct?: number | null; remainingPct?: number | null; reason?: string | null;
  evidence?: string;
}
export interface PositionCandle { time: number; open: number; high: number; low: number; close: number; volumeUsd: number }
export interface PositionEvidence {
  operations?: PositionOperation[];
  chart?: { state: string; candles: PositionCandle[] };
  priceUpdatedAt?: string | null;
  quoteStale?: boolean;
  remainingQuantity?: number | null;
}

/** Next Link owns the Pages basePath. Terminal resolves id or chain+address. */
export function agentChartHref(target: { tokenId?: string | null; chain?: string | null; address?: string | null }): string | null {
  // Historical skipped signals can belong to another terminal-supported chain.
  // A chart link does not grant that network permission to trade.
  const canonical = target.chain?.trim().toUpperCase() ?? '';
  const chain = normalizeAgentNetwork(target.chain) ?? (Object.keys(CHAIN_IDS).includes(canonical) ? canonical as ChainKey : null);
  if (!target.tokenId && !(chain && target.address)) return null;
  if (target.chain && !chain) return null;
  const query = new URLSearchParams();
  if (target.tokenId) query.set('token', target.tokenId);
  if (chain) query.set('chain', chain);
  if (target.address) query.set('address', target.address);
  return `/terminal/?${query}`;
}

export const OPERATION_LABELS = { OPEN: 'Вход', PARTIAL_EXIT: 'Частичная фиксация', CLOSE: 'Выход' } as const;

/** Never promote pending/error decisions into final skipped signals. */
export function splitAgentDecisions<T extends { state: string }>(rows: T[]) {
  return {
    skipped: rows.filter(row => row.state === 'SKIPPED'),
    pending: rows.filter(row => ['RECEIVED', 'ELIGIBLE', 'WAITING_PRICE', 'WAITING_ENTRY'].includes(row.state)),
  };
}
