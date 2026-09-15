import { Prisma, type PrismaClient } from '@prisma/client';
import type { CanonicalTrade, ChainKey } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { Concurrency } from '../lib/cache.js';

/** Bound the Prisma/Rust/JSON/Decimal intermediates, not the economic history. */
export const WALLET_HISTORY_PAGE_SIZE = 1_000;
// Compact output also grows with history: paging alone is not an absolute bound.
// Exceeding either budget fails the entire read, never returns a truncated PnL.
export const WALLET_HISTORY_MAX_ROWS = 250_000;
export const WALLET_HISTORY_MAX_ESTIMATED_BYTES = 256 * 1024 * 1024;
const reads = new Concurrency(1);

export class WalletHistoryCapacityError extends Error {
  readonly code = 'WALLET_HISTORY_CAPACITY_EXCEEDED';
  constructor() { super('Wallet history exceeds the safe in-process calculation budget'); }
}

export function assertWalletHistoryBudget(rows: number, estimatedBytes: number): void {
  if (rows > WALLET_HISTORY_MAX_ROWS || estimatedBytes > WALLET_HISTORY_MAX_ESTIMATED_BYTES) {
    throw new WalletHistoryCapacityError();
  }
}

function estimatedBytes(trade: CanonicalTrade): number {
  // Conservative accounting, not a claim to measure V8's exact object layout.
  return 512 + Object.values(trade).reduce<number>((n, value) =>
    n + (typeof value === 'string' ? value.length * 2 : 16), 0);
}

const select = {
  key: true, chain: true, walletAddress: true, tokenAddress: true, tokenSymbol: true,
  side: true, amount: true, valueUsd: true, price: true, marketCapUsd: true,
  providerPnlUsd: true, tradedAt: true, reconciliation: true,
} satisfies Prisma.WalletEconomicTradeSelect;

type Row = Prisma.WalletEconomicTradeGetPayload<{ select: typeof select }>;

function toCanonical(row: Row): CanonicalTrade {
  return {
    key: row.key, chain: row.chain as ChainKey, wallet: row.walletAddress,
    tokenAddress: row.tokenAddress, tokenSymbol: row.tokenSymbol,
    side: row.side as 'BUY' | 'SELL', amount: row.amount.toString(),
    valueUsd: row.valueUsd.toString(), price: row.price.toString(),
    marketCapUsd: row.marketCapUsd?.toString() ?? null,
    providerPnlUsd: row.providerPnlUsd?.toString() ?? null,
    tradedAt: row.tradedAt.getTime(),
    ...(row.reconciliation === 'ambiguous' ? { ambiguous: true } : {}),
  };
}

/**
 * A single MVCC snapshot, read in bounded pages. Loading 160k full Prisma rows
 * at once used >2 GB of RSS before the ledger even started calculating.
 * Keep only compact canonical records between queries; never truncate history.
 * RepeatableRead preserves the old one-query snapshot semantics when a late
 * fill is inserted or a reconciliation changes while pages are being read.
 */
export async function loadWalletHistory(
  where: Prisma.WalletEconomicTradeWhereInput,
  database: Pick<PrismaClient, '$transaction'> = prisma,
): Promise<CanonicalTrade[]> {
  return reads.run(() => database.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const trades: CanonicalTrade[] = [];
    let after: { tradedAt: Date; key: string } | null = null;
    let previousKey: string | undefined;
    let bytes = 0;
    for (;;) {
      const page: Row[] = await tx.walletEconomicTrade.findMany({
        where: after ? { AND: [where, { OR: [
          { tradedAt: { gt: after.tradedAt } },
          { tradedAt: after.tradedAt, key: { gt: after.key } },
        ] }] } : where,
        orderBy: [{ tradedAt: 'asc' }, { key: 'asc' }],
        take: WALLET_HISTORY_PAGE_SIZE,
        select,
      });
      for (const row of page) {
        const trade = toCanonical(row);
        bytes += estimatedBytes(trade);
        assertWalletHistoryBudget(trades.length + 1, bytes);
        trades.push(trade);
      }
      if (page.length < WALLET_HISTORY_PAGE_SIZE) return trades;
      const last = page[page.length - 1]!;
      if (previousKey === last.key) throw new Error('WALLET_HISTORY_CURSOR_STALLED');
      previousKey = last.key;
      after = { tradedAt: last.tradedAt, key: last.key };
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 }));
}
