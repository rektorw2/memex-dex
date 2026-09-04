import { EXPIRY_BATCH_SIZE } from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/**
 * Закрытие забытого.
 *
 * Предложение, на которое человек не ответил, и намерение, которое
 * никто не подписал, остаются висеть навсегда, если их не закрыть.
 * Висящее одобрение опаснее отсутствующего: через сутки человек уже
 * не помнит, на что соглашался, а запись всё ещё выглядит живой.
 *
 * Чего этот воркер не делает: не подписывает, не отправляет, не
 * трогает подписанное. Истечение — это закрытие забытого, а не
 * способ отменить случившееся.
 *
 * Пакетами и одним оператором на пакет: длинная блокировка на всей
 * таблице остановила бы и приём решений от людей.
 */

export interface IntentExpiryStatus {
  running: boolean;
  lastCycleAt: string | null;
  lastErrorCode: string | null;
  expiredProposals: number;
  expiredIntents: number;
}

const runtime: IntentExpiryStatus = {
  running: false,
  lastCycleAt: null,
  lastErrorCode: null,
  expiredProposals: 0,
  expiredIntents: 0,
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function getIntentExpiryStatus(): IntentExpiryStatus {
  return { ...runtime };
}

export async function runIntentExpiryCycle(now = new Date()): Promise<{
  proposals: number;
  intents: number;
}> {
  /*
   * Состояние входит в условие обновления.
   *
   * Отдельные `SELECT` и `UPDATE` пропустили бы между собой чужой
   * переход: человек подтверждает предложение ровно в тот момент,
   * когда воркер решил, что оно истекло.
   */
  const proposals = await prisma.liveAgentProposal.updateMany({
    where: {
      status: { in: ['CREATED', 'AWAITING_CONFIRMATION'] },
      expiresAt: { lt: now },
      id: { in: await expiringProposalIds(now) },
    },
    data: { status: 'EXPIRED' },
  });

  const intents = await prisma.transactionIntent.updateMany({
    where: {
      // `SIGNING` не истекает: захваченное намерение либо станет
      // подписью, либо будет разобрано вручную. Закрыть его по
      // таймеру значит потерять след того, что происходило.
      state: { in: ['DRAFT', 'VALIDATED', 'APPROVED'] },
      expiresAt: { lt: now },
      id: { in: await expiringIntentIds(now) },
    },
    data: { state: 'EXPIRED', failureCode: 'INTENT_EXPIRED' },
  });

  return { proposals: proposals.count, intents: intents.count };
}

/** Ограниченная выборка: один проход не берёт больше, чем осилит. */
async function expiringProposalIds(now: Date): Promise<string[]> {
  const rows = await prisma.liveAgentProposal.findMany({
    where: { status: { in: ['CREATED', 'AWAITING_CONFIRMATION'] }, expiresAt: { lt: now } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: EXPIRY_BATCH_SIZE,
  });
  return rows.map((row) => row.id);
}

async function expiringIntentIds(now: Date): Promise<string[]> {
  const rows = await prisma.transactionIntent.findMany({
    where: { state: { in: ['DRAFT', 'VALIDATED', 'APPROVED'] }, expiresAt: { lt: now } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: EXPIRY_BATCH_SIZE,
  });
  return rows.map((row) => row.id);
}

async function tick(): Promise<void> {
  if (!runtime.running || ticking) return;
  ticking = true;
  runtime.lastCycleAt = new Date().toISOString();
  try {
    const result = await runIntentExpiryCycle();
    runtime.expiredProposals += result.proposals;
    runtime.expiredIntents += result.intents;
    runtime.lastErrorCode = null;

    /*
     * Одна строка на пакет, а не на запись.
     *
     * Журнал, в котором на каждое истёкшее предложение приходится
     * строка, за сутки перестаёт читаться, и настоящая проблема
     * тонет среди рутины.
     */
    if (result.proposals > 0 || result.intents > 0) {
      logger.info(
        { proposals: result.proposals, intents: result.intents },
        'Intent expiry cycle closed stale records',
      );
    }
  } catch (error: unknown) {
    runtime.lastErrorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'INTENT_EXPIRY_CYCLE_FAILED';
    logger.warn({ code: runtime.lastErrorCode }, 'Intent expiry cycle failed');
  } finally {
    ticking = false;
  }
}

/**
 * Запуск.
 *
 * Привязан к тому же выключателю, что и остальной LIVE-контур:
 * закрывать по таймеру записи контура, который не работает,
 * незачем — их там просто нет.
 */
export function startIntentExpiryWorker(): boolean {
  if (runtime.running) return true;
  if (!env.LIVE_AGENT_ENABLED) return false;
  runtime.running = true;
  timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
  void tick();
  return true;
}

export function stopIntentExpiryWorker(): void {
  runtime.running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
