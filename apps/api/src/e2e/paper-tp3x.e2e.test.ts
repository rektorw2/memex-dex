import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { paperExitPlan, type PaperExitMode } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { configurePaperAllocationAccounts, settlePaperAllocation } from '../services/paper-agent-allocation.js';
import { queuePaperAgentSignal, runPaperAgentTickOnce } from '../workers/paper-agent.js';
import { activeSession, agentServer, baselineRun, createToken, emitSignal, expectNoSigningOrBroadcast, forbidNetwork, paperAgentSnapshot, resetData, setPrice, setupPaperAgent } from './harness.js';
import { requireE2eDatabaseUrl } from './e2e-database.js';

let restore: () => void;
beforeEach(async () => {
  restore = forbidNetwork(); await resetData(); await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  await prisma.user.upsert({ where: { id: 'e2e-admin' }, create: { id: 'e2e-admin', email: 'tp3x@example.invalid', passwordHash: 'test-only', role: 'ADMIN' }, update: {} });
});
afterEach(async () => { await expectNoSigningOrBroadcast(); restore(); });
afterAll(async () => prisma.$disconnect());

async function save(mode: PaperExitMode) {
  const server = await agentServer('ADMIN');
  try {
    const result = await server.inject({ method: 'PUT', url: '/admin/paper-agent/allocation', payload: { mode: 'FIXED', capitalUsd: '1000', maxOpenPositions: 4, exitMode: mode, confirm: true } });
    expect(result.statusCode, result.body).toBe(200);
  } finally { await server.close(); }
}
async function open() {
  const now = new Date(); const token = await createToken({ priceUsd: 1 }, now);
  const signal = await emitSignal({ tokenId: token.id, priceUsd: 1 }, now);
  queuePaperAgentSignal(signal.id); await runPaperAgentTickOnce();
  const run = await baselineRun(signal.id); expect(run.state).toBe('PAPER_OPEN');
  const allocation = await prisma.paperAgentAllocation.findFirstOrThrow({ where: { runId: run.id, isShadow: false }, include: { run: { include: { strategy: true } } } });
  return { token, signal, run, allocation };
}
async function mark(tokenId: string, price: number) { await setPrice(tokenId, price); await runPaperAgentTickOnce(); }
const row = (id: string) => prisma.paperAgentAllocation.findUniqueOrThrow({ where: { id } });
const fills = (id: string) => prisma.paperAgentCapitalLedger.findMany({ where: { allocationId: id }, orderBy: { createdAt: 'asc' } });

