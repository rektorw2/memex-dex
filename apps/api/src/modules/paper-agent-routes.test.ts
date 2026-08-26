import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let control = {
  id: 'primary',
  isEnabled: false,
  baselineStrategyKey: 'okx-signal-v2-baseline',
  telegramShadowEnabled: false,
  activeAllocationMode: 'FIXED' as string | null,
  learningModeEnabled: false,
};
const audits: any[] = [];
const strategy = { id: 'shadow-id', key: 'okx-signal-v2-shadow-delay', kind: 'SHADOW', isEnabled: true };
const tx = {
  paperAgentControl: {
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matches =
        control.id === where.id &&
        (where.isEnabled == null || control.isEnabled === where.isEnabled) &&
        (where.telegramShadowEnabled == null || control.telegramShadowEnabled === where.telegramShadowEnabled) &&
        (where.baselineStrategyKey == null || control.baselineStrategyKey === where.baselineStrategyKey);
      if (!matches) return { count: 0 };
      control = { ...control, ...data };
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => ({ ...control })),
  },
  auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  paperAgentNotification: {
    updateMany: vi.fn(async ({ where }: any) => ({ count: where.id === 'sent' ? 0 : 1 })),
  },
  paperAgentAllocationPolicy: {
    findUnique: vi.fn(async ({ where }: any) => where.id === 'hypothesis-1' ? ({
      id: 'hypothesis-1', status: 'PROPOSED',
    }) : null),
    update: vi.fn(async ({ data }: any) => ({ id: 'hypothesis-1', ...data })),
  },
};
const prismaMock = {
  $transaction: vi.fn(async (work: (client: any) => Promise<unknown>) => work(tx)),
  paperAgentControl: { findUnique: vi.fn(async () => ({ ...control })) },
  paperAgentStrategy: { findUnique: vi.fn(async () => strategy) },
  paperAgentRun: { findMany: vi.fn(async () => []) },
  auditLog: { create: tx.auditLog.create },
};

const setCache = vi.fn();
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../workers/paper-agent.js', () => ({
  ensurePaperAgentConfig: vi.fn(async () => undefined),
  getPaperAgentRuntimeStatus: vi.fn(() => ({ running: true, queued: 0 })),
  paperAgentStartVerdict: vi.fn(() => ({ ok: true })),
  setPaperAgentEnabledCache: setCache,
}));
vi.mock('../workers/okx-signal-ingest.js', () => ({ getOkxSignalIngestStatus: vi.fn(() => ({ running: true, socket: { state: 'connected' } })) }));
vi.mock('../workers/paper-agent-notifications.js', () => ({
  getPaperAgentNotificationRuntime: vi.fn(() => ({ running: true, telegramEnabled: false, transport: 'disabled' })),
  retryPaperAgentNotification: vi.fn(async () => true),
}));
const accountFixture = (kind: 'ACTIVE' | 'SHADOW') => ({
  id: `${kind.toLowerCase()}-1`, kind, mode: kind === 'ACTIVE' ? 'FIXED' : 'AUTOPILOT',
  status: 'ACTIVE', policyKey: `${kind.toLowerCase()}-policy`, policyVersion: 1,
  riskProfile: kind === 'SHADOW' ? 'BALANCED' : null, policySnapshot: {},
  initialCapitalUsd: 100, freeBalanceUsd: 70, reservedBalanceUsd: 30,
  inPositionsUsd: 0, equityUsd: 100, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
  tradingFeesUsd: 0, slippageUsd: 0, networkCostsUsd: 0, peakEquityUsd: 100,
  drawdownPct: 0, reservePct: 30, maxExposurePct: 70, maxPositionPct: 17.5,
  maxOpenPositions: 4, minimumPositionUsd: 5, dailyEntryLimit: 100,
  drawdownStopPct: 100, allowPartialAllocation: false, openPositions: 0,
  dailyEntries: 0, dailyEntriesDate: new Date('2026-08-26T00:00:00Z'), resetFromId: null,
  createdAt: new Date('2026-08-26T10:00:00Z'), closedAt: null,
});
const configureAllocation = vi.fn(async () => ({
  active: accountFixture('ACTIVE'), shadow: accountFixture('SHADOW'),
}));
const resetAllocation = vi.fn(async () => accountFixture('ACTIVE'));
vi.mock('../services/paper-agent-allocation.js', () => ({
  configurePaperAllocationAccounts: configureAllocation,
  resetPaperAllocationAccount: resetAllocation,
}));
const { paperAgentRoutes } = await import('./paper-agent.js');

