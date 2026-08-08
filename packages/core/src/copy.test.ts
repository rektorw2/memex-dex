import { describe, it, expect } from 'vitest';
import { decideCopy, copyExitFraction, type SubscriptionConfig, type FollowerState } from './copy.js';

const cfg = (over: Partial<SubscriptionConfig> = {}): SubscriptionConfig => ({
  sizing: 'PCT_EQUITY',
  pctEquity: 5,
  maxOpenPositions: 10,
  allowedChains: ['SOLANA', 'BNB'],
  ...over,
});

const follower = (over: Partial<FollowerState> = {}): FollowerState => ({
  equityUsd: 10_000,
  freeQuoteUsd: 5_000,
  openPositions: 0,
  realizedPnlTodayUsd: 0,
  isFrozen: false,
  kycApproved: true,
  ...over,
});

const buy = { chain: 'SOLANA' as const, tokenAddress: 'X', side: 'BUY' as const, valueUsd: 1000 };

describe('решение о копировании', () => {
  it('считает размер как % от капитала', () => {
    const d = decideCopy(cfg(), follower(), buy);
    expect(d.copy).toBe(true);
    if (d.copy) expect(d.amountUsd.toString()).toBe('500'); // 5% от 10000
  });

  it('фиксированный размер', () => {
    const d = decideCopy(cfg({ sizing: 'FIXED_USD', fixedUsd: 250 }), follower(), buy);
    if (d.copy) expect(d.amountUsd.toString()).toBe('250');
  });

  it('пропорциональный размер по доле лидера', () => {
    const d = decideCopy(
      cfg({ sizing: 'PROPORTIONAL' }),
      follower(),
      { ...buy, leaderPortfolioShare: 0.03 },
    );
    if (d.copy) expect(d.amountUsd.toString()).toBe('300');
  });

  it('урезает по лимиту на сделку', () => {
    const d = decideCopy(cfg({ maxPerTradeUsd: 100 }), follower(), buy);
    if (d.copy) {
      expect(d.amountUsd.toString()).toBe('100');
      expect(d.notes.join()).toContain('урезан');
    }
  });

  it('урезает по свободному остатку', () => {
    const d = decideCopy(cfg({ pctEquity: 50 }), follower({ freeQuoteUsd: 800 }), buy);
    if (d.copy) expect(d.amountUsd.toString()).toBe('800');
  });

  it('блокирует замороженный аккаунт', () => {
    const d = decideCopy(cfg(), follower({ isFrozen: true }), buy);
    expect(d.copy).toBe(false);
  });

  it('блокирует без KYC', () => {
    const d = decideCopy(cfg(), follower({ kycApproved: false }), buy);
    expect(d.copy).toBe(false);
  });

  it('блокирует отключённую сеть', () => {
    const d = decideCopy(cfg({ allowedChains: ['SOLANA'] }), follower(), { ...buy, chain: 'BNB' });
    expect(d.copy).toBe(false);
    if (!d.copy) expect(d.reason).toContain('BNB');
  });

  it('блокирует низкую ликвидность', () => {
    const d = decideCopy(cfg({ minLiquidityUsd: 50_000 }), follower(), { ...buy, tokenLiquidityUsd: 9_000 });
    expect(d.copy).toBe(false);
  });

  it('блокирует токен выше порога риска', () => {
    const d = decideCopy(cfg({ maxRiskScore: 60 }), follower(), { ...buy, tokenRiskScore: 90 });
    expect(d.copy).toBe(false);
  });

  it('блокирует при дневном лимите убытка', () => {
    const d = decideCopy(cfg({ dailyLossLimitUsd: 500 }), follower({ realizedPnlTodayUsd: -600 }), buy);
    expect(d.copy).toBe(false);
  });

  it('блокирует при переполнении числа позиций', () => {
    const d = decideCopy(cfg({ maxOpenPositions: 3 }), follower({ openPositions: 3 }), buy);
    expect(d.copy).toBe(false);
  });

  it('отклоняет пылевые размеры', () => {
    const d = decideCopy(cfg({ sizing: 'FIXED_USD', fixedUsd: 2 }), follower(), buy);
    expect(d.copy).toBe(false);
    if (!d.copy) expect(d.reason).toContain('минимума');
  });

  it('копирует выход даже при исчерпанных лимитах входа', () => {
    const d = decideCopy(
      cfg({ maxOpenPositions: 1 }),
      follower({ openPositions: 5, freeQuoteUsd: 0 }),
      { ...buy, side: 'SELL' },
    );
    expect(d.copy).toBe(true);
  });
});

describe('доля выхода', () => {
  it('повторяет частичную продажу лидера', () => {
    expect(copyExitFraction({ leaderQtyBefore: 1000, leaderQtySold: 250 }).toString()).toBe('0.25');
  });
  it('полный выход = 1', () => {
    expect(copyExitFraction({ leaderQtyBefore: 1000, leaderQtySold: 1000 }).toString()).toBe('1');
  });
  it('защищён от деления на ноль', () => {
    expect(copyExitFraction({ leaderQtyBefore: 0, leaderQtySold: 10 }).toString()).toBe('0');
  });
});
