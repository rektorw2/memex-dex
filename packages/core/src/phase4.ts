/**
 * Phase 4 contracts are deliberately independent from the PAPER agent.
 * A PAPER position can never be promoted into one of these records by
 * changing a status: LIVE proposals have their own identity and lifecycle.
 */

export const LIVE_AGENT_NETWORK = 'SOLANA' as const;
export const LIVE_AGENT_MODE = 'SEMI_AUTO' as const;

export type LiveProposalState =
  | 'CREATED'
  | 'AWAITING_CONFIRMATION'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'EXPIRED';

export type SolanaTransactionState =
  | 'CREATED'
  | 'QUOTED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'FAILED'
  | 'AMBIGUOUS'
  | 'EXPIRED';

export type WithdrawalLifecycleState =
  | 'REQUESTED'
  | 'LOCKED'
  | 'APPROVED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'FAILED'
  | 'AMBIGUOUS'
  | 'CANCELLED';

const TX_TRANSITIONS: Readonly<Record<SolanaTransactionState, readonly SolanaTransactionState[]>> = {
  CREATED: ['QUOTED', 'FAILED', 'EXPIRED'],
  QUOTED: ['SIGNED', 'FAILED', 'EXPIRED'],
  SIGNED: ['SUBMITTED', 'FAILED', 'EXPIRED'],
  SUBMITTED: ['CONFIRMED', 'AMBIGUOUS', 'FAILED'],
  CONFIRMED: ['FINALIZED', 'AMBIGUOUS', 'FAILED'],
  AMBIGUOUS: ['CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'],
  FINALIZED: [],
  FAILED: [],
  EXPIRED: [],
};

const WITHDRAWAL_TRANSITIONS: Readonly<
  Record<WithdrawalLifecycleState, readonly WithdrawalLifecycleState[]>
> = {
  REQUESTED: ['LOCKED', 'CANCELLED', 'FAILED'],
  LOCKED: ['APPROVED', 'CANCELLED', 'FAILED'],
  APPROVED: ['SIGNED', 'CANCELLED', 'FAILED'],
  SIGNED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'AMBIGUOUS', 'FAILED'],
  CONFIRMED: ['FINALIZED', 'AMBIGUOUS', 'FAILED'],
  AMBIGUOUS: ['CONFIRMED', 'FINALIZED', 'FAILED'],
  FINALIZED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionSolanaTransaction(
  from: SolanaTransactionState,
  to: SolanaTransactionState,
): boolean {
  return TX_TRANSITIONS[from].includes(to);
}

export function canTransitionWithdrawal(
  from: WithdrawalLifecycleState,
  to: WithdrawalLifecycleState,
): boolean {
  return WITHDRAWAL_TRANSITIONS[from].includes(to);
}

/**
 * RPC returning a signature only means that the node accepted the request.
 * Broadcasting is permitted exactly once from SIGNED. AMBIGUOUS is resolved
 * by signature reconciliation, never by sending the payload again.
 */
export function broadcastVerdict(input: {
  state: SolanaTransactionState;
  broadcastAttempts: number;
  idempotencyKey: string;
}): { allowed: boolean; reason: string | null } {
  if (!input.idempotencyKey.trim()) return { allowed: false, reason: 'IDEMPOTENCY_KEY_REQUIRED' };
  if (input.state === 'AMBIGUOUS') return { allowed: false, reason: 'RECONCILE_SIGNATURE_FIRST' };
  if (input.state !== 'SIGNED') return { allowed: false, reason: 'INVALID_STATE' };
  if (input.broadcastAttempts !== 0) return { allowed: false, reason: 'ALREADY_BROADCAST' };
  return { allowed: true, reason: null };
}

export function expiredBlockhashState(input: {
  state: SolanaTransactionState;
  currentBlockHeight: number;
  lastValidBlockHeight: number;
}): SolanaTransactionState {
  if (
    ['CREATED', 'QUOTED', 'SIGNED'].includes(input.state) &&
    input.currentBlockHeight > input.lastValidBlockHeight
  ) {
    return 'EXPIRED';
  }
  return input.state;
}

