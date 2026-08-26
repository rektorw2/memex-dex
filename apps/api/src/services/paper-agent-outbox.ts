import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type PaperAgentNotificationType =
  | 'PAPER_BUY'
  | 'PAPER_SELL'
  | 'TRADE_RESULT'
  | 'CRITICAL_ERROR'
  | 'OKX_WS_LOST'
  | 'OKX_WS_RESTORED';

export interface PaperAgentOutboxEvent {
  eventKey: string;
  runId?: string | null;
  eventType: PaperAgentNotificationType;
  strategyKey?: string | null;
  strategyVersion?: number | null;
  isBaselineEvent?: boolean;
  telegramEligible?: boolean;
  payload: P.InputJsonValue;
}

/**
 * Вызывается внутри той же транзакции, что меняет позицию.
 * Уникальный eventKey превращает повтор перехода состояния в no-op базы.
 */
export function enqueuePaperAgentOutbox(
  tx: P.TransactionClient,
  event: PaperAgentOutboxEvent,
) {
  return tx.paperAgentNotification.create({
    data: {
      eventKey: event.eventKey,
      runId: event.runId ?? null,
      eventType: event.eventType,
      strategyKey: event.strategyKey ?? null,
      strategyVersion: event.strategyVersion ?? null,
      isBaselineEvent: event.isBaselineEvent ?? false,
      payload: event.payload,
      inAppStatus: 'PENDING',
      telegramEligible: event.telegramEligible ?? false,
      telegramStatus: event.telegramEligible ? 'PENDING' : 'DISABLED',
      telegramNextAttemptAt: event.telegramEligible ? new Date() : null,
    },
  });
}

/** Системное событие не сопровождает позицию, поэтому само является транзакцией. */
export async function enqueuePaperAgentSystemEvent(event: PaperAgentOutboxEvent): Promise<boolean> {
  try {
    await prisma.$transaction((tx) => enqueuePaperAgentOutbox(tx, event));
    return true;
  } catch (error: any) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
}

export function paperAgentRunEventKey(
  runId: string,
  eventType: PaperAgentNotificationType,
  strategyVersion: number,
): string {
  return `${runId}:${eventType}:v${strategyVersion}`;
}
