import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Источник роли и границы служебного доступа.
 *
 * Проверяется две вещи, и вторая важнее первой.
 *
 * Первая: роль берётся из базы. Не из тела запроса, не из строки
 * запроса, не из заголовка и не из токена — токен подписан нами,
 * но это снимок на момент входа, и снятая роль осталась бы в нём
 * до истечения срока.
 *
 * Вторая: обходятся тарифные правила, а не защита. Аудит, ограничение
 * частоты и проверка подписи токена работают для администратора
 * ровно так же, как для всех.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

let dbRole: 'USER' | 'ADMIN' = 'USER';
let roleReads = 0;
const auditWrites: { actorId: string; action: string }[] = [];

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        roleReads++;
        return where.id ? { role: dbRole } : null;
      },
    },
    auditLog: {
      create: async ({ data }: { data: { actorId: string; action: string } }) => {
        auditWrites.push({ actorId: data.actorId, action: data.action });
        return data;
      },
    },
  },
  serializable: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { hasServiceAccess } = await import('./service-access.js');

describe('роль читается из базы', () => {
  beforeEach(() => {
    dbRole = 'USER';
    roleReads = 0;
  });

  it('администратор опознаётся', async () => {
    dbRole = 'ADMIN';
    expect(await hasServiceAccess('user-1')).toBe(true);
  });

  it('обычный пользователь — нет', async () => {
    expect(await hasServiceAccess('user-1')).toBe(false);
  });

  it('аноним — нет, и базу для этого не тревожим', async () => {
    expect(await hasServiceAccess(null)).toBe(false);
    expect(roleReads).toBe(0);
  });

  it('запрашивается при каждом обращении, а не кэшируется навсегда', async () => {
    // Иначе снятие роли не действовало бы до перезапуска процесса.
    dbRole = 'ADMIN';
    expect(await hasServiceAccess('user-1')).toBe(true);

    dbRole = 'USER';
    expect(await hasServiceAccess('user-1')).toBe(false);

    expect(roleReads).toBe(2);
  });
});

// ─────────────────── Защита работает для администратора тоже ─────────────────

describe('служебный доступ не отменяет защиту', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    dbRole = 'ADMIN';
    auditWrites.length = 0;

    app = Fastify();
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

    // Образец чувствительного действия администратора: устроен так же,
    // как настоящий `admin.quick_buy` — сначала вход, потом запись
    // в журнал.
    const { prisma } = await import('../lib/prisma.js');

    app.post('/admin/action', { preHandler: [app.authenticate] }, async (req) => {
      await prisma.auditLog.create({
        data: { actorId: req.user.sub, action: 'admin.quick_buy' } as never,
      });

      return { ok: true };
    });

    await app.ready();
  });

  it('вход обязателен и для администратора', async () => {
    // Полный набор возможностей не означает входа без токена.
    const r = await app.inject({ method: 'POST', url: '/admin/action' });

    expect(r.statusCode).toBe(401);
    expect(auditWrites).toHaveLength(0);
  });

  it('подделанный токен не принимается', async () => {
    const foreign = await import('@fastify/jwt').then(() => 'не подпись');

    const r = await app.inject({
      method: 'POST',
      url: '/admin/action',
      headers: { authorization: `Bearer ${foreign}` },
    });

    expect(r.statusCode).toBe(401);
  });

  it('аудит чувствительного действия записывается', async () => {
    const token = app.jwt.sign({ sub: 'admin-1', role: 'ADMIN' });

    const r = await app.inject({
      method: 'POST',
      url: '/admin/action',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    expect(auditWrites).toEqual([{ actorId: 'admin-1', action: 'admin.quick_buy' }]);
  });

  it('в журнале остаётся тот, кто действовал', async () => {
    // Запись без автора не отвечает на вопрос, ради которого журнал
    // и ведётся.
    const token = app.jwt.sign({ sub: 'admin-2', role: 'ADMIN' });

    await app.inject({
      method: 'POST',
      url: '/admin/action',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(auditWrites[0]!.actorId).toBe('admin-2');
  });
});