it.each(['TRAILING', 'TRAILING_PURE'] as const)('%s: body → TP3x → trailing → close; persisted volumes, fees and no reopening', async mode => {
  await save(mode); const { token, signal, allocation } = await open();
  const quantity = Number(allocation.entryQuantity);
  const target = new Prisma.Decimal(allocation.entryExecutionPriceUsd!).mul(3).toNumber();
  await mark(token.id, 2);
  expect((await row(allocation.id)).exitState).toMatchObject({ remainingPct: 50, legsFilled: 1 });
  await mark(token.id, target - .00001);
  expect((await fills(allocation.id)).filter(fill => fill.eventType === 'PARTIAL_EXIT')).toHaveLength(1);
  await mark(token.id, target);
  expect((await row(allocation.id)).exitState).toMatchObject({ remainingPct: 25, legsFilled: 2 });
  const afterTp = await row(allocation.id);
  const operations = (await fills(allocation.id)).filter(fill => fill.eventType === 'PARTIAL_EXIT');
  expect(operations).toHaveLength(2);
  const tp = (operations[1]!.metadata as any).execution;
  expect(tp.quantity).toBeCloseTo(quantity / 4, 10);
  expect(tp.targetPriceUsd).toBe(target);
  expect(tp.executionPriceUsd).toBeLessThan(target); // PAPER exit slippage, not execution at the target line.
  expect(tp.pnlUsd).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) { queuePaperAgentSignal(signal.id); await runPaperAgentTickOnce(); }
  expect((await row(allocation.id)).realizedPnlUsd).toEqual(afterTp.realizedPnlUsd);
  expect((await fills(allocation.id)).filter(fill => fill.eventType === 'PARTIAL_EXIT')).toHaveLength(2);
  await mark(token.id, 4); await mark(token.id, 2);
  const closed = await row(allocation.id);
  expect(closed).toMatchObject({ state: 'CLOSED', exitReason: 'TRAILING_STOP' });
  const allFills = await fills(allocation.id);
  expect(allFills.map(fill => fill.eventType)).toEqual(['OPEN', 'PARTIAL_EXIT', 'PARTIAL_EXIT', 'CLOSE']);
  const sold = allFills.filter(fill => fill.eventType !== 'OPEN');
  expect(sold.reduce((sum, fill) => sum + (fill.metadata as any).execution.quantity, 0)).toBeCloseTo(quantity, 10);
  expect(sold.reduce((sum, fill) => sum + (fill.metadata as any).execution.pnlUsd, 0)).toBeCloseTo(Number(closed.realizedPnlUsd), 7);
  const session = await prisma.paperAgentAccountSession.findUniqueOrThrow({ where: { id: allocation.sessionId } });
  expect(session.equityUsd.minus(session.initialCapitalUsd).toNumber()).toBeCloseTo(Number(session.realizedPnlUsd), 7);
  expect(session.inPositionsUsd.toString()).toBe('0');
  queuePaperAgentSignal(signal.id); await runPaperAgentTickOnce();
  expect((await row(allocation.id)).exitAt).toEqual(closed.exitAt);
  expect(await fills(allocation.id)).toHaveLength(4);
  const snapshot = await paperAgentSnapshot();
  const view = snapshot.tradePositions.find((position: any) => position.id === allocation.runId);
  expect(view.operations.map((fill: any) => fill.kind)).toEqual(['OPEN', 'PARTIAL_EXIT', 'PARTIAL_EXIT', 'CLOSE']);
  expect(view.remainingQuantity).toBe(0);
  expect(view.allocation.exit.nextTargetPriceUsd).toBeNull();
  expect(snapshot.phase4.live.enabled).toBe(false);
});

it('a gap sells body then half of the remainder in one execution at the observed price', async () => {
  await save('TRAILING'); const { token, allocation } = await open();
  await mark(token.id, 4);
  expect((await row(allocation.id)).exitState).toMatchObject({ remainingPct: 25, legsFilled: 2 });
  const partial = (await fills(allocation.id)).find(fill => fill.eventType === 'PARTIAL_EXIT')!;
  expect((partial.metadata as any).execution.quantity).toBeCloseTo(Number(allocation.entryQuantity) * .75, 10);
  expect((partial.metadata as any).execution.legs).toHaveLength(2);
  expect((partial.metadata as any).execution.executionPriceUsd).toBeCloseTo(3.96, 10);
});

it('saving the new profile preserves an already-open v1 plan and its body fixation', async () => {
  const legacy = { ...paperExitPlan('TRAILING_PURE'), version: 1 as const, legs: [{ multiple: 2, sellPct: 50 }] };
  await configurePaperAllocationAccounts({ mode: 'FIXED', capitalUsd: '1000', fixed: { maxOpenPositions: 4 }, exitPlan: legacy });
  const old = await open(); await mark(old.token.id, 2);
  await save('TRAILING_PURE'); await mark(old.token.id, 3.5);
  expect((await row(old.allocation.id)).exitPlan).toEqual(legacy);
  expect((await row(old.allocation.id)).exitState).toMatchObject({ remainingPct: 50, legsFilled: 1 });
  const fresh = await open(); expect(fresh.allocation.exitPlan).toEqual(paperExitPlan('TRAILING_PURE'));
  expect(fresh.allocation.sessionId).not.toBe(old.allocation.sessionId);
});

