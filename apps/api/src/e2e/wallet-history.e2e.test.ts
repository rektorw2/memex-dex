import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { calculateWalletLedger } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { loadWalletHistory } from '../services/wallet-history.js';
import { walletLedgerRepo } from '../workers/wallet-ledger-repo.js';
import { walletPnlForWallets } from '../services/wallet-pnl.js';

const wallet = '0x' + 'c'.repeat(40);
const largeWallet = '0x' + 'b'.repeat(40);
const where = { chain: 'BNB' as const, walletAddress: wallet, reconciliation: { in: ['canonical', 'confirmed'] } };
const fixtureWhere = { walletAddress: { in: [wallet, largeWallet] }, key: { startsWith: 'memory-e2e-' } };
beforeAll(async () => {
  await prisma.walletEconomicTrade.deleteMany({ where: fixtureWhere });
  await prisma.walletEconomicTrade.createMany({ data: Array.from({ length: 1002 }, (_, i) => ({
    key: `memory-e2e-small-${String(i).padStart(6, '0')}`, chain: 'BNB', walletAddress: wallet,
    tokenAddress: '0x' + 'd'.repeat(40), side: i < 1001 ? 'BUY' : 'SELL',
    amount: i < 1001 ? '10' : '10010', valueUsd: i < 1001 ? '100' : '120120', price: i < 1001 ? '10' : '12',
    tradedAt: new Date(Date.parse('2026-09-01') + (i < 1001 ? 0 : 1000)),
  })) });
});
afterAll(async () => {
  await prisma.walletEconomicTrade.deleteMany({ where: fixtureWhere });
  await prisma.$disconnect();
});

it('preserves full history and exact realized PnL through the worker repository and public service', async () => {
  const trades = await walletLedgerRepo.loadCanonicalTrades('BNB', wallet);
  expect(trades).toHaveLength(1002);
  expect(new Set(trades.map(t => t.key)).size).toBe(1002);
  const ledger = calculateWalletLedger(trades);
  expect(ledger.realizedUsd).toBe('20020');
  expect(ledger.closedPositions).toBe(1);
  const snapshot = (await walletPnlForWallets([{ chain: 'BNB', address: wallet }])).get(`BNB:${wallet}`)!;
  expect(snapshot).toMatchObject({ state: 'available', realizedUsd: '20020', assetsUsd: '0', openPositions: 0 });
});

it('keeps one real MVCC snapshot when an unread trade changes and an earlier fill arrives between pages', async () => {
  const writer = new PrismaClient();
  let reads = 0;
  const laterKey = 'memory-e2e-small-001000';
  const lateKey = 'memory-e2e-late';
  const reader = new PrismaClient().$extends({ query: { walletEconomicTrade: {
    async findMany({ args, query }) {
      const page = await query(args);
      if (++reads === 1) {
        await writer.walletEconomicTrade.update({ where: { key: laterKey }, data: { reconciliation: 'superseded' } });
        await writer.walletEconomicTrade.create({ data: {
          key: lateKey, chain: 'BNB', walletAddress: wallet, tokenAddress: '0x' + 'd'.repeat(40),
          side: 'BUY', amount: '10', valueUsd: '100', price: '10', tradedAt: new Date('2026-08-31'),
        } });
      }
      return page;
    },
  } } });
  try {
    const snapshot = await loadWalletHistory(where, reader as unknown as PrismaClient);
    expect(reads).toBe(2);
    expect(snapshot).toHaveLength(1002);
    expect(snapshot.some(t => t.key === laterKey)).toBe(true);
    expect(snapshot.some(t => t.key === lateKey)).toBe(false);
    expect(calculateWalletLedger(snapshot).realizedUsd).toBe('20020');
    const next = await loadWalletHistory(where);
    expect(next.some(t => t.key === laterKey)).toBe(false);
    expect(next.some(t => t.key === lateKey)).toBe(true);
  } finally { await writer.$disconnect(); await reader.$disconnect(); }
});

it('processes 160184 real PostgreSQL rows in a separate 256 MB V8 heap without truncation', async () => {
  await prisma.$executeRawUnsafe(`INSERT INTO "WalletEconomicTrade"
    ("key","chain","walletAddress","tokenAddress","tokenSymbol","side","amount","valueUsd","price","marketCapUsd","providerPnlUsd","tradedAt","updatedAt")
    SELECT 'memory-e2e-large-' || i || repeat('x',130), 'BNB', $1,
      '0x' || lpad((i % 400)::text,40,'0'), 'TEST', 'BUY',
      100.123456789012345678, 200.1234567890, 2.00123456789012345678, 10000, 0,
      TIMESTAMP '2026-09-01' + i * INTERVAL '1 second', NOW()
    FROM generate_series(1,160184) i`, largeWallet);
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--max-old-space-size=256', '--import', 'tsx',
    fileURLToPath(new URL('./wallet-history-memory-process.ts', import.meta.url)),
  ], { env: process.env, timeout: 110_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.totalTrades).toBe(160184);
  expect(result.openPositions).toBe(400);
  expect(result.maxRssKb).toBeLessThan(768 * 1024);
}, 120_000);
