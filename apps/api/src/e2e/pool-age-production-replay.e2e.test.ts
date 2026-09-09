import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun } from './harness.js';

vi.mock('../services/agent-networks.js', () => ({ isAgentNetworkReady: () => true, readyAgentNetworks: () => ['SOLANA', 'BNB', 'ROBINHOOD'] }));
const address = '0xc1a0fe7b31fd287c23d81bdeac859e3aa1e67d66';
// Public Gecko response captured 2026-09-09 21:00:52 UTC; production signal
// arrived at 20:57:05.294 with 4202 ms delivery delay. Only wall-clock dates
// are translated so the same pool age is replayable against a real DB clock.
const captured = JSON.parse(readFileSync(new URL('../test-support/fixtures/stepz-gecko-pools.json', import.meta.url), 'utf8'));
const capturedArrival = Date.parse('2026-09-09T20:57:05.294Z');
let restore: () => void;
let worker: typeof import('../workers/paper-agent.js');
let payload: typeof captured;
let poolDate: Date;
let now: Date;
let requests: string[];
beforeEach(async () => {
  restore = forbidNetwork(); await resetData(); await prisma.paperMetadataGate.deleteMany();
  await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  vi.resetModules(); worker = await import('../workers/paper-agent.js');
  worker.setPaperSignalSourceProbe(() => ({ configured: true, transportMode: 'WEBSOCKET', socketHealthy: true, channelDeniedCode: null, lastRestSuccessAtMs: Date.now(), lastRestErrorCode: null, restIntervalMs: 60000, startedAtMs: Date.now() - 600000, nowMs: Date.now() }));
  now = new Date(); requests = []; payload = structuredClone(captured);
  for (const pool of payload.data) pool.attributes.pool_created_at = new Date(now.getTime() + Date.parse(pool.attributes.pool_created_at) - capturedArrival).toISOString();
  poolDate = new Date(payload.data[0].attributes.pool_created_at);
});
afterEach(async () => { worker.setPaperSignalSourceProbe(null); await expectNoSigningOrBroadcast(); vi.unstubAllGlobals(); restore(); });
afterAll(async () => { await prisma.$disconnect(); });
async function fixture() {
  const token = await createToken({ priceUsd: 1, poolCreatedAt: null }, now);
  const signal = await emitSignal({ tokenId: token.id, priceUsd: 1 }, now);
  await prisma.token.update({ where: { id: token.id }, data: { chain: 'ROBINHOOD', address } });
  await prisma.okxSignal.update({ where: { id: signal.id }, data: { chain: 'ROBINHOOD', address, ingestOrigin: 'WEBSOCKET_LIVE', amountUsd: '1502.0466615', signaledAt: new Date(now.getTime() - 4202), receivedAt: now } });
  return { token, signal };
}
it('STEPZ captured provider response is parsed, saved and permits exactly one timely PAPER entry', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url); expect(url).toContain(`/robinhood/tokens/${address}/pools`);
    return new Response(JSON.stringify(payload));
  }));
  const { token, signal } = await fixture();
  await worker.processPaperAgentSignal(signal.id);
  await vi.waitFor(async () => expect((await prisma.token.findUniqueOrThrow({ where: { id: token.id } })).poolCreatedAt).toEqual(poolDate));
  await worker.runPaperAgentTickOnce();
  const opened = await baselineRun(signal.id);
  expect(opened.state).toBe('PAPER_OPEN');
  expect(opened.poolCreatedAt).toEqual(poolDate);
  expect(opened.tokenAgeMs).toBeGreaterThanOrEqual(369294);
  expect(opened.tokenAgeMs).toBeLessThan(15 * 60_000);
  await worker.processPaperAgentSignal(signal.id); await worker.runPaperAgentTickOnce();
  expect(requests).toHaveLength(1);
  expect(await prisma.paperAgentAllocation.count({ where: { runId: opened.id, state: 'OPEN', isShadow: false } })).toBe(1);
});
it('STEPZ during shared Gecko 429 cannot obtain metadata before its deadline and must not reopen later', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return new Response('', { status: 429, headers: { 'retry-after': '60' } }); }));
  const market = await import('../services/market-data.js');
  await market.fetchPools('BASE');
  const { token, signal } = await fixture();
  await worker.processPaperAgentSignal(signal.id);
  await worker.runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).decisionCode).toBe('WAITING_FOR_TOKEN_METADATA');
  expect((await prisma.token.findUniqueOrThrow({ where: { id: token.id } })).poolCreatedAt).toBeNull();
  expect(requests).toHaveLength(1);
  // Advance this isolated signal beyond its original window without waiting
  // in real time or relaxing the production deadline.
  await prisma.okxSignal.update({ where: { id: signal.id }, data: { signaledAt: new Date(Date.now() - 31000) } });
  await worker.runPaperAgentTickOnce();
  const skipped = await baselineRun(signal.id);
  expect(skipped.state).toBe('SKIPPED');
  expect(skipped.decisionCode).toBe('DECISION_DEADLINE_EXCEEDED');
  await prisma.token.update({ where: { id: token.id }, data: { poolCreatedAt: poolDate } });
  await worker.processPaperAgentSignal(signal.id); await worker.runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).decidedAt).toEqual(skipped.decidedAt);
  expect(await prisma.paperAgentAllocation.count({ where: { runId: skipped.id, state: 'OPEN' } })).toBe(0);
  expect(requests).toHaveLength(1);
});

it('a social-enrichment 429 persists in PostgreSQL and blocks metadata after service restart', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url); expect(url).toContain('/networks/solana/tokens/mint/info');
    return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  }));
  const socials = await import('../services/token-intel.js');
  await socials.fetchSocialFacts('SOLANA', 'mint');
  const { token } = await fixture();
  vi.resetModules();
  const restarted = await import('../services/paper-token-metadata.js');
  expect(await restarted.requestPaperTokenMetadata(token.id, 'ROBINHOOD', address, Date.now() + 25_000)).toBe('waiting_capacity');
  expect(requests).toHaveLength(1);
  const gate = await prisma.paperMetadataGate.findUniqueOrThrow({ where: { id: 1 } });
  expect((gate.state as any).provider.blockedUntil).toBeGreaterThan(Date.now() + 115_000);
  expect((await prisma.token.findUniqueOrThrow({ where: { id: token.id } })).poolCreatedAt).toBeNull();
});
