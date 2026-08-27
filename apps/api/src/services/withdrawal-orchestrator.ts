import {
  canTransitionWithdrawal,
  complianceVerdict,
  type ComplianceCheck,
  type WithdrawalLifecycleState,
} from '@memex/core';

export interface WithdrawalRequest {
  id: string;
  userId: string;
  tokenId: string;
  idempotencyKey: string;
  amountRaw: bigint;
  destination: string;
  state: WithdrawalLifecycleState;
  compliance: ComplianceCheck;
  approvedBy: string | null;
}
export interface WithdrawalAuditEvent {
  operationId: string;
  action: string;
  actorId: string;
  state: WithdrawalLifecycleState;
}

export interface WithdrawalAccount {
  availableRaw: bigint;
  lockedRaw: bigint;
  unfinalizedDepositRaw: bigint;
  dailyRemainingRaw: bigint;
  perOperationLimitRaw: bigint;
}

/**
 * Deterministic Phase 4 test repository. The future Prisma adapter must keep
 * the same atomic boundary: idempotency claim + balance lock + operation +
 * audit event in one serializable transaction.
 */
export class InMemoryWithdrawalRepository {
  readonly operations = new Map<string, WithdrawalRequest>();
  readonly operationByKey = new Map<string, string>();
  readonly audit: WithdrawalAuditEvent[] = [];
  failAtomicLock = false;

  constructor(readonly account: WithdrawalAccount) {}

  requestAndLock(input: Omit<WithdrawalRequest, 'state' | 'approvedBy'>) {
    const duplicateId = this.operationByKey.get(input.idempotencyKey);
    if (duplicateId) return { operation: this.operations.get(duplicateId)!, duplicate: true };
    if (!input.idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    if (input.amountRaw <= 0n) throw new Error('INVALID_WITHDRAWAL_AMOUNT');
    if (input.amountRaw > this.account.perOperationLimitRaw) throw new Error('PER_OPERATION_LIMIT');
    if (input.amountRaw > this.account.dailyRemainingRaw) throw new Error('DAILY_LIMIT');
    if (input.amountRaw > this.account.availableRaw) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
    if (this.account.unfinalizedDepositRaw > 0n) throw new Error('UNFINALIZED_DEPOSIT_PRESENT');
    if (complianceVerdict(input.compliance) !== 'APPROVED') throw new Error('COMPLIANCE_NOT_APPROVED');
    if (!canTransitionWithdrawal('REQUESTED', 'LOCKED')) throw new Error('INVALID_WITHDRAWAL_TRANSITION');
    if (this.failAtomicLock) throw new Error('SIMULATED_WITHDRAWAL_ATOMIC_FAILURE');

    const operation: WithdrawalRequest = { ...input, state: 'LOCKED', approvedBy: null };
    this.account.availableRaw -= input.amountRaw;
    this.account.lockedRaw += input.amountRaw;
    this.account.dailyRemainingRaw -= input.amountRaw;
    this.operations.set(input.id, operation);
    this.operationByKey.set(input.idempotencyKey, input.id);
    this.audit.push({ operationId: input.id, action: 'withdrawal.lock', actorId: input.userId, state: 'LOCKED' });
    return { operation, duplicate: false };
  }

  approve(operationId: string, adminId: string) {
    const current = this.operations.get(operationId);
    if (!current) throw new Error('WITHDRAWAL_NOT_FOUND');
    if (!canTransitionWithdrawal(current.state, 'APPROVED')) throw new Error('INVALID_WITHDRAWAL_TRANSITION');
    const approved = { ...current, state: 'APPROVED' as const, approvedBy: adminId };
    this.operations.set(operationId, approved);
    this.audit.push({ operationId, action: 'withdrawal.approve', actorId: adminId, state: 'APPROVED' });
    return approved;
  }

  lockedDiscrepancy(): bigint {
    const expected = [...this.operations.values()]
      .filter((row) => !['FINALIZED', 'FAILED', 'CANCELLED'].includes(row.state))
      .reduce((sum, row) => sum + row.amountRaw, 0n);
    return this.account.lockedRaw - expected;
  }
}
