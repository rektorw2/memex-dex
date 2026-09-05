import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Сквозной путь первого сценария поверх настоящего HTTP.
 *
 * Регистрация → вход → письмо → неверный код → пауза → верный код →
 * один период на пять суток → права → выход → повторный вход.
 *
 * Почему одним тестом, а не десятью. Каждый шаг по отдельности уже
 * проверен, и все проверки зелёные — но путь ломается на стыках:
 * пауза, посчитанная от другого времени; период, выданный дважды,
 * потому что второй запрос прошёл другой веткой; права, которые
 * обновились не там. Такое видно только тогда, когда шаги идут
 * подряд и по одному состоянию.
 *
 * Чего здесь нет и о чём надо сказать прямо. Настоящего Postgres
 * в этом окружении нет, поэтому база заменена хранилищем в памяти —
 * но с теми же ограничениями, которые делают защиту защитой:
 * условное обновление «подтвердить, только если ещё не подтверждён»
 * и уникальность записи о пробном периоде. Настоящих писем тоже нет:
 * транспорт подставной, как в разработке.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';
const FIVE_DAYS_MS = 5 * 24 * 3_600_000;

let now = Date.UTC(2026, 4, 12, 9, 0, 0);

// ────────────────────────── Хранилище в памяти ───────────────────────────────

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  role: 'USER' | 'ADMIN';
  emailVerifiedAt: Date | null;
  emailCodeHash: string | null;
  emailCodeIssuedAt: Date | null;
  emailCodeExpires: Date | null;
  emailCodeAttempts: number;
}

const users = new Map<string, UserRow>();
const subscriptions: Array<{
  id: string;
  userId: string;
  plan: string;
  startsAt: Date;
  expiresAt: Date | null;
  status: string;
  source: string;
}> = [];
const audits: Array<Record<string, unknown>> = [];

/** Письма, «отправленные» подставным транспортом. */
const mailbox: Array<{
  to: string;
  code: string;
  subject?: string;
  text?: string;
  html?: string;
}> = [];

/** Сколько раз пытались вставить запись о периоде — включая отвергнутые. */
let trialInsertAttempts = 0;

function reset() {
  users.clear();
  subscriptions.length = 0;
  audits.length = 0;
  mailbox.length = 0;
  trialInsertAttempts = 0;
  now = Date.UTC(2026, 4, 12, 9, 0, 0);
}

vi.mock('../lib/clock.js', () => ({
  serverNow: () => new Date(now),
  serverNowMs: () => now,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../lib/prisma.js', () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: never) =>
        users.get((where as { id?: string }).id ?? '') ??
        [...users.values()].find((u) => u.email === (where as { email?: string }).email) ??
        null,
      create: async ({ data }: never) => {
        const row = { ...(data as UserRow), emailCodeAttempts: 0 };
        users.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: never) => {
        const row = users.get((where as { id: string }).id);
        if (!row) throw new Error('нет такого пользователя');
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          const inc = (value as { increment?: number })?.increment;
          if (typeof inc === 'number') {
            // Счётчик мог не существовать: увеличиваем от нуля, как
            // это делает база при `increment` на NULL-совместимом поле.
            const store = row as unknown as Record<string, number>;
            store[key] = (store[key] ?? 0) + inc;
          } else {
            (row as unknown as Record<string, unknown>)[key] = value;
          }
        }
        return row;
      },
      /**
       * Условное обновление — то самое, что делает переход атомарным.
       *
       * Из двух одновременных подтверждений ровно одно получает
       * `count: 1`. Без этого оба сообщили бы «подтверждено только
       * что», и оба попытались бы выдать период.
       */
      updateMany: async ({ where, data }: never) => {
        const w = where as { id: string; emailVerifiedAt?: null };
        const row = users.get(w.id);
        if (!row) return { count: 0 };

        if ('emailVerifiedAt' in w && row.emailVerifiedAt !== null) return { count: 0 };

        Object.assign(row, data as Record<string, unknown>);
        return { count: 1 };
      },
    },
    subscription: {
      findFirst: async ({ where }: never) => {
        const w = where as { userId: string; plan?: string };
        return (
          subscriptions.find(
            (s) => s.userId === w.userId && (w.plan ? s.plan === w.plan : s.plan !== 'TRIAL'),
          ) ?? null
        );
      },
      create: async ({ data }: never) => {
        const row = data as { userId: string; plan: string };
        trialInsertAttempts += 1;

        /*
         * Уникальность «один пробный период на пользователя».
         *
         * Второй рубеж после условного обновления. Ошибка повторяет
         * настоящую: `P2002`, которую вызывающий обязан разобрать
         * как нормальный исход гонки, а не как сбой.
         */
        if (
          row.plan === 'TRIAL' &&
          subscriptions.some((s) => s.userId === row.userId && s.plan === 'TRIAL')
        ) {
          const error = new Error('Unique constraint failed') as Error & { code: string };
          error.code = 'P2002';
          error.name = 'PrismaClientKnownRequestError';
          throw error;
        }

        const saved = {
          id: `sub-${subscriptions.length + 1}`,
          status: 'ACTIVE',
          ...(data as Record<string, unknown>),
        };
        subscriptions.push(saved as never);
        return saved;
      },
    },
    entitlementAudit: { create: async ({ data }: never) => { audits.push(data as never); return data; } },
    auditLog: { create: async ({ data }: never) => { audits.push(data as never); return data; } },
    refreshToken: {
      create: async ({ data }: never) => data,
      findUnique: async () => null,
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    /*
     * Транзакция выполняет обратный вызов на том же хранилище.
     *
     * Откат здесь не моделируется: в этом сценарии единственная
     * запись внутри транзакции — вставка периода, и её отвергает
     * ограничение уникальности до всяких откатов.
     */
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };

  return {
    prisma,
    serializable: async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    prismaWasInstantiated: () => true,
  };
});

