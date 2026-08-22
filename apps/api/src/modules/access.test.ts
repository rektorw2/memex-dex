import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import jwt from '@fastify/jwt';
import {
  TRIAL_DURATION_MS,
  entitlementFor,
  capabilityList,
  requiredPlanFor,
  type PlanCode,
} from '@memex/core';

/**
 * Проверки доступа поверх настоящего HTTP.
 *
 * Не вызовы функций напрямую: половина ошибок доступа живёт не в правилах,
 * а в том, как правила подключены к маршруту. Забытая проверка на карточке,
 * план, прочитанный из тела запроса, отказ без кода причины — всё это
 * видно только через запрос целиком.
 *
 * Время подделано. Ждать пять суток нельзя, но и сдвигать проверку
 * на «примерно потом» тоже: границу в сто двадцать часов надо проверить
 * с обеих сторон, вплотную.
 *
 * База не поднимается: вместо неё подставлено состояние договоров.
 * Здесь проверяется решение о доступе, а не хранение — хранение
 * проверяется отдельно, на настоящем Postgres.
 */

const T0 = Date.UTC(2026, 7, 21, 12, 0, 0);
const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

/** Состояние договоров, которое подставляется вместо базы. */
interface FakeState {
  trial: { startsAt: Date; expiresAt: Date } | null;
  paidPlan: Exclude<PlanCode, 'TRIAL' | 'EXPIRED'> | null;
  paidExpiresAt: Date | null;
  emailVerified: boolean;
}

const state: FakeState = {
  trial: null,
  paidPlan: null,
  paidExpiresAt: null,
  emailVerified: true,
};

let now = T0;

vi.mock('../lib/prisma.js', () => ({ prisma: {}, serializable: vi.fn() }));
vi.mock('../lib/clock.js', () => ({
  serverNow: () => new Date(now),
  serverNowMs: () => now,
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/trial.js', () => ({
  trialOf: async () => state.trial,
  activateTrial: async (_userId: string, at: Date) => {
    if (state.trial) return { ok: true, trial: state.trial, created: false };
    if (!state.emailVerified) return { ok: false, reason: 'EMAIL_NOT_VERIFIED' };

    state.trial = { startsAt: at, expiresAt: new Date(at.getTime() + TRIAL_DURATION_MS) };
    return { ok: true, trial: state.trial, created: true };
  },
  expireDueTrials: async () => 0,
  TRIAL_HOURS: 120,
}));

/** Как ведёт себя доставка писем в этом сценарии. */
let delivery: 'ok' | 'unavailable' | 'failed' = 'ok';

vi.mock('../services/email-verify.js', () => ({
  issueCode: async () => {
    if (state.emailVerified) return { ok: false, reason: 'ALREADY_VERIFIED' };
    if (delivery === 'unavailable') return { ok: false, reason: 'EMAIL_DELIVERY_UNAVAILABLE' };
    if (delivery === 'failed') {
      return { ok: false, reason: 'EMAIL_DELIVERY_FAILED', failure: 'REJECTED', retryAfterSeconds: 0 };
    }

    return { ok: true, expiresAt: new Date(now + 900_000), devCode: '123456' };
  },
  verifyCode: async (_userId: string, code: string) => {
    if (code !== '123456') return { result: 'CODE_WRONG' };
    state.emailVerified = true;
    return { result: 'OK', verifiedAt: new Date(now) };
  },
  isEmailVerified: async () => state.emailVerified,
}));

vi.mock('../services/subscriptions.js', () => ({
  activeSubscription: async (_userId: string, at: Date) => {
    if (!state.paidPlan) return null;
    if (state.paidExpiresAt && state.paidExpiresAt <= at) return null;

    return {
      id: 'sub-1',
      plan: state.paidPlan,
      startsAt: new Date(T0 - 1000),
      expiresAt: state.paidExpiresAt,
    };
  },
}));

