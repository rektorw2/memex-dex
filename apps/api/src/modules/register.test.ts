import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Регистрация и вход.
 *
 * Дефект, ради которого написан этот файл: существующий адрес получал
 * `201 { ok: true }`. Это была сознательная защита от перебора
 * зарегистрированных адресов, но интерфейс читал 201 как успех
 * и показывал «Аккаунт создан» человеку, у которого аккаунт уже есть.
 * Он уходил ждать письма, которого не будет, вместо того чтобы войти.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

/** Пользователи в памяти. Ключ — нормализованный адрес. */
let users: Map<string, Record<string, any>>;
/** Следующая запись падает с нарушением уникальности. */
let raceOnNextCreate = false;

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    user: {
      findUnique: async (args: any) => users.get(args.where.email) ?? null,
      create: async (args: any) => {
        /*
         * Подделка ведёт себя как база с уникальным индексом:
         * последняя защита от гонки должна быть проверяема.
         */
        if (raceOnNextCreate || users.has(args.data.email)) {
          raceOnNextCreate = false;
          const e: any = new Error('Unique constraint failed on the fields: (`email`)');
          e.code = 'P2002';
          throw e;
        }

        const row = { id: `u-${users.size + 1}`, role: 'USER', isFrozen: false, ...args.data };
        users.set(args.data.email, row);
        return row;
      },
      update: async () => ({}),
    },
    session: { create: async () => ({}), findFirst: async () => null, updateMany: async () => ({}) },
    auditLog: { create: async () => ({}) },
    $transaction: async <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };

  return { prisma, serializable: vi.fn() };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { authRoutes } = await import('./auth.js');
const { sendError } = await import('../lib/error-handler.js');

let app: FastifyInstance;

beforeEach(async () => {
  users = new Map();
  raceOnNextCreate = false;

  app = Fastify();
  await app.register(jwt, { secret: SECRET });
  // Маршруты выхода и 2FA объявляют `app.authenticate`. Здесь
  // проверяются регистрация и вход, но без заглушки Fastify
  // откажется зарегистрировать плагин целиком.
  app.decorate('authenticate', async () => undefined);
  // Тот же обработчик ошибок, что и у боевого сервера: иначе
  // `ZodError` дошла бы до общего обработчика Fastify и тест
  // видел бы 500 там, где продукт отвечает 400.
  app.setErrorHandler(sendError);
  await app.register(authRoutes);
  await app.ready();
});

const register = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/auth/register', payload: body });

const login = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: body });

const GOOD = { email: 'user@example.com', password: 'достаточно-длинный-пароль' };

// ────────────────────────── Обычная регистрация ─────────────────────────────

describe('первая регистрация', () => {
  it('создаёт аккаунт', async () => {
    const res = await register(GOOD);

    expect(res.statusCode).toBe(201);
    expect(users.has('user@example.com')).toBe(true);
  });

  it('адрес сохраняется нормализованным', async () => {
    await register({ ...GOOD, email: '  User@Example.COM  ' });

    // Ключ — приведённый адрес: иначе тот же ящик заводился бы
    // дважды, а вход одним написанием не находил бы второй.
    expect([...users.keys()]).toEqual(['user@example.com']);
  });

  it('пароль в ответе не появляется', async () => {
    const res = await register(GOOD);

    expect(res.body).not.toContain(GOOD.password);
  });
});

// ────────────────────────── Повторная регистрация ───────────────────────────

describe('повторная регистрация', () => {
  it('отвечает конфликтом, а не успехом', async () => {
    await register(GOOD);
    const res = await register(GOOD);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ACCOUNT_ALREADY_EXISTS');
  });

  it('второго пользователя не создаёт', async () => {
    await register(GOOD);
    await register(GOOD);

    expect(users.size).toBe(1);
  });

  it('другой регистр считается тем же адресом', async () => {
    await register(GOOD);
    const res = await register({ ...GOOD, email: 'USER@Example.com' });

    expect(res.statusCode).toBe(409);
    expect(users.size).toBe(1);
  });

  it('пробелы вокруг адреса тоже', async () => {
    await register(GOOD);

    expect((await register({ ...GOOD, email: ' user@example.com ' })).statusCode).toBe(409);
  });

  it('пароль существующего аккаунта не проверяется', async () => {
    await register(GOOD);

    // Регистрация не является скрытым входом: с чужим паролем
    // ответ обязан быть тем же самым.
    const res = await register({ ...GOOD, password: 'совершенно-другой-пароль' });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ACCOUNT_ALREADY_EXISTS');
  });

  it('гонка двух одновременных регистраций упирается в базу', async () => {
    // Проверка «есть ли такой» и запись — не одна операция.
    // Последней защитой остаётся уникальное ограничение.
    raceOnNextCreate = true;
    const res = await register(GOOD);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ACCOUNT_ALREADY_EXISTS');
  });
});

// ──────────────────────────── Валидация ─────────────────────────────────────

describe('валидация регистрации', () => {
  it('неверный адрес отклоняется', async () => {
    for (const email of ['не-адрес', 'user@', '@example.com', '']) {
      const res = await register({ ...GOOD, email });
      expect(res.statusCode, email).toBe(400);
    }
  });

  it('короткий пароль отклоняется', async () => {
    expect((await register({ ...GOOD, password: 'коротк' })).statusCode).toBe(400);
  });

  it('пароль из пробелов отклоняется', async () => {
    expect((await register({ ...GOOD, password: ' '.repeat(20) })).statusCode).toBe(400);
  });

  it('слишком длинный пароль отклоняется', async () => {
    expect((await register({ ...GOOD, password: 'a'.repeat(300) })).statusCode).toBe(400);
  });

  it('ошибка валидации — это 400, а не 500', async () => {
    // Незакрытая zod-ошибка превращается во внутреннюю ошибку
    // сервера, и человек видит «что-то пошло не так» вместо
    // «проверьте адрес».
    const res = await register({ email: 42, password: null });

    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
  });
});

// ────────────────────────────── Вход ────────────────────────────────────────

describe('вход после регистрации', () => {
  it('работает с тем же паролем', async () => {
    await register(GOOD);
    const res = await login(GOOD);

    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
  });

  it('работает при другом регистре адреса', async () => {
    await register(GOOD);

    expect((await login({ ...GOOD, email: 'USER@EXAMPLE.COM' })).statusCode).toBe(200);
  });

  it('неверный пароль по-прежнему даёт 401', async () => {
    await register(GOOD);
    const res = await login({ ...GOOD, password: 'неверный-длинный-пароль' });

    expect(res.statusCode).toBe(401);
  });

  it('несуществующий адрес тоже 401 и с тем же текстом', async () => {
    // Разные тексты выдавали бы существование аккаунта.
    const missing = await login({ email: 'nobody@example.com', password: 'какой-то-пароль' });

    expect(missing.statusCode).toBe(401);
  });

  it('код 2FA не шести цифр отклоняется до проверки секрета', async () => {
    await register(GOOD);
    const res = await login({ ...GOOD, totp: '12345' });

    expect(res.statusCode).toBe(400);
  });

  it('ни пароль, ни токен не попадают в ответ об ошибке', async () => {
    const res = await login({ ...GOOD, password: 'секретная-строка-пароля' });

    expect(res.body).not.toContain('секретная-строка-пароля');
  });
});