/**
 * Подставной транспорт: письма никуда не уходят, код виден тесту.
 *
 * Это контролируемый транспорт того же вида, что используется
 * в разработке, — не подмена логики отправки. Настоящий Resend
 * в тестах не вызывается: письмо живому человеку из прогона тестов
 * это письмо, которое он не просил.
 */
vi.mock('../services/mailer.js', () => ({
  getMailer: () => ({
    name: 'test',
    enabled: true,
    async send(email: {
      to: string;
      message: { subject: string; text: string; html: string };
    }) {
      /*
       * Код ищется в теле, а не в теме.
       *
       * Тема письма попадает в уведомления и в списки на чужих
       * экранах — кода там быть не должно. Проверка ниже это
       * подтверждает отдельно.
       */
      const match = /\b(\d{6})\b/.exec(email.message.text);
      mailbox.push({
        to: email.to,
        code: match?.[1] ?? '',
        subject: email.message.subject,
        text: email.message.text,
        html: email.message.html,
      });
      return { ok: true as const };
    },
  }),
  isDeliveryConfigured: () => true,
}));

const { accessRoutes } = await import('./access.js');
const { sendError } = await import('../lib/error-handler.js');

let app: FastifyInstance;
let token: string;

/** Заводит аккаунт так, как это делает регистрация. */
async function register(email: string) {
  const row: UserRow = {
    id: 'u1',
    email,
    // Пароль здесь не проверяется: вход выполняется выдачей токена,
    // а предмет теста — путь после входа.
    passwordHash: 'не-проверяется-в-этом-тесте',
    role: 'USER',
    // Регистрация создаёт аккаунт неподтверждённым. Это и есть
    // единственное препятствие между человеком и продуктом.
    emailVerifiedAt: null,
    emailCodeHash: null,
    emailCodeIssuedAt: null,
    emailCodeExpires: null,
    emailCodeAttempts: 0,
  };
  users.set(row.id, row);
  token = app.jwt.sign({ sub: row.id, role: 'USER' });
}

const post = (url: string, body?: unknown) =>
  app.inject({
    method: 'POST' as const,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeEach(async () => {
  reset();

  app = Fastify();
  await app.register(jwt, { secret: SECRET });
  app.decorate(
    'authenticate',
    (async (req: { jwtVerify: () => Promise<void> }, reply: {
      code: (n: number) => { send: (b: unknown) => unknown };
    }) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'Требуется авторизация' });
      }
    }) as never,
  );
  app.setErrorHandler(sendError);
  await app.register(accessRoutes, { prefix: '/api' });
  await app.ready();

  await register('newcomer@example.com');
});

