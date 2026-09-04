import {
  allowsAutomaticCredit,
  assetByMint,
  decideCredit,
  depositKey,
  type AssetRule,
  type DepositRejectCode,
  type FundingSafetyState,
} from '@memex/core';

export type SolanaCommitment = 'processed' | 'confirmed' | 'finalized' | 'reorged';

export interface SolanaDepositSourceEvent {
  signature: string;
  instructionIndex: number;
  slot: bigint;
  blockhash: string | null;
  network: string;
  mint: string | null;
  destination: string;
  rawAmount: bigint;
  confirmations: number;
  commitment: SolanaCommitment;
}

export interface ResolvedDepositDestination {
  walletId: string;
  userId: string;
  tokenId: string;
  expectedDestination: string;
}

export type ResolvedSolanaDepositEvent = SolanaDepositSourceEvent & ResolvedDepositDestination;

export interface SolanaDepositReadBatch {
  events: SolanaDepositSourceEvent[];
  /**
   * Highest slot that the source fully inspected, including empty slots.
   * Advancing only to the newest transfer would rescan the same empty range
   * forever and eventually exhaust a production RPC provider.
   */
  scannedThroughSlot: bigint;
}

/** Network adapter. Implementations must never return a partial scan as complete. */
export interface SolanaDepositEventSource {
  readAfterSlot(afterSlot: bigint): Promise<SolanaDepositReadBatch>;
  /** Refresh previously observed non-final events even after checkpoint advanced. */
  readByEventKeys(eventKeys: readonly string[]): Promise<SolanaDepositSourceEvent[]>;
}

export class MockSolanaDepositEventSource implements SolanaDepositEventSource {
  constructor(
    private readonly events: SolanaDepositSourceEvent[],
    private readonly headSlot: bigint = events.reduce(
      (latest, event) => event.slot > latest ? event.slot : latest,
      0n,
    ),
  ) {}

  async readAfterSlot(afterSlot: bigint): Promise<SolanaDepositReadBatch> {
    return {
      events: this.events
        .filter((event) => event.slot > afterSlot)
        .sort(compareEventSlots),
      scannedThroughSlot: this.headSlot > afterSlot ? this.headSlot : afterSlot,
    };
  }

  async readByEventKeys(eventKeys: readonly string[]): Promise<SolanaDepositSourceEvent[]> {
    const wanted = new Set(eventKeys);
    return this.events.filter((event) => wanted.has(depositKey(event.signature, event.instructionIndex)));
  }
}

export type StoredDepositState =
  | 'DETECTED'
  | 'AWAITING_CONFIRMATIONS'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'CREDITED'
  | 'REJECTED'
  | 'REVIEW_REQUIRED'
  | 'REORGED';

export interface SolanaDepositRepository {
  acquireCheckpointLease(consumer: string, workerId: string, now: Date, leaseMs: number): Promise<boolean>;
  checkpoint(consumer: string): Promise<bigint>;
  pendingEventKeys(): Promise<string[]>;
  /** Resolve ownership from our database. Provider payloads never assign user ids. */
  resolveDestination(
    event: SolanaDepositSourceEvent,
    asset: AssetRule,
  ): Promise<ResolvedDepositDestination | null>;
  observe(
    event: SolanaDepositSourceEvent | ResolvedSolanaDepositEvent,
    state: StoredDepositState,
    rejectCode?: string,
  ): Promise<void>;
  creditFinalizedAtomically(event: ResolvedSolanaDepositEvent, asset: AssetRule): Promise<'credited' | 'duplicate'>;
  markReorg(event: SolanaDepositSourceEvent): Promise<'reorged' | 'review-required'>;
  advanceCheckpoint(consumer: string, workerId: string, slot: bigint): Promise<void>;
  releaseCheckpointLease(consumer: string, workerId: string): Promise<void>;
  reconciliationIssues(): Promise<Array<{ eventKey: string; kind: string }>>;
  /** Server-owned latch. No client action can lower it. */
  fundingSafetyState(): Promise<FundingSafetyState>;
}

