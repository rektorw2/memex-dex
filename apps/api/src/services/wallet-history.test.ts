import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const db = vi.hoisted(() => ({ findMany: vi.fn(), executeRaw: vi.fn(), transaction: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ prisma: { $transaction: db.transaction } }));
const { loadWalletHistory, WALLET_HISTORY_PAGE_SIZE: SIZE, assertWalletHistoryBudget,
  WALLET_HISTORY_MAX_ROWS, WALLET_HISTORY_MAX_ESTIMATED_BYTES } = await import('./wallet-history.js');
const at = new Date('2026-09-01');
const where = { chain: 'BNB' as const, walletAddress: 'wallet', reconciliation: { in: ['canonical', 'confirmed'] } };
const row = (i: number) => ({
  key: String(i).padStart(8, '0'), chain: 'BNB', walletAddress: 'wallet',
  tokenAddress: 'token', tokenSymbol: null, side: 'BUY',
  amount: new Prisma.Decimal('1.123456789012345678'), valueUsd: new Prisma.Decimal('2.123456789'),
  price: new Prisma.Decimal('0.12345678901234567890'), marketCapUsd: null,
  providerPnlUsd: null, tradedAt: at, reconciliation: 'canonical',
});

beforeEach(() => {
  vi.clearAllMocks(); db.findMany.mockReset();
  db.transaction.mockImplementation(fn => fn({ $executeRaw: db.executeRaw, walletEconomicTrade: { findMany: db.findMany } }));
});

describe('bounded history reads without truncation', () => {
  it('accepts each exact budget boundary and rejects one row or byte beyond it', () => {
    expect(() => assertWalletHistoryBudget(WALLET_HISTORY_MAX_ROWS, WALLET_HISTORY_MAX_ESTIMATED_BYTES)).not.toThrow();
    expect(() => assertWalletHistoryBudget(WALLET_HISTORY_MAX_ROWS + 1, 0)).toThrow();
    expect(() => assertWalletHistoryBudget(0, WALLET_HISTORY_MAX_ESTIMATED_BYTES + 1)).toThrow();
  });
  it('reads all pages, uses a composite cursor for equal timestamps, keeps filters and exact decimals', async () => {
    db.findMany.mockResolvedValueOnce(Array.from({ length: SIZE }, (_, i) => row(i)))
      .mockResolvedValueOnce([row(SIZE), { ...row(SIZE + 1), reconciliation: 'ambiguous' }]);
    const result = await loadWalletHistory(where);
    expect(result).toHaveLength(SIZE + 2);
    expect(new Set(result.map(x => x.key)).size).toBe(SIZE + 2);
    expect(result[0]).toMatchObject({ amount: '1.123456789012345678', price: '0.1234567890123456789', marketCapUsd: null });
    expect(result.at(-1)?.ambiguous).toBe(true);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead', timeout: 60_000 });
    expect(db.executeRaw.mock.calls[0]![0][0]).toBe('SET TRANSACTION READ ONLY');
    expect(db.findMany.mock.calls[0]![0].where).toEqual(where);
    expect(db.findMany.mock.calls[1]![0].where).toEqual({ AND: [where, { OR: [
      { tradedAt: { gt: at } }, { tradedAt: at, key: { gt: row(SIZE - 1).key } },
    ] }] });
    for (const [query] of db.findMany.mock.calls) {
      expect(query.take).toBe(SIZE);
      expect(query.orderBy).toEqual([{ tradedAt: 'asc' }, { key: 'asc' }]);
      expect(query.select).not.toHaveProperty('sourceEventId');
      expect(query).not.toHaveProperty('skip');
    }
  });
  it('checks the next page at an exact boundary and handles empty history', async () => {
    db.findMany.mockResolvedValueOnce(Array.from({ length: SIZE }, (_, i) => row(i))).mockResolvedValue([]);
    expect(await loadWalletHistory(where)).toHaveLength(SIZE);
    expect(db.findMany).toHaveBeenCalledTimes(2);
    expect(await loadWalletHistory(where)).toEqual([]);
  });
  it('rejects a failed later page instead of returning a partial ledger', async () => {
    db.findMany.mockResolvedValueOnce(Array.from({ length: SIZE }, (_, i) => row(i))).mockRejectedValueOnce(new Error('DB failed'));
    await expect(loadWalletHistory(where)).rejects.toThrow('DB failed');
  });
  it('fails closed if a transport/mock repeats a page, never loops indefinitely', async () => {
    db.findMany.mockResolvedValue(Array.from({ length: SIZE }, (_, i) => row(i)));
    await expect(loadWalletHistory(where)).rejects.toThrow('WALLET_HISTORY_CURSOR_STALLED');
    expect(db.findMany).toHaveBeenCalledTimes(2);
  });
  it('rejects an oversized compact result without returning partial PnL and releases the read slot', async () => {
    db.findMany.mockResolvedValueOnce(Array.from({ length: SIZE }, (_, i) => ({ ...row(i), tokenSymbol: 'x'.repeat(200_000) })));
    await expect(loadWalletHistory(where)).rejects.toMatchObject({ code: 'WALLET_HISTORY_CAPACITY_EXCEEDED' });
    db.findMany.mockResolvedValueOnce([row(1)]);
    expect(await loadWalletHistory(where)).toHaveLength(1);
  });
  it('does not materialize two large Prisma snapshots concurrently', async () => {
    let release!: (rows: unknown[]) => void;
    db.findMany.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce([]);
    const first = loadWalletHistory(where);
    await vi.waitFor(() => expect(db.findMany).toHaveBeenCalledTimes(1));
    const second = loadWalletHistory(where);
    await Promise.resolve();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    release([]);
    await Promise.all([first, second]);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
});
