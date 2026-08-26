import { describe, expect, it } from 'vitest';
import {
  allocatePaperCapital,
  autopilotAllocationPolicy,
  closePaperCapitalLedger,
  fixedAllocationPolicy,
  initialPaperCapitalLedger,
  openPaperCapitalLedger,
  scorePaperAllocationSignal,
  validatePaperAllocationLimits,
  type AllocationContext,
  type PaperSignalAllocationFacts,
} from './paper-allocation.js';

const now = Date.UTC(2026, 7, 26, 10);
const signal = (over: Partial<PaperSignalAllocationFacts> = {}): PaperSignalAllocationFacts => ({
  sourcePurchaseUsd: '12000', walletTypes: ['smart_money'], tokenAgeMs: 4 * 60_000,
  signalLatencyMs: 3_000, liquidityUsd: '150000', liquidityUpdatedAtMs: now - 2_000,
  marketCapUsd: '100000', marketCapUpdatedAtMs: now - 2_000,
  historicalWalletWinRatePct: 65, historicalWalletSampleSize: 50, decidedAtMs: now, ...over,
});
const context = (over: Partial<AllocationContext> = {}): AllocationContext => ({
  initialCapitalUsd: '100', freeBalanceUsd: '70', reservedBalanceUsd: '30', inPositionsUsd: '0',
  openPositions: 0, entriesToday: 0, currentDrawdownPct: 0,
  policy: fixedAllocationPolicy({ capitalUsd: 100, maxOpenPositions: 4 }), signal: signal(), ...over,
});

