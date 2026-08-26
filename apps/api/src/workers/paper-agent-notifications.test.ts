import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: any[] = [];
const prismaMock = {
  paperAgentNotification: {
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of rows) {
        const matches =
          (where.id == null || row.id === where.id) &&
          (where.inAppStatus == null || row.inAppStatus === where.inAppStatus) &&
          (where.telegramStatus == null ||
            (typeof where.telegramStatus === 'string'
              ? row.telegramStatus === where.telegramStatus
              : where.telegramStatus.in?.includes(row.telegramStatus))) &&
          (where.telegramAttempts == null || row.telegramAttempts === where.telegramAttempts);
        if (!matches) continue;
        count++;
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            row[key] += (value as { increment: number }).increment;
          } else row[key] = value;
        }
      }
      return { count };
    }),
    findMany: vi.fn(async ({ where, take }: any) => rows.filter((row) =>
      row.telegramEligible &&
      where.telegramStatus.in.includes(row.telegramStatus) &&
      row.telegramAttempts < where.telegramAttempts.lt &&
      (row.telegramNextAttemptAt == null || row.telegramNextAttemptAt <= new Date()),
    ).slice(0, take)),
  },
};

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));

const { deliverPaperAgentNotifications, retryPaperAgentNotification } = await import('./paper-agent-notifications.js');

function notification(over: Record<string, unknown> = {}) {
  return {
    id: 'notification-1', eventType: 'PAPER_BUY', payload: { paper: true, symbol: 'GEM' },
    inAppStatus: 'PENDING', inAppDeliveredAt: null, telegramEligible: true,
    telegramStatus: 'PENDING', telegramAttempts: 0, telegramNextAttemptAt: null,
    createdAt: new Date(), ...over,
  };
}

beforeEach(() => { rows.length = 0; vi.clearAllMocks(); });

describe('paper notification outbox worker', () => {
  it('один persisted event отправляет Telegram ровно один раз', async () => {
    rows.push(notification());
    const sender = { kind: 'telegram' as const, send: vi.fn(async () => ({
      ok: true, retryable: false, ambiguous: false, errorCode: null,
    })) };
    await deliverPaperAgentNotifications(sender, new Date());
    await deliverPaperAgentNotifications(sender, new Date(Date.now() + 10_000));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ inAppStatus: 'DELIVERED', telegramStatus: 'SENT', telegramAttempts: 1 });
  });

  it('определённый сбой получает bounded retry, успешный больше не повторяется', async () => {
    rows.push(notification());
    const sender = { kind: 'telegram' as const, send: vi.fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, ambiguous: false, errorCode: 'TELEGRAM_HTTP_500' })
      .mockResolvedValueOnce({ ok: true, retryable: false, ambiguous: false, errorCode: null }) };
    const start = new Date();
    await deliverPaperAgentNotifications(sender, start);
    expect(rows[0].telegramStatus).toBe('FAILED');
    rows[0].telegramNextAttemptAt = new Date(start.getTime() - 1);
    await deliverPaperAgentNotifications(sender, new Date(start.getTime() + 10_000));
    await deliverPaperAgentNotifications(sender, new Date(start.getTime() + 20_000));
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(rows[0].telegramStatus).toBe('SENT');
  });

  it('не повторяет неоднозначный сетевой результат автоматически', async () => {
    rows.push(notification());
    const sender = { kind: 'telegram' as const, send: vi.fn(async () => ({
      ok: false, retryable: false, ambiguous: true, errorCode: 'TELEGRAM_DELIVERY_AMBIGUOUS',
    })) };
    await deliverPaperAgentNotifications(sender, new Date());
    await deliverPaperAgentNotifications(sender, new Date(Date.now() + 60_000));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(rows[0].telegramStatus).toBe('AMBIGUOUS');
  });

  it('ручной retry разрешён для FAILED/AMBIGUOUS, но не для SENT', async () => {
    rows.push(
      notification({ telegramStatus: 'FAILED' }),
      notification({ id: 'ambiguous', telegramStatus: 'AMBIGUOUS' }),
      notification({ id: 'sent', telegramStatus: 'SENT' }),
    );
    await expect(retryPaperAgentNotification('notification-1')).resolves.toBe(true);
    await expect(retryPaperAgentNotification('ambiguous')).resolves.toBe(true);
    await expect(retryPaperAgentNotification('sent')).resolves.toBe(false);
  });

  it('shadow не отправляется, когда событие создано telegramEligible=false', async () => {
    rows.push(notification({ telegramEligible: false, telegramStatus: 'DISABLED' }));
    const sender = { kind: 'telegram' as const, send: vi.fn() };
    await deliverPaperAgentNotifications(sender, new Date());
    expect(sender.send).not.toHaveBeenCalled();
    expect(rows[0].inAppStatus).toBe('DELIVERED');
  });

  it('рестарт не отправляет автоматически зависший SENDING повторно', async () => {
    rows.push(notification({
      telegramStatus: 'SENDING',
      telegramAttempts: 1,
      telegramLastAttemptAt: new Date(Date.now() - 120_000),
    }));
    const sender = { kind: 'telegram' as const, send: vi.fn() };
    await deliverPaperAgentNotifications(sender, new Date());
    expect(sender.send).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      telegramStatus: 'AMBIGUOUS',
      telegramErrorCode: 'TELEGRAM_DELIVERY_INTERRUPTED',
    });
  });
});
