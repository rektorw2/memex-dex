import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Снятие защёлки контура пополнений.
 *
 * Защёлка — единственное, что стоит между расхождением и продолжением
 * автоматических зачислений. Поэтому проверяется не «работает ли
 * кнопка», а кто именно способен её нажать и остаётся ли след.
 *
 * Роль читается из базы. Токен — подписанный, но устаревающий снимок:
 * пользователь мог быть разжалован час назад, а его токен ещё живёт.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

interface LatchRow {
  id: string;
  state: string;
  reasonKind: string | null;
  eventKey: string | null;
  clearedAt: Date | null;
  clearedBy: string | null;
}

let latch: LatchRow | null;
let users: Map<string, { role: string }>;
let auditLog: Array<Record<string, unknown>>;

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    user: {
      findUnique: async (args: any) => users.get(args.where.id) ?? null,
    },
    fundingSafetyLatch: {
      findUnique: async () => latch,
      update: async (args: any) => {
        latch = { ...latch!, ...args.data };
        return latch;
      },
      upsert: async () => latch,
    },
    auditLog: {
      create: async (args: any) => {
        auditLog.push(args.data);
        return args.data;
      },
    },
    $transaction: async <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };
  return {
    prisma,
    serializable: async <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
    prismaWasInstantiated: () => true,
  };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { clearFundingSafetyLatch, readFundingSafetyState, safetyOf } =
  await import('../services/prisma-solana-reconciliation-repository.js');

let app: FastifyInstance;

/**
 * Тот же обработчик прав, что и у боевого сервера: роль читается
 * из базы, а не из полезной нагрузки токена.
 */
async function requireAdmin(req: any, reply: any) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Требуется авторизация' });
  }
  const actor = users.get(req.user.sub);
  if (actor?.role !== 'ADMIN') return reply.code(403).send({ error: 'Недостаточно прав' });
}

beforeEach(async () => {
  latch = {
    id: 'solana-funding-v1',
    state: 'PAUSED',
    reasonKind: 'AMOUNT_MISMATCH',
    eventKey: 'sig-1:0',
    clearedAt: null,
    clearedBy: null,
  };
  users = new Map([
    ['admin-1', { role: 'ADMIN' }],
    ['user-1', { role: 'USER' }],
  ]);
  auditLog = [];

  app = Fastify();
  await app.register(jwt, { secret: SECRET });
  app.decorate('requireAdmin', requireAdmin);

  app.post('/admin/funding/latch/clear', { preHandler: [requireAdmin] }, async (req: any, reply) => {
    const reason = String(req.body?.reason ?? '');
    if (reason.trim().length < 10) {
      return reply.code(400).send({ error: 'Нужна причина' });
    }
    const outcome = await clearFundingSafetyLatch({
      actorId: req.user.sub,
      reason,
      ip: req.ip,
    });
    if (outcome === 'already-healthy') {
      return reply.code(409).send({ code: 'LATCH_NOT_RAISED' });
    }
    return { ok: true, state: 'HEALTHY' };
  });

  await app.ready();
});

const tokenFor = (sub: string, role: 'USER' | 'ADMIN' | 'TRADER' = 'USER') =>
  app.jwt.sign({ sub, role });

const clear = (
  token: string | null,
  body: Record<string, unknown> = { reason: 'разобрались вручную' },
) =>
  app.inject({
    method: 'POST',
    url: '/admin/funding/latch/clear',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });

// ─────────────────────────── Кто может снять ─────────────────────────────────