it('a delayed worker snapshot cannot undo or repeat a committed partial exit', async () => {
  await save('TRAILING'); const { allocation } = await open();
  expect((await settlePaperAllocation(allocation as any, 2, new Date())).outcome).toBe('PARTIAL');
  const before = await row(allocation.id);
  expect((await settlePaperAllocation(allocation as any, 1.5, new Date())).outcome).toBe('CONFLICT');
  expect((await settlePaperAllocation(allocation as any, 4, new Date())).outcome).toBe('CONFLICT');
  expect((await row(allocation.id)).exitState).toEqual(before.exitState);
  expect(await fills(allocation.id)).toHaveLength(2);
});

async function separateProcess() {
  const url = requireE2eDatabaseUrl();
  const code = `globalThis.fetch = async () => { throw Error('External fetch forbidden in PAPER test'); };
    const { processPaperAllocationPositions } = await import(${JSON.stringify(new URL('../services/paper-agent-allocation.ts', import.meta.url).href)});
    const { prisma } = await import(${JSON.stringify(new URL('../lib/prisma.ts', import.meta.url).href)});
    try { await processPaperAllocationPositions(); } finally { await prisma.$disconnect(); }`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, DIRECT_DATABASE_URL: url }, timeout: 20_000 });
}
it('three real processes and a fresh restarted process execute TP3x only once', async () => {
  await save('TRAILING_PURE'); const { token, allocation } = await open();
  await mark(token.id, 2); await setPrice(token.id, 3.5);
  await Promise.all([separateProcess(), separateProcess(), separateProcess()]);
  const before = await row(allocation.id);
  expect(before.exitState).toMatchObject({ remainingPct: 25, legsFilled: 2 });
  expect(await fills(allocation.id)).toHaveLength(3);
  await separateProcess();
  expect((await row(allocation.id)).realizedPnlUsd).toEqual(before.realizedPnlUsd);
  expect(await fills(allocation.id)).toHaveLength(3);
});

it('position candles are read from stored history without provider calls, including closed positions', async () => {
  await save('TRAILING'); const { token, allocation } = await open();
  const base = Math.floor(allocation.entryAt!.getTime() / 300_000) * 300_000;
  await prisma.candle.createMany({ data: [0, 1].map(index => ({ tokenId: token.id, interval: '5m', openTime: new Date(base - index * 300_000), open: '1', high: '1.2', low: '.9', close: '1.1', volumeUsd: '500' })) });
  const snapshot = await paperAgentSnapshot();
  const view = snapshot.positions.find((position: any) => position.id === allocation.runId);
  expect(view.chart.state).toBe('ready'); expect(view.chart.candles).toHaveLength(2);
  expect(view.operations[0].executionPriceUsd).toBe(Number(allocation.entryExecutionPriceUsd));
  expect(view.quoteStale).toBe(false);
  expect((await activeSession()).openPositions).toBe(1);
});

it('a newer flood of skipped signals cannot evict an executed entry from public history', async () => {
  await save('TRAILING'); const { token, allocation } = await open();
  // Real test-source ingest and real worker decisions, not fabricated run records.
  for (let index = 0; index < 65; index++) {
    const signal = await emitSignal({ tokenId: token.id, amountUsd: 10 }, new Date());
    queuePaperAgentSignal(signal.id);
  }
  await runPaperAgentTickOnce();
  const snapshot = await paperAgentSnapshot();
  expect(snapshot.recentDecisions.length).toBeGreaterThan(0);
  expect(snapshot.recentDecisions.every((run: any) => run.id !== allocation.runId)).toBe(true);
  expect(snapshot.positions.find((run: any) => run.id === allocation.runId)?.operations[0].kind).toBe('OPEN');
  expect(snapshot.tradePositions.find((run: any) => run.id === allocation.runId)?.operations.map((op: any) => op.kind)).toEqual(['OPEN']);
  expect((await activeSession()).openPositions).toBe(1);
});
