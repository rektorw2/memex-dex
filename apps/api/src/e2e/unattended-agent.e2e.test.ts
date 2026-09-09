import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun } from './harness.js';

// Only the external price provider is replaced. No browser, API request,
// manual token price update or hot-token registration drives this scenario.
const provider = vi.hoisted(() => ({ price: 1.5, requests: [] as unknown[] }));
vi.mock('../services/okx-market.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/okx-market.js')>(),
  fetchLivePrices: async (tokens: Array<{ chain: string; address: string }>) => {
    provider.requests.push(tokens);
    return {
      prices: new Map(tokens.map(t => [`${t.chain}:${t.address}`, { priceUsd: provider.price, at: new Date() }])),
      report: { requested: tokens.length, fetched: tokens.length, missing: 0, transient: 0, rateLimited: 0, retryAfterMs: null },
    };
  },
}));
const worker = await import('../workers/paper-agent.js');
const prices = await import('../workers/price-updater.js');
const hot = await import('../workers/hot-tokens.js');
let restore: () => void;
beforeEach(async () => {
  restore = forbidNetwork();
  await resetData();
  await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  hot.resetHotTokensForTests();
  prices.resetPriceUpdaterForTests();
  provider.price = 1.5;
  provider.requests = [];
});
afterEach(async () => { await expectNoSigningOrBroadcast(); restore(); });
afterAll(async () => { await prisma.$disconnect(); });

it('PAPER entry, fresh prices and capital exit work with zero visitors, including after hot-cache loss', async () => {
  const now = new Date();
  const token = await createToken({ priceUsd: 1 }, now);
  const signal = await emitSignal({ tokenId: token.id, priceUsd: 1 }, now);
  // The regular database reconciliation discovers the signal without a UI queue push.
  await worker.runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).state).toBe('PAPER_OPEN');
  expect(hot.hotTokens()).toEqual([]);

  expect((await prices.updateHotPrices()).written).toBe(1);
  await worker.runPaperAgentTickOnce();
  const marked = await baselineRun(signal.id);
  expect(marked.state).toBe('PAPER_OPEN');
  expect(Number(marked.currentSourcePriceUsd)).toBe(1.5);
  expect(Number(marked.unrealizedPnlUsd)).toBeGreaterThan(0);

  hot.resetHotTokensForTests();
  prices.resetPriceUpdaterForTests();
  provider.price = 3;
  expect((await prices.updateHotPrices()).written).toBe(1);
  await worker.runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).state).toBe('PAPER_CLOSED');
  expect(await prisma.paperAgentAllocation.count({ where: { runId: marked.id, state: 'OPEN' } })).toBe(0);
  expect(await prisma.paperAgentAllocation.count({ where: { runId: marked.id, state: 'CLOSED' } })).toBeGreaterThan(0);

  // Closed positions do not keep spending quota when nobody is watching.
  const requests = provider.requests.length;
  expect((await prices.updateHotPrices()).written).toBe(0);
  await worker.runPaperAgentTickOnce();
  expect(provider.requests).toHaveLength(requests);
  expect((await baselineRun(signal.id)).state).toBe('PAPER_CLOSED');
});
