// Separate V8 heap for the real PostgreSQL regression. No provider or worker timers.
import assert from 'node:assert/strict';
import { requireE2eDatabaseUrl } from './e2e-database.js';
process.env.DATABASE_URL = requireE2eDatabaseUrl();
globalThis.fetch = async () => { throw new Error('EXTERNAL_TRANSPORT_FORBIDDEN'); };
const { prisma } = await import('../lib/prisma.js');
const { walletLedgerRepo } = await import('../workers/wallet-ledger-repo.js');
const { rebuildWallet } = await import('../workers/wallet-ledger-core.js');
const { walletPnlForWallets } = await import('../services/wallet-pnl.js');
const { assessCoverage } = await import('@memex/core');
const wallet = '0x' + 'b'.repeat(40);
try {
  const result = await rebuildWallet('BNB', wallet, {
    repo: walletLedgerRepo,
    history: { fetch: async () => ({ trades: [], coverage: assessCoverage({
      trades: [], pagesFetched: 1, cursorExhausted: true, pageLimitReached: false,
    }) }) },
  });
  assert.equal(result.totalTrades, 160_184);
  assert.equal(result.newTrades, 0);
  assert.equal(result.incompleteTokens, 0);
  const snapshot = (await walletPnlForWallets([{ chain: 'BNB', address: wallet }])).get(`BNB:${wallet}`)!;
  assert.equal(snapshot.state, 'pending'); // No invented price for these test tokens.
  assert.equal(snapshot.openPositions, 400);
  assert.equal(snapshot.realizedUsd, '0');
  assert.equal(snapshot.assetsUsd, null);
  console.log(JSON.stringify({ totalTrades: result.totalTrades, openPositions: snapshot.openPositions,
    maxRssKb: process.resourceUsage().maxRSS, heapUsed: process.memoryUsage().heapUsed }));
} finally { await prisma.$disconnect(); }
