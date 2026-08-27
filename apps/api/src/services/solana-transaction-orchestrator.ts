import {
  broadcastVerdict,
  expiredBlockhashState,
  type SolanaTransactionState,
} from '@memex/core';

export interface SolanaExecutionRecord {
  id: string;
  state: SolanaTransactionState;
  idempotencyKey: string;
  signature: string | null;
  broadcastAttempts: number;
  lastValidBlockHeight: number;
  version: number;
}

export interface ActualSolanaFill {
  inputRaw: string;
  outputRaw: string;
  feeLamports: bigint;
}

export interface SolanaExecutionTransport {
  currentBlockHeight(): Promise<number>;
  submitOnce(idempotencyKey: string): Promise<
    | { kind: 'accepted'; signature: string }
    | { kind: 'unknown'; signature: string | null }
    | { kind: 'failed'; code: string }
  >;
  transactionStatus(signature: string): Promise<
    | { state: 'missing' }
    | { state: 'confirmed' }
    | { state: 'finalized'; fill: ActualSolanaFill }
    | { state: 'failed'; code: string }
  >;
}

export interface SolanaExecutionRepository {
  load(id: string): Promise<SolanaExecutionRecord>;
  claimBroadcast(id: string, expectedVersion: number): Promise<boolean>;
  update(id: string, expectedVersion: number, patch: {
    state: SolanaTransactionState;
    signature?: string | null;
    errorCode?: string | null;
    actualFill?: ActualSolanaFill;
  }): Promise<boolean>;
}

/**
 * The claim is stored before RPC. A timeout therefore becomes AMBIGUOUS and
 * reconciliation-only; it is never treated as permission to broadcast again.
 */
export async function submitSolanaTransaction(input: {
  id: string;
  repository: SolanaExecutionRepository;
  transport: SolanaExecutionTransport;
}): Promise<SolanaTransactionState> {
  const record = await input.repository.load(input.id);
  const height = await input.transport.currentBlockHeight();
  const expiry = expiredBlockhashState({
    state: record.state,
    currentBlockHeight: height,
    lastValidBlockHeight: record.lastValidBlockHeight,
  });
  if (expiry === 'EXPIRED') {
    await input.repository.update(record.id, record.version, { state: 'EXPIRED' });
    return 'EXPIRED';
  }

  const verdict = broadcastVerdict(record);
  if (!verdict.allowed) throw new Error(verdict.reason ?? 'BROADCAST_FORBIDDEN');
  const claimed = await input.repository.claimBroadcast(record.id, record.version);
  if (!claimed) throw new Error('BROADCAST_ALREADY_CLAIMED');

  const response = await input.transport.submitOnce(record.idempotencyKey);
  const versionAfterClaim = record.version + 1;
  if (response.kind === 'failed') {
    await input.repository.update(record.id, versionAfterClaim, { state: 'FAILED', errorCode: response.code });
    return 'FAILED';
  }
  if (response.kind === 'unknown') {
    await input.repository.update(record.id, versionAfterClaim, {
      state: 'AMBIGUOUS',
      signature: response.signature,
      errorCode: 'RPC_RESULT_UNKNOWN',
    });
    return 'AMBIGUOUS';
  }

  await input.repository.update(record.id, versionAfterClaim, {
    state: 'SUBMITTED',
    signature: response.signature,
  });
  return 'SUBMITTED';
}

export async function reconcileSolanaTransaction(input: {
  id: string;
  repository: SolanaExecutionRepository;
  transport: SolanaExecutionTransport;
}): Promise<SolanaTransactionState> {
  const record = await input.repository.load(input.id);
  if (!['SUBMITTED', 'CONFIRMED', 'AMBIGUOUS'].includes(record.state)) return record.state;
  if (!record.signature) return 'AMBIGUOUS';

  const status = await input.transport.transactionStatus(record.signature);
  if (status.state === 'missing') {
    if (record.state !== 'AMBIGUOUS') {
      const updated = await input.repository.update(record.id, record.version, {
        state: 'AMBIGUOUS',
        errorCode: 'SIGNATURE_NOT_FOUND',
      });
      if (!updated) throw new Error('TRANSACTION_RECONCILIATION_RACE');
    }
    return 'AMBIGUOUS';
  }
  if (status.state === 'failed') {
    await input.repository.update(record.id, record.version, { state: 'FAILED', errorCode: status.code });
    return 'FAILED';
  }
  if (status.state === 'confirmed') {
    await input.repository.update(record.id, record.version, { state: 'CONFIRMED' });
    return 'CONFIRMED';
  }
  await input.repository.update(record.id, record.version, {
    state: 'FINALIZED',
    actualFill: status.fill,
  });
  return 'FINALIZED';
}

/** Bounded polling; it never calls submit and therefore cannot rebroadcast. */
export async function reconcileSolanaTransactionBounded(input: {
  id: string;
  repository: SolanaExecutionRepository;
  transport: SolanaExecutionTransport;
  maxAttempts: number;
  wait?: (attempt: number) => Promise<void>;
}): Promise<SolanaTransactionState> {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) {
    throw new Error('INVALID_RECONCILIATION_ATTEMPTS');
  }
  let state: SolanaTransactionState = 'AMBIGUOUS';
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    state = await reconcileSolanaTransaction(input);
    if (['FINALIZED', 'FAILED', 'EXPIRED'].includes(state)) return state;
    if (attempt < input.maxAttempts) await input.wait?.(attempt);
  }
  return state;
}

export class InMemorySolanaExecutionRepository implements SolanaExecutionRepository {
  readonly records = new Map<string, SolanaExecutionRecord & { errorCode?: string | null; actualFill?: ActualSolanaFill }>();
  constructor(record: SolanaExecutionRecord) { this.records.set(record.id, { ...record }); }
  async load(id: string) {
    const row = this.records.get(id);
    if (!row) throw new Error('NOT_FOUND');
    return { ...row };
  }
  async claimBroadcast(id: string, expectedVersion: number) {
    const row = this.records.get(id)!;
    if (row.version !== expectedVersion || row.state !== 'SIGNED' || row.broadcastAttempts !== 0) return false;
    row.broadcastAttempts += 1;
    row.version += 1;
    return true;
  }
  async update(id: string, expectedVersion: number, patch: Parameters<SolanaExecutionRepository['update']>[2]) {
    const row = this.records.get(id)!;
    if (row.version !== expectedVersion) return false;
    Object.assign(row, patch, { version: row.version + 1 });
    return true;
  }
}