export interface DepositCycleResult {
  acquired: boolean;
  observed: number;
  credited: number;
  duplicates: number;
  pending: number;
  rejected: number;
  reviewRequired: number;
  /** Finalized and resolved, but not credited: the latch is up. */
  heldBack: number;
  safetyState: FundingSafetyState;
  checkpoint: bigint;
}

const DEFAULT_CHECKPOINT_OVERLAP_SLOTS = 512n;

/**
 * One safe ingestion cycle. A checkpoint lease prevents two API/worker
 * processes from finalizing the same range at once; event uniqueness is the
 * second line of defence when leases expire during a long request.
 */
export async function processSolanaDepositCycle(input: {
  source: SolanaDepositEventSource;
  repository: SolanaDepositRepository;
  workerId: string;
  consumer?: string;
  now?: Date;
  leaseMs?: number;
  /** Explicit chain boundary for the first ever production scan. */
  initialStartSlot?: bigint;
  /** Re-read a bounded tail to tolerate RPC indexing lag and newly added wallets. */
  overlapSlots?: bigint;
}): Promise<DepositCycleResult> {
  const consumer = input.consumer ?? 'solana-deposits-v1';
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 30_000;
  const acquired = await input.repository.acquireCheckpointLease(
    consumer,
    input.workerId,
    now,
    leaseMs,
  );
  const current = await input.repository.checkpoint(consumer);
  if (!acquired) return emptyResult(false, current);

  const result = emptyResult(true, current);
  try {
    const overlapSlots = input.overlapSlots ?? DEFAULT_CHECKPOINT_OVERLAP_SLOTS;
    if (overlapSlots < 0n) throw new Error('SOLANA_DEPOSIT_OVERLAP_INVALID');
    const isBootstrap = current === 0n && input.initialStartSlot !== undefined;
    const after = isBootstrap
      ? input.initialStartSlot!
      : current > overlapSlots
        ? current - overlapSlots
        : -1n;
    const [newBatch, refreshedEvents] = await Promise.all([
      input.source.readAfterSlot(after),
      input.repository.pendingEventKeys().then((keys) => input.source.readByEventKeys(keys)),
    ]);
    if (isBootstrap && newBatch.scannedThroughSlot < after) {
      throw new Error('SOLANA_DEPOSIT_BOOTSTRAP_SLOT_AHEAD_OF_CHAIN');
    }
    const byKey = new Map<string, SolanaDepositSourceEvent>();
    for (const event of [...newBatch.events, ...refreshedEvents]) {
      byKey.set(depositKey(event.signature, event.instructionIndex), event);
    }
    const events = [...byKey.values()].sort(compareEventSlots);
    if (newBatch.scannedThroughSlot > result.checkpoint) {
      result.checkpoint = newBatch.scannedThroughSlot;
    }

    /*
     * Останавливать зачисления решает сервер, а не воркер.
     *
     * Проверка делается один раз за цикл и до первой проводки:
     * состояние, поднятое сверкой, обязано подействовать сразу, а не
     * со следующего запуска.
     */
    const safety = await input.repository.fundingSafetyState();
    const creditAllowed = allowsAutomaticCredit(safety);
    result.safetyState = safety;

    for (const event of events) {
      result.observed += 1;
      /*
       * Checkpoint не поднимается выше просмотренного края.
       *
       * Повторно прочитанное событие может вернуться из более
       * позднего слота, чем тот, до которого дошёл этот проход.
       * Записать его номер как границу значит объявить просмотренным
       * диапазон, в который никто не смотрел, — и потерять всё,
       * что в нём лежало.
       */

      if (event.commitment === 'reorged') {
        const outcome = await input.repository.markReorg(event);
        if (outcome === 'review-required') result.reviewRequired += 1;
        continue;
      }

      const asset = assetByMint(event.mint);
      const destination = asset
        ? await input.repository.resolveDestination(event, asset)
        : null;
      const decision = decideCredit(
        {
          signature: event.signature,
          instructionIndex: event.instructionIndex,
          network: event.network as 'solana',
          mint: event.mint,
          destination: event.destination,
          rawAmount: event.rawAmount,
          confirmations: event.confirmations,
        },
        destination?.expectedDestination ?? '',
      );
      const observedEvent = destination ? { ...event, ...destination } : event;

      if (event.network !== 'solana') {
        await input.repository.observe(observedEvent, 'REJECTED', 'WRONG_NETWORK');
        result.rejected += 1;
        continue;
      }

      if (!decision.credit) {
        const state = decision.state === 'pending' ? 'AWAITING_CONFIRMATIONS' : 'REJECTED';
        await input.repository.observe(observedEvent, state, decision.reason);
        if (state === 'REJECTED') result.rejected += 1;
        else result.pending += 1;
        continue;
      }

      if (event.commitment !== 'finalized') {
        await input.repository.observe(
          observedEvent,
          event.commitment === 'confirmed' ? 'CONFIRMED' : 'AWAITING_CONFIRMATIONS',
        );
        result.pending += 1;
        continue;
      }

      // A credited decision is impossible without a database-owned destination,
      // but keep the assertion explicit before crossing the atomic boundary.
      if (!destination) throw new Error('CREDITED_DESTINATION_NOT_RESOLVED');

      if (!creditAllowed) {
        /*
         * Контур остановлен сверкой. Событие сохраняется как
         * финализированное — данные не теряются и не искажаются, —
         * но денег на баланс не попадает, пока человек не разберётся.
         */
        await input.repository.observe({ ...event, ...destination }, 'FINALIZED');
        result.heldBack += 1;
        continue;
      }

      const credited = await input.repository.creditFinalizedAtomically(
        { ...event, ...destination },
        decision.asset!,
      );
      result[credited === 'credited' ? 'credited' : 'duplicates'] += 1;
    }

    await input.repository.advanceCheckpoint(consumer, input.workerId, result.checkpoint);
    return result;
  } finally {
    await input.repository.releaseCheckpointLease(consumer, input.workerId);
  }
}

