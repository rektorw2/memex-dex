import { metadataGateDatabase } from '../test-support/metadata-gate.js';
const gate = metadataGateDatabase();
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ allow: true, reply: 'ok', delay: false, releases: [] as (() => void)[], calls: [] as { at: number; chain: string }[] }));
vi.mock('../lib/env.js', () => ({ env: { OKX_API_KEY: 'test-key', OKX_API_SECRET: 'test-secret', OKX_PASSPHRASE: 'test-pass', OKX_WS_ENABLED: false, OKX_PLAN: 'growth', OKX_SIGNAL_REST_MONTHLY_BUDGET: 900000, OKX_SIGNAL_REST_REQUESTS_PER_SECOND: 1, OKX_SIGNAL_REST_CONSUMERS: 1, OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS: 60000 } }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({ prisma: { $transaction: (fn: any) => gate.transaction(() => fn({ $queryRaw: gate.$queryRaw, $executeRaw: gate.$executeRaw })) } }));
vi.mock('./hot-tokens.js', () => ({ markHot: vi.fn() }));
vi.mock('./candle-builder.js', () => ({ requestCandlesSoon: vi.fn() }));
vi.mock('./paper-agent.js', () => ({ queuePaperAgentSignal: vi.fn(), setPaperSignalSourceProbe: vi.fn() }));
vi.mock('../services/evm-chain-probe.js', () => ({ refreshEvmProbes: async () => {} }));
vi.mock('../services/okx-ws-client.js', () => ({ OkxWalletWebSocketClient: class { start() {} stop() {} setSignalChains() {} isHealthy() { return false; } stats() { return { state: 'rest_only', loginVerified: true, subscriptionsVerified: false, channelAccessDeniedCode: '60036' }; } } }));
vi.mock('../services/okx-usage.js', () => ({ canSpendOkxCall: () => ({ allow: state.allow, slow: false }), recordOkxCall: vi.fn() }));
let ingest: typeof import('./okx-signal-ingest.js');
const indexes = ['1', '56', '501', '8453', '4663'];
beforeEach(async () => {
  gate.reset();
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  state.allow = true; state.reply = 'ok'; state.delay = false; state.releases = []; state.calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.includes('/supported/chain')) return new Response(JSON.stringify({ code: '0', data: indexes.map(chainIndex => ({ chainIndex, chainName: chainIndex })) }));
    if (!url.includes('/signal/list')) throw new Error(`Unexpected HTTP: ${url}`);
    state.calls.push({ at: Date.now(), chain: JSON.parse(options.body as string)[0].chainIndex });
    if (state.delay) await new Promise<void>(resolve => state.releases.push(resolve));
    return state.reply === '429' ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
      : new Response(JSON.stringify({ code: '0', data: [] }));
  }));
  ingest = await import('./okx-signal-ingest.js'); ingest.startOkxSignalIngest(); await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => { ingest.stopOkxSignalIngest(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('real worker, OKX HTTP adapter and transport limiter pace all five chains without startup burst', async () => {
  await vi.advanceTimersByTimeAsync(60000);
  expect(state.calls.length).toBeLessThanOrEqual(21); expect(state.calls.length).toBeGreaterThanOrEqual(18);
  expect(new Set(state.calls.slice(0, 5).map(c => c.chain)).size).toBe(5);
  for (let i = 1; i < state.calls.length; i++) expect(state.calls[i]!.at - state.calls[i - 1]!.at).toBeGreaterThanOrEqual(3000);
  for (const chain of indexes) {
    const calls = state.calls.filter(c => c.chain === chain);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.at - calls[i - 1]!.at).toBeLessThanOrEqual(20000);
  }
  expect(ingest.getOkxSignalIngestStatus().restDelivery).toMatchObject({ status: 'CONDITIONAL', timelyEntryGuaranteed: false });
});
it('real HTTP 429 suspends every chain for Retry-After, then resumes paced rotation', async () => {
  state.reply = '429'; await vi.advanceTimersByTimeAsync(3000);
  const count = state.calls.length; expect(ingest.getOkxSignalIngestStatus().lastRestErrorCode).toMatch(/rate-limit/);
  state.reply = 'ok'; await vi.advanceTimersByTimeAsync(119999); expect(state.calls).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1); expect(state.calls).toHaveLength(count + 1);
  expect(ingest.getOkxSignalIngestStatus().lastRestErrorCode).toBeNull();
  await vi.advanceTimersByTimeAsync(1000); expect(state.calls).toHaveLength(count + 1);
});
it('shared usage denial spends no HTTP and does not spin; recovery is bounded', async () => {
  state.allow = false; const count = state.calls.length; await vi.advanceTimersByTimeAsync(3000);
  expect(ingest.getOkxSignalIngestStatus().lastRestErrorCode).toBe('budget');
  await vi.advanceTimersByTimeAsync(60000); expect(state.calls).toHaveLength(count);
  state.allow = true; await vi.advanceTimersByTimeAsync(240000); expect(state.calls).toHaveLength(count + 1);
});
it('slow response prevents overlapping polls and catch-up requests', async () => {
  state.delay = true; await vi.advanceTimersByTimeAsync(3000); const count = state.calls.length;
  await vi.advanceTimersByTimeAsync(6000); expect(state.calls).toHaveLength(count);
  state.delay = false; state.releases.splice(0).forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2999); expect(state.calls).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1); expect(state.calls).toHaveLength(count + 1);
});
