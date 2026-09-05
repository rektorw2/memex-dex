import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERIFY_RESULT } from '@memex/core';

/**
 * Продуктовая политика доступа — шесть правил в одном месте.
 *
 * Правила разнесены по слоям: одно живёт в `activateTrial`, другое
 * в расчёте прав, третье в оформлении оплаты. Разнесены они верно —
 * каждое стоит там, где принимается решение, — но проверять их
 * по отдельности недостаточно: политика существует как целое, и
 * ломается она обычно на стыке.
 *
 * Здесь собраны все шесть. Если завтра одно из них изменят, станет
 * видно, какое именно и что оно значило.
 */

// ─────────────────────────── Подставное состояние ────────────────────────────

interface Account {
  emailVerifiedAt: Date | null;
  role: 'USER' | 'ADMIN';
}

let account: Account;
let trial: { id: string; startsAt: Date; expiresAt: Date } | null;
let paidSubscription: { plan: string; startsAt: Date; expiresAt: Date | null } | null;

/** Сколько раз создавалась запись о пробном периоде. */
let trialInserts: number;

const NOW = new Date('2026-03-10T12:00:00Z');
const FIVE_DAYS_MS = 5 * 24 * 3_600_000;

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: async () => account },
    subscription: { findFirst: async () => paidSubscription },
    // Клиента провайдера нет: проверка личности не пройдена.
    paymentCustomer: { findUnique: async () => null },
  },
  serializable: async (fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('./trial.js', () => ({
  trialOf: async () => trial,
  activateTrial: async (_userId: string, now: Date) => {
    // Порядок проверок повторяет настоящий: подтверждение раньше
    // всего остального.
    if (trial) return { ok: true, trial, created: false };
    if (!account.emailVerifiedAt) return { ok: false, reason: 'EMAIL_NOT_VERIFIED' };

    trialInserts += 1;
    trial = {
      id: 't1',
      startsAt: now,
      expiresAt: new Date(now.getTime() + FIVE_DAYS_MS),
    };
    return { ok: true, trial, created: true };
  },
}));

vi.mock('./service-access.js', () => ({
  accountFacts: async () => ({
    emailVerified: account.emailVerifiedAt != null,
    serviceAccess: account.role === 'ADMIN',
  }),
}));

/*
 * Провайдер включён.
 *
 * Иначе оформление отвечает «оплата не настроена» и до проверки
 * почты не доходит. Порядок верный — отсутствие провайдера это факт
 * о сервере, а не о человеке, — но проверить нужную защиту он
 * мешает.
 */
vi.mock('./payments/index.js', () => ({
  getPaymentProvider: () => ({
    enabled: true,
    name: 'bridge',
    createCheckout: async () => {
      throw new Error('до провайдера доходить не должно');
    },
  }),
  treasuryAddress: () => '0xtreasury',
}));

vi.mock('../lib/clock.js', () => ({ serverNow: () => NOW }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Подтверждение кода.
 *
 * Переход «не подтверждён → подтверждён» смоделирован атомарно, как
 * в базе: второй запрос получает `alreadyVerified`, а не второй `ok`.
 */
vi.mock('./email-verify.js', () => ({
  verifyCode: async (_userId: string, code: string, now: Date) => {
    if (code !== '123456') return { result: VERIFY_RESULT.wrong };
    if (account.emailVerifiedAt) {
      return { result: VERIFY_RESULT.alreadyVerified, verifiedAt: account.emailVerifiedAt };
    }
    account.emailVerifiedAt = now;
    return { result: VERIFY_RESULT.ok, verifiedAt: now };
  },
}));

const { verifyEmailAndStartTrial } = await import('./verify-and-trial.js');
const { entitlementOfRequest } = await import('./entitlement.js');
const { entitlementFor } = await import('@memex/core');

const request = { user: { sub: 'u1' } } as never;
const rights = () => entitlementOfRequest(request, NOW);

/** Право, которое даёт только оплаченный или пробный доступ. */
const PAID = 'RADAR_ACCESS';

beforeEach(() => {
  account = { emailVerifiedAt: null, role: 'USER' };
  trial = null;
  paidSubscription = null;
  trialInserts = 0;
});

// ═══════════ Правило 1. Trial только после подтверждения ══════════════════════

describe('правило 1: пробный период — только после подтверждения адреса', () => {
  it('до подтверждения периода нет и прав нет', async () => {
    const ent = await rights();

    expect(ent.plan).toBe('EXPIRED');
    expect([...ent.capabilities]).not.toContain(PAID);
  });

  it('верный код выдаёт период и открывает права', async () => {
    const res = await verifyEmailAndStartTrial('u1', '123456', NOW);

    expect(res.trialOutcome).toBe('STARTED');

    const ent = await rights();
    expect(ent.plan).toBe('TRIAL');
    expect([...ent.capabilities]).toContain(PAID);
  });

  it('период ровно пять суток по серверным часам', async () => {
    const res = await verifyEmailAndStartTrial('u1', '123456', NOW);

    const started = res.trial!.startsAt.getTime();
    const ends = res.trial!.expiresAt.getTime();

    expect(ends - started).toBe(FIVE_DAYS_MS);
    // Отсчёт от серверного времени, а не от часов браузера.
    expect(started).toBe(NOW.getTime());
  });

  it('неверный код ничего не создаёт', async () => {
    const res = await verifyEmailAndStartTrial('u1', '000000', NOW);

    expect(res.trialOutcome).toBe('NOT_APPLICABLE');
    expect(trialInserts).toBe(0);
    expect(account.emailVerifiedAt).toBeNull();
  });
});

// ═════════ Правило 2. Неподтверждённый не активирует и не платит ═════════════

describe('правило 2: без подтверждения ни период, ни оплата', () => {
  it('прямая активация периода отвергается', async () => {
    const { activateTrial } = await import('./trial.js');

    const res = await activateTrial('u1', NOW);

    expect(res).toEqual({ ok: false, reason: 'EMAIL_NOT_VERIFIED' });
    expect(trialInserts).toBe(0);
  });

  it('оформление оплаты отвергается без подтверждения', async () => {
    /*
     * Проверка поведения, а не текста.
     *
     * Первая версия этого теста грепала исходник на имя поля — и
     * прошла даже тогда, когда настоящую проверку убрали: имя
     * осталось в соседней строке. Так и обнаружилось, что в пути
     * Bridge проверки не было вовсе: она держалась транзитивно,
     * через запись клиента провайдера, созданную при проверке
     * личности.
     *
     * Транзитивная гарантия настоящая, но рвётся молча — ручной
     * выдачей, переносом данных, восстановлением из копии.
     */
    const { createCheckout, CHECKOUT_ERROR } = await import('./payments/checkout.js');

    const res = await createCheckout('u1', 'PRO');

    expect(res).toEqual({ ok: false, error: CHECKOUT_ERROR.emailNotVerified });
  });

  it('после подтверждения отказ уже не про почту', async () => {
    // Дальше человека остановят другие условия — проверка личности,
    // казначейский адрес, — но не подтверждение адреса.
    const { createCheckout, CHECKOUT_ERROR } = await import('./payments/checkout.js');
    account.emailVerifiedAt = NOW;

    const res = await createCheckout('u1', 'PRO');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toBe(CHECKOUT_ERROR.emailNotVerified);
  });

  it('оба пути оплаты отвечают одинаково', () => {
    /*
     * Bridge и Coinbase — два независимых пути к деньгам. Разойтись
     * они могут только в одну сторону: тот, где проверку забыли.
     */
    const bridge = readFileSync(new URL('./payments/checkout.ts', import.meta.url), 'utf8');
    const coinbase = readFileSync(
      new URL('./payments/coinbase-checkout.ts', import.meta.url),
      'utf8',
    );

    expect(bridge).toMatch(/emailVerifiedAt[\s\S]{0,200}emailNotVerified/);
    expect(coinbase).toMatch(/emailVerifiedAt[\s\S]{0,200}emailNotVerified/);
  });
});

// ═══════ Правило 3. Оплаченный доступ переживает новое требование ═════════════

describe('правило 3: оплаченный доступ сохраняется без подтверждения', () => {
  beforeEach(() => {
    // Старый аккаунт: подписка есть, `emailVerifiedAt` пуст.
    paidSubscription = {
      plan: 'PRO',
      startsAt: new Date('2026-03-01T00:00:00Z'),
      expiresAt: new Date('2026-04-01T00:00:00Z'),
    };
  });

  it('права по оплате остаются', async () => {
    /*
     * Отобрать доступ у заплатившего из-за нового требования к почте
     * значит наказать человека за наше изменение. Требование к нему
     * остаётся — интерфейс проведёт его через подтверждение, — но
     * доступ не отбирается.
     */
    const ent = await rights();

    expect(ent.plan).toBe('PRO');
    expect([...ent.capabilities]).toContain(PAID);
  });

  it('но бесплатный период ему всё равно не выдаётся', async () => {
    const { activateTrial } = await import('./trial.js');

    expect(await activateTrial('u1', NOW)).toEqual({
      ok: false,
      reason: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('после подтверждения оплаченный план остаётся оплаченным', async () => {
    await verifyEmailAndStartTrial('u1', '123456', NOW);

    // Пробный период поверх оплаченного плана его не подменяет:
    // действующая подписка старше по приоритету.
    const ent = await rights();
    expect(ent.plan).toBe('PRO');
  });
});

// ═══════════ Правило 4. Следующая оплата требует подтверждения ════════════════

describe('правило 4: следующее оформление требует подтверждения', () => {
  it('проверка стоит в оформлении, а не в расчёте прав', () => {
    /*
     * Разделение намеренное. Расчёт прав отвечает на вопрос «что
     * человеку доступно сейчас» и не должен отбирать оплаченное.
     * Оформление отвечает на вопрос «можно ли взять деньги» — и вот
     * там подтверждение обязательно.
     */
    const checkout = readFileSync(
      new URL('./payments/checkout.ts', import.meta.url),
      'utf8',
    );
    const entitlement = readFileSync(new URL('./entitlement.ts', import.meta.url), 'utf8');

    expect(checkout).toContain('emailVerifiedAt');
    // В расчёте прав подтверждение закрывает только пробный период.
    expect(entitlement).toContain('trialWithoutVerification');
  });
});

// ═══════════════════ Правило 5. ADMIN без подтверждения ══════════════════════

describe('правило 5: служебный доступ не зависит от почты', () => {
  beforeEach(() => {
    account = { emailVerifiedAt: null, role: 'ADMIN' };
  });

  it('права полные без подтверждения и без подписки', async () => {
    const ent = await rights();

    expect(ent.serviceAccess).toBe(true);
    expect([...ent.capabilities]).toContain(PAID);
  });

  it('план остаётся честным: выдуманной подписки нет', async () => {
    const ent = await rights();

    // Выдуманная подписка была бы записью о деньгах, которых
    // не было, и однажды попала бы в отчёт.
    expect(ent.plan).toBe('EXPIRED');
  });

  it('бесплатный период администратору не начисляется', async () => {
    const ent = await rights();

    expect(ent.canStartTrial).toBe(false);
    expect(trialInserts).toBe(0);
  });

  it('снятие роли сразу убирает служебный доступ', async () => {
    expect((await rights()).serviceAccess).toBe(true);

    // Роль читается из базы при каждом запросе, а не из токена:
    // иначе снятие ждало бы окончания срока действия токена.
    account.role = 'USER';

    const after = await rights();
    expect(after.serviceAccess).toBe(false);
    expect([...after.capabilities]).not.toContain(PAID);
  });
});

// ═════════ Правило 6. Повторное подтверждение не продлевает ══════════════════

describe('правило 6: повторное подтверждение не выдаёт и не продлевает', () => {
  it('второй верный код не создаёт второго периода', async () => {
    const first = await verifyEmailAndStartTrial('u1', '123456', NOW);
    const later = new Date(NOW.getTime() + 3 * 3_600_000);
    const second = await verifyEmailAndStartTrial('u1', '123456', later);

    expect(first.trialOutcome).toBe('STARTED');
    expect(second.trialOutcome).toBe('NOT_APPLICABLE');
    expect(trialInserts).toBe(1);
  });

  it('срок окончания не сдвигается', async () => {
    const first = await verifyEmailAndStartTrial('u1', '123456', NOW);
    const ends = first.trial!.expiresAt.getTime();

    await verifyEmailAndStartTrial('u1', '123456', new Date(NOW.getTime() + 3 * 3_600_000));

    expect(trial!.expiresAt.getTime()).toBe(ends);
  });

  it('уже израсходованный период не восстанавливается', async () => {
    // Период был и закончился: запись осталась, и она запрещает второй.
    trial = {
      id: 'old',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-06T00:00:00Z'),
    };

    const res = await verifyEmailAndStartTrial('u1', '123456', NOW);

    expect(res.trialOutcome).toBe('ALREADY_USED');
    expect(trialInserts).toBe(0);

    const ent = await rights();
    expect(ent.plan).toBe('EXPIRED');
    expect(ent.canStartTrial).toBe(false);
  });

  it('повторная регистрация тем же аккаунтом второго периода не даёт', async () => {
    await verifyEmailAndStartTrial('u1', '123456', NOW);

    // Аккаунт «перерегистрировали»: подтверждение сброшено.
    account.emailVerifiedAt = null;

    const again = await verifyEmailAndStartTrial('u1', '123456', NOW);

    // Запись о периоде не удаляется никогда — именно она и запрещает.
    expect(again.trialOutcome).toBe('ALREADY_USED');
    expect(trialInserts).toBe(1);
  });
});
