import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Права при неподтверждённом адресе.
 *
 * Бесплатный период не должен давать возможностей человеку, который
 * не подтвердил почту. Первый рубеж — `activateTrial`, он такой
 * период просто не создаёт. Здесь проверяется второй: даже если
 * запись всё-таки появилась, права по ней не выдаются.
 *
 * Второй рубеж нужен не из перестраховки. Запись о периоде может
 * возникнуть помимо обычного пути: ручная выдача, восстановление
 * из резервной копии, миграция. Защита, живущая в одном месте,
 * перестаёт работать в тот день, когда появится второй способ.
 */

let userRow: { emailVerifiedAt: Date | null; role: string } | null;
let subscription: unknown;
let trial: { id: string; startsAt: Date; expiresAt: Date } | null;

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: async () => userRow },
    subscription: { findFirst: async () => subscription },
  },
}));

vi.mock('./trial.js', () => ({ trialOf: async () => trial }));

vi.mock('./service-access.js', () => ({
  accountFacts: async () => ({
    emailVerified: userRow?.emailVerifiedAt != null,
    serviceAccess: userRow?.role === 'ADMIN',
  }),
}));

vi.mock('../lib/clock.js', () => ({ serverNow: () => new Date('2026-01-02T00:00:00Z') }));

const { entitlementOfRequest } = await import('./entitlement.js');
const { entitlementFor } = await import('@memex/core');

/** Право, которое даёт только оплаченный или пробный доступ. */
const PAID = 'RADAR_ACCESS';

/**
 * Запрос с проверенной подписью.
 *
 * Права считаются по идентификатору из токена и данным в базе;
 * тело, строка запроса и заголовки в этом не участвуют.
 */
const request = { user: { sub: 'u1' } } as never;
const entitlementOf = (_userId: string, now: Date) => entitlementOfRequest(request, now);

const NOW = new Date('2026-01-02T00:00:00Z');

/** Действующий период: начался вчера, кончится через четверо суток. */
const activeTrial = {
  id: 't1',
  startsAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt: new Date('2026-01-06T00:00:00Z'),
};

beforeEach(() => {
  userRow = { emailVerifiedAt: new Date('2026-01-01T00:00:00Z'), role: 'USER' };
  subscription = null;
  trial = activeTrial;
});

describe('пробный период требует подтверждённого адреса', () => {
  it('подтверждённый пользователь получает права периода', async () => {
    const ent = await entitlementOf('u1', NOW);

    expect(ent.plan).toBe('TRIAL');
    expect([...ent.capabilities]).toContain(PAID);
  });

  it('неподтверждённый не получает ничего, даже с записью периода', async () => {
    userRow = { emailVerifiedAt: null, role: 'USER' };

    const ent = await entitlementOf('u1', NOW);

    /*
     * План остаётся честным: запись существует, и врать про неё
     * незачем. Права при этом опускаются до уровня «без плана» —
     * не до пустоты: портфель и вывод своих средств доступны
     * и без подписки.
     */
    expect(ent.plan).toBe('TRIAL');
    expect([...ent.capabilities]).not.toContain(PAID);
    expect([...ent.capabilities].sort()).toEqual(
      [...entitlementFor('EXPIRED').capabilities].sort(),
    );
  });

  it('администратору подтверждение не требуется', async () => {
    // Служебный доступ выдан ролью, а не тарифом.
    userRow = { emailVerifiedAt: null, role: 'ADMIN' };

    const ent = await entitlementOf('u1', NOW);

    expect([...ent.capabilities]).toContain(PAID);
    expect(ent.serviceAccess).toBe(true);
  });

  it('администратору бесплатный период не начисляется', async () => {
    userRow = { emailVerifiedAt: null, role: 'ADMIN' };
    trial = null;

    const ent = await entitlementOf('u1', NOW);

    // Потратить единственную попытку на человека с полным доступом
    // значит отобрать её у него же после снятия роли.
    expect(ent.canStartTrial).toBe(false);
  });
});

describe('контракт правила', () => {
  it('правило записано и не сведено к константе', () => {
    /*
     * Проверка на случай «отключим на минутку». Условие должно
     * читать и план, и признак подтверждения — а не быть заменено
     * на `false`.
     */
    const source = readFileSync(new URL('./entitlement.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).toMatch(/trialWithoutVerification\s*=\s*plan === 'TRIAL'/);
    expect(source).toContain('!emailVerified');
    expect(source).not.toMatch(/trialWithoutVerification\s*=\s*(false|true)\s*;/);
  });
});
