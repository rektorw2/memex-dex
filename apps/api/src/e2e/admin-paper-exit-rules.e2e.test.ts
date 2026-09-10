import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { PAPER_EXIT_MODES, paperExitPlan } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { activeSession, agentServer, expectNoSigningOrBroadcast, forbidNetwork, paperAgentSnapshot, resetData, setupPaperAgent } from './harness.js';

let restore: () => void;
beforeEach(async () => {
  restore = forbidNetwork(); await resetData();
  await prisma.user.upsert({ where: { id: 'e2e-admin' }, create: {
    id: 'e2e-admin', email: 'admin-exit-e2e@example.invalid', passwordHash: 'test-only', role: 'ADMIN',
  }, update: {} });
  await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
});
afterEach(async () => { await expectNoSigningOrBroadcast(); restore(); });
afterAll(async () => { await prisma.$disconnect(); });

it.each(PAPER_EXIT_MODES)('admin saves PAPER %s to PostgreSQL while LIVE stays semi-auto and locked', async (exitMode) => {
  const before = await activeSession();
  const server = await agentServer('ADMIN');
  try {
    const response = await server.inject({ method: 'PUT', url: '/admin/paper-agent/allocation', payload: {
      mode: 'FIXED', capitalUsd: '1000', maxOpenPositions: 4, exitMode, confirm: true,
    } });
    expect(response.statusCode, response.body).toBe(200);
    const session = await activeSession();
    expect(session.id).not.toBe(before.id);
    expect((session.policySnapshot as any).exitPlan).toEqual(paperExitPlan(exitMode));
    expect((await prisma.paperAgentAccountSession.findUniqueOrThrow({ where: { id: before.id } })).policySnapshot).toEqual(before.policySnapshot);
    const snapshot = await paperAgentSnapshot();
    expect(snapshot.wallet.exitPlan.mode).toBe(exitMode);
    expect(snapshot.phase4.controlMode).toBe('semi-auto');
    expect(snapshot.phase4.allowedExitModes).toEqual(['TARGET']);
    expect(snapshot.phase4.live.enabled).toBe(false);
    expect((await prisma.paperAgentControl.findUniqueOrThrow({ where: { id: 'primary' } })).isEnabled).toBe(true);
  } finally { await server.close(); }
});

it('non-admin direct PAPER configuration creates no account and changes no plan', async () => {
  const before = await activeSession();
  const count = await prisma.paperAgentAccountSession.count();
  const server = await agentServer('USER');
  try {
    const response = await server.inject({ method: 'PUT', url: '/admin/paper-agent/allocation', payload: {
      mode: 'FIXED', capitalUsd: '1000', maxOpenPositions: 4, exitMode: 'TRAILING_PURE', confirm: true,
    } });
    expect(response.statusCode).toBe(403);
    expect(await activeSession()).toEqual(before);
    expect(await prisma.paperAgentAccountSession.count()).toBe(count);
  } finally { await server.close(); }
});