describe('Phase 3 allocation engine', () => {
  it('Fixed считает резерв, торговый капитал и лимит позиции', () => {
    const policy = fixedAllocationPolicy({ capitalUsd: 100, maxOpenPositions: 4 });
    expect(policy.limits).toMatchObject({ reservePct: 30, maxExposurePct: 70, maxPositionPct: 17.5, maxOpenPositions: 4, allowPartialAllocation: false });
    expect(allocatePaperCapital(context())).toMatchObject({ allocated: true, amountUsd: '17.5', freeAfterUsd: '52.5', reserveAfterUsd: '30' });
  });

  it('Fixed не размещает частично, когда полного лимита нет', () => {
    expect(allocatePaperCapital(context({ freeBalanceUsd: '10' }))).toMatchObject({ allocated: false, code: 'INSUFFICIENT_FREE_BALANCE' });
  });

  it.each([
    ['CONSERVATIVE', 15], ['BALANCED', 20], ['AGGRESSIVE', 25],
  ] as const)('Autopilot %s не превышает max position', (profile, expected) => {
    const policy = autopilotAllocationPolicy(profile);
    const result = allocatePaperCapital(context({ policy, freeBalanceUsd: String(100 - policy.limits.reservePct), reservedBalanceUsd: String(policy.limits.reservePct) }));
    expect(Number(result.amountUsd)).toBeLessThanOrEqual(expected);
    expect(Number(result.exposureAfterUsd)).toBeLessThanOrEqual(policy.limits.maxExposurePct);
  });

  it('слабый сигнал получает меньшую, но детерминированную сумму', () => {
    const policy = autopilotAllocationPolicy('BALANCED');
    const result = allocatePaperCapital(context({ policy, signal: signal({ walletTypes: [], sourcePurchaseUsd: null, tokenAgeMs: null, liquidityUsd: null, marketCapUsd: null, historicalWalletSampleSize: 0 }) }));
    expect(result.score.band).toBe('WEAK');
    expect(result.amountUsd).toBe('10');
  });

  it('устаревшие данные не делают сигнал сильным', () => {
    const scored = scorePaperAllocationSignal(signal({ liquidityUpdatedAtMs: now - 61_000, marketCapUpdatedAtMs: now - 61_000 }));
    expect(scored.missingOrStale).toEqual(expect.arrayContaining(['LIQUIDITY_MISSING_OR_STALE', 'MARKET_CAP_MISSING_OR_STALE']));
    expect(scored.score).toBeLessThan(100);
  });

  it('будущие ATH и PnL отсутствуют в контракте score', () => {
    expect(Object.keys(signal())).not.toEqual(expect.arrayContaining(['peakPriceUsd', 'ath', 'pnlUsd', 'result']));
  });

  it('drawdown stop блокирует вход', () => {
    const policy = autopilotAllocationPolicy('CONSERVATIVE');
    expect(allocatePaperCapital(context({ policy, reservedBalanceUsd: '40', freeBalanceUsd: '60', currentDrawdownPct: 10 }))).toMatchObject({ allocated: false, code: 'DRAWDOWN_STOP' });
  });

  it('reserve, exposure, max positions и дневной лимит — hard limits', () => {
    const policy = autopilotAllocationPolicy('BALANCED');
    expect(allocatePaperCapital(context({ policy, reservedBalanceUsd: '29', freeBalanceUsd: '71' })).code).toBe('RESERVE_VIOLATION');
    expect(allocatePaperCapital(context({ policy, inPositionsUsd: '70' })).code).toBe('EXPOSURE_LIMIT_REACHED');
    expect(allocatePaperCapital(context({ policy, openPositions: 5 })).code).toBe('MAX_POSITIONS_REACHED');
    expect(allocatePaperCapital(context({ policy, entriesToday: 8 })).code).toBe('DAILY_ENTRY_LIMIT_REACHED');
  });

  it('нулевой и отрицательный баланс отвергаются', () => {
    expect(allocatePaperCapital(context({ initialCapitalUsd: '0' })).code).toBe('INVALID_CAPITAL_STATE');
    expect(allocatePaperCapital(context({ freeBalanceUsd: '-1' })).code).toBe('INVALID_CAPITAL_STATE');
  });

  it('очень маленький капитал не создаёт бессмысленную позицию', () => {
    const policy = fixedAllocationPolicy({ capitalUsd: 10, maxOpenPositions: 4 });
    expect(allocatePaperCapital(context({ initialCapitalUsd: '10', freeBalanceUsd: '7', reservedBalanceUsd: '3', policy })).code).toBe('POSITION_BELOW_MINIMUM');
  });

  it('некорректные проценты и лимиты отвергаются', () => {
    const base = autopilotAllocationPolicy('BALANCED').limits;
    expect(validatePaperAllocationLimits({ ...base, reservePct: 90, maxExposurePct: 70 })).toBe('RESERVE_AND_EXPOSURE_EXCEED_CAPITAL');
    expect(() => autopilotAllocationPolicy('BALANCED', { maxOpenPositions: 0 })).toThrow('INVALID_MAX_OPEN_POSITIONS');
  });

  it('одно и то же состояние даёт побайтово одинаковое решение', () => {
    const first = allocatePaperCapital(context());
    const second = allocatePaperCapital(context());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('score не изменяет входной снимок', () => {
    const facts = signal();
    const before = JSON.stringify(facts);
    scorePaperAllocationSignal(facts);
    expect(JSON.stringify(facts)).toBe(before);
  });

  it('данные с временной меткой из будущего не считаются свежими', () => {
    const scored = scorePaperAllocationSignal(signal({
      liquidityUpdatedAtMs: now + 1,
      marketCapUpdatedAtMs: now + 1,
    }));
    expect(scored.missingOrStale).toEqual(expect.arrayContaining([
      'LIQUIDITY_MISSING_OR_STALE',
      'MARKET_CAP_MISSING_OR_STALE',
    ]));
  });

  it('отрицательная капитализация не усиливает signal score', () => {
    const negative = scorePaperAllocationSignal(signal({ marketCapUsd: '-1' }));
    const missing = scorePaperAllocationSignal(signal({ marketCapUsd: null }));
    expect(negative.reasons.find((reason) => reason.startsWith('FRESH_MARKET_CAP'))).toBe('FRESH_MARKET_CAP:0');
    expect(negative.score).toBe(missing.score);
  });

  it('невалидная историческая статистика не участвует в score', () => {
    const scored = scorePaperAllocationSignal(signal({
      historicalWalletWinRatePct: 140,
      historicalWalletSampleSize: 50,
    }));
    expect(scored.reasons).toContain('PRE_SIGNAL_WALLET_HISTORY:0');
  });

  it('граница свежести 60 секунд включительна', () => {
    const freshAtBoundary = scorePaperAllocationSignal(signal({
      liquidityUpdatedAtMs: now - 60_000,
      marketCapUpdatedAtMs: now - 60_000,
    }));
    expect(freshAtBoundary.missingOrStale).not.toContain('LIQUIDITY_MISSING_OR_STALE');
    expect(freshAtBoundary.missingOrStale).not.toContain('MARKET_CAP_MISSING_OR_STALE');
  });

  it('Fixed не размещает позицию поверх точного остатка exposure', () => {
    const result = allocatePaperCapital(context({ inPositionsUsd: '60', freeBalanceUsd: '10' }));
    expect(result.allocated).toBe(false);
    expect(Number(result.exposureAfterUsd)).toBe(60);
  });

  it('Autopilot разрешает частичную позицию, но не нарушает exposure', () => {
    const policy = autopilotAllocationPolicy('BALANCED');
    const result = allocatePaperCapital(context({
      policy,
      inPositionsUsd: '68',
      freeBalanceUsd: '2',
      reservedBalanceUsd: '30',
      signal: signal(),
    }));
    expect(result).toMatchObject({ allocated: false, code: 'POSITION_BELOW_MINIMUM' });
    expect(Number(result.exposureAfterUsd)).toBeLessThanOrEqual(70);
  });

  it('отрицательные счётчики и drawdown отвергаются как повреждённый ledger', () => {
    expect(allocatePaperCapital(context({ openPositions: -1 })).code).toBe('INVALID_CAPITAL_STATE');
    expect(allocatePaperCapital(context({ entriesToday: -1 })).code).toBe('INVALID_CAPITAL_STATE');
    expect(allocatePaperCapital(context({ currentDrawdownPct: -0.01 })).code).toBe('INVALID_CAPITAL_STATE');
  });

  it('профили Autopilot упорядочены по reserve и exposure', () => {
    const conservative = autopilotAllocationPolicy('CONSERVATIVE').limits;
    const balanced = autopilotAllocationPolicy('BALANCED').limits;
    const aggressive = autopilotAllocationPolicy('AGGRESSIVE').limits;
    expect(conservative.reservePct).toBeGreaterThan(balanced.reservePct);
    expect(balanced.reservePct).toBeGreaterThan(aggressive.reservePct);
    expect(conservative.maxExposurePct).toBeLessThan(balanced.maxExposurePct);
    expect(balanced.maxExposurePct).toBeLessThan(aggressive.maxExposurePct);
  });

  it('Fixed делит торговую долю на число одновременных позиций', () => {
    expect(fixedAllocationPolicy({ capitalUsd: 10_000, maxOpenPositions: 7, reservePct: 30 }).limits.maxPositionPct).toBe(10);
  });

  it('минимальная позиция хранится десятичной строкой без float-шума', () => {
    const policy = fixedAllocationPolicy({
      capitalUsd: '100.00000001',
      maxOpenPositions: 4,
      minimumPositionUsd: '0.00000001',
    });
    expect(policy.limits.minimumPositionUsd).toBe('0.00000001');
  });
});

describe('paper capital ledger', () => {
  it('не резервирует одну сумму дважды и не уходит в минус', () => {
    const initial = initialPaperCapitalLedger('100', 30);
    const opened = openPaperCapitalLedger(initial, '17.5');
    expect(opened).toMatchObject({ freeBalanceUsd: '52.5', reservedBalanceUsd: '30', inPositionsUsd: '17.5', openPositions: 1 });
    expect(() => openPaperCapitalLedger(opened, '60')).toThrow('INSUFFICIENT_FREE_BALANCE');
  });

  it('закрытие возвращает капитал ровно один раз и учитывает расходы', () => {
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('100', 30), '17.5');
    const closed = closePaperCapitalLedger(opened, { allocatedUsd: '17.5', netExitUsd: '19', tradingFeesUsd: '.2', slippageUsd: '.4', networkCostsUsd: '.04' });
    expect(closed).toMatchObject({ freeBalanceUsd: '71.5', inPositionsUsd: '0', realizedPnlUsd: '1.5', tradingFeesUsd: '0.2', slippageUsd: '0.4', networkCostsUsd: '0.04', openPositions: 0 });
    expect(() => closePaperCapitalLedger(closed, { allocatedUsd: '17.5', netExitUsd: '19', tradingFeesUsd: '0', slippageUsd: '0', networkCostsUsd: '0' })).toThrow('INVALID_CLOSE');
  });

  it('Decimal-округление не создаёт дополнительный баланс', () => {
    const initial = initialPaperCapitalLedger('0.3', 30);
    expect(Number(initial.freeBalanceUsd) + Number(initial.reservedBalanceUsd)).toBeCloseTo(0.3, 8);
  });

  it('ACTIVE и SHADOW снимки не делят свободный баланс', () => {
    const active = openPaperCapitalLedger(initialPaperCapitalLedger('100', 30), '17.5');
    const shadow = initialPaperCapitalLedger('100', 40);
    expect(active.freeBalanceUsd).toBe('52.5');
    expect(shadow.freeBalanceUsd).toBe('60');
    expect(shadow.openPositions).toBe(0);
  });

  it('резерв остаётся неизменным на открытии и закрытии', () => {
    const initial = initialPaperCapitalLedger('123.45678901', 30);
    const opened = openPaperCapitalLedger(initial, '10.00000001');
    const closed = closePaperCapitalLedger(opened, {
      allocatedUsd: '10.00000001', netExitUsd: '9.5', tradingFeesUsd: '0.1',
      slippageUsd: '0.2', networkCostsUsd: '0.01',
    });
    expect(opened.reservedBalanceUsd).toBe(initial.reservedBalanceUsd);
    expect(closed.reservedBalanceUsd).toBe(initial.reservedBalanceUsd);
  });

  it('проигрыш уменьшает equity и увеличивает drawdown', () => {
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('100', 30), '20');
    const closed = closePaperCapitalLedger(opened, {
      allocatedUsd: '20', netExitUsd: '10', tradingFeesUsd: '1', slippageUsd: '1', networkCostsUsd: '0.1',
    });
    expect(closed.equityUsd).toBe('90');
    expect(closed.peakEquityUsd).toBe('100');
    expect(closed.drawdownPct).toBe('10');
  });

  it('победа повышает peak equity без отрицательного drawdown', () => {
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('100', 30), '20');
    const closed = closePaperCapitalLedger(opened, {
      allocatedUsd: '20', netExitUsd: '30', tradingFeesUsd: '1', slippageUsd: '1', networkCostsUsd: '0.1',
    });
    expect(closed.equityUsd).toBe('110');
    expect(closed.peakEquityUsd).toBe('110');
    expect(closed.drawdownPct).toBe('0');
  });

  it('отрицательные расходы не могут создать капитал', () => {
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('100', 30), '20');
    expect(() => closePaperCapitalLedger(opened, {
      allocatedUsd: '20', netExitUsd: '20', tradingFeesUsd: '-1', slippageUsd: '0', networkCostsUsd: '0',
    })).toThrow('INVALID_CLOSE');
  });

  it('NaN и Infinity не проходят в закрытие ledger', () => {
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('100', 30), '20');
    expect(() => closePaperCapitalLedger(opened, {
      allocatedUsd: '20', netExitUsd: 'Infinity', tradingFeesUsd: '0', slippageUsd: '0', networkCostsUsd: '0',
    })).toThrow('INVALID_CLOSE');
  });
});