function compareEventSlots(a: SolanaDepositSourceEvent, b: SolanaDepositSourceEvent): number {
  if (a.slot === b.slot) return a.instructionIndex - b.instructionIndex;
  return a.slot < b.slot ? -1 : 1;
}

function emptyResult(acquired: boolean, checkpoint: bigint): DepositCycleResult {
  return {
    acquired,
    observed: 0,
    credited: 0,
    duplicates: 0,
    pending: 0,
    rejected: 0,
    reviewRequired: 0,
    heldBack: 0,
    safetyState: 'HEALTHY',
    checkpoint,
  };
}

interface StoredEvent {
  state: StoredDepositState;
  rejectCode?: string;
  event: SolanaDepositSourceEvent;
}

/** Test adapter with transaction-like copy-on-write crediting semantics. */
export class InMemorySolanaDepositRepository implements SolanaDepositRepository {
  readonly events = new Map<string, StoredEvent>();
  readonly deposits = new Map<string, string>();
  readonly ledger = new Map<string, bigint>();
  readonly balances = new Map<string, bigint>();
  readonly issues = new Map<string, { eventKey: string; kind: string }>();
  failAtomicCreditFor: string | null = null;
  safety: FundingSafetyState = 'HEALTHY';
  private readonly checkpoints = new Map<string, bigint>();
  private readonly leases = new Map<string, { owner: string; until: number }>();
  private readonly destinations = new Map<string, ResolvedDepositDestination>();

  registerDestination(destination: ResolvedDepositDestination) {
    this.destinations.set(destination.expectedDestination, { ...destination });
  }