const { accessRoutes } = await import('./access.js');
const { entitlementOfRequest, denyIfMissing, applyCacheHeaders } = await import(
  '../services/entitlement.js'
);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: SECRET });

  app.decorate('authenticate', async function authenticate(
    this: FastifyInstance,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Требуется авторизация' });
    }
  });

  await app.register(accessRoutes, { prefix: '/api' });

  // Маршруты-образцы: по одному на каждое право, которое закрывается
  // планом. Настоящие маршруты устроены так же — тот же вызов,
  // тот же ответ.
  const guarded = (path: string, capability: Parameters<typeof denyIfMissing>[1]) =>
    app.get(path, { preHandler: [app.authenticate] }, async (req, reply) => {
      const ent = await entitlementOfRequest(req);
      applyCacheHeaders(reply);
      if (denyIfMissing(ent, capability, reply)) return reply;
      return { ok: true, plan: ent.plan };
    });

  guarded('/radar', 'RADAR_ACCESS');
  guarded('/terminal', 'TERMINAL_ACCESS');
  guarded('/smart-wallets', 'SMART_WALLETS_ACCESS');
  guarded('/copy', 'LEADER_COPY_BUY');
  guarded('/semi-auto', 'SEMI_AUTO_TRADE');
  guarded('/auto-exit', 'AUTO_EXIT');
  guarded('/portfolio', 'PORTFOLIO_READ');
  guarded('/withdraw', 'WALLET_WITHDRAW');

  // Покупка и продажа на одном маршруте — как в настоящих заявках.
  app.post('/orders', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = req.body as { side: 'BUY' | 'SELL' };
    const ent = await entitlementOfRequest(req);
    const needed = body.side === 'BUY' ? 'MANUAL_TRADE' : 'SELL_OWN_ASSET';
    if (denyIfMissing(ent, needed, reply)) return reply;
    return { ok: true, side: body.side };
  });

  await app.ready();
  return app;
}

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  now = T0;
  state.trial = null;
  state.paidPlan = null;
  state.paidExpiresAt = null;
  state.emailVerified = true;
  delivery = 'ok';

  app = await buildApp();
  token = app.jwt.sign({ sub: 'user-1', role: 'USER' });
});

const auth = { authorization: () => `Bearer ${token}` };

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { authorization: auth.authorization(), ...headers } });

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as never,
    headers: { authorization: auth.authorization(), ...headers },
  });

