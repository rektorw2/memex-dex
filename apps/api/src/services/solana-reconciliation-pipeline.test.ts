import { describe, it, expect, beforeEach } from 'vitest';
import { MISSING_CHECKS_BEFORE_ISSUE, MISSING_MIN_AGE_MS, type FundingSafetyState } from '@memex/core';
import {
  runSolanaReconciliationCycle,
  type ChainLookup,
  type ReconcilableEvent,
  type ReconciliationChainReader,
  type ReconciliationIssueDraft,
  type ReconciliationObservation,
  type SolanaReconciliationRepository,
} from './solana-reconciliation-pipeline.js';
import type { SolanaDepositSourceEvent } from './solana-deposit-pipeline.js';

/**
 * Сверка зачислений.
 *
 * Проверяется не «вызвалась ли функция», а последствия: появилась ли
 * проблема, остановился ли контур, не отменил ли кто-нибудь проводку
 * сам. Последнее важнее всего: списание по подозрению здесь должно
 * быть невозможно, а не просто не реализовано.
 */

const NOW = new Date('2026-09-04T12:00:00Z');
const KEY = 'sig-1:0';

function storedEvent(over: Partial<ReconcilableEvent> = {}): ReconcilableEvent {
  return {
    eventKey: KEY,
    signature: 'sig-1',
    instructionIndex: 0,
    state: 'FINALIZED',
    facts: {
      slot: '100',
      blockhash: 'hash-a',
      rawAmount: '1000000',
      destination: 'Dest111',
      mint: null,
    },
    observedAt: new Date(NOW.getTime() - 60_000),
    missingSince: null,
    consecutiveMissingChecks: 0,
    reconcileAttempts: 0,
    ...over,
  };
}

function chainEvent(over: Partial<SolanaDepositSourceEvent> = {}): SolanaDepositSourceEvent {
  return {
    signature: 'sig-1',
    instructionIndex: 0,
    slot: 100n,
    blockhash: 'hash-a',
    network: 'solana',
    mint: null,
    destination: 'Dest111',
    rawAmount: 1_000_000n,
    confirmations: 32,
    commitment: 'finalized',
    ...over,
  };
}

/**
 * Хранилище в памяти.
 *
 * Захват строки моделируется честно: две попытки взять одну строку
 * не могут обе получить её. Без этого тест на два планировщика
 * проверял бы подделку, а не правило.
 */
class FakeRepo implements SolanaReconciliationRepository {
  rows: ReconcilableEvent[] = [];
  claims = new Map<string, string>();
  observations: ReconciliationObservation[] = [];
  issues: ReconciliationIssueDraft[] = [];
  safety: Array<{ state: FundingSafetyState; kind: string; eventKey: string }> = [];
  orphanCredits: string[] = [];
  /** Строки, у которых кто-то менял деньги. Должна остаться пустой. */
  moneyTouched: string[] = [];

  async claimBatch(workerId: string, _now: Date, _leaseMs: number, limit: number) {
    const free = this.rows.filter((row) => !this.claims.has(row.eventKey)).slice(0, limit);
    for (const row of free) this.claims.set(row.eventKey, workerId);
    return free.map((row) => ({ ...row }));
  }

  async releaseClaim(workerId: string, eventKeys: readonly string[]) {
    for (const key of eventKeys) {
      if (this.claims.get(key) === workerId) this.claims.delete(key);
    }
  }

  async recordObservation(observation: ReconciliationObservation) {
    this.observations.push(observation);
    const row = this.rows.find((item) => item.eventKey === observation.eventKey);
    if (row) {
      row.missingSince = observation.missingSince;
      row.consecutiveMissingChecks = observation.consecutiveMissingChecks;
      row.reconcileAttempts = observation.reconcileAttempts;
    }
  }

  async raiseIssue(issue: ReconciliationIssueDraft) {
    // Хранилище ведёт себя как таблица с уникальностью (eventKey, kind).
    const existing = this.issues.findIndex(
      (item) => item.eventKey === issue.eventKey && item.kind === issue.kind,
    );
    if (existing >= 0) this.issues[existing] = issue;
    else this.issues.push(issue);
  }

