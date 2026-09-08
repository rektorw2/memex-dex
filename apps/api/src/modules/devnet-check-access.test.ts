import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Кто может запустить проверку узла devnet.
 *
 * Проверка сама по себе безобидна — она только читает сеть. Опасно
 * другое: её результат поднимает ступень готовности LIVE. Поэтому
 * вопрос здесь не «работает ли кнопка», а кто способен её нажать и
 * что при этом остаётся в журнале.
 *
 * Роль читается из базы. Токен — подписанный, но устаревающий снимок:
 * пользователь мог быть разжалован час назад, а токен ещё живёт.
 *
 * Второй вопрос раздела — откуда берётся адрес узла. Ответ: только с
 * сервера. Если бы клиент мог прислать URL, ступень готовности
 * поднималась бы проверкой чужого узла, то есть запросом.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

let users: Map<string, { role: string }>;
/** Аргументы, с которыми вызвали службу. Ни одного — значит не вызывали. */
let checks: Array<Record<string, unknown>>;

const snapshot = {
  state: 'VERIFIED',
  code: 'VERIFIED',
  verified: true,
  stale: false,
  checkInProgress: false,
  verifiedAt: '2026-09-05T10:00:00.000Z',
  expiresAt: '2026-09-05T10:30:00.000Z',
  checkedAt: '2026-09-05T10:00:00.000Z',
  failureCode: null,
  methods: ['getHealth', 'getGenesisHash', 'getSlot', 'getSignaturesForAddress'],
  maxLatencyMs: 42,
  formatVersion: 1,
};

vi.mock('../services/devnet-network-proof.js', () => ({
  readDevnetProof: async () => snapshot,
  verifyDevnetNetwork: async (request: Record<string, unknown>) => {
    checks.push(request);
    return { ok: true, snapshot };
  },
}));

const { verifyDevnetNetwork } = await import('../services/devnet-network-proof.js');

let app: FastifyInstance;

/**
 * Тот же обработчик прав, что и у боевого сервера: роль читается из
 * базы, а не из полезной нагрузки токена. Совпадение с production
 * отдельно проверяется контрактом в конце файла.
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
  users = new Map([
    ['admin-1', { role: 'ADMIN' }],
    ['user-1', { role: 'USER' }],
  ]);
  checks = [];

  app = Fastify();
  await app.register(jwt, { secret: SECRET });

  app.post('/admin/live/devnet-network/check', { preHandler: [requireAdmin] }, async (req: any) => {
    /*
     * Тело запроса не читается вовсе — ни здесь, ни в production.
     * Адрес узла служба берёт из конфигурации сервера.
     */
    const outcome = await verifyDevnetNetwork({ actorId: req.user.sub, ip: req.ip });
    return { ok: outcome.ok, rpc: outcome.snapshot };
  });

  await app.ready();
});

const tokenFor = (sub: string, role: 'USER' | 'ADMIN' | 'TRADER' = 'USER') =>
  app.jwt.sign({ sub, role });

const run = (token: string | null, body: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/admin/live/devnet-network/check',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });

describe('проверку запускает только администратор', () => {
  it('администратор запускает', async () => {
    const res = await run(tokenFor('admin-1', 'ADMIN'));

    expect(res.statusCode).toBe(200);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ actorId: 'admin-1' });
  });

  it('обычный пользователь получает отказ и проверка не запускается', async () => {
    const res = await run(tokenFor('user-1'));

    expect(res.statusCode).toBe(403);
    expect(checks, 'к узлу не обращались').toHaveLength(0);
  });

  it('роль в токене не даёт прав', async () => {
    // Токен подписан нами, но роль в нём — снимок. Разжалование
    // должно действовать сразу, а не после истечения токена.
    const res = await run(tokenFor('user-1', 'ADMIN'));

    expect(res.statusCode).toBe(403);
    expect(checks).toHaveLength(0);
  });

  it('отзыв прав действует немедленно', async () => {
    const token = tokenFor('admin-1', 'ADMIN');
    users.set('admin-1', { role: 'USER' });

    expect((await run(token)).statusCode).toBe(403);
    expect(checks).toHaveLength(0);
  });

  it('без токена — отказ', async () => {
    expect((await run(null)).statusCode).toBe(401);
    expect(checks).toHaveLength(0);
  });

  it('роль в теле запроса игнорируется', async () => {
    const res = await run(tokenFor('user-1'), { role: 'ADMIN', isAdmin: true });

    expect(res.statusCode).toBe(403);
    expect(checks).toHaveLength(0);
  });
});

describe('адрес узла приходит только с сервера', () => {
  it('присланный клиентом URL не попадает в проверку', async () => {
    /*
     * Главный тест раздела. Проверка чужого узла, записанная как
     * своя, подняла бы ступень готовности LIVE одним запросом.
     */
    await run(tokenFor('admin-1', 'ADMIN'), {
      endpoint: 'https://злоумышленник.invalid/rpc',
      url: 'https://злоумышленник.invalid/rpc',
      rpcUrl: 'https://злоумышленник.invalid/rpc',
    });

    expect(checks).toHaveLength(1);
    const serialized = JSON.stringify(checks[0]);
    expect(serialized).not.toContain('злоумышленник');
    expect(Object.keys(checks[0]!).sort()).toEqual(['actorId', 'ip']);
  });

  it('ответ не содержит ни адреса, ни отпечатка настройки', async () => {
    const res = await run(tokenFor('admin-1', 'ADMIN'));

    expect(res.body).not.toMatch(/https?:\/\//);
    expect(res.body).not.toContain('endpointFingerprint');
    expect(res.body).not.toContain('api-key');
  });
});

describe('боевой маршрут защищён тем же правилом', () => {
  /**
   * Тест выше проверяет копию обработчика, поэтому нужен второй,
   * который смотрит на настоящий файл. Слабый сам по себе — он не
   * проверяет поведение, — но ловит ровно тот случай, ради которого
   * написан: маршрут добавили, а `requireAdmin` забыли.
   */
  const source = readFileSync(new URL('./admin.ts', import.meta.url), 'utf8')
    // Комментарии вырезаются: иначе проверка обвиняла бы собственное
    // объяснение рядом с маршрутом.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('оба маршрута проверки сети требуют администратора', () => {
    for (const route of ['/admin/live/devnet-network', '/admin/live/devnet-network/check']) {
      const line = source
        .split('\n')
        .find((row) => row.includes(`'${route}'`));

      expect(line, `маршрут ${route} найден`).toBeTruthy();
      expect(line, `маршрут ${route} без requireAdmin`).toContain('app.requireAdmin');
    }
  });

  it('обработчик не разбирает тело запроса', () => {
    /*
     * `req.body` в этом маршруте не читается вовсе — ни через zod,
     * ни напрямую. Появление разбора тела означало бы, что клиент
     * снова может на что-то влиять.
     */
    /*
     * Границей взят следующий маршрут, а не комментарий: комментарии
     * из текста вырезаны выше, и опираться на них здесь значило бы
     * искать то, чего в разбираемой строке уже нет.
     */
    const from = source.indexOf("'/admin/live/devnet-network/check'");
    const to = source.indexOf("'/admin/funding/latch/clear'");

    expect(from, 'маршрут проверки найден').toBeGreaterThan(-1);
    expect(to, 'следующий маршрут найден').toBeGreaterThan(from);

    const handler = source.slice(from, to);

    expect(handler).not.toContain('req.body');
    expect(handler).not.toContain('parse(');
  });
});
