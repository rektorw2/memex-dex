import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ configured: true }));
vi.mock('../lib/env.js', () => ({ env: { get OKX_API_KEY() { return config.configured ? 'test-key' : ''; }, OKX_API_SECRET: 'test-secret', OKX_PASSPHRASE: 'test-pass', OKX_PLAN: 'free' } }));
vi.mock('../lib/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
let market: typeof import('./okx-market.js');
let usage: typeof import('./okx-usage.js');
const endpoint = '/api/v6/dex/market/token/advanced-info';
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  config.configured = true;
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  market = await import('./okx-market.js'); usage = await import('./okx-usage.js');
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const ok = () => new Response(JSON.stringify({ code: '0', data: [{ value: 1 }] }));
async function safe() {
  const result = market.safeCall('GET', endpoint);
  await vi.runAllTimersAsync(); return result;
}

it.each([402, 429])('HTTP %s causes one request, no immediate retries, and permits a later recovery', async status => {
  fetcher.mockResolvedValueOnce(new Response('', { status, headers: { 'retry-after': '120' } })).mockImplementation(async () => ok());
  expect(await safe()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(usage.okxUsageSnapshot().premium.used).toBe(1);
  vi.advanceTimersByTime(120_000);
  expect(await safe()).toEqual([{ value: 1 }]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('transient failures still recover, with every HTTP attempt counted once', async () => {
  fetcher.mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockImplementation(async () => ok());
  expect(await safe()).toEqual([{ value: 1 }]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(usage.okxUsageSnapshot().premium.used).toBe(3);
  expect(usage.okxUsageSnapshot().byEndpoint[0]).toMatchObject({ calls: 3, error: 2, ok: 1 });
});

it('a failed attempt reaching the reserve prevents further background retries', async () => {
  usage.seedOkxUsageForTests('premium', 84_999);
  fetcher.mockResolvedValue(new Response('', { status: 500 }));
  expect(await safe()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(usage.okxUsageSnapshot().premium.used).toBe(85_000);
});

it('reported calls retain status and Retry-After and count each request exactly once', async () => {
  fetcher.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } })).mockImplementation(async () => ok());
  const first = market.reportedCall('GET', endpoint); await vi.runAllTimersAsync();
  expect(await first).toMatchObject({ kind: 'rate-limit', status: 429, retryAfterMs: 120_000 });
  const second = market.reportedCall('GET', endpoint); await vi.runAllTimersAsync();
  expect(await second).toMatchObject({ kind: 'ok', value: [{ value: 1 }] });
  expect(usage.okxUsageSnapshot().premium.used).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('an unconfigured provider spends no HTTP and records no quota usage', async () => {
  config.configured = false;
  expect(await safe()).toBeNull();
  expect(await market.reportedCall('GET', endpoint)).toMatchObject({ kind: 'empty' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(usage.okxUsageSnapshot().premium.used).toBe(0);
});

it('slow background requests cannot occupy the Signal slot; total concurrency and physical accounting stay bounded', async () => {
  const releases: (() => void)[] = [];
  let active = 0; let peak = 0;
  fetcher.mockImplementation(async (url: string) => {
    active++; peak = Math.max(peak, active);
    try {
      if (!url.includes('/signal/list')) await new Promise<void>(resolve => releases.push(resolve));
      return ok();
    } finally { active--; }
  });
  const background = Array.from({ length: 6 }, (_, i) => market.safeCall('GET', `${endpoint}?token=${i}`));
  await vi.advanceTimersByTimeAsync(0);
  const signal = market.reportedCall('POST', '/api/v6/dex/market/signal/list', [{ chainIndex: '501' }], 'signal');
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/signal/list'))).toHaveLength(1);
    expect(await signal).toMatchObject({ kind: 'ok' });
    expect(releases).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(6);
  } finally {
    // Also drain on a failing negative control, including the queued sixth job.
    for (let round = 0; round < 3; round++) {
      releases.splice(0).forEach(resolve => resolve());
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all([...background, signal]);
  }
  expect(fetcher).toHaveBeenCalledTimes(7);
  expect(usage.okxUsageSnapshot().premium.used).toBe(7);
});