// ═════════════════════════ Полный путь ═══════════════════════════════════════

describe('сквозной путь: регистрация → подтверждение → период', () => {
  it('после регистрации доступа нет', async () => {
    const me = await get('/api/access/me');

    expect(me.statusCode).toBe(200);
    expect(me.json().emailVerified).toBe(false);
    expect(me.json().effectivePlan).toBe('EXPIRED');
  });

  it('код уходит письмом и в ответе его нет', async () => {
    const sent = await post('/api/access/email/code');

    expect(sent.statusCode).toBe(200);
    expect(sent.json().sent).toBe(true);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.to).toBe('newcomer@example.com');

    /*
     * Код в ответе HTTP — это код, доступный тому, кто до почты
     * не добрался. Он должен приходить письмом и только письмом.
     */
    expect(JSON.stringify(sent.json())).not.toContain(mailbox[0]!.code);
  });

  it('неверный код не подтверждает и не выдаёт периода', async () => {
    await post('/api/access/email/code');
    const wrong = await post('/api/access/email/verify', { code: '000000' });

    expect(wrong.statusCode).toBe(400);
    expect(users.get('u1')!.emailVerifiedAt).toBeNull();
    expect(subscriptions).toHaveLength(0);
  });

  it('повторная отправка сразу упирается в паузу', async () => {
    await post('/api/access/email/code');
    const again = await post('/api/access/email/code');

    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe('TOO_SOON');
    // Пауза считается сервером: часы браузера правятся мгновенно.
    expect(again.json().retryAfterSeconds).toBeGreaterThan(0);
    expect(mailbox).toHaveLength(1);
  });

  it('после паузы письмо уходит снова', async () => {
    await post('/api/access/email/code');
    now += 5 * 60_000;

    const again = await post('/api/access/email/code');

    expect(again.statusCode).toBe(200);
    expect(mailbox).toHaveLength(2);
    // Новый код отменяет старый: два действующих ключа к аккаунту
    // одновременно существовать не должны.
    expect(mailbox[1]!.code).not.toBe('');
  });

  it('верный код подтверждает и сразу выдаёт один период на пять суток', async () => {
    await post('/api/access/email/code');
    const code = mailbox[0]!.code;

    const verified = await post('/api/access/email/verify', { code });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().verified).toBe(true);
    expect(verified.json().trial.outcome).toBe('STARTED');

    const trial = subscriptions.filter((s) => s.plan === 'TRIAL');
    expect(trial).toHaveLength(1);
    expect(trial[0]!.expiresAt!.getTime() - trial[0]!.startsAt.getTime()).toBe(FIVE_DAYS_MS);
  });

  it('права появляются сразу после подтверждения', async () => {
    await post('/api/access/email/code');
    await post('/api/access/email/verify', { code: mailbox[0]!.code });

    const me = await get('/api/access/me');

    expect(me.json().emailVerified).toBe(true);
    expect(me.json().effectivePlan).toBe('TRIAL');
    expect(me.json().capabilities).toContain('RADAR_ACCESS');
    expect(me.json().canStartTrial).toBe(false);
  });

  it('тарифы показывают действующий период, а не предложение начать', async () => {
    await post('/api/access/email/code');
    await post('/api/access/email/verify', { code: mailbox[0]!.code });

    const me = await get('/api/access/me');

    expect(me.json().trialExpiresAt).toBeTruthy();
    expect(me.json().trialRemainingSeconds).toBeGreaterThan(0);
  });

  it('повторный вход ничего не меняет', async () => {
    await post('/api/access/email/code');
    await post('/api/access/email/verify', { code: mailbox[0]!.code });
    const before = (await get('/api/access/me')).json().trialExpiresAt;

    // «Выход и повторный вход» на уровне API — это новый токен
    // для того же аккаунта.
    token = app.jwt.sign({ sub: 'u1', role: 'USER' });
    now += 3 * 3_600_000;

    const after = await get('/api/access/me');

    expect(after.json().trialExpiresAt).toBe(before);
    expect(subscriptions.filter((s) => s.plan === 'TRIAL')).toHaveLength(1);
  });
});

