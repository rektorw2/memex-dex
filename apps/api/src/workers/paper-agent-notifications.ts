/** Reliable delivery for Phase 2 paper notifications. No trading dependencies. */
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import {
  createAgentNotificationTransport,
  formatPaperAgentTelegram,
  type AgentNotificationTransport,
} from '../services/paper-agent-notification-transport.js';
import { enqueuePaperAgentSystemEvent } from '../services/paper-agent-outbox.js';
import { getOkxSignalIngestStatus } from './okx-signal-ingest.js';
import { paperAgentModeVerdict } from '@memex/core';

const INTERVAL_MS = 1_000;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticking = false;
let transport: AgentNotificationTransport | null = null;
let lastSocketHealthy: boolean | null = null;

export function getPaperAgentNotificationRuntime() {
  return {
    running,
    telegramEnabled: env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED,
    transport: transport?.kind ?? 'disabled',
  };
}

function retryDelay(attempt: number): number {
  return Math.min(60_000, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export async function deliverPaperAgentNotifications(
  sender: AgentNotificationTransport = transport ?? createAgentNotificationTransport(),
  now = new Date(),
): Promise<void> {
  // Процесс мог завершиться после ответа Telegram, но до записи SENT.
  // Автоматически повторять такое событие нельзя: sendMessage не имеет
  // idempotency key. Оно становится AMBIGUOUS и ждёт решения администратора.
  await prisma.paperAgentNotification.updateMany({
    where: {
      telegramStatus: 'SENDING',
      telegramLastAttemptAt: { lt: new Date(now.getTime() - 60_000) },
    },
    data: {
      telegramStatus: 'AMBIGUOUS',
      telegramNextAttemptAt: null,
      telegramErrorCode: 'TELEGRAM_DELIVERY_INTERRUPTED',
    },
  });

  await prisma.paperAgentNotification.updateMany({
    where: { inAppStatus: 'PENDING' },
    data: { inAppStatus: 'DELIVERED', inAppDeliveredAt: now },
  });

  if (sender.kind === 'disabled') return;

  const rows = await prisma.paperAgentNotification.findMany({
    where: {
      telegramEligible: true,
      telegramStatus: { in: ['PENDING', 'FAILED'] },
      telegramAttempts: { lt: MAX_ATTEMPTS },
      OR: [{ telegramNextAttemptAt: null }, { telegramNextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });

  for (const row of rows) {
    const claimed = await prisma.paperAgentNotification.updateMany({
      where: {
        id: row.id,
        telegramStatus: row.telegramStatus,
        telegramAttempts: row.telegramAttempts,
      },
      data: {
        telegramStatus: 'SENDING',
        telegramAttempts: { increment: 1 },
        telegramLastAttemptAt: now,
        telegramNextAttemptAt: null,
        telegramErrorCode: null,
      },
    });
    if (claimed.count !== 1) continue;

    const payload = row.payload as Record<string, unknown>;
    const result = await sender.send(formatPaperAgentTelegram(row.eventType, payload));
    const attempts = row.telegramAttempts + 1;

    if (result.ok) {
      await prisma.paperAgentNotification.updateMany({
        where: { id: row.id, telegramStatus: 'SENDING' },
        data: { telegramStatus: 'SENT', telegramDeliveredAt: new Date(), telegramErrorCode: null },
      });
      continue;
    }

    const retryable = result.retryable && attempts < MAX_ATTEMPTS;
    await prisma.paperAgentNotification.updateMany({
      where: { id: row.id, telegramStatus: 'SENDING' },
      data: {
        telegramStatus: result.ambiguous ? 'AMBIGUOUS' : 'FAILED',
        telegramErrorCode: result.errorCode,
        telegramNextAttemptAt: retryable ? new Date(now.getTime() + retryDelay(attempts)) : null,
      },
    });
  }
}

async function observeSocketTransition(): Promise<void> {
  const status = getOkxSignalIngestStatus();
  const healthy = status.running && status.socket?.state === 'connected';
  if (lastSocketHealthy == null) {
    lastSocketHealthy = healthy;
    return;
  }
  if (healthy === lastSocketHealthy) return;
  lastSocketHealthy = healthy;

  const eventType = healthy ? 'OKX_WS_RESTORED' : 'OKX_WS_LOST';
  const discriminator = healthy
    ? status.socket?.lastLoginAt ?? Date.now()
    : `${status.socket?.reconnects ?? 0}:${status.socket?.lastErrorCode ?? 'disconnected'}`;
  await enqueuePaperAgentSystemEvent({
    eventKey: `paper-agent:${eventType}:${discriminator}`,
    eventType,
    isBaselineEvent: true,
    telegramEligible: env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED,
    payload: {
      paper: true,
      eventType,
      observedAt: new Date().toISOString(),
      socketState: status.socket?.state ?? 'disconnected',
      errorCode: status.socket?.lastErrorCode ?? null,
    },
  });
}

async function tick(): Promise<void> {
  if (!running || ticking) return;
  ticking = true;
  try {
    await observeSocketTransition();
    await deliverPaperAgentNotifications();
  } catch (error: any) {
    logger.warn({ code: error?.code ?? error?.name ?? 'PAPER_NOTIFICATION_TICK_FAILED' },
      'paper-agent notifications: проход завершился ошибкой');
  } finally {
    ticking = false;
  }
}

export function startPaperAgentNotifications(): boolean {
  if (running) return true;
  if (!paperAgentModeVerdict(env.EXECUTION_MODE).ok) return false;
  transport = createAgentNotificationTransport();
  running = true;
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
  void tick();
  return true;
}

export function stopPaperAgentNotifications(): void {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  transport = null;
  lastSocketHealthy = null;
}

export async function retryPaperAgentNotification(id: string): Promise<boolean> {
  const result = await prisma.paperAgentNotification.updateMany({
    where: { id, telegramStatus: { in: ['FAILED', 'AMBIGUOUS'] } },
    data: { telegramStatus: 'PENDING', telegramNextAttemptAt: new Date(), telegramErrorCode: null },
  });
  return result.count === 1;
}
