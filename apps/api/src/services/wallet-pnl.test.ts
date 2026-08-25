import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tradeFindMany: vi.fn(),
  tokenFindMany: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    walletEconomicTrade: { findMany: mocks.tradeFindMany },
    token: { findMany: mocks.tokenFindMany },
  },
}));

const { walletPnlForWallets, serializeWalletPnl } = await import('./wallet-pnl.js');

const dec = (value: string) => ({ toString: () => value });
const NOW = Date.parse('2026-08-25T12:00:00Z');

beforeEach(() => {
  mocks.tradeFindMany.mockReset();
  mocks.tokenFindMany.mockReset();
});
describe('единый серверный PnL', () => {
  it('считает partial SELL локально и загружает цены одним batch-запросом', async () => {
    mocks.tradeFindMany.mockResolvedValue([
      {
        key: 'buy', chain: 'SOLANA', walletAddress: 'Wallet1', tokenAddress: 'Token1',
        tokenSymbol: 'TKN', side: 'BUY', amount: dec('10'), valueUsd: dec('100'),
        price: dec('10'), marketCapUsd: null, providerPnlUsd: null,
        tradedAt: new Date(NOW - 20_000), reconciliation: 'canonical',
      },
      {
        key: 'sell', chain: 'SOLANA', walletAddress: 'Wallet1', tokenAddress: 'Token1',
        tokenSymbol: 'TKN', side: 'SELL', amount: dec('4'), valueUsd: dec('60'),
        price: dec('15'), marketCapUsd: null, providerPnlUsd: dec('999999'),
        tradedAt: new Date(NOW - 10_000), reconciliation: 'canonical',
      },
    ]);
    mocks.tokenFindMany.mockResolvedValue([
      {
        chain: 'SOLANA', address: 'Token1', priceUsd: dec('20'),
        priceUpdatedAt: new Date(NOW - 1_000),
      },
    ]);

    const snapshots = await walletPnlForWallets(
      [{ chain: 'SOLANA', address: 'Wallet1' }],
      NOW,
    );
    const result = serializeWalletPnl(snapshots.get('SOLANA:Wallet1')!);

    expect(result).toMatchObject({
      state: 'available',
      realizedUsd: 20,
      unrealizedUsd: 60,
      totalUsd: 80,
      openPositions: 1,
      method: 'weighted_average',
      version: 1,
    });
    expect(result.realizedUsd).not.toBe(999999);
    expect(mocks.tradeFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.tokenFindMany).toHaveBeenCalledTimes(1);
  });

  it('не делает запрос цен, если открытых позиций нет', async () => {
    mocks.tradeFindMany.mockResolvedValue([
      {
        key: 'buy', chain: 'SOLANA', walletAddress: 'Wallet1', tokenAddress: 'Token1',
        tokenSymbol: null, side: 'BUY', amount: dec('10'), valueUsd: dec('100'),
        price: dec('10'), marketCapUsd: null, providerPnlUsd: null,
        tradedAt: new Date(NOW - 2), reconciliation: 'canonical',
      },
      {
        key: 'sell', chain: 'SOLANA', walletAddress: 'Wallet1', tokenAddress: 'Token1',
        tokenSymbol: null, side: 'SELL', amount: dec('10'), valueUsd: dec('120'),
        price: dec('12'), marketCapUsd: null, providerPnlUsd: null,
        tradedAt: new Date(NOW - 1), reconciliation: 'canonical',
      },
    ]);

    const snapshots = await walletPnlForWallets(
      [{ chain: 'SOLANA', address: 'Wallet1' }],
      NOW,
    );
    const result = serializeWalletPnl(snapshots.get('SOLANA:Wallet1')!);

    expect(result).toMatchObject({ state: 'available', realizedUsd: 20, unrealizedUsd: 0, totalUsd: 20 });
    expect(mocks.tokenFindMany).not.toHaveBeenCalled();
  });

  it('не смешивает неоднозначную запись с подтверждённым результатом', async () => {
    mocks.tradeFindMany.mockResolvedValue([
      {
        key: 'amb', chain: 'SOLANA', walletAddress: 'Wallet1', tokenAddress: 'Token1',
        tokenSymbol: null, side: 'SELL', amount: dec('1'), valueUsd: dec('50'),
        price: dec('50'), marketCapUsd: null, providerPnlUsd: dec('50'),
        tradedAt: new Date(NOW), reconciliation: 'ambiguous',
      },
    ]);

    const snapshots = await walletPnlForWallets(
      [{ chain: 'SOLANA', address: 'Wallet1' }],
      NOW,
    );
    const result = serializeWalletPnl(snapshots.get('SOLANA:Wallet1')!);

    expect(result.state).toBe('ambiguous');
    expect(result.realizedUsd).toBeNull();
    expect(mocks.tokenFindMany).not.toHaveBeenCalled();
  });
});