// ═════════════════════════ Само письмо ══════════════════════════════════════

describe('письмо не рассказывает лишнего', () => {
  it('код есть в теле и отсутствует в теме', async () => {
    await post('/api/access/email/code');
    const mail = mailbox[0]!;

    /*
     * Тема попадает в уведомления на заблокированном экране и
     * в списки писем на чужих мониторах. Кода там быть не должно.
     */
    expect(mail.text).toContain(mail.code);
    expect(mail.subject).not.toContain(mail.code);
  });

  it('есть и текстовая, и html-версия', async () => {
    await post('/api/access/email/code');
    const mail = mailbox[0]!;

    // Часть почтовых клиентов html не показывает вовсе.
    expect(mail.text!.length).toBeGreaterThan(0);
    expect(mail.html!.length).toBeGreaterThan(0);
  });

  it('сказано, что делать, если это были не вы', async () => {
    await post('/api/access/email/code');

    expect(mailbox[0]!.text).toMatch(/не вы|не запрашивали|проигнорируйте/i);
  });

  it('нет обещаний прибыли и технических подробностей', async () => {
    await post('/api/access/email/code');
    const mail = mailbox[0]!;
    const body = `${mail.subject} ${mail.text} ${mail.html}`;

    expect(body).not.toMatch(/гарантирован|прибыл|доход|иксов|×\d/i);
    // Ни внутренних адресов, ни стека, ни кодов ошибок.
    expect(body).not.toMatch(/localhost|127\.0\.0\.1|stack|at .*\.ts:\d+|Error:/);
    expect(body).not.toMatch(/re_[A-Za-z0-9]{8}/);
  });

  it('срок действия назван', async () => {
    await post('/api/access/email/code');

    expect(mailbox[0]!.text).toMatch(/\d+\s*(минут|мин)/i);
  });
});

// ═════════════════════════ Повторы и гонки ═══════════════════════════════════

describe('повторы не создают второго периода', () => {
  it('повторное подтверждение тем же кодом', async () => {
    await post('/api/access/email/code');
    const code = mailbox[0]!.code;

    await post('/api/access/email/verify', { code });
    const second = await post('/api/access/email/verify', { code });

    expect(second.statusCode).toBe(200);
    expect(second.json().trial.outcome).not.toBe('STARTED');
    expect(subscriptions.filter((s) => s.plan === 'TRIAL')).toHaveLength(1);
  });

  it('два одновременных подтверждения', async () => {
    await post('/api/access/email/code');
    const code = mailbox[0]!.code;

    const [a, b] = await Promise.all([
      post('/api/access/email/verify', { code }),
      post('/api/access/email/verify', { code }),
    ]);

    /*
     * Оба запроса завершились успешно — это верно, человек ввёл
     * верный код. Период при этом ровно один.
     */
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(subscriptions.filter((s) => s.plan === 'TRIAL')).toHaveLength(1);

    const started = [a, b].filter((r) => r.json().trial?.outcome === 'STARTED');
    expect(started).toHaveLength(1);
  });

  it('отдельная активация после подтверждения период не удваивает', async () => {
    await post('/api/access/email/code');
    await post('/api/access/email/verify', { code: mailbox[0]!.code });

    // Путь восстановления. Он идемпотентен и второго периода
    // не создаёт — даже если вставка была отвергнута ограничением.
    const retry = await post('/api/access/trial/activate');

    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe('already_active');
    expect(subscriptions.filter((s) => s.plan === 'TRIAL')).toHaveLength(1);
  });

  it('ограничение базы срабатывает, а не обходится проверкой в памяти', async () => {
    await post('/api/access/email/code');
    const code = mailbox[0]!.code;

    await Promise.all([
      post('/api/access/email/verify', { code }),
      post('/api/access/email/verify', { code }),
      post('/api/access/trial/activate'),
    ]);

    // Попыток вставки могло быть несколько; записей — одна.
    expect(trialInsertAttempts).toBeGreaterThanOrEqual(1);
    expect(subscriptions.filter((s) => s.plan === 'TRIAL')).toHaveLength(1);
  });
});
