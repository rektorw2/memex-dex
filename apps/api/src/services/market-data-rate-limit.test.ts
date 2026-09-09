import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { metadataGateDatabase } from '../test-support/metadata-gate.js';
const gate = metadataGateDatabase();
vi.mock('../lib/prisma.js', () => ({ prisma: { $transaction: (fn: any) => gate.transaction(() => fn({ $queryRaw: gate.$queryRaw, $executeRaw: gate.$executeRaw })) } }));
import { GeckoRateLimiter } from './gecko-admission.js';
beforeEach(() => { gate.reset(); vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());
it('shared background budget is paced across separate process instances', async () => {
  const a = new GeckoRateLimiter(), b = new GeckoRateLimiter(); const starts: number[] = [];
  const tasks = [a, b, a].map(async limiter => { await limiter.take(); starts.push(Date.now()); });
  await vi.runAllTimersAsync(); await Promise.all(tasks); expect(starts).toEqual([0, 30000, 60000]);
});
it('provider backoff survives a new instance and blocks urgent as well as background requests', async () => {
  const a = new GeckoRateLimiter(); await a.take(); await a.backoff(60000);
  const restarted = new GeckoRateLimiter(); expect(await restarted.tryTake(30000)).toBe(false);
  await vi.advanceTimersByTimeAsync(30000); expect(await restarted.tryTake(30000)).toBe(false);
  await vi.advanceTimersByTimeAsync(30000); expect(await restarted.tryTake(90000)).toBe(true);
});
it('urgent requests create no wait queue and never consume parallel slots', async () => {
  const a = new GeckoRateLimiter(), b = new GeckoRateLimiter();
  const attempts = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).tryTake(30000)));
  expect(attempts.filter(Boolean)).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(7500); expect(await b.tryTake(30000)).toBe(true);
});