  async acquireCheckpointLease(consumer: string, workerId: string, now: Date, leaseMs: number) {
    const lease = this.leases.get(consumer);
    if (lease && lease.owner !== workerId && lease.until > now.getTime()) return false;
    this.leases.set(consumer, { owner: workerId, until: now.getTime() + leaseMs });
    return true;
  }

  async checkpoint(consumer: string) {
    return this.checkpoints.get(consumer) ?? 0n;
  }

  async pendingEventKeys() {
    return [...this.events.entries()]
      .filter(([, stored]) => ['DETECTED', 'AWAITING_CONFIRMATIONS', 'CONFIRMED'].includes(stored.state))
      .map(([key]) => key);
  }

  async resolveDestination(event: SolanaDepositSourceEvent) {
    return this.destinations.get(event.destination) ?? null;
  }

  async observe(
    event: SolanaDepositSourceEvent | ResolvedSolanaDepositEvent,
    state: StoredDepositState,
    rejectCode?: string,
  ) {
    const key = depositKey(event.signature, event.instructionIndex);
    const existing = this.events.get(key);
    if (existing?.state === 'CREDITED') return;
    this.events.set(key, { event, state, rejectCode });
  }

  async creditFinalizedAtomically(event: ResolvedSolanaDepositEvent, asset: AssetRule) {
    const key = depositKey(event.signature, event.instructionIndex);
    if (this.deposits.has(key)) return 'duplicate' as const;
    if (this.failAtomicCreditFor === key) throw new Error('SIMULATED_ATOMIC_FAILURE');

    const amountKey = `${event.userId}:${event.tokenId}`;
    const scale = 10n ** BigInt(asset.decimals);
    // The in-memory ledger keeps raw units to prove atomic identity. The
    // Prisma adapter stores the exact decimal amount in NUMERIC(38,18).
    const nextBalance = (this.balances.get(amountKey) ?? 0n) + event.rawAmount;
    const nextLedger = (this.ledger.get(amountKey) ?? 0n) + event.rawAmount;

    this.deposits.set(key, `${event.rawAmount}/${scale}`);
    this.balances.set(amountKey, nextBalance);
    this.ledger.set(amountKey, nextLedger);
    this.events.set(key, { event, state: 'CREDITED' });
    return 'credited' as const;
  }

  async markReorg(event: SolanaDepositSourceEvent) {
    const key = depositKey(event.signature, event.instructionIndex);
    const existing = this.events.get(key);
    if (existing?.state === 'CREDITED') {
      this.events.set(key, { event, state: 'REVIEW_REQUIRED', rejectCode: 'REORG_AFTER_CREDIT' });
      this.issues.set(`${key}:REORG_AFTER_CREDIT`, { eventKey: key, kind: 'REORG_AFTER_CREDIT' });
      return 'review-required' as const;
    }
    this.events.set(key, { event, state: 'REORGED', rejectCode: 'REORGED' });
    return 'reorged' as const;
  }

  async advanceCheckpoint(consumer: string, workerId: string, slot: bigint) {
    if (this.leases.get(consumer)?.owner !== workerId) throw new Error('CHECKPOINT_LEASE_LOST');
    if (slot > (this.checkpoints.get(consumer) ?? 0n)) this.checkpoints.set(consumer, slot);
  }

  async releaseCheckpointLease(consumer: string, workerId: string) {
    if (this.leases.get(consumer)?.owner === workerId) this.leases.delete(consumer);
  }

  async reconciliationIssues() {
    return [...this.issues.values()];
  }

  async fundingSafetyState() {
    return this.safety;
  }
}

export function depositRejectCode(value: unknown): DepositRejectCode | undefined {
  return typeof value === 'string' ? (value as DepositRejectCode) : undefined;
}

export function canonicalAssetForEvent(event: SolanaDepositSourceEvent): AssetRule | null {
  return assetByMint(event.mint);
}
