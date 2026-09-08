import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAPER_AGENT_STRATEGIES } from '@memex/core';

const current = PAPER_AGENT_STRATEGIES[0]!;
const oldKey = 'okx-signal-v2-baseline';
let control: any;
const strategies = new Map<string, any>();
const audit: any[] = [];
const db: any = {
  $transaction: async (fn: any) => fn(db),
  paperAgentControl: {
    upsert: async ({ create }: any) => control ??= structuredClone(create),
    updateMany: async ({ where, data }: any) => {
      if (control.baselineStrategyKey !== where.baselineStrategyKey) return { count: 0 };
      Object.assign(control, data);
      return { count: 1 };
    },
  },
  paperAgentStrategy: {
    upsert: async ({ where, create, update }: any) => {
      const existing = strategies.get(where.key);
      if (existing) Object.assign(existing, update);
      else strategies.set(where.key, structuredClone(create));
    },
    updateMany: async ({ where, data }: any) => {
      for (const [key, row] of strategies) {
        const match = typeof where.key === 'string' ? key === where.key : key.startsWith(where.key.startsWith);
        if (match && (where.isEnabled == null || where.isEnabled === row.isEnabled)) Object.assign(row, data);
      }
    },
  },
  auditLog: { create: async ({ data }: any) => audit.push(data) },
};
vi.mock('../lib/prisma.js', () => ({ prisma: db }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { ensurePaperAgentConfig } = await import('./paper-agent.js');

beforeEach(() => {
  control = { id: 'primary', baselineStrategyKey: oldKey, isEnabled: true, activeAllocationMode: 'FIXED' };
  strategies.clear();
  strategies.set(oldKey, { key: oldKey, isEnabled: true, config: { minAmountUsd: 5_000 }, label: 'Baseline v2' });
  audit.length = 0;
});

describe('baseline $600 rollout', () => {
  it('switches the active version once, preserving historical configuration and control settings', async () => {
    await ensurePaperAgentConfig();
    await ensurePaperAgentConfig();
    expect(control).toEqual({ id: 'primary', baselineStrategyKey: current.key, isEnabled: true, activeAllocationMode: 'FIXED' });
    expect(strategies.get(current.key).config.minAmountUsd).toBe(600);
    expect(strategies.get(oldKey)).toEqual({ key: oldKey, isEnabled: false, config: { minAmountUsd: 5_000 }, label: 'Baseline v2' });
    expect(audit).toHaveLength(1);
    expect(audit[0].before.minAmountUsd).toBe(5_000);
    expect(audit[0].after.minAmountUsd).toBe(600);
  });

  it('preserves an administrator-promoted shadow and a stopped agent', async () => {
    control.baselineStrategyKey = 'okx-signal-v2-shadow-amount-10k';
    control.isEnabled = false;
    await ensurePaperAgentConfig();
    expect(control.baselineStrategyKey).toBe('okx-signal-v2-shadow-amount-10k');
    expect(control.isEnabled).toBe(false);
    expect(audit).toHaveLength(0);
  });

  it('creates a fresh agent with $600 but does not start it', async () => {
    control = null;
    await ensurePaperAgentConfig();
    expect(control.baselineStrategyKey).toBe(current.key);
    expect(control.isEnabled).toBe(false);
    expect(strategies.get(current.key).config.minAmountUsd).toBe(600);
    expect(audit).toHaveLength(0);
  });
});
