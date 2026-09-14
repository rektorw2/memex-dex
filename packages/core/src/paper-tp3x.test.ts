import { describe, expect, it } from 'vitest';
import { advancePaperExitState, evaluatePaperExit, initialPaperExitState, paperExitPlan, paperLegTargetPrice, paperStopPrice, validatePaperExitPlan, type PaperExitPlan } from './paper-exit.js';

describe.each(['TRAILING', 'TRAILING_PURE'] as const)('%s: body first, then half the remainder at execution-entry 3×', mode => {
  const plan = paperExitPlan(mode);
  const initial = () => initialPaperExitState(1, 0, 1.01);
  const afterBody = () => advancePaperExitState(initial(), evaluatePaperExit(plan, initial(), 2, 1), 2);
  it('preserves body fixation and original trailing activation', () => {
    const before = paperStopPrice(plan, initial());
    expect(before?.reason).toBe(mode === 'TRAILING' ? 'STOP_LOSS' : 'TRAILING_STOP');
    const body = evaluatePaperExit(plan, initial(), 2, 1);
    expect(body).toMatchObject({ action: 'SELL', sellPct: 50, fractionOfRemaining: .5, legsFilledAfter: 1, closes: false });
    expect(afterBody().remainingPct).toBe(50);
  });
  it.each([2.9, 3, 3.029999])('does not confuse source 3× with execution 3×: %s', price => {
    expect(evaluatePaperExit(plan, afterBody(), price, 2)).toEqual({ action: 'HOLD' });
  });
  it.each([3.03, 3.5, 8])('sells exactly half of current remainder at/past target: %s', price => {
    const state = afterBody();
    const decision = evaluatePaperExit(plan, state, price, 2);
    expect(decision).toMatchObject({ action: 'SELL', sellPct: 25, fractionOfRemaining: .5, closes: false, legsFilledAfter: 2 });
    const next = advancePaperExitState(state, decision, price);
    expect(next.remainingPct).toBe(25);
    expect(evaluatePaperExit(plan, next, price, 3)).toEqual({ action: 'HOLD' });
    expect(paperStopPrice(plan, next)?.priceUsd).toBe(price * .5);
    expect(evaluatePaperExit(plan, next, price * .5, 4)).toMatchObject({ action: 'SELL', reason: 'TRAILING_STOP', sellPct: 25, closes: true });
  });
  it('gap through both legs sizes sequentially and produces one bounded execution', () => {
    const decision = evaluatePaperExit(plan, initial(), 4, 1);
    expect(decision).toMatchObject({ action: 'SELL', sellPct: 75, fractionOfRemaining: .75, legsFilledAfter: 2, closes: false });
    expect(advancePaperExitState(initial(), decision, 4).remainingPct).toBe(25);
  });
  it('stop and max hold have priority over profit legs; never two decisions', () => {
    expect(evaluatePaperExit(plan, { ...afterBody(), peakSourcePriceUsd: 10 }, 4, 2)).toMatchObject({ reason: 'TRAILING_STOP', sellPct: 50, closes: true });
    expect(evaluatePaperExit(plan, afterBody(), 4, 6 * 3600_000)).toMatchObject({ reason: 'MAX_HOLD', sellPct: 50, closes: true });
  });
  it('old version 1 snapshot keeps only its body leg, never acquires TP3x', () => {
    const old: PaperExitPlan = { ...plan, version: 1, legs: [{ multiple: 2, sellPct: 50 }] };
    expect(validatePaperExitPlan(old)).toBeNull();
    const state = advancePaperExitState(initial(), evaluatePaperExit(old, initial(), 2, 1), 2);
    expect(evaluatePaperExit(old, state, 3.5, 2)).toEqual({ action: 'HOLD' });
    expect(state.remainingPct).toBe(50);
  });
  it('does not guess a missing actual entry price or accept invalid quotes', () => {
    const state = { ...afterBody(), entryExecutionPriceUsd: undefined };
    expect(paperLegTargetPrice(plan.legs[1]!, state)).toBeNull();
    expect(evaluatePaperExit(plan, state, 4, 2)).toEqual({ action: 'HOLD' });
    for (const price of [NaN, Infinity, -1, 0]) expect(evaluatePaperExit(plan, afterBody(), price, 2)).toEqual({ action: 'HOLD' });
  });
});