  async raiseSafety(state: FundingSafetyState, kind: string, eventKey: string) {
    this.safety.push({ state, kind, eventKey });
  }

  async creditsWithoutChainEvent() {
    return this.orphanCredits;
  }
}

class FakeReader implements ReconciliationChainReader {
  constructor(private readonly answer: (key: string) => ChainLookup) {}
  async lookup(events: readonly ReconcilableEvent[]) {
    return new Map(events.map((event) => [event.eventKey, this.answer(event.eventKey)]));
  }
}

let repo: FakeRepo;

beforeEach(() => {
  repo = new FakeRepo();
});

const run = (reader: ReconciliationChainReader, workerId = 'worker-a', now = NOW) =>
  runSolanaReconciliationCycle({
    repository: repo,
    reader,
    workerId,
    now,
    random: () => 0.5,
  });

// ──────────────────────── Совпадение и расхождения ───────────────────────────

describe('совпадение с цепочкой', () => {
  it('не заводит проблем', async () => {
    repo.rows = [storedEvent({ state: 'CREDITED' })];
    const result = await run(new FakeReader(() => ({ kind: 'found', event: chainEvent() })));

    expect(result.matched).toBe(1);
    expect(repo.issues).toEqual([]);
    expect(repo.safety).toEqual([]);
  });

  it('обнуляет счётчик исчезновений', async () => {
    // Иначе старая серия промахов дождалась бы порога через месяц
    // исправной работы и подняла бы тревогу на пустом месте.
    repo.rows = [storedEvent({ state: 'CREDITED', consecutiveMissingChecks: 2, missingSince: NOW })];
    await run(new FakeReader(() => ({ kind: 'found', event: chainEvent() })));

    expect(repo.observations[0]!.consecutiveMissingChecks).toBe(0);
    expect(repo.observations[0]!.missingSince).toBeNull();
  });
});

describe('расхождения', () => {
  const mismatch = async (event: SolanaDepositSourceEvent, state = 'CREDITED') => {
    repo.rows = [storedEvent({ state })];
    return run(new FakeReader(() => ({ kind: 'found', event })));
  };

  it('несовпадение суммы', async () => {
    await mismatch(chainEvent({ rawAmount: 999n }));
    expect(repo.issues.map((issue) => issue.kind)).toContain('AMOUNT_MISMATCH');
  });

  it('несовпадение получателя', async () => {
    await mismatch(chainEvent({ destination: 'Other' }));
    expect(repo.issues.map((issue) => issue.kind)).toContain('DESTINATION_MISMATCH');
  });

  it('несовпадение адреса выпуска', async () => {
    await mismatch(chainEvent({ mint: 'EPjF' }));
    expect(repo.issues.map((issue) => issue.kind)).toContain('MINT_MISMATCH');
  });

  it('изменился слот', async () => {
    await mismatch(chainEvent({ slot: 777n }));
    expect(repo.issues.map((issue) => issue.kind)).toContain('SLOT_CHANGED');
  });

  it('изменился blockhash', async () => {
    await mismatch(chainEvent({ blockhash: 'hash-b' }));
    expect(repo.issues.map((issue) => issue.kind)).toContain('BLOCKHASH_CHANGED');
  });

  it('расхождение у зачисленного требует решения человека', async () => {
    await mismatch(chainEvent({ rawAmount: 999n }), 'CREDITED');
    expect(repo.safety.map((entry) => entry.state)).toContain('REVIEW_REQUIRED');
  });

  it('расхождение до зачисления останавливает зачисления', async () => {
    await mismatch(chainEvent({ rawAmount: 999n }), 'FINALIZED');
    expect(repo.safety.map((entry) => entry.state)).toContain('PAUSED');
  });

  it('финализировано, но не зачислено', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    await run(new FakeReader(() => ({ kind: 'found', event: chainEvent() })));

    expect(repo.issues.map((issue) => issue.kind)).toContain('FINALIZED_WITHOUT_CREDIT');
  });

  it('слишком долгое ожидание подтверждений', async () => {
    repo.rows = [storedEvent({
      state: 'AWAITING_CONFIRMATIONS',
      observedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
    })];
    await run(new FakeReader(() => ({ kind: 'found', event: chainEvent({ commitment: 'confirmed' }) })));

    expect(repo.issues.map((issue) => issue.kind)).toContain('PENDING_TOO_LONG');
  });
});

