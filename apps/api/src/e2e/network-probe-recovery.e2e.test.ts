import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/env.js', async original => {
  const actual = await original<typeof import('../lib/env.js')>();
  return { ...actual, env: { ...actual.env, BNB_RPC_URL: 'https://probe-bnb.test', RHC_RPC_URL: 'https://probe-rh.test', RHC_CHAIN_ID: 4663 } };
});
import { prisma } from '../lib/prisma.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun } from './harness.js';
import { refreshEvmProbes, resetEvmProbesForTests } from '../services/evm-chain-probe.js';
import { setOkxMarketChainIndexes, setOkxSignalChainIndexes } from '../services/okx-market.js';
import { runPaperAgentTickOnce, processPaperAgentSignal } from '../workers/paper-agent.js';
import { createServer } from 'node:http';
import { env } from '../lib/env.js';
import { evmProbeState } from '../services/evm-chain-probe.js';

const nativeFetch = globalThis.fetch;

let restore: () => void;
let now: number;
let failing: boolean;
beforeEach(async () => {
  restore = forbidNetwork();
  await resetData(); await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  resetEvmProbesForTests();
  setOkxSignalChainIndexes(['501', '56', '4663']); setOkxMarketChainIndexes(['501', '56', '4663']);
  failing = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(['https://probe-bnb.test', 'https://probe-rh.test']).toContain(url);
    return new Response(JSON.stringify({ result: url.includes('rh') ? '0x1237' : '0x38' }), { status: failing && url.includes('rh') ? 503 : 200 });
  }));
});
afterEach(async () => {
  await expectNoSigningOrBroadcast(); vi.useRealTimers(); vi.unstubAllGlobals(); restore();
  resetEvmProbesForTests(); setOkxMarketChainIndexes(null); setOkxSignalChainIndexes(null);
});
afterAll(async () => { await prisma.$disconnect(); });

it.each([15_000, 35_000])('real network readiness and PAPER worker recover after RPC failure at %i ms without extending the signal deadline', async delay => {
  const token = await createToken({ priceUsd: 1 }, new Date(now));
  const signal = await emitSignal({ tokenId: token.id, priceUsd: 1 }, new Date(now));
  const address = '0x03d148407da8696888d154a00ac02d5182756f0a';
  await prisma.token.update({ where: { id: token.id }, data: { chain: 'ROBINHOOD', address } });
  await prisma.okxSignal.update({ where: { id: signal.id }, data: { chain: 'ROBINHOOD', address } });
  await refreshEvmProbes();
  await processPaperAgentSignal(signal.id);
  expect(await prisma.paperAgentRun.count({ where: { signalId: signal.id } })).toBe(0);
  expect((await prisma.okxSignal.findUniqueOrThrow({ where: { id: signal.id } })).paperAgentIngestCode).toBe('NETWORK_NOT_READY');
  failing = false; vi.setSystemTime(now + delay);
  await refreshEvmProbes(); await runPaperAgentTickOnce();
  const result = await baselineRun(signal.id);
  expect(result.state).toBe(delay < 30_000 ? 'PAPER_OPEN' : 'SKIPPED');
  if (delay > 30_000) expect(result.decisionCode).toBe('DECISION_DEADLINE_EXCEEDED');
  await processPaperAgentSignal(signal.id); await runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).id).toBe(result.id);
  expect(await prisma.paperAgentAllocation.count({ where: { runId: result.id, isShadow: false, state: 'OPEN' } })).toBe(delay < 30_000 ? 1 : 0);
  // Loss of the process-local probe cache never restores an old signal's deadline.
  resetEvmProbesForTests(); vi.setSystemTime(now + 40_000);
  await refreshEvmProbes(); await runPaperAgentTickOnce();
  const restored = await baselineRun(signal.id);
  expect(restored.id).toBe(result.id);
  expect(restored.state).toBe(result.state);
  expect(restored.decidedAt).toEqual(result.decidedAt);
  expect(await prisma.paperAgentCapitalLedger.count({ where: { allocation: { runId: result.id, isShadow: false }, eventType: 'OPEN' } })).toBe(delay < 30_000 ? 1 : 0);
});

