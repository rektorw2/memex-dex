import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun } from './harness.js';
// Only independent network-readiness facts are fixed. The worker, metadata
// service, limiter, HTTP response parsing and PostgreSQL gate are real.
vi.mock('../services/agent-networks.js', () => ({ isAgentNetworkReady: () => true, readyAgentNetworks: () => ['SOLANA', 'BNB', 'ROBINHOOD'] }));
let restore: () => void;
let worker: typeof import('../workers/paper-agent.js');
let date: string | null;
let wrongPool = false;
let calls: string[];
const address = '0x03d148407da8696888d154a00ac02d5182756f0a';
beforeEach(async () => {
  restore = forbidNetwork(); await resetData(); await prisma.paperMetadataGate.deleteMany();
  await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  vi.resetModules(); worker = await import('../workers/paper-agent.js'); worker.setPaperAgentEnabledCache(true);
  worker.setPaperSignalSourceProbe(() => ({ configured: true, transportMode: 'WEBSOCKET', socketHealthy: true, channelDeniedCode: null, lastRestSuccessAtMs: Date.now(), lastRestErrorCode: null, restIntervalMs: 60000, startedAtMs: Date.now() - 600000, nowMs: Date.now() }));
  date = new Date(Date.now() - 60_000).toISOString(); wrongPool = false; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url).toContain(`/networks/robinhood/tokens/${address}/pools`); calls.push(url);
    return new Response(JSON.stringify({ data: [{ attributes: { address: 'pool', reserve_in_usd: '10000', pool_created_at: date }, relationships: { base_token: { data: { id: `robinhood_${wrongPool ? 'unrelated' : address}` } }, quote_token: { data: { id: 'robinhood_quote' } } } }], included: [] }));
  }));
});
afterEach(async () => { worker.setPaperSignalSourceProbe(null); await expectNoSigningOrBroadcast(); vi.unstubAllGlobals(); restore(); });
afterAll(async () => { await prisma.$disconnect(); });
async function fixture() {
  const now = new Date(); const token = await createToken({ priceUsd: 1, poolCreatedAt: null }, now);
  const signal = await emitSignal({ tokenId: token.id, priceUsd: 1 }, now);
  await prisma.token.update({ where: { id: token.id }, data: { chain: 'ROBINHOOD', address } });
  await prisma.okxSignal.update({ where: { id: signal.id }, data: { chain: 'ROBINHOOD', address, ingestOrigin: 'WEBSOCKET_LIVE' } });
  return { token, signal };
}
async function completed() {
  await vi.waitFor(async () => {
    const row = await prisma.paperMetadataGate.findUniqueOrThrow({ where: { id: 1 } });
    expect((row.state as any).requests[0].completed).toBe(true);
  });
}
it('Robinhood worker → actual metadata service → real HTTP adapter → PostgreSQL → one PAPER entry', async () => {
  const { token, signal } = await fixture(); await worker.processPaperAgentSignal(signal.id); await completed();
  expect(calls).toHaveLength(1);
  expect((await prisma.token.findUniqueOrThrow({ where: { id: token.id } })).poolCreatedAt?.toISOString()).toBe(date);
  await worker.runPaperAgentTickOnce(); expect((await baselineRun(signal.id)).state).toBe('PAPER_OPEN');
  const opened = await baselineRun(signal.id);
  const buys = await prisma.paperAgentNotification.count({ where: { runId: opened.id, eventType: 'PAPER_BUY' } });
  await worker.processPaperAgentSignal(signal.id); await worker.runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).id).toBe(opened.id);
  expect(await prisma.paperAgentAllocation.count({ where: { runId: opened.id, isShadow: false, state: 'OPEN' } })).toBe(1);
  expect(await prisma.paperAgentNotification.count({ where: { runId: opened.id, eventType: 'PAPER_BUY' } })).toBe(buys);
  expect(calls).toHaveLength(1);
});
it.each(['missing', 'unrelated', 'old'] as const)('%s pool date cannot bypass age/deadline filters or rewrite the final decision', async reason => {
  const { token, signal } = await fixture();
  if (reason === 'missing') date = null;
  if (reason === 'unrelated') wrongPool = true;
  if (reason === 'old') date = new Date(Date.now() - 86400000).toISOString();
  await worker.processPaperAgentSignal(signal.id); await completed();
  if (reason !== 'old') {
    expect((await prisma.token.findUniqueOrThrow({ where: { id: token.id } })).poolCreatedAt).toBeNull();
    await prisma.okxSignal.update({ where: { id: signal.id }, data: { signaledAt: new Date(Date.now() - 31000) } });
  }
  await worker.runPaperAgentTickOnce(); const final = await baselineRun(signal.id); expect(final.state).toBe('SKIPPED');
  await prisma.token.update({ where: { id: token.id }, data: { poolCreatedAt: new Date(Date.now() - 60000) } });
  await worker.processPaperAgentSignal(signal.id); await worker.runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).decidedAt).toEqual(final.decidedAt); expect(calls).toHaveLength(1);
});

it('real PostgreSQL provider budget serializes separate limiters and persists Retry-After through restart', async () => {
  const { GeckoRateLimiter } = await import('../services/gecko-admission.js');
  const a = new GeckoRateLimiter(), b = new GeckoRateLimiter();
  const deadline = Date.now() + 30000;
  expect((await Promise.all([a.tryTake(deadline), b.tryTake(deadline)])).sort()).toEqual([false, true]);
  await a.backoff(120000);
  const restarted = new GeckoRateLimiter(); expect(await restarted.tryTake(deadline)).toBe(false);
  const state = (await prisma.paperMetadataGate.findUniqueOrThrow({ where: { id: 1 } })).state as any;
  expect(state.provider.blockedUntil).toBeGreaterThan(Date.now() + 119000);
  expect(calls).toHaveLength(0);
});

it('REST round and Retry-After share PostgreSQL across processes and survive metadata bookkeeping', async () => {
  const { claimSharedSignalPoll, finishSharedSignalPoll } = await import('../services/signal-rest-schedule.js');
  const { GeckoRateLimiter } = await import('../services/gecko-admission.js');
  const outcomes = await Promise.all(['one','two'].map(owner => claimSharedSignalPoll(['SOL','BNB'],3000,owner)));
  expect(outcomes.filter(o => o.chain != null)).toHaveLength(1);
  const owner = outcomes[0]!.chain != null ? 'one' : 'two';
  const blocked = Date.now() + 120000; await finishSharedSignalPoll(owner,3000,blocked);
  await new GeckoRateLimiter().tryTake(Date.now()+30000);
  expect(await claimSharedSignalPoll(['SOL','BNB'],3000,'restarted')).toEqual({chain:null,blockedUntil:blocked});
  expect(calls).toHaveLength(0);
});
