import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { metadataGateDatabase } from '../test-support/metadata-gate.js';
const gate = metadataGateDatabase();
const mocks = vi.hoisted(() => ({ fetchPool:vi.fn(), update:vi.fn() }));
vi.mock('./market-data.js', () => ({ fetchPoolForToken:mocks.fetchPool, reservePoolMetadataSlot: () => true }));
vi.mock('../lib/prisma.js', () => ({ prisma:{token:{updateMany:mocks.update}, $queryRaw: (...args: any[]) => (gate.$queryRaw as any)(...args), $executeRaw: (...args: any[]) => (gate.$executeRaw as any)(...args), $transaction: (fn: any) => gate.transaction(() => fn({ $queryRaw:gate.$queryRaw, $executeRaw:gate.$executeRaw }))} }));
vi.mock('../lib/logger.js', () => ({logger:{debug:vi.fn()}}));
beforeEach(() => {gate.reset();vi.resetModules();vi.useFakeTimers();vi.clearAllMocks();mocks.update.mockResolvedValue({count:1});});
afterEach(() => vi.useRealTimers());
const flush = async () => {for(let i=0;i<40;i++) await Promise.resolve();};
it('only valid provider pool date fills missing metadata; prices are untouched', async () => {
  const date=new Date(Date.now()-60_000);mocks.fetchPool.mockResolvedValue({poolCreatedAt:date,priceUsd:99});
  const {requestPaperTokenMetadata:request}=await import('./paper-token-metadata.js');
  await request('t','SOLANA','mint',Date.now()+30_000);await flush();
  expect(mocks.update).toHaveBeenCalledWith({where:{id:'t',chain:'SOLANA',address:'mint',poolCreatedAt:null},data:{poolCreatedAt:date}});
});
it.each([null,new Date(NaN),new Date('2100-01-01'),new Date(0)])('unknown/invalid/future pool dates never substitute first observation: %s', async date => {
  mocks.fetchPool.mockResolvedValue({poolCreatedAt:date});
  const {requestPaperTokenMetadata:request}=await import('./paper-token-metadata.js');
  await request('t','SOLANA','mint',Date.now()+30_000);await flush();expect(mocks.update).not.toHaveBeenCalled();
});
it('deduplicates five strategies and simultaneous signals; never builds an unbounded queue', async () => {
  mocks.fetchPool.mockImplementation(()=>new Promise(()=>{}));
  const {requestPaperTokenMetadata:request}=await import('./paper-token-metadata.js');
  for(let i=0;i<200;i++)await request('t','SOLANA','mint',Date.now()+30_000);
  expect(mocks.fetchPool).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5_000);await request('u','BNB','0xa',Date.now()+30_000);
  vi.advanceTimersByTime(5_000);expect(await request('v','BNB','0xb',Date.now()+30_000)).toBe('waiting_capacity');
  expect(mocks.fetchPool).toHaveBeenCalledTimes(2);
});
it('metadata provider failure is bounded and does not reject the worker', async () => {
  mocks.fetchPool.mockRejectedValue(new Error('timeout'));
  const {requestPaperTokenMetadata:request}=await import('./paper-token-metadata.js');
  await request('t','SOLANA','mint',Date.now()+30_000);await flush();await request('t','SOLANA','mint',Date.now()+30_000);
  expect(mocks.fetchPool).toHaveBeenCalledTimes(1);expect(mocks.update).not.toHaveBeenCalled();
});

it('different tokens acquire freed capacity; repeated strategies and separate module instances share admission', async () => {
  mocks.fetchPool.mockImplementation(()=>new Promise(()=>{}));
  const first = await import('./paper-token-metadata.js');
  vi.resetModules(); const second = await import('./paper-token-metadata.js');
  const deadline=Date.now()+30_000;
  const results = await Promise.all([first.requestPaperTokenMetadata('a','BNB','a',deadline),second.requestPaperTokenMetadata('a','BNB','a',deadline)]);
  expect(results.sort()).toEqual(['accepted','in_flight']);
  expect(await second.requestPaperTokenMetadata('b','BNB','b',deadline)).toBe('waiting_capacity');
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await second.requestPaperTokenMetadata('b','BNB','b',deadline)).toBe('accepted');
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await first.requestPaperTokenMetadata('c','BNB','c',deadline)).toBe('waiting_capacity');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await first.requestPaperTokenMetadata('c','BNB','c',deadline)).toBe('accepted');
  expect(mocks.fetchPool).toHaveBeenCalledTimes(3);
});
it('unfinished attempt can recover only once; expired caller never joins a queue', async () => {
  mocks.fetchPool.mockImplementation(()=>new Promise(()=>{}));
  const {requestPaperTokenMetadata:request}=await import('./paper-token-metadata.js');
  const deadline=Date.now()+50_000;
  expect(await request('t','BNB','a',deadline)).toBe('accepted');
  await vi.advanceTimersByTimeAsync(16_000);
  expect(await request('t','BNB','a',deadline)).toBe('accepted');
  await vi.advanceTimersByTimeAsync(16_000);
  expect(await request('t','BNB','a',deadline)).toBe('exhausted');
  expect(await request('u','BNB','u',Date.now())).toBe('expired');
  expect(mocks.fetchPool).toHaveBeenCalledTimes(2);
});

it('sustained arrivals prune the durable ledger instead of creating an infinite queue', async () => {
  mocks.fetchPool.mockResolvedValue(null);
  const {requestPaperTokenMetadata:request}=await import('./paper-token-metadata.js');
  for(let i=0;i<50;i++) {
    expect(await request(`token-${i}`,'BNB',`address-${i}`,Date.now()+30_000)).toBe('accepted');
    await flush();
    expect(gate.snapshot().requests.length).toBeLessThanOrEqual(12);
    await vi.advanceTimersByTimeAsync(5_000);
  }
  expect(mocks.fetchPool).toHaveBeenCalledTimes(50);
});
