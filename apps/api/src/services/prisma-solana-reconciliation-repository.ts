import { Prisma as P } from '@prisma/client';
import { worstSafetyState, type FundingSafetyState } from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import type {
  ReconcilableEvent,
  ReconciliationIssueDraft,
  ReconciliationObservation,
  SolanaReconciliationRepository,
} from './solana-reconciliation-pipeline.js';

/** Единственная строка защёлки. Идентификатор фиксирован. */
export const FUNDING_LATCH_ID = 'solana-funding-v1';

const RECONCILABLE_STATES = ['AWAITING_CONFIRMATIONS', 'CONFIRMED', 'FINALIZED', 'CREDITED'] as const;

/**
 * Персистентный адаптер сверки.
 *
 * Захват строк — единственная часть, где важна атомарность: два
 * планировщика, взявшие одну строку, удвоят и проблемы, и счётчики
 * исчезновений, а счётчик исчезновений решает, поднимать ли тревогу.
 */
export class PrismaSolanaReconciliationRepository implements SolanaReconciliationRepository {
  async claimBatch(
    workerId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<ReconcilableEvent[]> {
    const until = new Date(now.getTime() + leaseMs);
    /*
     * `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.
     *
     * Выбор и захват одним оператором: между `SELECT` и `UPDATE`
     * в двух отдельных запросах помещается второй планировщик.
     * `SKIP LOCKED` даёт ему пропустить занятые строки вместо того,
     * чтобы ждать освобождения и получить те же самые.
     */
    const rows = await prisma.$queryRaw<Array<{
      eventKey: string;
      signature: string;
      instructionIndex: number;
      state: string;
      slot: bigint;
      blockhash: string | null;
      rawAmount: string;
      destination: string;
      mint: string | null;
      observedAt: Date;
      missingSince: Date | null;
      consecutiveMissingChecks: number;
      reconcileAttempts: number;
    }>>`
      UPDATE "SolanaDepositEvent" AS target
      SET "leaseOwner" = ${workerId},
          "leaseUntil" = ${until},
          "version" = target."version" + 1
      WHERE target."id" IN (
        SELECT candidate."id" FROM "SolanaDepositEvent" AS candidate
        WHERE candidate."state" = ANY (${P.sql`ARRAY[${P.join(
          RECONCILABLE_STATES.map((state) => P.sql`${state}`),
        )}]::"SolanaDepositEventState"[]`})
          AND (candidate."leaseUntil" IS NULL OR candidate."leaseUntil" < ${now})
          AND (candidate."reconcileNotBefore" IS NULL OR candidate."reconcileNotBefore" <= ${now})
        ORDER BY candidate."lastReconciledAt" ASC NULLS FIRST, candidate."slot" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING target."eventKey", target."signature", target."instructionIndex",
                target."state"::text AS "state", target."slot", target."blockhash",
                target."rawAmount", target."destination", target."mint",
                target."observedAt", target."missingSince",
                target."consecutiveMissingChecks", target."reconcileAttempts"
    `;

    return rows.map((row) => ({
      eventKey: row.eventKey,
      signature: row.signature,
      instructionIndex: row.instructionIndex,
      state: row.state,
      facts: {
        slot: row.slot.toString(),
        blockhash: row.blockhash,
        rawAmount: row.rawAmount,
        destination: row.destination,
        mint: row.mint,
      },
      observedAt: row.observedAt,
      missingSince: row.missingSince,
      consecutiveMissingChecks: row.consecutiveMissingChecks,
      reconcileAttempts: row.reconcileAttempts,
    }));
  }

  async releaseClaim(workerId: string, eventKeys: readonly string[]): Promise<void> {
    if (eventKeys.length === 0) return;
    await prisma.solanaDepositEvent.updateMany({
      where: { eventKey: { in: [...eventKeys] }, leaseOwner: workerId },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }

  async recordObservation(observation: ReconciliationObservation): Promise<void> {
    await prisma.solanaDepositEvent.updateMany({
      where: { eventKey: observation.eventKey },
      data: {
        reconciliationState: observation.reconciliationState,
        lastReconciledAt: new Date(),
        lastChainSeenAt: observation.lastChainSeenAt ?? undefined,
        missingSince: observation.missingSince,
        consecutiveMissingChecks: observation.consecutiveMissingChecks,
        reconcileAttempts: observation.reconcileAttempts,
        reconcileNotBefore: observation.reconcileNotBefore,
      },
    });
  }

  async raiseIssue(issue: ReconciliationIssueDraft): Promise<void> {
    /*
     * Ключ проблемы — событие и вид, а не время.
     *
     * Сверка повторяется каждые несколько минут; проблема, заводимая
     * заново на каждом проходе, за сутки превратилась бы в сотни
     * строк об одном и том же, и настоящая новая проблема утонула бы
     * среди них.
     */
    await prisma.solanaReconciliationIssue.upsert({
      where: { eventKey_kind: { eventKey: issue.eventKey, kind: issue.kind } },
      create: {
        eventKey: issue.eventKey,
        kind: issue.kind,
        expected: issue.expected as P.InputJsonValue,
        actual: issue.actual as P.InputJsonValue,
      },
      update: {
        actual: issue.actual as P.InputJsonValue,
        // Закрытая вручную проблема, вернувшаяся снова, снова открыта:
        // расхождение не исчезло от того, что его один раз посмотрели.
        status: 'OPEN',
        resolvedAt: null,
      },
    });
  }

  async raiseSafety(
    state: FundingSafetyState,
    reasonKind: string,
    eventKey: string,
  ): Promise<void> {
    if (state === 'HEALTHY') return;
    await serializable(async (tx) => {
      const current = await tx.fundingSafetyLatch.findUnique({ where: { id: FUNDING_LATCH_ID } });
      const next = worstSafetyState([safetyOf(current?.state), state]);
      /*
       * Защёлка только поднимается.
       *
       * Опустить её может лишь человек, и делает это не здесь.
       * Автоматическое снятие означало бы, что один удачный проход
       * отменяет расхождение, которое никто не разобрал.
       */
      if (current && safetyOf(current.state) === next) return;
      await tx.fundingSafetyLatch.upsert({
        where: { id: FUNDING_LATCH_ID },
        create: {
          id: FUNDING_LATCH_ID,
          state: next,
          reasonKind,
          eventKey,
          raisedAt: new Date(),
        },
        update: {
          state: next,
          reasonKind,
          eventKey,
          raisedAt: new Date(),
          clearedAt: null,
          clearedBy: null,
        },
      });
    });
  }

  async creditsWithoutChainEvent(limit: number): Promise<string[]> {
    /*
     * Проводка есть, события нет.
     *
     * `Deposit.txSignature` в Phase 4 хранит ключ события целиком,
     * поэтому сравнение прямое. Строка без пары означает, что деньги
     * выданы по основанию, которого в журнале больше нет.
     */
    const rows = await prisma.$queryRaw<Array<{ txSignature: string }>>`
      SELECT d."txSignature"
      FROM "Deposit" AS d
      LEFT JOIN "SolanaDepositEvent" AS e ON e."eventKey" = d."txSignature"
      WHERE d."chain" = 'SOLANA'
        AND d."isCredited" = TRUE
        AND d."txSignature" LIKE '%:%'
        AND e."id" IS NULL
      LIMIT ${limit}
    `;
    return rows.map((row) => row.txSignature);
  }
}

/** Текущее состояние защёлки. Незаполненная строка означает здоровье. */
export async function readFundingSafetyState(): Promise<FundingSafetyState> {
  const row = await prisma.fundingSafetyLatch.findUnique({ where: { id: FUNDING_LATCH_ID } });
  return safetyOf(row?.state);
}

/** Полное состояние защёлки для диагностики. */
export async function readFundingSafetyLatch(): Promise<{
  state: FundingSafetyState;
  reasonKind: string | null;
  raisedAt: Date | null;
  clearedAt: Date | null;
}> {
  const row = await prisma.fundingSafetyLatch.findUnique({ where: { id: FUNDING_LATCH_ID } });
  return {
    state: safetyOf(row?.state),
    reasonKind: row?.reasonKind ?? null,
    raisedAt: row?.raisedAt ?? null,
    clearedAt: row?.clearedAt ?? null,
  };
}

export type ClearLatchOutcome = 'cleared' | 'already-healthy';

/**
 * Снятие защёлки.
 *
 * Единственный путь опустить её, и он ручной. Автоматика умеет
 * только поднимать: расхождение не исчезает от того, что следующий
 * проход прошёл удачно, — оно исчезает от того, что человек в нём
 * разобрался.
 *
 * Запись в журнал идёт той же транзакцией, что и снятие. Не рядом,
 * а внутри: снятая защёлка без следа в журнале означает, что
 * однажды никто не сможет сказать, кто разрешил продолжить.
 */
export async function clearFundingSafetyLatch(input: {
  actorId: string;
  reason: string;
  ip?: string;
}): Promise<ClearLatchOutcome> {
  return serializable(async (tx) => {
    const current = await tx.fundingSafetyLatch.findUnique({ where: { id: FUNDING_LATCH_ID } });
    if (current == null || safetyOf(current.state) === 'HEALTHY') return 'already-healthy';

    await tx.fundingSafetyLatch.update({
      where: { id: FUNDING_LATCH_ID },
      data: {
        state: 'HEALTHY',
        clearedAt: new Date(),
        clearedBy: input.actorId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'FUNDING_SAFETY_LATCH_CLEARED',
        entity: 'FundingSafetyLatch',
        entityId: FUNDING_LATCH_ID,
        // Снимаемое состояние сохраняется: иначе через месяц нельзя
        // будет понять, что именно человек счёл разобранным.
        before: {
          state: current.state,
          reasonKind: current.reasonKind,
          eventKey: current.eventKey,
        } as never,
        after: { state: 'HEALTHY', reason: input.reason } as never,
        ip: input.ip ?? null,
      },
    });

    return 'cleared';
  });
}

/**
 * Незнакомое значение в колонке не считается здоровьем.
 *
 * Колонка текстовая: опечатка при ручной правке не должна открывать
 * денежный контур.
 */
export function safetyOf(value: string | null | undefined): FundingSafetyState {
  switch (value) {
    case 'HEALTHY':
    case undefined:
    case null:
      return 'HEALTHY';
    case 'DEGRADED':
      return 'DEGRADED';
    case 'PAUSED':
      return 'PAUSED';
    default:
      return 'REVIEW_REQUIRED';
  }
}
