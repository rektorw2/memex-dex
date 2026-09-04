import {
  classifyMissing,
  compareChainFacts,
  depositKey,
  isPendingTooLong,
  reconciliationBackoffMs,
  safetyStateForIssue,
  worstSafetyState,
  type FundingSafetyState,
  type ReconciliationIssueKind,
  type StoredChainFacts,
} from '@memex/core';
import type { SolanaDepositSourceEvent } from './solana-deposit-pipeline.js';

/**
 * Сверка записанных пополнений с тем, что цепочка говорит сейчас.
 *
 * Цикл отделён от приёма депозитов намеренно. Приём должен быть
 * быстрым и не зависеть от того, сколько старых записей нужно
 * перепроверить; сверка должна идти медленно и не мешать приёму.
 * Общего у них только одно — база.
 *
 * Здесь нет ни одной операции, меняющей деньги. Сверка умеет ровно
 * три вещи: записать наблюдение, завести проблему и поднять защёлку.
 * Списание по подозрению не предусмотрено конструкцией, а не забыто.
 */

/** Как строка выглядит для сверки. Суммы — строки, слоты — строки. */
export interface ReconcilableEvent {
  eventKey: string;
  signature: string;
  instructionIndex: number;
  state: string;
  facts: StoredChainFacts;
  observedAt: Date;
  missingSince: Date | null;
  consecutiveMissingChecks: number;
  reconcileAttempts: number;
}

export type ChainLookup =
  | { kind: 'found'; event: SolanaDepositSourceEvent }
  | { kind: 'absent' }
  | { kind: 'unreachable'; code: string }
  | { kind: 'invalid'; code: string };

export interface ReconciliationObservation {
  eventKey: string;
  reconciliationState: 'MATCHED' | 'MISSING' | 'MISMATCHED' | 'UNREACHABLE';
  lastChainSeenAt: Date | null;
  missingSince: Date | null;
  consecutiveMissingChecks: number;
  reconcileAttempts: number;
  reconcileNotBefore: Date | null;
}

export interface ReconciliationIssueDraft {
  eventKey: string;
  kind: ReconciliationIssueKind;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  safety: FundingSafetyState;
}

export interface SolanaReconciliationRepository {
  /** Atomic claim. Two schedulers must never receive the same row. */
  claimBatch(workerId: string, now: Date, leaseMs: number, limit: number): Promise<ReconcilableEvent[]>;
  releaseClaim(workerId: string, eventKeys: readonly string[]): Promise<void>;
  recordObservation(observation: ReconciliationObservation): Promise<void>;
  /** Upsert by (eventKey, kind). Repeating a check must not pile up rows. */
  raiseIssue(issue: ReconciliationIssueDraft): Promise<void>;
  raiseSafety(state: FundingSafetyState, reasonKind: string, eventKey: string): Promise<void>;
  /** Credited rows whose chain event row is missing entirely. */
  creditsWithoutChainEvent(limit: number): Promise<string[]>;
}

export interface ReconciliationChainReader {
  lookup(events: readonly ReconcilableEvent[]): Promise<Map<string, ChainLookup>>;
}

export interface ReconciliationCycleResult {
  claimed: number;
  matched: number;
  missing: number;
  mismatched: number;
  unreachable: number;
  issuesRaised: number;
  safetyState: FundingSafetyState;
}

const CREDITED_STATES = new Set(['CREDITED']);
const FINALIZED_STATES = new Set(['FINALIZED', 'CREDITED']);

