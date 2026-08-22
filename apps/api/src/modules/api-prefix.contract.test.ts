import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import jwt from '@fastify/jwt';
import { apiBaseFor } from '@memex/core';

/**
 * Договор между таблицей баз и настоящей регистрацией маршрутов.
 *
 * Таблица `apiBaseFor` существует, чтобы клиент не ошибался с базой.
 * Но сама она — тоже утверждение, и утверждение это можно записать
 * неверно. Ровно так и вышло: `/auth/` попал в список корневых
 * «по смыслу» — вход и регистрация ведь про пользователя, а не про
 * версию торгового API, — тогда как зарегистрирован он под `/api/v1`.
 * Тесты при этом подтверждали ошибку, потому что проверяли таблицу
 * саму по себе.
 *
 * Поэтому здесь поднимается настоящий Fastify с настоящими модулями
 * маршрутов и теми же префиксами, что в `server.ts`, и проверяется
 * не мнение, а факт: 404 или не 404.
 *
 * Отличать 404 от прочих кодов достаточно. Что маршрут ответит
 * по существу — дело других тестов; здесь вопрос один: существует ли
 * он по этому адресу.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

/**
 * Минимальная база в памяти.
 *
 * Нужна не для проверки хранения, а чтобы регистрация и вход прошли
 * по-настоящему: проверка «маршрут не отвечает 404» доказывает
 * существование адреса, но не то, что по нему что-то работает.
 */
interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  totpSecret: string | null;
  isFrozen: boolean;
  kycStatus: string;
}

const users = new Map<string, FakeUser>();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
        (where.email ? users.get(where.email) : [...users.values()].find((u) => u.id === where.id)) ??
        null,
      create: async ({ data }: { data: { email: string; passwordHash: string } }) => {
        const row: FakeUser = {
          id: `u-${users.size + 1}`,
          email: data.email,
          passwordHash: data.passwordHash,
          role: 'USER',
          totpSecret: null,
          isFrozen: false,
          kycStatus: 'NONE',
        };
        users.set(data.email, row);
        return row;
      },
    },
    refreshToken: { create: async () => ({ id: 'rt-1' }), findFirst: async () => null },
    session: { create: async () => ({ id: 's-1' }) },
    subscription: { findFirst: async () => null },
    subscriptionPayment: { findFirst: async () => null, findMany: async () => [] },
    paymentCustomer: { findUnique: async () => null },
  },
  serializable: vi.fn(),
}));

