import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const tx = {
    walletActivity: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
    },
    walletSyncQueue: {
      upsert: vi.fn(),
    },
  };

  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock('../lib/prisma.js', () => ({ prisma: db.prisma }));

import { PrismaWalletLedgerRepository, type ActivityInput } from './wallet-ledger-repo.js';

const activity: ActivityInput = {
  id: 'event-1',
  chain: 'BASE',
  walletAddress: '0xwallet',
  tokenAddress: '0xtoken',
  tokenSymbol: 'TOKEN',
  side: 'BUY',
  quoteSymbol: 'ETH',
  quoteAmount: 1,
  priceUsd: 2,
  marketCapUsd: 3,
  realizedPnlUsd: null,
  txHash: '0xtx',
  trackerType: 1,
  source: 'okx_websocket',
  parsingConfidence: 1,
  tradedAt: new Date('2026-08-23T00:00:00.000Z'),
};

beforeEach(() => {
  db.tx.walletActivity.createMany.mockReset();
  db.tx.walletActivity.findUnique.mockReset();
  db.tx.walletSyncQueue.upsert.mockReset();
  db.prisma.$transaction.mockClear();
});

describe('идемпотентный приём WalletActivity', () => {
  it('новое событие создаёт строку и задачу без исключений', async () => {
    db.tx.walletActivity.createMany.mockResolvedValue({ count: 1 });

    const result = await new PrismaWalletLedgerRepository().ingestAtomically(
      activity,
      new Date('2026-08-23T00:00:01.000Z'),
    );

    expect(result).toEqual({ created: true });
    expect(db.tx.walletActivity.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(db.tx.walletSyncQueue.upsert).toHaveBeenCalledOnce();
  });

  it('повтор ожидается базой и не проходит через P2002', async () => {
    db.tx.walletActivity.createMany.mockResolvedValue({ count: 0 });
    db.tx.walletActivity.findUnique.mockResolvedValue({ appliedToLedger: false });

    const result = await new PrismaWalletLedgerRepository().ingestAtomically(
      activity,
      new Date('2026-08-23T00:00:01.000Z'),
    );

    expect(result).toEqual({ created: false });
    expect(db.tx.walletSyncQueue.upsert).toHaveBeenCalledOnce();
  });

  it('не ставит уже учтённый дубль в очередь повторно', async () => {
    db.tx.walletActivity.createMany.mockResolvedValue({ count: 0 });
    db.tx.walletActivity.findUnique.mockResolvedValue({ appliedToLedger: true });

    const result = await new PrismaWalletLedgerRepository().ingestAtomically(
      activity,
      new Date('2026-08-23T00:00:01.000Z'),
    );

    expect(result).toEqual({ created: false });
    expect(db.tx.walletSyncQueue.upsert).not.toHaveBeenCalled();
  });
});