it.each([
  { label: 'wrong network', payload: { result: '0x38' }, state: 'MISMATCH' },
  { label: 'malformed matching prefix', payload: { result: '0x1237junk' }, state: 'FAILED' },
  { label: 'RPC error with result', payload: { result: '0x1237', error: { code: -32603 } }, state: 'FAILED' },
])('$label cannot admit a PAPER position; a later genuine confirmation can', async ({ payload, state }) => {
  const token = await createToken({ priceUsd: 1 }, new Date(now));
  const signal = await emitSignal({ tokenId: token.id, priceUsd: 1 }, new Date(now));
  const address = '0x03d148407da8696888d154a00ac02d5182756f0a';
  await prisma.token.update({ where: { id: token.id }, data: { chain: 'ROBINHOOD', address } });
  await prisma.okxSignal.update({ where: { id: signal.id }, data: { chain: 'ROBINHOOD', address } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(['https://probe-bnb.test', 'https://probe-rh.test']).toContain(url);
    return new Response(JSON.stringify(url.includes('rh') ? payload : { result: '0x38' }));
  }));
  await refreshEvmProbes(); await runPaperAgentTickOnce();
  expect(evmProbeState('ROBINHOOD').state).toBe(state);
  expect(await prisma.paperAgentRun.count({ where: { signalId: signal.id } })).toBe(0);
  expect(await prisma.paperAgentCapitalLedger.count({ where: { eventType: 'OPEN' } })).toBe(0);
  vi.setSystemTime(now + 15_000);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url).toBe('https://probe-rh.test');
    return new Response(JSON.stringify({ result: '0x1237' }));
  }));
  await refreshEvmProbes(); await runPaperAgentTickOnce();
  const opened = await baselineRun(signal.id);
  expect(opened.state).toBe('PAPER_OPEN');
  await runPaperAgentTickOnce();
  expect(await prisma.paperAgentAllocation.count({ where: { runId: opened.id, isShadow: false } })).toBe(1);
});

it.each(['headers', 'body'])('native fetch aborts stalled %s in 8 seconds and permits a later retry', async stage => {
  const originalUrls = { bnb: env.BNB_RPC_URL, rh: env.RHC_RPC_URL };
  let recovered = false;
  let bnbRequests = 0;
  let rhRequests = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/bnb') bnbRequests++; else rhRequests++;
    if (req.url === '/rh' && !recovered) {
      if (stage === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"result":');
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: req.url === '/bnb' ? '0x38' : '0x1237' }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    env.BNB_RPC_URL = `http://127.0.0.1:${port}/bnb`;
    env.RHC_RPC_URL = `http://127.0.0.1:${port}/rh`;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      expect([env.BNB_RPC_URL, env.RHC_RPC_URL]).toContain(url);
      expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
      return nativeFetch(url, init);
    }));
    const started = performance.now();
    await Promise.all([refreshEvmProbes(), refreshEvmProbes()]);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(7_900);
    expect(elapsed).toBeLessThan(12_000);
    expect(evmProbeState('ROBINHOOD').state).toBe('FAILED');
    expect(evmProbeState('BNB').state).toBe('VERIFIED');
    expect([bnbRequests, rhRequests]).toEqual([1, 1]);
    recovered = true;
    vi.setSystemTime(now + 15_000);
    await refreshEvmProbes();
    expect(evmProbeState('ROBINHOOD').state).toBe('VERIFIED');
    expect([bnbRequests, rhRequests]).toEqual([1, 2]);
  } finally {
    env.BNB_RPC_URL = originalUrls.bnb; env.RHC_RPC_URL = originalUrls.rh;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20_000);
