import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const wallets = readFileSync(new URL('../modules/wallets.ts', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../modules/admin.ts', import.meta.url), 'utf8');
const solana = readFileSync(new URL('../chains/solana.ts', import.meta.url), 'utf8');
const paperWorker = readFileSync(new URL('../workers/paper-agent.ts', import.meta.url), 'utf8');

describe('Phase 4 hard boundaries', () => {
  it('refuses user withdrawal before any balance lock while withdrawals are disabled', () => {
    const route = wallets.slice(wallets.indexOf("app.post('/wallets/withdraw'"));
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeGreaterThan(-1);
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeLessThan(route.indexOf('balances.lock'));
  });

  it('refuses administrative withdrawal approval before changing its state', () => {
    const route = admin.slice(admin.indexOf("app.post('/admin/withdrawals/:id/decide'"));
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeGreaterThan(-1);
    expect(route.indexOf('WITHDRAWALS_DISABLED')).toBeLessThan(route.indexOf('prisma.withdrawal.update'));
  });

  it('contains no implemented Solana live broadcast path', () => {
    expect(solana).toContain('LIVE_SOLANA_EXECUTION_NOT_IMPLEMENTED');
    expect(solana).not.toMatch(/sendRawTransaction|sendAndConfirmTransaction/);
  });

  it('keeps the PAPER worker free of RPC, KMS and private-key imports', () => {
    expect(paperWorker).not.toMatch(/sendRawTransaction|privateKey|KMS_SIGNING_ENABLED|SOLANA_RPC_URL/);
  });
});
