import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paperExitPlan } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { configurePaperAllocationAccounts } from '../services/paper-agent-allocation.js';
import { ensurePaperAgentConfig, queuePaperAgentSignal, runPaperAgentTickOnce } from '../workers/paper-agent.js';
import { activeSession, baselineRun, createToken, emitSignal, enableAgent, expectNoSigningOrBroadcast, forbidNetwork, money, resetData, setPrice } from './harness.js';

const now = new Date('2026-09-10T00:00:00Z');
let restore: () => void;
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  restore = forbidNetwork(); await resetData(); await ensurePaperAgentConfig();
  // Production account shape: FIXED $1000, 30% reserve, four slots,
  // trailing from entry. Only this isolated database is configured.
  await configurePaperAllocationAccounts({ mode: 'FIXED', capitalUsd: '1000', fixed: { maxOpenPositions: 4, reservePct: 30 }, exitPlan: paperExitPlan('TRAILING_PURE') });
  await enableAgent(true);
});
afterEach(async () => { await expectNoSigningOrBroadcast(); restore(); vi.useRealTimers(); });
afterAll(async () => { await prisma.$disconnect(); });
async function signalForNewToken() {
  const token = await createToken({ priceUsd: 1 }, new Date());
  const signal = await emitSignal({ tokenId: token.id, amountUsd: 1500 }, new Date());
  queuePaperAgentSignal(signal.id); await runPaperAgentTickOnce();
  return { token, signal };
}
async function closeFirstAtLoss() {
  const first = await signalForNewToken();
  expect((await baselineRun(first.signal.id)).state).toBe('PAPER_OPEN');
  expect(money((await activeSession()).inPositionsUsd)).toBe(175);
  await setPrice(first.token.id, 0.258); await runPaperAgentTickOnce();
  expect(await baselineRun(first.signal.id)).toMatchObject({ state: 'PAPER_CLOSED', exitReason: 'TRAILING_STOP' });
  const session = await activeSession();
  expect(session.openPositions).toBe(0);
  expect(money(session.inPositionsUsd)).toBe(0);
  expect(money(session.realizedPnlUsd)).toBeLessThan(0);
  expect(money(session.freeBalanceUsd)).toBeGreaterThan(560);
  expect(money(session.reservedBalanceUsd)).toBe(300);
  return first;
}
it('first losing position frees its slot and a second eligible token opens; redelivery never reopens the first', async () => {
  const first = await closeFirstAtLoss();
  const second = await signalForNewToken();
  expect((await baselineRun(second.signal.id)).state).toBe('PAPER_OPEN');
  queuePaperAgentSignal(first.signal.id); queuePaperAgentSignal(second.signal.id);
  await runPaperAgentTickOnce(); await runPaperAgentTickOnce();
  expect((await baselineRun(first.signal.id)).state).toBe('PAPER_CLOSED');
  expect(await activeSession()).toMatchObject({ openPositions: 1, dailyEntries: 2 });
  expect(await prisma.paperAgentAllocation.count({ where: { isShadow: false } })).toBe(2);
  expect((await prisma.paperAgentControl.findUniqueOrThrow({ where: { id: 'primary' } })).isEnabled).toBe(true);
});
it('explicit stop blocks a second entry, survives configuration initialization, and enabling permits a new timely signal', async () => {
  await closeFirstAtLoss(); await enableAgent(false); await ensurePaperAgentConfig();
  expect((await prisma.paperAgentControl.findUniqueOrThrow({ where: { id: 'primary' } })).isEnabled).toBe(false);
  await signalForNewToken();
  expect(await activeSession()).toMatchObject({ openPositions: 0, dailyEntries: 1 });
  expect(await prisma.paperAgentAllocation.count({ where: { isShadow: false } })).toBe(1);
  vi.setSystemTime(new Date(now.getTime() + 60_000));
  await enableAgent(true);
  const next = await signalForNewToken();
  expect((await baselineRun(next.signal.id)).state).toBe('PAPER_OPEN');
  expect(await activeSession()).toMatchObject({ openPositions: 1, dailyEntries: 2 });
});