async function app() {
  const instance = Fastify();
  (instance as any).decorateRequest('user', null);
  instance.decorate('requireAdmin', async (req: any) => { req.user = { sub: 'admin-1', role: 'ADMIN' }; });
  await instance.register(paperAgentRoutes);
  return instance;
}

async function nonAdminApp() {
  const instance = Fastify();
  (instance as any).decorateRequest('user', null);
  instance.decorate('requireAdmin', async (_req: any, reply: any) =>
    reply.code(403).send({ code: 'FORBIDDEN' }));
  await instance.register(paperAgentRoutes);
  return instance;
}

beforeEach(() => {
  control = {
    id: 'primary',
    isEnabled: false,
    baselineStrategyKey: 'okx-signal-v2-baseline',
    telegramShadowEnabled: false,
    activeAllocationMode: 'FIXED',
    learningModeEnabled: false,
  };
  audits.length = 0; vi.clearAllMocks();
});

describe('ручное управление paper-agent', () => {
  it('включение атомарно, сохраняет аудит и повтор не создаёт второй аудит', async () => {
    const server = await app();
    const first = await server.inject({ method: 'PUT', url: '/admin/paper-agent', payload: { isEnabled: true } });
    const second = await server.inject({ method: 'PUT', url: '/admin/paper-agent', payload: { isEnabled: true } });
    expect(first.json()).toMatchObject({ isEnabled: true, changed: true });
    expect(second.json()).toMatchObject({ isEnabled: true, changed: false });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: 'admin-1', action: 'paper_agent.toggle', before: { isEnabled: false }, after: { isEnabled: true } });
    expect(setCache).toHaveBeenLastCalledWith(true);
    await server.close();
  });

  it('Stop запрещает новые входы через cache и не удаляет историю', async () => {
    control.isEnabled = true;
    const server = await app();
    const response = await server.inject({ method: 'PUT', url: '/admin/paper-agent', payload: { isEnabled: false } });
    expect(response.json()).toMatchObject({ isEnabled: false, changed: true });
    expect(setCache).toHaveBeenCalledWith(false);
    expect(prismaMock.paperAgentRun.findMany).not.toHaveBeenCalled();
    await server.close();
  });

  it('promotion требует явного подтверждения и пишет аудит', async () => {
    const server = await app();
    const invalid = await server.inject({ method: 'POST', url: '/admin/paper-agent/promote', payload: { strategyKey: strategy.key } });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    const response = await server.inject({ method: 'POST', url: '/admin/paper-agent/promote', payload: { strategyKey: strategy.key, confirm: true } });
    expect(response.json()).toMatchObject({ baselineStrategyKey: strategy.key, changed: true });
    expect(audits.at(-1)).toMatchObject({ action: 'paper_agent.promote', before: { baselineStrategyKey: 'okx-signal-v2-baseline' }, after: { baselineStrategyKey: strategy.key } });
    await server.close();
  });

  it('ручной retry пишет аудит только когда FAILED действительно возвращён в очередь', async () => {
    const server = await app();
    await server.inject({ method: 'POST', url: '/admin/paper-agent/notifications/n-1/retry' });
    expect(audits.at(-1)).toMatchObject({ action: 'paper_agent.notification_retry', entityId: 'n-1' });
    await server.inject({ method: 'POST', url: '/admin/paper-agent/notifications/sent/retry' });
    expect(audits.filter((row) => row.action === 'paper_agent.notification_retry')).toHaveLength(1);
    await server.close();
  });

  it('Start запрещён, пока режим распределения капитала не настроен', async () => {
    control.activeAllocationMode = null;
    const server = await app();
    const response = await server.inject({
      method: 'PUT', url: '/admin/paper-agent', payload: { isEnabled: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PAPER_ALLOCATION_MODE_REQUIRED' });
    expect(setCache).not.toHaveBeenCalled();
    await server.close();
  });

  it('Fixed требует капитал, число позиций и явное подтверждение', async () => {
    const server = await app();
    const withoutConfirm = await server.inject({
      method: 'PUT', url: '/admin/paper-agent/allocation',
      payload: { mode: 'FIXED', capitalUsd: '100', maxOpenPositions: 4 },
    });
    expect(withoutConfirm.statusCode).toBeGreaterThanOrEqual(400);
    const withoutPositions = await server.inject({
      method: 'PUT', url: '/admin/paper-agent/allocation',
      payload: { mode: 'FIXED', capitalUsd: '100', confirm: true },
    });
    expect(withoutPositions.json()).toMatchObject({ code: 'MAX_OPEN_POSITIONS_REQUIRED' });
    const configured = await server.inject({
      method: 'PUT', url: '/admin/paper-agent/allocation',
      payload: { mode: 'FIXED', capitalUsd: '100', maxOpenPositions: 4, reservePct: 30, confirm: true },
    });
    expect(configured.json()).toMatchObject({ paper: true, active: { kind: 'ACTIVE' }, shadow: { kind: 'SHADOW' } });
    expect(configureAllocation).toHaveBeenCalledWith(expect.objectContaining({ mode: 'FIXED', capitalUsd: '100' }), expect.objectContaining({ actorId: 'admin-1' }));
    await server.close();
  });

  it('Autopilot принимает только известный risk profile', async () => {
    const server = await app();
    const invalid = await server.inject({
      method: 'PUT', url: '/admin/paper-agent/allocation',
      payload: { mode: 'AUTOPILOT', capitalUsd: '100', riskProfile: 'YOLO', confirm: true },
    });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    const valid = await server.inject({
      method: 'PUT', url: '/admin/paper-agent/allocation',
      payload: { mode: 'AUTOPILOT', capitalUsd: '100', riskProfile: 'CONSERVATIVE', confirm: true },
    });
    expect(valid.statusCode).toBe(200);
    expect(configureAllocation).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'AUTOPILOT', autopilot: expect.objectContaining({ riskProfile: 'CONSERVATIVE' }),
    }), expect.anything());
    await server.close();
  });

  it('reset требует confirm и передаёт автора в аудитный сервис', async () => {
    const server = await app();
    const invalid = await server.inject({
      method: 'POST', url: '/admin/paper-agent/allocation/active-1/reset', payload: {},
    });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    const response = await server.inject({
      method: 'POST', url: '/admin/paper-agent/allocation/active-1/reset',
      payload: { capitalUsd: '200', confirm: true },
    });
    expect(response.json()).toMatchObject({ paper: true, account: { id: 'active-1' } });
    expect(resetAllocation).toHaveBeenCalledWith('active-1', '200', expect.objectContaining({ actorId: 'admin-1' }));
    await server.close();
  });

  it('learning review меняет только статус гипотезы, а не рабочий режим', async () => {
    const server = await app();
    const response = await server.inject({
      method: 'POST', url: '/admin/paper-agent/allocation-policies/hypothesis-1/review',
      payload: { decision: 'PROMOTE', confirm: true },
    });
    expect(response.json()).toMatchObject({ id: 'hypothesis-1', status: 'PROMOTED', activated: false });
    expect(audits.at(-1)).toMatchObject({
      action: 'paper_agent.allocation_policy_promoted',
      after: { status: 'PROMOTED', autoActivated: false },
    });
    await server.close();
  });

  it('обычный пользователь не может менять policy или капитал', async () => {
    const server = await nonAdminApp();
    const response = await server.inject({
      method: 'PUT', url: '/admin/paper-agent/allocation',
      payload: { mode: 'FIXED', capitalUsd: '100', maxOpenPositions: 4, confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(configureAllocation).not.toHaveBeenCalled();
    await server.close();
  });

  it('chart marker несёт mode, сумму и капитал после решения', async () => {
    prismaMock.paperAgentRun.findMany.mockResolvedValueOnce([{
      id: 'run-marker',
      entryAt: new Date('2026-08-26T10:00:05Z'), exitAt: null,
      entryExecutionPriceUsd: 1, exitExecutionPriceUsd: null,
      realizedPnlUsd: null, positionUsd: 25,
      strategy: { key: 'baseline', label: 'Baseline', version: 1 },
      allocations: [{
        id: 'allocation-marker', isShadow: false,
        entryAt: new Date('2026-08-26T10:00:05Z'), exitAt: null,
        entryExecutionPriceUsd: 1, exitExecutionPriceUsd: null, realizedPnlUsd: null,
        mode: 'AUTOPILOT', allocatedUsd: 25, capitalPct: 12.5,
        freeAfterUsd: 145, reserveAfterUsd: 60, exposureAfterUsd: 25,
        riskProfile: 'BALANCED', allocationReason: 'SCORE_MEDIUM',
        policyKey: 'autopilot-balanced', policyVersion: 2,
      }],
    }] as any);
    const server = await app();
    const response = await server.inject({
      method: 'GET', url: '/admin/paper-agent/markers?tokenId=token-1&interval=5m',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({
      side: 'BUY', allocationMode: 'AUTOPILOT', allocatedUsd: 25, capitalPct: 12.5,
      freeAfterUsd: 145, reserveAfterUsd: 60, exposureAfterUsd: 25,
      allocationReason: 'SCORE_MEDIUM', shadow: false,
    })]);
    await server.close();
  });
});
