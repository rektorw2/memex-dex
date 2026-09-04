import { describe, expect, it } from 'vitest';
import {
  broadcastVerdict,
  canTransitionSolanaTransaction,
  canTransitionWithdrawal,
  complianceVerdict,
  expiredBlockhashState,
  liveReadiness,
} from './phase4.js';

describe('Solana transaction lifecycle', () => {
  it('does not treat SUBMITTED as confirmation', () => {
    expect(canTransitionSolanaTransaction('SIGNED', 'SUBMITTED')).toBe(true);
    expect(canTransitionSolanaTransaction('SIGNED', 'CONFIRMED')).toBe(false);
    expect(canTransitionSolanaTransaction('SUBMITTED', 'FINALIZED')).toBe(false);
  });

  it('allows finality only after confirmation or reconciliation', () => {
    expect(canTransitionSolanaTransaction('CONFIRMED', 'FINALIZED')).toBe(true);
    expect(canTransitionSolanaTransaction('AMBIGUOUS', 'FINALIZED')).toBe(true);
  });

  it('forbids a second broadcast and any broadcast from AMBIGUOUS', () => {
    expect(broadcastVerdict({ state: 'SIGNED', broadcastAttempts: 0, idempotencyKey: 'op-1' })).toEqual({ allowed: true, reason: null });
    expect(broadcastVerdict({ state: 'SIGNED', broadcastAttempts: 1, idempotencyKey: 'op-1' }).reason).toBe('ALREADY_BROADCAST');
    expect(broadcastVerdict({ state: 'AMBIGUOUS', broadcastAttempts: 1, idempotencyKey: 'op-1' }).reason).toBe('RECONCILE_SIGNATURE_FIRST');
  });

  it('expires an unsubmitted transaction when its blockhash expires', () => {
    expect(expiredBlockhashState({ state: 'SIGNED', currentBlockHeight: 101, lastValidBlockHeight: 100 })).toBe('EXPIRED');
    expect(expiredBlockhashState({ state: 'SUBMITTED', currentBlockHeight: 101, lastValidBlockHeight: 100 })).toBe('SUBMITTED');
  });
});

describe('withdrawal lifecycle', () => {
  it('requires lock and manual approval before signing', () => {
    expect(canTransitionWithdrawal('REQUESTED', 'SIGNED')).toBe(false);
    expect(canTransitionWithdrawal('REQUESTED', 'LOCKED')).toBe(true);
    expect(canTransitionWithdrawal('LOCKED', 'APPROVED')).toBe(true);
    expect(canTransitionWithdrawal('APPROVED', 'SIGNED')).toBe(true);
  });

  it('cannot cancel after broadcast', () => {
    expect(canTransitionWithdrawal('LOCKED', 'CANCELLED')).toBe(true);
    expect(canTransitionWithdrawal('SUBMITTED', 'CANCELLED')).toBe(false);
  });
});

describe('compliance', () => {
  it('never turns an absent provider into approval', () => {
    expect(complianceVerdict({ kyc: 'APPROVED', aml: 'NOT_CONFIGURED', sanctions: 'APPROVED', sourceOfFunds: 'APPROVED' })).toBe('NOT_CONFIGURED');
  });

  it('reject dominates all other states', () => {
    expect(complianceVerdict({ kyc: 'PENDING', aml: 'APPROVED', sanctions: 'REJECTED', sourceOfFunds: 'NOT_CONFIGURED' })).toBe('REJECTED');
  });
});

describe('server-side LIVE readiness', () => {
  const ready = {
    executionMode: 'live' as const,
    liveAgentEnabled: true,
    liveExecutionEnabled: true,
    withdrawalsEnabled: false,
    custodyProvider: 'aws-kms' as const,
    transactionSigningEnabled: true,
    rpcReady: true,
    reconciliationReady: true,
    migrationsReady: true,
    semiAutoReady: true,
    networkAdaptersReady: true,
  };

  it('is blocked by default', () => {
    expect(liveReadiness({ ...ready, executionMode: 'paper', liveAgentEnabled: false, liveExecutionEnabled: false })).toEqual({ ready: false, blockers: ['LIVE_DISABLED'] });
  });

  it('requires every operational dependency', () => {
    const result = liveReadiness({ ...ready, custodyProvider: 'local', rpcReady: false, reconciliationReady: false });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining(['PRODUCTION_CUSTODY_REQUIRED', 'RPC_NOT_READY', 'RECONCILIATION_NOT_READY']));
  });

  it('blocks Auto even if all Semi-Auto dependencies are ready', () => {
    expect(liveReadiness({ ...ready, autoRequested: true }).blockers).toContain('AUTO_NOT_AVAILABLE');
  });

  it('reports an honest blocker while only mock network adapters exist', () => {
    expect(liveReadiness({ ...ready, networkAdaptersReady: false }).blockers)
      .toContain('NETWORK_ADAPTERS_NOT_IMPLEMENTED');
  });

  it('can only be ready for explicit Semi-Auto LIVE', () => {
    expect(liveReadiness(ready)).toEqual({ ready: true, blockers: [] });
  });
});