export type ComplianceState =
  | 'NOT_CONFIGURED'
  | 'PENDING'
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'REJECTED';

export interface ComplianceCheck {
  kyc: ComplianceState;
  aml: ComplianceState;
  sanctions: ComplianceState;
  sourceOfFunds: ComplianceState;
}

export function complianceVerdict(check: ComplianceCheck): ComplianceState {
  const values = Object.values(check);
  if (values.includes('REJECTED')) return 'REJECTED';
  // Missing providers are a blocker, never an implicit approval.
  if (values.includes('NOT_CONFIGURED')) return 'NOT_CONFIGURED';
  if (values.includes('REVIEW_REQUIRED')) return 'REVIEW_REQUIRED';
  if (values.includes('PENDING')) return 'PENDING';
  return 'APPROVED';
}

export interface LiveReadinessInput {
  executionMode: 'paper' | 'live';
  liveAgentEnabled: boolean;
  liveExecutionEnabled: boolean;
  withdrawalsEnabled: boolean;
  kmsProvider: 'local' | 'aws-kms' | 'gcp-kms';
  kmsSigningReady: boolean;
  rpcReady: boolean;
  reconciliationReady: boolean;
  migrationsReady: boolean;
  semiAutoReady: boolean;
  networkAdaptersReady: boolean;
  autoRequested?: boolean;
}

export interface LiveReadiness {
  ready: boolean;
  blockers: string[];
}

/** Server-side readiness. The browser never gets to manufacture this state. */
export function liveReadiness(input: LiveReadinessInput): LiveReadiness {
  const requested =
    input.liveAgentEnabled || input.liveExecutionEnabled || input.withdrawalsEnabled;
  const blockers: string[] = [];

  if (!requested) return { ready: false, blockers: ['LIVE_DISABLED'] };
  if (input.executionMode !== 'live') blockers.push('EXECUTION_MODE_NOT_LIVE');
  if (!input.liveAgentEnabled) blockers.push('LIVE_AGENT_DISABLED');
  if (!input.liveExecutionEnabled) blockers.push('LIVE_EXECUTION_DISABLED');
  if (input.kmsProvider === 'local') blockers.push('PRODUCTION_KMS_REQUIRED');
  if (!input.kmsSigningReady) blockers.push('KMS_SIGNING_NOT_READY');
  if (!input.rpcReady) blockers.push('RPC_NOT_READY');
  if (!input.reconciliationReady) blockers.push('RECONCILIATION_NOT_READY');
  if (!input.migrationsReady) blockers.push('MIGRATIONS_NOT_READY');
  if (!input.semiAutoReady) blockers.push('SEMI_AUTO_NOT_READY');
  if (!input.networkAdaptersReady) blockers.push('NETWORK_ADAPTERS_NOT_IMPLEMENTED');
  if (input.autoRequested) blockers.push('AUTO_NOT_AVAILABLE');

  return { ready: blockers.length === 0, blockers };
}

export type FundingPipelineState =
  | 'WAITING_TRANSFER'
  | 'DETECTED'
  | 'AWAITING_CONFIRMATIONS'
  | 'CONFIRMED'
  | 'CREDITED'
  | 'REJECTED'
  | 'REVIEW_REQUIRED';

export const FUNDING_PIPELINE_LABEL: Readonly<Record<FundingPipelineState, string>> = {
  WAITING_TRANSFER: 'Ожидаем перевод',
  DETECTED: 'Перевод обнаружен',
  AWAITING_CONFIRMATIONS: 'Ожидаем подтверждения сети',
  CONFIRMED: 'Транзакция подтверждена',
  CREDITED: 'Средства зачислены',
  REJECTED: 'Перевод отклонён',
  REVIEW_REQUIRED: 'Требуется ручная проверка',
};