describe('включение пробного периода', () => {
  it('новый пользователь может его включить', async () => {
    const r = await post('/api/access/trial/activate');

    expect(r.statusCode).toBe(201);
    expect(r.json().plan).toBe('TRIAL');
    expect(r.json().status).toBe('started');
  });

  it('до нажатия периода нет', async () => {
    // Начинать при регистрации нельзя: зарегистрировавшийся
    // «посмотреть» вернётся через неделю и обнаружит, что бесплатный
    // доступ кончился, пока он им не пользовался.
    const me = await get('/api/access/me');

    expect(me.json().effectivePlan).toBe('EXPIRED');
    expect(me.json().canStartTrial).toBe(true);
    expect(me.json().trialStartedAt).toBeNull();
  });

  it('повторное включение возвращает существующий период', async () => {
    const first = await post('/api/access/trial/activate');
    now = T0 + 3600_000;
    const second = await post('/api/access/trial/activate');

    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('already_active');
    expect(second.json().expiresAt).toBe(first.json().expiresAt);
  });

  it('срок не сдвигается повторным нажатием', async () => {
    const first = await post('/api/access/trial/activate');
    now = T0 + 24 * 3600_000;
    const again = await post('/api/access/trial/activate');

    expect(again.json().startsAt).toBe(first.json().startsAt);
  });

  it('второй период после окончания создать нельзя', async () => {
    await post('/api/access/trial/activate');
    now = T0 + TRIAL_DURATION_MS + 1000;

    const me = await get('/api/access/me');
    expect(me.json().effectivePlan).toBe('EXPIRED');
    expect(me.json().canStartTrial).toBe(false);

    const again = await post('/api/access/trial/activate');
    // Запись осталась, поэтому включение отвечает тем же периодом,
    // а не выдаёт новый.
    expect(again.json().expiresAt).toBe(new Date(T0 + TRIAL_DURATION_MS).toISOString());
    expect((await get('/api/access/me')).json().effectivePlan).toBe('EXPIRED');
  });

  it('без подтверждённой почты период не выдаётся', async () => {
    state.emailVerified = false;
    const r = await post('/api/access/trial/activate');

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('без авторизации включить нельзя', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/access/trial/activate' });

    expect(r.statusCode).toBe(401);
  });

  it('срок считает сервер, а не клиент', async () => {
    // Тело запроса с чужими датами не должно ни на что влиять.
    const r = await post('/api/access/trial/activate', {
      startsAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      plan: 'FULL_AUTO',
    });

    expect(r.json().expiresAt).toBe(new Date(T0 + TRIAL_DURATION_MS).toISOString());
    expect(r.json().plan).toBe('TRIAL');
  });
});

describe('во время пробного периода', () => {
  beforeEach(async () => {
    await post('/api/access/trial/activate');
  });

  it('радар открыт и отдаётся без задержки', async () => {
    const r = await get('/radar');

    expect(r.statusCode).toBe(200);
    expect(r.json().plan).toBe('TRIAL');
    // Полей задержки в ответе больше нет вовсе.
    expect(r.json()).not.toHaveProperty('isDelayed');
    expect(r.json()).not.toHaveProperty('dataAsOf');
  });

  it('терминал открыт', async () => {
    expect((await get('/terminal')).statusCode).toBe(200);
  });

  it('ручная покупка разрешена', async () => {
    expect((await post('/orders', { side: 'BUY' })).statusCode).toBe(200);
  });

  it('смарт-кошельки закрыты с кодом апгрейда', async () => {
    const r = await get('/smart-wallets');

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('UPGRADE_REQUIRED');
    expect(r.json().requiredPlan).toBe('PRO');
    expect(r.json().currentPlan).toBe('TRIAL');
  });

  it('копирование и полуавтомат закрыты', async () => {
    expect((await get('/copy')).statusCode).toBe(403);
    expect((await get('/semi-auto')).statusCode).toBe(403);
    expect((await get('/semi-auto')).json().requiredPlan).toBe('SEMI_AUTO');
  });

  it('автоматические выходы закрыты', async () => {
    const r = await get('/auto-exit');

    expect(r.statusCode).toBe(403);
    expect(r.json().requiredPlan).toBe('FULL_AUTO');
  });

  it('в отказе нет платёжных сведений', async () => {
    const body = JSON.stringify((await get('/smart-wallets')).json());

    expect(body).not.toMatch(/sub-1|externalReference|price|amount/i);
  });

  it('остаток времени уменьшается', async () => {
    const at0 = (await get('/api/access/me')).json().trialRemainingSeconds;
    now = T0 + 3600_000;
    const at1 = (await get('/api/access/me')).json().trialRemainingSeconds;

    expect(at0).toBe(120 * 3600);
    expect(at1).toBe(119 * 3600);
  });
});

describe('граница ста двадцати часов', () => {
  beforeEach(async () => {
    await post('/api/access/trial/activate');
  });

  it('за миллисекунду до конца радар ещё открыт', async () => {
    now = T0 + TRIAL_DURATION_MS - 1;

    expect((await get('/radar')).statusCode).toBe(200);
  });

  it('ровно в момент окончания радар закрывается', async () => {
    now = T0 + TRIAL_DURATION_MS;

    const r = await get('/radar');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('UPGRADE_REQUIRED');
  });

  it('терминал перестаёт принимать новые покупки', async () => {
    now = T0 + TRIAL_DURATION_MS;

    const r = await post('/orders', { side: 'BUY' });
    expect(r.statusCode).toBe(403);
    expect(r.json().capability).toBe('MANUAL_TRADE');
  });

  it('продажа собственного актива остаётся разрешённой', async () => {
    // Самая важная проверка файла. Актив принадлежит человеку,
    // а не платформе, и запереть его в позиции из-за неоплаченного
    // счёта нельзя.
    now = T0 + TRIAL_DURATION_MS + 30 * 24 * 3600_000;

    const r = await post('/orders', { side: 'SELL' });
    expect(r.statusCode).toBe(200);
  });

  it('вывод средств остаётся разрешённым', async () => {
    now = T0 + TRIAL_DURATION_MS + 1;

    expect((await get('/withdraw')).statusCode).toBe(200);
  });

  it('свой баланс остаётся виден', async () => {
    now = T0 + TRIAL_DURATION_MS + 1;

    expect((await get('/portfolio')).statusCode).toBe(200);
  });

  it('защитные выходы не отменяются', async () => {
    now = T0 + TRIAL_DURATION_MS + 1;

    const caps = (await get('/api/access/me')).json().capabilities;
    expect(caps).toContain('PROTECTIVE_EXIT');
  });

  it('состояние сообщает о необходимости купить план', async () => {
    now = T0 + TRIAL_DURATION_MS + 1;

    const me = (await get('/api/access/me')).json();
    expect(me.effectivePlan).toBe('EXPIRED');
    expect(me.upgradeRequired).toBe(true);
    expect(me.canStartTrial).toBe(false);
    expect(me.trialRemainingSeconds).toBe(0);
  });
});

describe('подтверждение почты', () => {
  it('без подтверждения период не выдаётся', async () => {
    state.emailVerified = false;
    const r = await post('/api/access/trial/activate');

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('код выдаётся, пока адрес не подтверждён', async () => {
    state.emailVerified = false;
    const r = await post('/api/access/email/code');

    expect(r.statusCode).toBe(200);
    expect(r.json().sent).toBe(true);
  });

  it('без настроенной доставки — честный отказ, а не мнимый успех', async () => {
    state.emailVerified = false;
    delivery = 'unavailable';

    const r = await post('/api/access/email/code');

    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('EMAIL_DELIVERY_UNAVAILABLE');
    expect(r.json().sent).toBeUndefined();
  });

  it('при отказе провайдера паузы не возникает', async () => {
    // Иначе человек ждёт минуту письма, которого не было.
    state.emailVerified = false;
    delivery = 'failed';

    const r = await post('/api/access/email/code');

    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe('EMAIL_DELIVERY_FAILED');
    expect(r.json().retryAfterSeconds).toBe(0);
  });

  it('после сбоя доставки повтор разрешён сразу', async () => {
    state.emailVerified = false;
    delivery = 'failed';
    await post('/api/access/email/code');

    delivery = 'ok';
    const again = await post('/api/access/email/code');

    expect(again.statusCode).toBe(200);
    expect(again.json().sent).toBe(true);
  });

  it('подтверждение не запускает пробный период само', async () => {
    // Подтверждение только снимает препятствие. Пять суток,
    // начавшиеся сами собой, кончаются раньше, чем человек успевает
    // посмотреть продукт.
    state.emailVerified = false;
    await post('/api/access/email/verify', { code: '123456' });

    const me = await get('/api/access/me');
    expect(me.json().effectivePlan).toBe('EXPIRED');
    expect(me.json().canStartTrial).toBe(true);
  });

  it('чужой адрес в теле запроса ни на что не влияет', async () => {
    state.emailVerified = false;
    const r = await post('/api/access/email/code', { email: 'victim@example.com' });

    expect(r.statusCode).toBe(200);
    // Адреса в ответе нет вовсе: подставлять некуда и подтверждать
    // нечего.
    expect(JSON.stringify(r.json())).not.toContain('victim@example.com');
  });

  it('подтверждённому адресу код не нужен', async () => {
    const r = await post('/api/access/email/code');

    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('ALREADY_VERIFIED');
  });

  it('неверный код отклоняется', async () => {
    state.emailVerified = false;
    const r = await post('/api/access/email/verify', { code: '000000' });

    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('CODE_WRONG');
  });

  it('верный код открывает дорогу к пробному периоду', async () => {
    state.emailVerified = false;

    const v = await post('/api/access/email/verify', { code: '123456' });
    expect(v.statusCode).toBe(200);
    expect(v.json().verified).toBe(true);
    expect(v.json().canStartTrial).toBe(true);

    const t = await post('/api/access/trial/activate');
    expect(t.statusCode).toBe(201);
  });

  it('подтверждение требует авторизации', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/access/email/verify',
      payload: { code: '123456' },
    });

    expect(r.statusCode).toBe(401);
  });
});

