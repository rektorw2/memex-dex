import { describe, expect, it } from 'vitest';
import { InMemoryWithdrawalRepository } from './withdrawal-orchestrator.js';

const APPROVED = {
  kyc: 'APPROVED', aml: 'APPROVED', sanctions: 'APPROVED', sourceOfFunds: 'APPROVED',
} as const;

function repository(over: Record<string, bigint> = {}) {
  return new InMemoryWithdrawalRepository({
    availableRaw: 100n,
    lockedRaw: 0n,
    unfinalizedDepositRaw: 0n,
    dailyRemainingRaw: 80n,
    perOperationLimitRaw: 60n,
    ...over,
  });
}

const request = (over: Record<string, unknown> = {}) => ({
  id: 'withdraw-1', userId: 'user-1', tokenId: 'usdc', idempotencyKey: 'key-1',
  amountRaw: 50n, destination: 'solana-address', compliance: APPROVED, ...over,
});
describe('future LIVE withdrawal foundation', () => {
  it('locks funds and audit atomically before manual approval', () => {
    const repo = repository();
    const result = repo.requestAndLock(request());
    expect(result).toMatchObject({ duplicate: false, operation: { state: 'LOCKED' } });
    expect(repo.account).toMatchObject({ availableRaw: 50n, lockedRaw: 50n });
    expect(repo.audit).toMatchObject([{ action: 'withdrawal.lock', state: 'LOCKED' }]);
    expect(repo.approve('withdraw-1', 'admin-1')).toMatchObject({ state: 'APPROVED', approvedBy: 'admin-1' });
  });

  it('deduplicates the same request without locking twice', () => {
    const repo = repository();
    repo.requestAndLock(request());
    expect(repo.requestAndLock(request({ id: 'withdraw-duplicate' })).duplicate).toBe(true);
    expect(repo.account.lockedRaw).toBe(50n);
    expect(repo.audit).toHaveLength(1);
  });

  it('rejects unfinalized incoming funds and missing compliance providers', () => {
    expect(() => repository({ unfinalizedDepositRaw: 1n }).requestAndLock(request()))
      .toThrow('UNFINALIZED_DEPOSIT_PRESENT');
    expect(() => repository().requestAndLock(request({
      compliance: { ...APPROVED, sanctions: 'NOT_CONFIGURED' },
    }))).toThrow('COMPLIANCE_NOT_APPROVED');
  });

  it('enforces operation and daily limits', () => {
    expect(() => repository().requestAndLock(request({ amountRaw: 61n }))).toThrow('PER_OPERATION_LIMIT');
    expect(() => repository({ dailyRemainingRaw: 40n }).requestAndLock(request())).toThrow('DAILY_LIMIT');
  });

  it('does not partially mutate the account when the atomic write fails', () => {
    const repo = repository();
    repo.failAtomicLock = true;
    expect(() => repo.requestAndLock(request())).toThrow('SIMULATED_WITHDRAWAL_ATOMIC_FAILURE');
    expect(repo.account).toMatchObject({ availableRaw: 100n, lockedRaw: 0n, dailyRemainingRaw: 80n });
    expect(repo.operations.size).toBe(0);
    expect(repo.audit).toHaveLength(0);
  });

  it('reports a locked-balance reconciliation mismatch', () => {
    const repo = repository();
    repo.requestAndLock(request());
    repo.account.lockedRaw = 40n;
    expect(repo.lockedDiscrepancy()).toBe(-10n);
  });
});
