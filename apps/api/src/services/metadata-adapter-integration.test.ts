import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { metadataGateDatabase } from '../test-support/metadata-gate.js';
const gate = metadataGateDatabase();
const mocks = vi.hoisted(() => ({ update: vi.fn(), http: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ prisma: { token: { updateMany: mocks.update }, $transaction: (fn: any) => gate.transaction(() => fn({ $queryRaw: gate.$queryRaw, $executeRaw: gate.$executeRaw })) } }));
vi.mock('../lib/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
const NOW = Date.parse('2026-09-09T01:56:33.589Z');
const address = '0x03d148407da8696888d154a00ac02d5182756f0a';
function response(date: string | null = '2026-09-09T01:50:00Z', network = 'robinhood', token = address) {
  return new Response(JSON.stringify({ data: [{ attributes: { address: 'pool', reserve_in_usd: '10000', pool_created_at: date }, relationships: { base_token: { data: { id: `${network}_${token}` } }, quote_token: { data: { id: `${network}_quote` } } } }], included: [] }), { status: 200 });
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
beforeEach(() => { vi.resetModules(); gate.reset(); vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.http); mocks.update.mockResolvedValue({ count: 1 }); mocks.http.mockImplementation(() => Promise.resolve(response())); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('real Robinhood adapter makes HTTP request, validates pool identity and saves only pool creation date', async () => {
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  expect(await request('t', 'ROBINHOOD', address, NOW + 30_000)).toBe('accepted'); await flush();
  expect(mocks.http.mock.calls[0]![0]).toContain(`/networks/robinhood/tokens/${address}/pools?include=base_token,quote_token`);
  expect(mocks.update).toHaveBeenCalledWith({ where: { id: 't', chain: 'ROBINHOOD', address, poolCreatedAt: null }, data: { poolCreatedAt: new Date('2026-09-09T01:50:00Z') } });
  expect(gate.snapshot().requests[0].outcome).toBe('POOL_DATE_SAVED');
});
it.each([null, 'invalid', '2099-01-01', '1970-01-01'])('missing or invalid provider date (%s) is explicitly unavailable, no observation-date fallback', async date => {
  mocks.http.mockResolvedValue(response(date));
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  await request('t', 'ROBINHOOD', address, NOW + 30_000); await flush();
  expect(mocks.update).not.toHaveBeenCalled(); expect(gate.snapshot().requests[0].outcome).toBe('POOL_DATE_UNAVAILABLE');
});
it('an unrelated pool cannot supply the requested token age', async () => {
  mocks.http.mockResolvedValue(response(undefined, 'robinhood', 'other'));
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  await request('t', 'ROBINHOOD', address, NOW + 30_000); await flush();
  expect(mocks.update).not.toHaveBeenCalled(); expect(gate.snapshot().requests[0].outcome).toBe('POOL_NOT_FOUND');
});
it('WOWCAT: priority waits out the original 429 then wins a slot before the original deadline, attempts=0 is free', async () => {
  const market = await import('./market-data.js');
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  mocks.http.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  await market.fetchPools('SOLANA');
  const background = market.fetchPools('SOLANA');
  await vi.advanceTimersByTimeAsync(57_882); // received 01:57:31.471
  const deadline = Date.parse('2026-09-09T01:57:38.694Z');
  expect(await request('wow', 'SOLANA', 'wow', deadline)).toBe('waiting_capacity');
  expect(gate.snapshot().requests[0]).toMatchObject({ attempts: 0, completed: false, leaseUntil: 0 });
  expect(gate.snapshot().nextAt).toBe(Date.now());
  mocks.http.mockImplementation(() => Promise.resolve(response(undefined, 'solana', 'wow')));
  await vi.advanceTimersByTimeAsync(2_118); // provider backoff ends
  expect(mocks.http).toHaveBeenCalledTimes(1); // background still waiting
  expect(await request('wow', 'SOLANA', 'wow', deadline)).toBe('accepted'); await flush();
  expect(mocks.http).toHaveBeenCalledTimes(2); expect(mocks.update).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000); await background;
});
it('Retry-After beyond the deadline is never bypassed by another token or repeated attempts', async () => {
  const market = await import('./market-data.js');
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  mocks.http.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await market.fetchPools('SOLANA');
  const deadline = NOW + 30_000;
  for (let t = 0; t < 30; t++) {
    for (const token of ['a', 'b', 'c']) expect(await request(token, 'ROBINHOOD', address, deadline)).toBe('waiting_capacity');
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(await request('a', 'ROBINHOOD', address, deadline)).toBe('expired');
  expect(mocks.http).toHaveBeenCalledTimes(1); expect(mocks.update).not.toHaveBeenCalled();
});
it('continuous background traffic leaves bounded slots for several urgent tokens without a burst', async () => {
  const market = await import('./market-data.js');
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  const times: number[] = []; mocks.http.mockImplementation(() => { times.push(Date.now()); return Promise.resolve(response()); });
  const background = Array.from({ length: 8 }, () => market.fetchPools('ROBINHOOD'));
  await flush();
  for (let t = 0; t < 25; t++) {
    for (const id of ['a', 'b', 'c']) await request(id, 'ROBINHOOD', address, NOW + 30_000);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(mocks.update).toHaveBeenCalledTimes(3);
  await vi.runAllTimersAsync(); await Promise.all(background);
  expect(times.every((t, i) => i === 0 || t - times[i - 1]! >= 7500)).toBe(true);
});
it('two process instances share deduplication and restart lease recovery with real adapters', async () => {
  mocks.http.mockImplementation(() => new Promise(() => {}));
  const a = await import('./paper-token-metadata.js'); vi.resetModules();
  const b = await import('./paper-token-metadata.js'); const deadline = NOW + 30_000;
  expect((await Promise.all([a.requestPaperTokenMetadata('t', 'ROBINHOOD', address, deadline), b.requestPaperTokenMetadata('t', 'ROBINHOOD', address, deadline)])).sort()).toEqual(['accepted', 'in_flight']);
  expect(mocks.http).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(await b.requestPaperTokenMetadata('t', 'ROBINHOOD', address, deadline)).toBe('accepted');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await a.requestPaperTokenMetadata('t', 'ROBINHOOD', address, deadline)).toBe('expired');
  expect(mocks.http).toHaveBeenCalledTimes(2);
});

it('failed capacity claims have a fixed cardinality bound, and expired pending rows are pruned', async () => {
  const market = await import('./market-data.js');
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  mocks.http.mockResolvedValueOnce(new Response('', { status: 429 })); await market.fetchPools('SOLANA');
  for (let i = 0; i < 200; i++) await request(`token-${i}`, 'ROBINHOOD', address, NOW + 30000);
  expect(gate.snapshot().requests.length).toBeLessThanOrEqual(32); expect(mocks.http).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30000); await request('next', 'ROBINHOOD', address, NOW + 60000);
  expect(gate.snapshot().requests.length).toBe(1);
});
it('a provider 429 is retained across module restart and a second real adapter instance', async () => {
  const market = await import('./market-data.js');
  mocks.http.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await market.fetchPools('SOLANA'); vi.resetModules();
  const { requestPaperTokenMetadata: request } = await import('./paper-token-metadata.js');
  expect(await request('t', 'ROBINHOOD', address, NOW + 30000)).toBe('waiting_capacity');
  await vi.advanceTimersByTimeAsync(30000);
  expect(await request('t', 'ROBINHOOD', address, NOW + 30000)).toBe('expired');
  expect(mocks.http).toHaveBeenCalledTimes(1);
});
