import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = { ...process.env };

async function load(over: Record<string, string>) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/memex',
    JWT_SECRET: 'x'.repeat(40),
    KMS_LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    EXECUTION_MODE: 'paper',
    FUNDING_ENABLED: 'false',
    LIVE_AGENT_ENABLED: 'false',
    LIVE_EXECUTION_ENABLED: 'false',
    WITHDRAWALS_ENABLED: 'false',
    LIVE_RPC_READY: 'false',
    LIVE_RECONCILIATION_ENABLED: 'false',
    LIVE_MIGRATIONS_READY: 'false',
    KMS_SIGNING_ENABLED: 'false',
    LIVE_AGENT_CONTROL_MODE: 'semi-auto',
    ...over,
  };
  return import('./env.js');
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('Phase 4 startup guards', () => {
  it('keeps every money-moving flag disabled by default', async () => {
    const { env } = await load({});
    expect(env.EXECUTION_MODE).toBe('paper');
    expect(env.FUNDING_ENABLED).toBe(false);
    expect(env.LIVE_AGENT_ENABLED).toBe(false);
    expect(env.LIVE_EXECUTION_ENABLED).toBe(false);
    expect(env.WITHDRAWALS_ENABLED).toBe(false);
  });

  it('cannot enable LIVE from paper mode', async () => {
    await expect(load({ LIVE_AGENT_ENABLED: 'true' })).rejects.toThrow('EXECUTION_MODE=paper');
  });

  it('cannot enable LIVE with local KMS', async () => {
    await expect(load({ EXECUTION_MODE: 'live', LIVE_AGENT_ENABLED: 'true' })).rejects.toThrow('KMS_PROVIDER=local');
  });

  it('requires RPC, reconciliation and migrations before funding', async () => {
    await expect(load({ FUNDING_ENABLED: 'true' })).rejects.toThrow('LIVE_RPC_READY');
  });

  it('requires signing before execution', async () => {
    await expect(load({
      EXECUTION_MODE: 'live', KMS_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'key-1',
      LIVE_AGENT_ENABLED: 'true', LIVE_EXECUTION_ENABLED: 'true',
      LIVE_RPC_READY: 'true', LIVE_RECONCILIATION_ENABLED: 'true', LIVE_MIGRATIONS_READY: 'true',
    })).rejects.toThrow('KMS_SIGNING_ENABLED');
  });

  it('does not allow withdrawals without the LIVE executor', async () => {
    await expect(load({
      EXECUTION_MODE: 'live', KMS_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'key-1',
      LIVE_AGENT_ENABLED: 'true', WITHDRAWALS_ENABLED: 'true', KMS_SIGNING_ENABLED: 'true',
      LIVE_RPC_READY: 'true', LIVE_RECONCILIATION_ENABLED: 'true', LIVE_MIGRATIONS_READY: 'true',
    })).rejects.toThrow('LIVE_EXECUTION_ENABLED');
  });

  it('rejects Auto even when all readiness flags are true', async () => {
    await expect(load({ LIVE_AGENT_CONTROL_MODE: 'auto' })).rejects.toThrow('Auto');
  });

  it('does not let readiness flags turn mock contracts into a mainnet implementation', async () => {
    await expect(load({
      EXECUTION_MODE: 'live', KMS_PROVIDER: 'aws-kms', AWS_KMS_KEY_ID: 'key-1',
      LIVE_AGENT_ENABLED: 'true', LIVE_EXECUTION_ENABLED: 'true', KMS_SIGNING_ENABLED: 'true',
      LIVE_RPC_READY: 'true', LIVE_RECONCILIATION_ENABLED: 'true', LIVE_MIGRATIONS_READY: 'true',
    })).rejects.toThrow('network adapters are not implemented');
  });
});
