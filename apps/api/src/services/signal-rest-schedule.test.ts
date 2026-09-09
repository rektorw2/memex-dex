import { metadataGateDatabase } from '../test-support/metadata-gate.js';
import { beforeEach, afterEach, vi } from 'vitest';
const gate = metadataGateDatabase();
vi.mock('../lib/prisma.js', () => ({ prisma: { $transaction: (fn: any) => gate.transaction(() => fn({ $queryRaw: gate.$queryRaw, $executeRaw: gate.$executeRaw })) } }));
beforeEach(() => { gate.reset(); vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());
import { expect, it } from 'vitest';
import { SignalRestSchedule, signalRestPlan, claimSharedSignalPoll, finishSharedSignalPoll } from './signal-rest-schedule.js';
const config = { plan: 'growth', monthlyBudget: 900_000, requestsPerSecond: 1, consumers: 1, legacyIntervalMs: 60_000 };
it('unverified production budget keeps conservative polling and never claims freshness', () => {
  expect(signalRestPlan({ legacyIntervalMs: 60_000 }, 5)).toMatchObject({ status: 'BUDGET_UNCONFIRMED', roundMs: 300_000, timelyEntryGuaranteed: false });
});
it('explicit allocation respects plan, competing consumers and verified RPS share', () => {
  expect(signalRestPlan(config, 5)).toMatchObject({ status: 'CONDITIONAL', intervalMs: 3000, roundMs: 15000 });
  const double = signalRestPlan({ ...config, consumers: 2 }, 5);
  expect(double.estimatedMonthlyCalls).toBeLessThanOrEqual(900_000);
  expect(signalRestPlan({ ...config, plan: 'free' }, 5)).toMatchObject({ status: 'INSUFFICIENT_BUDGET', allocatedMonthlyCalls: 50_000 });
  expect(signalRestPlan({ ...config, requestsPerSecond: 0.1 }, 5).intervalMs).toBe(10_000);
});
it('five networks receive fresh generated events within the simulated cycle, bounded cost and no overlap', () => {
  const plan = signalRestPlan(config, 5); const scheduler = new SignalRestSchedule();
  const chains = ['SOL', 'BNB', 'RH', 'BASE', 'ETH']; const calls: { chain: string; at: number }[] = [];
  const last = new Map(chains.map(c => [c, 0])); const delivery: number[] = [];
  for (let now = 0; now < 60_000; now += 250) {
    const chain = scheduler.claim(chains, now, plan.intervalMs); if (!chain) continue;
    calls.push({ chain, at: now }); delivery.push(now - last.get(chain)!); last.set(chain, now);
    expect(scheduler.claim(chains, now, plan.intervalMs)).toBeNull();
    scheduler.complete(now + 250, plan.intervalMs);
  }
  expect(Math.max(...delivery)).toBeLessThanOrEqual(20_000);
  expect(calls.length).toBeLessThanOrEqual(20);
  expect(calls.slice(0, 5).map(c => c.chain)).toEqual(chains);
});
it('429 blocks all networks, honors long Retry-After and recovers without a catch-up avalanche', () => {
  const s = new SignalRestSchedule(); const chains = ['a', 'b', 'c'];
  expect(s.claim(chains, 0, 3000)).toBe('a');
  s.complete(100, 3000, { kind: 'rate-limit', retryAfterMs: 120_000 });
  for (let t = 100; t < 120100; t += 250) expect(s.claim(chains, t, 3000)).toBeNull();
  expect(s.claim(chains, 120100, 3000)).toBe('b'); s.complete(120200, 3000);
  expect(s.claim(chains, 120200, 3000)).toBeNull(); expect(s.claim(chains, 123200, 3000)).toBe('c');
});
it.each(['network', 'budget', 'auth', 'quota'])('%s failures back off; slow calls do not accumulate debt', kind => {
  const s = new SignalRestSchedule(); expect(s.claim(['a', 'b'], 0, 3000)).toBe('a');
  expect(s.claim(['a', 'b'], 60000, 3000)).toBeNull(); s.complete(60000, 3000, { kind });
  expect(s.claim(['a', 'b'], 60001, 3000)).toBeNull();
  expect(s.claim(['a', 'b'], 400000, 3000)).toBe('b'); s.complete(400000, 3000);
  expect(s.claim(['a', 'b'], 400001, 3000)).toBeNull();
});

it('shared poll reservation prevents parallel process bursts and retains 429 across restart', async () => {
  const calls = await Promise.all(['a','b','c'].map(owner => claimSharedSignalPoll(['SOL','BNB','RH'],3000,owner)));
  expect(calls.filter(r => r.chain != null)).toHaveLength(1);
  await finishSharedSignalPoll('a',3000,120000);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await claimSharedSignalPoll(['SOL','BNB','RH'],3000,'restarted')).toEqual({chain:null,blockedUntil:120000});
  await vi.advanceTimersByTimeAsync(110000);
  expect((await claimSharedSignalPoll(['SOL','BNB','RH'],3000,'restarted')).chain).toBe('BNB');
});
it('crashed poll lease expires once without an accumulated queue, late owner cannot release its successor', async () => {
  expect((await claimSharedSignalPoll(['SOL','BNB'],3000,'dead')).chain).toBe('SOL');
  await vi.advanceTimersByTimeAsync(29999);
  expect((await claimSharedSignalPoll(['SOL','BNB'],3000,'new')).chain).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect((await claimSharedSignalPoll(['SOL','BNB'],3000,'new')).chain).toBe('BNB');
  await finishSharedSignalPoll('dead',3000,0);
  expect((await claimSharedSignalPoll(['SOL','BNB'],3000,'third')).chain).toBeNull();
});
