import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedAllocationPolicy } from '@memex/core';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  policyExists: vi.fn(),
  controlFind: vi.fn(),
  sessionFind: vi.fn(),
  allocationsFind: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    paperAgentControl: { findUnique: mocks.controlFind },
    paperAgentAccountSession: { findUnique: mocks.sessionFind },
    paperAgentAllocation: { findMany: mocks.allocationsFind },
    paperAgentAllocationPolicy: { findUnique: mocks.policyExists, create: mocks.create },
  },
}));

const { proposePaperAllocationHypothesisIfReady } = await import('./paper-agent-allocation.js');

describe('Phase 3 learning остаётся advisory-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.controlFind.mockResolvedValue({ learningModeEnabled: true });
    mocks.policyExists.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }: any) => data);
  });

  it.each([
    { name: 'положительная выборка', pnl: 2, factor: 0.98 },
    { name: 'отрицательная выборка', pnl: -2, factor: 0.9 },
  ])('$name не повышает hard limits и не активирует policy', async ({ pnl, factor }) => {
    const policy = fixedAllocationPolicy({ capitalUsd: 1_000, maxOpenPositions: 4, reservePct: 30 });
    mocks.sessionFind.mockResolvedValue({
      id: 'active', policyKey: policy.policyKey, policySnapshot: policy, initialCapitalUsd: 1_000,
    });
    mocks.allocationsFind.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({
      realizedPnlUsd: pnl,
      allocatedUsd: 100,
      capitalPct: 10,
      maxDrawdownPct: pnl < 0 ? 90 : 2,
      totalCostsUsd: 0.5,
      entryAt: new Date(Date.UTC(2026, 7, 1, 0, index)),
      exitAt: new Date(Date.UTC(2026, 7, 1, 1, index)),
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)),
    })));

    await expect(proposePaperAllocationHypothesisIfReady('active')).resolves.toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const proposal = mocks.create.mock.calls[0]![0].data;
    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.source).toBe('LEARNING');
    expect(proposal.limits.maxPositionPct).toBeCloseTo(policy.limits.maxPositionPct * factor, 7);
    expect(proposal.limits.maxPositionPct).toBeLessThan(policy.limits.maxPositionPct);
    expect(proposal.hypothesisMetrics).toMatchObject({
      autoPromotion: false,
      comparisonToActive: { increasesAnyHardLimit: false },
    });
  });
});
