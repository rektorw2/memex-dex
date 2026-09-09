import { afterEach, describe, expect, it, vi } from 'vitest';
import { PacedRateLimiter } from './market-data.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('равномерный лимит GeckoTerminal', () => {
  it('не выпускает разрешённый минутный бюджет одним залпом', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const limiter = new PacedRateLimiter(2, 1_000);
    const started: number[] = [];
    const tasks = [0, 1, 2].map(async () => {
      await limiter.take();
      started.push(Date.now());
    });

    await vi.runAllTimersAsync();
    await Promise.all(tasks);

    expect(started).toEqual([0, 500, 1_000]);
  });

  it('после 429 удерживает всю очередь до конца backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const limiter = new PacedRateLimiter(10, 1_000);
    await limiter.take();
    limiter.backoff(2_000);

    let released = false;
    const waiting = limiter.take().then(() => {
      released = true;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(released).toBe(true);
  });
});

it('metadata admission is immediate, respects provider backoff and creates no queue', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const limiter = new PacedRateLimiter(2, 1_000);
  expect(limiter.tryTake()).toBe(true);
  for (let i=0;i<100;i++) expect(limiter.tryTake()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(500); expect(limiter.tryTake()).toBe(true);
  limiter.backoff(2_000);
  await vi.advanceTimersByTimeAsync(1_999); expect(limiter.tryTake()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(limiter.tryTake()).toBe(true);
});