// ──────────────────────────── Исчезновение ───────────────────────────────────

describe('исчезновение транзакции', () => {
  const absent = new FakeReader(() => ({ kind: 'absent' as const }));

  it('одно исчезновение не считается реорганизацией', async () => {
    repo.rows = [storedEvent({ state: 'CREDITED' })];
    await run(absent);

    expect(repo.issues).toEqual([]);
    expect(repo.safety).toEqual([]);
  });

  it('после порога проверок и выдержки проблема заводится', async () => {
    repo.rows = [storedEvent({
      state: 'CREDITED',
      consecutiveMissingChecks: MISSING_CHECKS_BEFORE_ISSUE - 1,
      missingSince: new Date(NOW.getTime() - MISSING_MIN_AGE_MS),
    })];
    await run(absent);

    expect(repo.issues.map((issue) => issue.kind)).toEqual(['REORG_AFTER_CREDIT']);
    expect(repo.safety[0]!.state).toBe('REVIEW_REQUIRED');
  });

  it('повторная сверка не создаёт второй такой же проблемы', async () => {
    repo.rows = [storedEvent({
      state: 'CREDITED',
      consecutiveMissingChecks: MISSING_CHECKS_BEFORE_ISSUE - 1,
      missingSince: new Date(NOW.getTime() - MISSING_MIN_AGE_MS),
    })];
    await run(absent);
    await run(absent, 'worker-a', new Date(NOW.getTime() + 60_000));

    expect(repo.issues).toHaveLength(1);
  });

  it('счётчик растёт, а не сбрасывается между проходами', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    await run(absent);
    await run(absent);

    expect(repo.observations.at(-1)!.consecutiveMissingChecks).toBe(2);
  });

  it('первый промах запоминает время начала', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    await run(absent);

    expect(repo.observations[0]!.missingSince).toEqual(NOW);
  });
});

// ─────────────────────── Недоступность против исчезновения ───────────────────

describe('недоступность узла', () => {
  const unreachable = new FakeReader(() => ({ kind: 'unreachable' as const, code: 'SOLANA_RPC_TIMEOUT' }));

  it('не увеличивает счётчик исчезновений', async () => {
    // Ошибка сети — состояние наблюдателя, а не цепочки. Считать её
    // исчезновением значит поднимать реорганизацию на каждом таймауте.
    repo.rows = [storedEvent({ state: 'CREDITED', consecutiveMissingChecks: 2 })];
    await run(unreachable);

    expect(repo.observations[0]!.consecutiveMissingChecks).toBe(2);
  });

  it('никогда не превращается в реорганизацию, сколько бы раз ни повторилась', async () => {
    repo.rows = [storedEvent({ state: 'CREDITED' })];
    for (let attempt = 0; attempt < 10; attempt++) await run(unreachable);

    expect(repo.issues).toEqual([]);
  });

  it('ухудшает состояние, но не останавливает зачисления', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    const result = await run(unreachable);

    expect(result.safetyState).toBe('DEGRADED');
  });

  it('откладывает следующую попытку', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    await run(unreachable);

    expect(repo.observations[0]!.reconcileNotBefore!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('отступление растёт с числом неудач', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED', reconcileAttempts: 4 })];
    await run(unreachable);
    const far = repo.observations[0]!.reconcileNotBefore!.getTime();

    repo = new FakeRepo();
    repo.rows = [storedEvent({ state: 'FINALIZED', reconcileAttempts: 0 })];
    await run(unreachable);
    const near = repo.observations[0]!.reconcileNotBefore!.getTime();

    expect(far).toBeGreaterThan(near);
  });

  it('непонятный ответ отличается от недоступности', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    const result = await run(
      new FakeReader(() => ({ kind: 'invalid', code: 'SOLANA_RPC_MALFORMED_STATUSES' })),
    );

    expect(result.unreachable).toBe(1);
    expect(repo.observations[0]!.reconciliationState).toBe('UNREACHABLE');
  });
});