describe('подмена плана клиентом', () => {
  it('план из тела запроса игнорируется', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: auth.authorization() },
      payload: { side: 'BUY', plan: 'FULL_AUTO' },
    });

    expect(r.statusCode).toBe(403);
  });

  it('план из строки запроса игнорируется', async () => {
    const r = await get('/smart-wallets?plan=FULL_AUTO&effectivePlan=PRO');

    expect(r.statusCode).toBe(403);
  });

  it('план из заголовка игнорируется', async () => {
    const r = await get('/smart-wallets', {
      'x-plan': 'FULL_AUTO',
      'x-entitlement': 'PRO',
      'x-user-plan': 'FULL_AUTO',
    });

    expect(r.statusCode).toBe(403);
  });

  it('план из cookie игнорируется', async () => {
    const r = await get('/smart-wallets', { cookie: 'plan=FULL_AUTO; entitlement=PRO' });

    expect(r.statusCode).toBe(403);
  });

  it('чужой токен без подписи не принимается', async () => {
    const forged = Buffer.from(JSON.stringify({ sub: 'user-2', role: 'ADMIN' })).toString('base64');
    const r = await app.inject({
      method: 'GET',
      url: '/smart-wallets',
      headers: { authorization: `Bearer x.${forged}.x` },
    });

    expect(r.statusCode).toBe(401);
  });

  it('роль администратора не открывает платные возможности', async () => {
    // Роль — про полномочия внутри системы, план — про оплату.
    // Смешать их значит однажды выдать управление деньгами тому,
    // кто просто числится сотрудником.
    const adminToken = app.jwt.sign({ sub: 'user-1', role: 'ADMIN' });
    const r = await app.inject({
      method: 'GET',
      url: '/smart-wallets',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(r.statusCode).toBe(403);
  });
});

