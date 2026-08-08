import { describe, it, expect } from 'vitest';
import { assessToken } from './risk.js';

describe('риск-скоринг токена', () => {
  it('ханипот — максимальный риск и запрет торговли', () => {
    const r = assessToken({ isHoneypot: true });
    expect(r.score).toBe(100);
    expect(r.tradeable).toBe(false);
  });

  it('здоровый токен получает низкий скор', () => {
    const r = assessToken({
      liquidityUsd: 500_000, holders: 5_000, topHolderPct: 15,
      lpBurnedPct: 100, ageHours: 720, mintAuthorityActive: false,
      freezeAuthorityActive: false, sellTaxBps: 0,
    });
    expect(r.score).toBeLessThan(20);
    expect(r.tradeable).toBe(true);
  });

  it('свежий низколиквидный токен с живым mint — высокий риск', () => {
    const r = assessToken({
      liquidityUsd: 3_000, holders: 40, topHolderPct: 70,
      lpBurnedPct: 0, ageHours: 2, mintAuthorityActive: true, freezeAuthorityActive: true,
    });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.tradeable).toBe(false);
    expect(r.flags.length).toBeGreaterThan(4);
  });

  it('скор не превышает 100', () => {
    const r = assessToken({
      liquidityUsd: 1, holders: 1, topHolderPct: 99, lpBurnedPct: 0,
      ageHours: 1, mintAuthorityActive: true, freezeAuthorityActive: true, sellTaxBps: 5000,
    });
    expect(r.score).toBe(100);
  });
});