export async function runSolanaReconciliationCycle(input: {
  repository: SolanaReconciliationRepository;
  reader: ReconciliationChainReader;
  workerId: string;
  now?: Date;
  leaseMs?: number;
  batchSize?: number;
  /** Injected so backoff jitter stays testable. */
  random?: () => number;
}): Promise<ReconciliationCycleResult> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 60_000;
  const batchSize = input.batchSize ?? 50;
  const random = input.random ?? Math.random;

  const result: ReconciliationCycleResult = {
    claimed: 0,
    matched: 0,
    missing: 0,
    mismatched: 0,
    unreachable: 0,
    issuesRaised: 0,
    safetyState: 'HEALTHY',
  };
  const raised: FundingSafetyState[] = [];

  const batch = await input.repository.claimBatch(input.workerId, now, leaseMs, batchSize);
  result.claimed = batch.length;

  try {
    /*
     * Проводка без события цепочки ищется отдельным запросом.
     *
     * Такую строку нельзя найти, перебирая события: её события нет.
     * Именно поэтому она и опасна — деньги выданы, а основания под
     * ними в журнале не осталось.
     */
    for (const eventKey of await input.repository.creditsWithoutChainEvent(batchSize)) {
      await input.repository.raiseIssue({
        eventKey,
        kind: 'CREDIT_WITHOUT_CHAIN_EVENT',
        expected: { chainEvent: 'present' },
        actual: { chainEvent: 'missing' },
        safety: 'REVIEW_REQUIRED',
      });
      await input.repository.raiseSafety('REVIEW_REQUIRED', 'CREDIT_WITHOUT_CHAIN_EVENT', eventKey);
      raised.push('REVIEW_REQUIRED');
      result.issuesRaised += 1;
    }

    if (batch.length === 0) {
      result.safetyState = worstSafetyState(raised);
      return result;
    }

    const lookups = await input.reader.lookup(batch);

    for (const event of batch) {
      const lookup = lookups.get(event.eventKey) ?? { kind: 'unreachable' as const, code: 'CHAIN_LOOKUP_MISSING' };
      const wasCredited = CREDITED_STATES.has(event.state);
      const wasFinalized = FINALIZED_STATES.has(event.state);

      if (lookup.kind === 'unreachable' || lookup.kind === 'invalid') {
        /*
         * Узел не ответил или ответил непонятно.
         *
         * Счётчик исчезновений не трогается: недоступность узла —
         * состояние наблюдателя, а не цепочки. Иначе десять минут
         * сетевых проблем выглядели бы как массовая реорганизация,
         * и контур встал бы на ровном месте.
         */
        result.unreachable += 1;
        const attempts = event.reconcileAttempts + 1;
        await input.repository.recordObservation({
          eventKey: event.eventKey,
          reconciliationState: 'UNREACHABLE',
          lastChainSeenAt: null,
          missingSince: event.missingSince,
          consecutiveMissingChecks: event.consecutiveMissingChecks,
          reconcileAttempts: attempts,
          reconcileNotBefore: new Date(now.getTime() + reconciliationBackoffMs(attempts, random())),
        });
        const kind: ReconciliationIssueKind =
          lookup.kind === 'invalid' ? 'CHAIN_RESPONSE_INVALID' : 'CHAIN_UNREACHABLE';
        raised.push(safetyStateForIssue(kind, wasCredited));
        continue;
      }

      if (lookup.kind === 'absent') {
        result.missing += 1;
        const missingSince = event.missingSince ?? now;
        const checks = event.consecutiveMissingChecks + 1;
        const verdict = classifyMissing({
          consecutiveMissingChecks: checks,
          missingSince: missingSince.getTime(),
          now: now.getTime(),
          wasCredited,
          wasFinalized,
        });
        await input.repository.recordObservation({
          eventKey: event.eventKey,
          reconciliationState: 'MISSING',
          lastChainSeenAt: null,
          missingSince,
          consecutiveMissingChecks: checks,
          reconcileAttempts: 0,
          reconcileNotBefore: new Date(now.getTime() + reconciliationBackoffMs(checks, random())),
        });
        if (verdict.escalate && verdict.kind) {
          const safety = safetyStateForIssue(verdict.kind, wasCredited);
          await input.repository.raiseIssue({
            eventKey: event.eventKey,
            kind: verdict.kind,
            expected: { slot: event.facts.slot, state: event.state },
            actual: { found: false, checks },
            safety,
          });
          await input.repository.raiseSafety(safety, verdict.kind, event.eventKey);
          raised.push(safety);
          result.issuesRaised += 1;
        }
        continue;
      }

      const observed = lookup.event;
      const kinds = compareChainFacts(event.facts, {
        slot: observed.slot.toString(),
        blockhash: observed.blockhash,
        rawAmount: observed.rawAmount.toString(),
        destination: observed.destination,
        mint: observed.mint,
      });
      /*
       * Зависшее ожидание — отдельная проблема, а не расхождение.
       * Цепочка не противоречит записи; она просто не двигается,
       * и человек, приславший деньги, уже второй час их не видит.
       */
      if (kinds.length === 0 && !wasFinalized && isPendingTooLong(event.observedAt.getTime(), now.getTime())) {
        kinds.push('PENDING_TOO_LONG');
      }
      if (kinds.length === 0 && wasFinalized && !wasCredited) {
        kinds.push('FINALIZED_WITHOUT_CREDIT');
      }

      await input.repository.recordObservation({
        eventKey: event.eventKey,
        reconciliationState: kinds.length === 0 ? 'MATCHED' : 'MISMATCHED',
        lastChainSeenAt: now,
        // Транзакция нашлась: счётчик исчезновений обнуляется, иначе
        // одна старая серия промахов накопилась бы до тревоги через
        // месяц исправной работы.
        missingSince: null,
        consecutiveMissingChecks: 0,
        reconcileAttempts: 0,
        reconcileNotBefore: null,
      });

      if (kinds.length === 0) {
        result.matched += 1;
        continue;
      }
      result.mismatched += 1;
      for (const kind of kinds) {
        const safety = safetyStateForIssue(kind, wasCredited);
        await input.repository.raiseIssue({
          eventKey: event.eventKey,
          kind,
          expected: { ...event.facts },
          actual: {
            slot: observed.slot.toString(),
            blockhash: observed.blockhash,
            rawAmount: observed.rawAmount.toString(),
            destination: observed.destination,
            mint: observed.mint,
          },
          safety,
        });
        await input.repository.raiseSafety(safety, kind, event.eventKey);
        raised.push(safety);
        result.issuesRaised += 1;
      }
    }
  } finally {
    await input.repository.releaseClaim(input.workerId, batch.map((event) => event.eventKey));
  }

  result.safetyState = worstSafetyState(raised);
  return result;
}

export function eventKeyOf(event: { signature: string; instructionIndex: number }): string {
  return depositKey(event.signature, event.instructionIndex);
}