// ───────────────────────── Проводка без основания ────────────────────────────

describe('проводка без события цепочки', () => {
  it('заводит проблему и требует решения человека', async () => {
    repo.orphanCredits = ['orphan-sig:0'];
    const result = await run(new FakeReader(() => ({ kind: 'absent' })));

    expect(repo.issues.map((issue) => issue.kind)).toEqual(['CREDIT_WITHOUT_CHAIN_EVENT']);
    expect(result.safetyState).toBe('REVIEW_REQUIRED');
  });

  it('находится даже при пустой очереди сверки', async () => {
    // Такую строку нельзя встретить, перебирая события: её события нет.
    repo.rows = [];
    repo.orphanCredits = ['orphan-sig:0'];
    await run(new FakeReader(() => ({ kind: 'absent' })));

    expect(repo.issues).toHaveLength(1);
  });
});

// ──────────────────────────── Планировщики ───────────────────────────────────

describe('два планировщика', () => {
  it('не обрабатывают одну строку одновременно', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    const reader = new FakeReader(() => ({ kind: 'found', event: chainEvent() }));

    const [first, second] = await Promise.all([
      run(reader, 'worker-a'),
      run(reader, 'worker-b'),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
  });

  it('освобождают строку после прохода', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    const reader = new FakeReader(() => ({ kind: 'found', event: chainEvent() }));
    await run(reader, 'worker-a');

    // Перезапуск процесса не должен оставлять строку занятой навсегда.
    expect(repo.claims.size).toBe(0);
    expect((await run(reader, 'worker-b')).claimed).toBe(1);
  });

  it('освобождают строку и после ошибки', async () => {
    repo.rows = [storedEvent({ state: 'FINALIZED' })];
    const broken: ReconciliationChainReader = {
      async lookup() { throw new Error('READER_FAILED'); },
    };

    await expect(run(broken)).rejects.toThrow('READER_FAILED');
    expect(repo.claims.size).toBe(0);
  });
});

// ──────────────────────────── Границы полномочий ─────────────────────────────

describe('чего сверка не делает', () => {
  it('не отменяет проводку при реорганизации после зачисления', async () => {
    repo.rows = [storedEvent({
      state: 'CREDITED',
      consecutiveMissingChecks: MISSING_CHECKS_BEFORE_ISSUE - 1,
      missingSince: new Date(NOW.getTime() - MISSING_MIN_AGE_MS),
    })];
    await run(new FakeReader(() => ({ kind: 'absent' })));

    // Подозрение бывает ложным, а списанные у человека деньги
    // возвращаются руками и с извинениями.
    expect(repo.moneyTouched).toEqual([]);
  });

  it('не удаляет и не переписывает записанные факты', async () => {
    const before = { ...storedEvent({ state: 'CREDITED' }).facts };
    repo.rows = [storedEvent({ state: 'CREDITED' })];
    await run(new FakeReader(() => ({ kind: 'found', event: chainEvent({ rawAmount: 999n }) })));

    expect(repo.rows[0]!.facts).toEqual(before);
  });

  it('в интерфейсе репозитория нет операции списания', () => {
    const surface = Object.getOwnPropertyNames(FakeRepo.prototype);
    for (const forbidden of ['debit', 'reverse', 'refund', 'deleteEvent']) {
      expect(surface, forbidden).not.toContain(forbidden);
    }
  });
});
