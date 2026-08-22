import { describe, it, expect, vi } from 'vitest';

/**
 * Границы выдачи планов.
 *
 * База здесь не нужна: проверяется решение, принимаемое до неё.
 * Отказ должен случиться раньше любой записи — иначе половина
 * перехода уже произошла, и чинить придётся вручную.
 */

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async () => {
      throw new Error('транзакция не должна была начаться');
    }),
  },
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { activatePlan, isGrantable, transitionKind } = await import('./subscriptions.js');

describe('какие планы выдаются оплатой', () => {
  it('платные планы выдаются', () => {
    expect(isGrantable('PRO')).toBe(true);
    expect(isGrantable('SEMI_AUTO')).toBe(true);
    expect(isGrantable('FULL_AUTO')).toBe(true);
  });

  it('пробный период так не выдаётся', () => {
    // Иначе обойдены сразу оба ограничения: проверка подтверждённой
    // почты и правило «один раз за всё время».
    expect(isGrantable('TRIAL')).toBe(false);
  });

  it('EXPIRED — не план, а его отсутствие', () => {
    expect(isGrantable('EXPIRED')).toBe(false);
  });

  it('отказ случается до записи в базу', async () => {
    // Подставленная транзакция бросает исключение. Если тест видит
    // именно наше сообщение, значит до базы дело не дошло.
    await expect(
      activatePlan({
        userId: 'u1',
        plan: 'TRIAL' as never,
        source: 'PAYMENT',
        reason: 'PAYMENT_RECEIVED',
      }),
    ).rejects.toThrow(/так не выдаётся/);
  });

  it('EXPIRED тоже отклоняется до записи', async () => {
    await expect(
      activatePlan({
        userId: 'u1',
        plan: 'EXPIRED' as never,
        source: 'ADMIN_GRANT',
        reason: 'GRANTED_BY_ADMIN',
      }),
    ).rejects.toThrow(/так не выдаётся/);
  });
});

describe('направление перехода', () => {
  it('вверх по лестнице — повышение', () => {
    expect(transitionKind('PRO', 'FULL_AUTO')).toBe('upgrade');
    expect(transitionKind('EXPIRED', 'TRIAL')).toBe('upgrade');
  });

  it('вниз — понижение', () => {
    expect(transitionKind('FULL_AUTO', 'PRO')).toBe('downgrade');
    expect(transitionKind('TRIAL', 'EXPIRED')).toBe('downgrade');
  });

  it('тот же план — не переход', () => {
    expect(transitionKind('PRO', 'PRO')).toBe('same');
  });
});