describe('снять защёлку может только администратор', () => {
  it('администратор снимает', async () => {
    const res = await clear(tokenFor('admin-1', 'ADMIN'));

    expect(res.statusCode).toBe(200);
    expect(await readFundingSafetyState()).toBe('HEALTHY');
  });

  it('обычный пользователь получает отказ', async () => {
    const res = await clear(tokenFor('user-1'));

    expect(res.statusCode).toBe(403);
    expect(await readFundingSafetyState()).toBe('PAUSED');
  });

  it('роль в токене не даёт прав', async () => {
    // Токен подписан нами, но роль в нём — снимок. Разжалование
    // должно действовать сразу, а не после истечения токена.
    const res = await clear(tokenFor('user-1', 'ADMIN'));

    expect(res.statusCode).toBe(403);
    expect(await readFundingSafetyState()).toBe('PAUSED');
  });

  it('отзыв прав действует немедленно', async () => {
    const token = tokenFor('admin-1', 'ADMIN');
    users.set('admin-1', { role: 'USER' });

    expect((await clear(token)).statusCode).toBe(403);
  });

  it('без токена — отказ', async () => {
    expect((await clear(null)).statusCode).toBe(401);
  });

  it('роль в теле запроса игнорируется', async () => {
    const res = await clear(tokenFor('user-1'), {
      reason: 'разобрались вручную',
      role: 'ADMIN',
      isAdmin: true,
    });

    expect(res.statusCode).toBe(403);
  });

  it('роль в заголовке игнорируется', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/funding/latch/clear',
      headers: {
        authorization: `Bearer ${tokenFor('user-1')}`,
        'x-role': 'ADMIN',
        'x-user-role': 'ADMIN',
      },
      payload: { reason: 'разобрались вручную' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('роль в query игнорируется', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/funding/latch/clear?role=ADMIN',
      headers: { authorization: `Bearer ${tokenFor('user-1')}` },
      payload: { reason: 'разобрались вручную' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('неизвестный пользователь с валидной подписью не проходит', async () => {
    expect((await clear(tokenFor('нет-такого', 'ADMIN'))).statusCode).toBe(403);
  });
});

// ─────────────────────────────── Аудит ───────────────────────────────────────

describe('след в журнале', () => {
  it('снятие записывается', async () => {
    await clear(tokenFor('admin-1', 'ADMIN'));

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe('FUNDING_SAFETY_LATCH_CLEARED');
    expect(auditLog[0]!.actorId).toBe('admin-1');
  });

  it('снимаемое состояние сохраняется', async () => {
    await clear(tokenFor('admin-1', 'ADMIN'));

    // Иначе через месяц нельзя понять, что именно человек счёл
    // разобранным.
    expect(auditLog[0]!.before).toMatchObject({
      state: 'PAUSED',
      reasonKind: 'AMOUNT_MISMATCH',
    });
  });

  it('причина обязательна', async () => {
    const res = await clear(tokenFor('admin-1', 'ADMIN'), { reason: 'ок' });

    expect(res.statusCode).toBe(400);
    expect(auditLog).toHaveLength(0);
    expect(await readFundingSafetyState()).toBe('PAUSED');
  });

  it('отказ ничего не пишет в журнал', async () => {
    await clear(tokenFor('user-1'));

    expect(auditLog).toHaveLength(0);
  });

  it('повторное снятие не меняет уже здоровое состояние', async () => {
    await clear(tokenFor('admin-1', 'ADMIN'));
    const second = await clear(tokenFor('admin-1', 'ADMIN'));

    expect(second.statusCode).toBe(409);
    expect(auditLog).toHaveLength(1);
  });
});

// ──────────────────────── Состояние переживает всё ───────────────────────────

describe('состояние защёлки', () => {
  it('после перезапуска процесса остаётся поднятым', async () => {
    // Строка в базе, а не поле в памяти: перезапуск не является
    // разбором расхождения.
    latch = { ...latch!, state: 'REVIEW_REQUIRED' };

    expect(await readFundingSafetyState()).toBe('REVIEW_REQUIRED');
  });

  it('незнакомое значение в колонке не считается здоровьем', () => {
    // Колонка текстовая: опечатка при ручной правке не должна
    // открывать денежный контур.
    expect(safetyOf('НЕИЗВЕСТНО')).toBe('REVIEW_REQUIRED');
    expect(safetyOf('healthy')).toBe('REVIEW_REQUIRED');
  });

  it('пустая строка защёлки означает здоровье', async () => {
    latch = null;

    expect(await readFundingSafetyState()).toBe('HEALTHY');
  });

  it('DEGRADED не блокирует, PAUSED и REVIEW_REQUIRED блокируют', async () => {
    const { allowsAutomaticCredit } = await import('@memex/core');

    expect(allowsAutomaticCredit('DEGRADED')).toBe(true);
    expect(allowsAutomaticCredit('PAUSED')).toBe(false);
    expect(allowsAutomaticCredit('REVIEW_REQUIRED')).toBe(false);
  });
});
