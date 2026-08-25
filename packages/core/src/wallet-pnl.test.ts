import { describe, expect, it } from 'vitest';
import {
  calculateWalletLedger,
  walletPnlSnapshot,
  type WalletPriceMark,
} from './wallet-pnl.js';
import type { CanonicalTrade } from './okx-dex-history.js';

const trade = (overrides: Partial<CanonicalTrade> = {}): CanonicalTrade => ({
  key: 'trade-1',
  chain: 'SOLANA',
  wallet: 'wallet',
  tokenAddress: 'token',
  tokenSymbol: 'TKN',
  side: 'BUY',
  amount: '10',
  valueUsd: '100',
  price: '10',
  marketCapUsd: null,
  providerPnlUsd: null,
  tradedAt: 1,
  ...overrides,
});

describe('точный локальный PnL', () => {
  it('учитывает частичную продажу, даже когда позиция остаётся открытой', () => {
    const ledger = calculateWalletLedger([
      trade(),
      trade({ key: 'sell', side: 'SELL', amount: '4', valueUsd: '60', price: '15', tradedAt: 2 }),
    ]);

    expect(ledger.realizedUsd).toBe('20');
    expect(ledger.openPositions).toBe(1);
    expect(ledger.tradePnl.find((p) => p.canonicalTradeKey === 'sell')).toEqual({
      canonicalTradeKey: 'sell',
      side: 'SELL',
      state: 'available',
      realizedUsd: '20',
      costBasisUsd: '40',
    });
  });

  it('не списывает остаток до одного процента как пыль', () => {
    const ledger = calculateWalletLedger([
      trade({ amount: '100', valueUsd: '100' }),
      trade({
        key: 'sell-99',
        side: 'SELL',
        amount: '99',
        valueUsd: '198',
        price: '2',
        tradedAt: 2,
      }),
    ]);

    expect(ledger.openPositions).toBe(1);
    expect(ledger.closedPositions).toBe(0);
    expect(ledger.positions[0]).toMatchObject({
      remainingAmount: '1',
      remainingCostUsd: '1',
      isClosed: false,
    });

    const snapshot = walletPnlSnapshot(
      ledger,
      [{ chain: 'SOLANA', tokenAddress: 'token', priceUsd: '2', observedAt: 9_000 }],
      { computedAt: 10_000 },
    );
    expect(snapshot).toMatchObject({
      realizedUsd: '99',
      unrealizedUsd: '1',
      totalUsd: '100',
    });
  });

  it('пересчитывает средневзвешенную себестоимость после докупки', () => {
    const ledger = calculateWalletLedger([
      trade({ amount: '10', valueUsd: '100' }),
      trade({ key: 'buy-2', amount: '10', valueUsd: '300', price: '30', tradedAt: 2 }),
      trade({ key: 'sell', side: 'SELL', amount: '5', valueUsd: '125', price: '25', tradedAt: 3 }),
    ]);

    expect(ledger.realizedUsd).toBe('25');
    expect(ledger.positions[0]?.remainingCostUsd).toBe('300');
  });

  it('не теряет 18 десятичных знаков и не использует provider PnL', () => {
    const ledger = calculateWalletLedger([
      trade({ amount: '0.123456789012345678', valueUsd: '1.0000000000' }),
      trade({
        key: 'sell',
        side: 'SELL',
        amount: '0.061728394506172839',
        valueUsd: '0.75',
        providerPnlUsd: '999999',
        tradedAt: 2,
      }),
    ]);

    expect(ledger.tradePnl[1]?.costBasisUsd).toBe('0.5');
    expect(ledger.tradePnl[1]?.realizedUsd).toBe('0.25');
  });

  it('не выдаёт частичный результат за полный при продаже без известной покупки', () => {
    const ledger = calculateWalletLedger([
      trade(),
      trade({ key: 'sell', side: 'SELL', amount: '11', valueUsd: '200', tradedAt: 2 }),
    ]);

    expect(ledger.realizedUsd).toBeNull();
    expect(ledger.incompleteTokens).toBe(1);
    expect(ledger.tradePnl.every((p) => p.state === 'incomplete_history')).toBe(true);
  });

  it('не выбирает случайный порядок BUY и SELL с одинаковым временем', () => {
    const ledger = calculateWalletLedger([
      trade({ tradedAt: 5 }),
      trade({ key: 'sell', side: 'SELL', amount: '5', valueUsd: '50', tradedAt: 5 }),
    ]);

    expect(ledger.ambiguousTokens).toBe(1);
    expect(ledger.realizedUsd).toBeNull();
  });
});

describe('снимок PnL с локальными ценами', () => {
  const ledger = calculateWalletLedger([
    trade(),
    trade({ key: 'sell', side: 'SELL', amount: '4', valueUsd: '60', price: '15', tradedAt: 2 }),
  ]);

  it('считает нереализованный и общий результат по свежей цене', () => {
    const marks: WalletPriceMark[] = [
      { chain: 'SOLANA', tokenAddress: 'token', priceUsd: '20', observedAt: 9_000 },
    ];
    const snapshot = walletPnlSnapshot(ledger, marks, { computedAt: 10_000 });

    expect(snapshot.state).toBe('available');
    expect(snapshot.realizedUsd).toBe('20');
    expect(snapshot.unrealizedUsd).toBe('60');
    expect(snapshot.totalUsd).toBe('80');
    expect(snapshot.priceAsOf).toBe(9_000);
  });

  it('не выдаёт старую цену за live PnL', () => {
    const snapshot = walletPnlSnapshot(
      ledger,
      [{ chain: 'SOLANA', tokenAddress: 'token', priceUsd: '20', observedAt: 1 }],
      { computedAt: 400_000, staleAfterMs: 300_000 },
    );

    expect(snapshot.state).toBe('stale');
    expect(snapshot.realizedUsd).toBe('20');
    expect(snapshot.unrealizedUsd).toBeNull();
    expect(snapshot.totalUsd).toBeNull();
    expect(snapshot.isStale).toBe(true);
  });

  it('отличает отсутствие цены от нулевого PnL', () => {
    const snapshot = walletPnlSnapshot(ledger, [], { computedAt: 10_000 });
    expect(snapshot.state).toBe('pending');
    expect(snapshot.unrealizedUsd).toBeNull();
    expect(snapshot.unpricedPositions).toBe(1);
  });
});