// Ключи шифрования настоящему KMS здесь не нужны: проверяются
// адреса маршрутов, а не работа с секретами.
vi.mock('../lib/crypto.js', () => ({
  hashToken: (v: string) => `hash:${v}`,
  getKms: () => ({ encrypt: async () => '', decrypt: async () => '' }),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../lib/clock.js', () => ({ serverNow: () => new Date(), serverNowMs: () => Date.now() }));

vi.mock('../services/subscriptions.js', () => ({ activeSubscription: async () => null }));
vi.mock('../services/trial.js', () => ({ trialOf: async () => null, TRIAL_HOURS: 120 }));
vi.mock('../services/email-verify.js', () => ({
  isEmailVerified: async () => false,
  issueCode: async () => ({ ok: false, reason: 'NO_USER' }),
  verifyCode: async () => ({ result: 'CODE_WRONG' }),
}));
vi.mock('../services/service-access.js', () => ({ hasServiceAccess: async () => false }));

vi.mock('../services/payments/index.js', () => ({
  getPaymentProvider: () => ({ name: 'disabled', enabled: false }),
  getCoinbase: () => null,
  activeProvider: () => 'disabled',
  paymentsEnabled: () => false,
  treasuryAddress: () => null,
}));

vi.mock('../lib/env.js', () => ({
  env: { EXECUTION_MODE: 'paper', NODE_ENV: 'test', JWT_TTL: '15m' },
}));

const { authRoutes } = await import('./auth.js');
const { accessRoutes } = await import('./access.js');
const { paymentRoutes } = await import('./payments.js');

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  await app.register(jwt, { secret: SECRET });

  for (const name of ['authenticate', 'requireAdmin', 'requireLeader'] as const) {
    app.decorate(name, async function guard(
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
  }

  // Ровно те же префиксы, что в server.ts. Разойтись они могут
  // только вместе с этим файлом.
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(accessRoutes, { prefix: '/api' });
  await app.register(paymentRoutes, { prefix: '/api' });

  users.clear();
  await app.ready();
});

/** Есть ли маршрут по этому адресу. 405 тоже «есть»: метод не тот. */
async function exists(method: 'GET' | 'POST', url: string): Promise<boolean> {
  const r = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
  return r.statusCode !== 404;
}

describe('вход и регистрация живут под /api/v1', () => {
  it('POST /api/v1/auth/login существует', async () => {
    expect(await exists('POST', '/api/v1/auth/login')).toBe(true);
  });

  it('POST /api/auth/login не существует', async () => {
    // Если это когда-нибудь станет 404 → не 404, значит маршруты
    // переехали, и таблица баз обязана переехать вместе с ними.
    expect(await exists('POST', '/api/auth/login')).toBe(false);
  });

  it('POST /api/v1/auth/register существует', async () => {
    expect(await exists('POST', '/api/v1/auth/register')).toBe(true);
  });

  it('POST /api/auth/register не существует', async () => {
    expect(await exists('POST', '/api/auth/register')).toBe(false);
  });
});

describe('доступ и оплата живут под /api', () => {
  it('GET /api/access/plans существует', async () => {
    expect(await exists('GET', '/api/access/plans')).toBe(true);
  });

  it('GET /api/v1/access/plans не существует', async () => {
    expect(await exists('GET', '/api/v1/access/plans')).toBe(false);
  });

  it('GET /api/payments/catalog существует', async () => {
    expect(await exists('GET', '/api/payments/catalog')).toBe(true);
  });

  it('GET /api/v1/payments/catalog не существует', async () => {
    expect(await exists('GET', '/api/v1/payments/catalog')).toBe(false);
  });

  it('GET /api/payments/status существует', async () => {
    expect(await exists('GET', '/api/payments/status')).toBe(true);
  });
});

describe('таблица баз совпадает с регистрацией', () => {
  /**
   * Главная проверка файла.
   *
   * Для каждого маршрута берётся база из таблицы, строится адрес
   * и проверяется, что он существует, — а адрес по другой базе
   * не существует. Так таблица перестаёт быть отдельным мнением
   * и становится описанием факта.
   */
  it.each([
    ['POST' as const, '/auth/login'],
    ['POST' as const, '/auth/register'],
    ['GET' as const, '/access/plans'],
    ['GET' as const, '/payments/catalog'],
    ['GET' as const, '/payments/status'],
  ])('%s %s', async (method, path) => {
    const base = apiBaseFor(path);

    const right = base === 'root' ? `/api${path}` : `/api/v1${path}`;
    const wrong = base === 'root' ? `/api/v1${path}` : `/api${path}`;

    expect(await exists(method, right), `${right} должен существовать`).toBe(true);
    expect(await exists(method, wrong), `${wrong} не должен существовать`).toBe(false);
  });
});

describe('регистрация и вход работают по настоящему адресу', () => {
  const account = { email: 'contract@example.com', password: 'ДлинныйПароль12345' };

  it('регистрация создаёт аккаунт', async () => {
    // Не «маршрут существует», а «по нему что-то происходит»:
    // адрес без работающего обработчика тоже отвечает не 404.
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: account,
    });

    expect(r.statusCode).toBe(201);
    expect(users.has(account.email)).toBe(true);
  });

  it('вход выдаёт токен', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: account });

    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: account });

    expect(r.statusCode).toBe(200);
    expect(typeof r.json().accessToken).toBe('string');
  });

  it('неверный пароль токена не даёт', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: account });

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { ...account, password: 'не тот пароль' },
    });

    expect(r.statusCode).toBe(401);
  });

  it('те же запросы под /api не доходят никуда', async () => {
    // Ровно та ошибка, которую допустила таблица баз: адрес выглядит
    // осмысленным, а обработчика по нему нет.
    for (const path of ['/api/auth/register', '/api/auth/login']) {
      const r = await app.inject({ method: 'POST', url: path, payload: account });
      expect(r.statusCode, path).toBe(404);
    }

    expect(users.size).toBe(0);
  });
});