describe('платные планы', () => {
  it('PRO открывает смарт-кошельки', async () => {
    state.paidPlan = 'PRO';

    const r = await get('/smart-wallets');
    expect(r.statusCode).toBe(200);
    expect(r.json().plan).toBe('PRO');
  });

  it('PRO не открывает копирование', async () => {
    state.paidPlan = 'PRO';

    expect((await get('/copy')).statusCode).toBe(403);
  });

  it('SEMI_AUTO открывает копирование покупок', async () => {
    state.paidPlan = 'SEMI_AUTO';

    expect((await get('/copy')).statusCode).toBe(200);
    expect((await get('/semi-auto')).statusCode).toBe(200);
  });

  it('SEMI_AUTO не открывает автоматические выходы — продажа остаётся ручной', async () => {
    state.paidPlan = 'SEMI_AUTO';

    expect((await get('/auto-exit')).statusCode).toBe(403);
  });

  it('FULL_AUTO открывает автоматические выходы', async () => {
    state.paidPlan = 'FULL_AUTO';

    expect((await get('/auto-exit')).statusCode).toBe(200);
  });

  it('оплата важнее действующего пробного периода', async () => {
    await post('/api/access/trial/activate');
    state.paidPlan = 'FULL_AUTO';

    expect((await get('/api/access/me')).json().effectivePlan).toBe('FULL_AUTO');
  });

  it('истёкшая подписка немедленно даёт поведение без плана', async () => {
    state.paidPlan = 'PRO';
    state.paidExpiresAt = new Date(T0 + 1000);

    expect((await get('/smart-wallets')).statusCode).toBe(200);

    now = T0 + 1000;
    expect((await get('/smart-wallets')).statusCode).toBe(403);
    expect((await get('/withdraw')).statusCode).toBe(200);
  });
});

describe('ответы о доступе', () => {
  it('состояние не содержит платёжных сведений', async () => {
    state.paidPlan = 'PRO';
    const body = JSON.stringify((await get('/api/access/me')).json());

    expect(body).not.toMatch(/sub-1|externalReference|createdByUserId|metadata/);
  });

  it('ответы о доступе не кешируются', async () => {
    const r = await get('/api/access/me');

    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['vary']).toBe('Authorization');
  });

  it('список возможностей совпадает с таблицей планов', async () => {
    state.paidPlan = 'SEMI_AUTO';
    const caps = (await get('/api/access/me')).json().capabilities;

    expect(caps).toEqual(capabilityList(entitlementFor('SEMI_AUTO')));
  });

  it('витрина тарифов открыта анониму', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/access/plans' });

    expect(r.statusCode).toBe(200);
    expect(r.json().trialHours).toBe(120);
    expect(r.json().plans.map((p: { plan: string }) => p.plan)).toEqual([
      'TRIAL',
      'PRO',
      'SEMI_AUTO',
      'FULL_AUTO',
    ]);
    expect(r.json().plans.map((p: { price: unknown }) => p.price)).toEqual([
      null,
      { amount: '50.00', currency: 'USDC' },
      { amount: '100.00', currency: 'USDC' },
      { amount: '200.00', currency: 'USDC' },
    ]);
  });

  it('аноним не получает никаких прав, кроме витрины', async () => {
    const r = await app.inject({ method: 'GET', url: '/radar' });

    expect(r.statusCode).toBe(401);
  });

  it('код нужного плана в отказе совпадает с таблицей', async () => {
    await post('/api/access/trial/activate');
    const r = await get('/smart-wallets');

    expect(r.json().requiredPlan).toBe(requiredPlanFor('SMART_WALLETS_ACCESS'));
  });
});
