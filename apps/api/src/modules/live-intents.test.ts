import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { readFileSync } from 'node:fs';

/**
 * Маршруты предложений и намерений.
 *
 * Проверяется граница, а не вёрстка ответа: что человек вправе
 * прислать, что он вправе увидеть и сколько решений получается из
 * двух одинаковых запросов.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

interface ProposalRow {
  id: string;
  userId: string;
  status: string;
  network: string;
  assetAddress: string;
  assetSymbol: string;
  amountUsd: string;
  estimatedNetworkFeeUsd: string | null;
  estimatedPlatformFeeUsd: string | null;
  priceImpactBps: number | null;
  riskSnapshot: unknown;
  expiresAt: Date;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
}

let proposals: Map<string, ProposalRow>;
let intents: Array<Record<string, unknown>>;
let idempotency: Map<string, { userId: string; response: unknown }>;
let audit: Array<Record<string, unknown>>;
let users: Map<string, { role: string }>;
let latch: string;

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    user: { findUnique: async (a: any) => users.get(a.where.id) ?? null },
    fundingSafetyLatch: { findUnique: async () => ({ state: latch }) },
    liveAgentProposal: {
      findUnique: async (a: any) => proposals.get(a.where.id) ?? null,
      findMany: async (a: any) =>
        [...proposals.values()].filter((p) => p.userId === a.where.userId),
      updateMany: async (a: any) => {
        const row = proposals.get(a.where.id);
        // Состояние в условии: параллельные запросы иначе оба победят.
        if (!row || !a.where.status.in.includes(row.status)) return { count: 0 };
        Object.assign(row, a.data);
        return { count: 1 };
      },
    },
    transactionIntent: {
      create: async (a: any) => {
        const row = { id: `intent-${intents.length + 1}`, ...a.data };
        intents.push(row);
        return { id: row.id };
      },
      findMany: async (a: any) => intents.filter((i) => i.userId === a.where.userId),
      findUnique: async (a: any) => intents.find((i) => i.id === a.where.id) ?? null,
    },
    wallet: {
      findFirst: async () => ({ id: 'wallet-1', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }),
    },
    idempotencyKey: {
      findUnique: async (a: any) => idempotency.get(a.where.key) ?? null,
      create: async (a: any) => {
        if (idempotency.has(a.data.key)) throw new Error('duplicate');
        idempotency.set(a.data.key, { userId: a.data.userId, response: a.data.response });
        return a.data;
      },
    },
    auditLog: { create: async (a: any) => { audit.push(a.data); return a.data; } },
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

vi.mock('../services/entitlement.js', () => ({
  entitlementOfRequest: async () => ({ capabilities: ['MANUAL_TRADE'] }),
  denyIfMissing: () => false,
}));

/**
 * Сеть подделывается, а не отключается.
 *
 * Настоящая фабрика читает окружение и в тестовом возвращает `null`:
 * без узла подтверждение отказывает. Это верное поведение, но
 * проверять на нём границу маршрутов нельзя — все решения свелись бы
 * к одному отказу, и правила владения, идемпотентности и запрещённых
 * полей остались бы непроверенными.
 *
 * Переключатель `blockhashAvailable` оставлен: отказ при отсутствии
 * сети проверяется отдельным тестом ниже.
 */
let blockhashAvailable: boolean;
vi.mock('../services/signer-factory.js', () => ({
  createBlockhashSource: () =>
    blockhashAvailable
      ? async () => ({
          blockhash: 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1X',
          lastValidBlockHeight: '284000000',
          network: 'devnet',
        })
      : null,
  blockhashProvider: () => null,
}));

const { liveIntentRoutes } = await import('./live-intents.js');
const { sendError } = await import('../lib/error-handler.js');
const { proposalFingerprint } = await import('../services/intent-source.js');

let app: FastifyInstance;

const proposal = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: 'p1',
  userId: 'user-1',
  status: 'CREATED',
  network: 'SOLANA',
  assetAddress: 'So11111111111111111111111111111111111111112',
  assetSymbol: 'BONK',
  amountUsd: '25',
  estimatedNetworkFeeUsd: '0.02',
  estimatedPlatformFeeUsd: '0.10',
  priceImpactBps: 50,
  riskSnapshot: { level: 'MEDIUM', strategy: 'baseline', reason: 'сигнал' },
  expiresAt: new Date(Date.now() + 600_000),
  confirmedAt: null,
  rejectedAt: null,
  ...over,
});

beforeEach(async () => {
  proposals = new Map([['p1', proposal()]]);
  intents = [];
  idempotency = new Map();
  audit = [];
  users = new Map([['user-1', { role: 'USER' }], ['admin-1', { role: 'ADMIN' }]]);
  latch = 'HEALTHY';
  blockhashAvailable = true;

  app = Fastify();
  await app.register(jwt, { secret: SECRET });
  app.decorate('authenticate', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Требуется авторизация' });
    }
  });
  app.decorate('requireAdmin', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Требуется авторизация' });
    }
    // Роль из базы, а не из токена.
    if (users.get(req.user.sub)?.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Недостаточно прав' });
    }
  });
  /*
   * Тот же обработчик ошибок, что и у боевого сервера.
   *
   * Без него `ZodError` доходит до общего обработчика Fastify, и
   * тест видит 500 там, где продукт отвечает 400: проверялась бы
   * не защита, а конфигурация тестового приложения.
   */
  app.setErrorHandler(sendError);
  await app.register(liveIntentRoutes);
  await app.ready();
});

const token = (sub: string, role: 'USER' | 'ADMIN' = 'USER') => app.jwt.sign({ sub, role });

const decide = (
  body: Record<string, unknown>,
  sub = 'user-1',
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url: '/live/proposals/p1/decide',
    headers: { authorization: `Bearer ${token(sub)}`, ...headers },
    payload: body,
  });

const fingerprint = () => proposalFingerprint(proposals.get('p1')!);

const confirmBody = () => ({ decision: 'CONFIRM', shownFingerprint: fingerprint() });

// ═══════════════════════ Владение и видимость ════════════════════════════════

describe('чужое не видно и не отличимо от несуществующего', () => {
  it('чужое предложение — 404', async () => {
    const res = await app.inject({
      method: 'GET', url: '/live/proposals/p1',
      headers: { authorization: `Bearer ${token('user-2')}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('несуществующее — тот же ответ', async () => {
    const missing = await app.inject({
      method: 'GET', url: '/live/proposals/нет-такого',
      headers: { authorization: `Bearer ${token('user-1')}` },
    });
    const foreign = await app.inject({
      method: 'GET', url: '/live/proposals/p1',
      headers: { authorization: `Bearer ${token('user-2')}` },
    });
    // Разные коды позволили бы перебором выяснить чужие предложения.
    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.json()).toEqual(foreign.json());
  });

  it('список содержит только свои', async () => {
    proposals.set('p2', proposal({ id: 'p2', userId: 'user-2' }));
    const res = await app.inject({
      method: 'GET', url: '/live/proposals',
      headers: { authorization: `Bearer ${token('user-1')}` },
    });
    expect(res.json().proposals.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('подтверждение чужого — 404, а не 403', async () => {
    const res = await decide(confirmBody(), 'user-2');
    expect(res.statusCode).toBe(404);
    expect(proposals.get('p1')!.status).toBe('CREATED');
  });

  it('без токена — отказ', async () => {
    const res = await app.inject({
      method: 'POST', url: '/live/proposals/p1/decide', payload: confirmBody(),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ═══════════════════════ Клиент не передаёт деньги ═══════════════════════════

describe('денежные поля от клиента', () => {
  it('сумма в теле отвергается с названием поля', async () => {
    const res = await decide({ ...confirmBody(), rawAmount: '999999' });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FORBIDDEN_FIELDS');
    expect(res.json().fields).toContain('rawAmount');
  });

  it('получатель в теле отвергается', async () => {
    const res = await decide({ ...confirmBody(), destinationAddress: 'чужой-адрес' });
    expect(res.json().fields).toContain('destinationAddress');
  });

  it('готовая транзакция отвергается', async () => {
    const res = await decide({ ...confirmBody(), transaction: 'base64…', instructions: [] });
    expect(res.json().fields).toEqual(expect.arrayContaining(['transaction', 'instructions']));
  });

  it('подмена владельца отвергается', async () => {
    const res = await decide({ ...confirmBody(), userId: 'admin-1', walletId: 'w9' });
    expect(res.json().fields).toEqual(expect.arrayContaining(['userId', 'walletId']));
  });

  it('подмена версии политики и ключа отвергается', async () => {
    const res = await decide({ ...confirmBody(), policyVersion: 'x', keyVersion: '9' });
    expect(res.json().fields).toEqual(expect.arrayContaining(['policyVersion', 'keyVersion']));
  });

  it('неизвестное поле не игнорируется молча', async () => {
    // Молчаливое игнорирование хуже отказа: отправитель считает,
    // что его учли.
    const res = await decide({ ...confirmBody(), somethingNew: true });
    expect(res.statusCode).toBe(400);
  });

  it('ничего из отвергнутого не попадает в базу', async () => {
    await decide({ ...confirmBody(), rawAmount: '999999' });
    expect(intents).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});

// ═══════════════════════ Решение и его последствия ═══════════════════════════

describe('решение человека', () => {
  it('подтверждение создаёт намерение', async () => {
    const res = await decide(confirmBody());

    expect(res.statusCode).toBe(200);
    expect(res.json().intentId).toBeTruthy();
    expect(proposals.get('p1')!.status).toBe('CONFIRMED');
  });

  it('ответ прямо говорит, что ничего не отправлено', async () => {
    const res = await decide(confirmBody());
    expect(res.json().submitted).toBe(false);
    expect(res.json().warning).toContain('не отправляет транзакцию');
  });

  it('намерение создаётся одобренным и из предложения', async () => {
    await decide(confirmBody());
    expect(intents[0]).toMatchObject({
      state: 'APPROVED', origin: 'AGENT_PROPOSAL', proposalId: 'p1',
    });
  });

  it('отклонение не создаёт намерения', async () => {
    const res = await decide({ decision: 'REJECT', shownFingerprint: fingerprint() });

    expect(res.json().status).toBe('rejected');
    expect(intents).toHaveLength(0);
    expect(proposals.get('p1')!.status).toBe('REJECTED');
  });

  it('изменённое предложение подтвердить нельзя', async () => {
    const stale = fingerprint();
    proposals.get('p1')!.amountUsd = '9999';

    const res = await decide({ decision: 'CONFIRM', shownFingerprint: stale });

    // Человек соглашался на то, что видел.
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PROPOSAL_CHANGED');
    expect(intents).toHaveLength(0);
  });

  it('истёкшее предложение подтвердить нельзя', async () => {
    proposals.get('p1')!.expiresAt = new Date(Date.now() - 1_000);
    const res = await decide(confirmBody());

    expect(res.json().code).toBe('PROPOSAL_EXPIRED');
  });

  it('поднятая защёлка останавливает подтверждение', async () => {
    latch = 'PAUSED';
    const res = await decide(confirmBody());

    expect(res.json().code).toBe('SAFETY_LATCH_RAISED');
    expect(intents).toHaveLength(0);
  });
});

// ═══════════════════════ Идемпотентность и гонки ═════════════════════════════

describe('идемпотентность', () => {
  it('повтор с тем же ключом возвращает тот же ответ', async () => {
    const headers = { 'idempotency-key': 'key-1' };
    const first = await decide(confirmBody(), 'user-1', headers);
    const second = await decide(confirmBody(), 'user-1', headers);

    expect(second.json().intentId).toBe(first.json().intentId);
    // Повтор — норма. Второе намерение нормой не является.
    expect(intents).toHaveLength(1);
  });

  it('тот же ключ с другим телом отвергается', async () => {
    const headers = { 'idempotency-key': 'key-1' };
    await decide(confirmBody(), 'user-1', headers);
    const other = await decide(
      { decision: 'REJECT', shownFingerprint: fingerprint() }, 'user-1', headers,
    );

    // Отдать другому запросу чужой ответ значит подтвердить не то,
    // что просили.
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('чужой ключ не отдаёт чужой ответ', async () => {
    const headers = { 'idempotency-key': 'key-1' };
    await decide(confirmBody(), 'user-1', headers);
    proposals.set('p1', proposal());

    const foreign = await decide(confirmBody(), 'user-2', headers);
    expect(foreign.statusCode).toBe(409);
  });

  it('подтверждение и отклонение одновременно — побеждает один', async () => {
    const [a, b] = await Promise.all([
      decide(confirmBody()),
      decide({ decision: 'REJECT', shownFingerprint: fingerprint() }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(['CONFIRMED', 'REJECTED']).toContain(proposals.get('p1')!.status);
  });

  it('одно предложение не порождает два намерения', async () => {
    await Promise.all([decide(confirmBody()), decide(confirmBody())]);
    expect(intents).toHaveLength(1);
  });

  it('уже решённое не решается второй раз', async () => {
    await decide(confirmBody());
    const again = await decide(confirmBody());

    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_DECIDED');
  });
});

// ═══════════════════════ Служебная фикстура ══════════════════════════════════

describe('служебная проверочная запись', () => {
  const fixture = (sub: string) =>
    app.inject({
      method: 'POST', url: '/admin/live/fixture-intent',
      headers: { authorization: `Bearer ${token(sub)}` },
      payload: { userId: 'user-1' },
    });

  it('обычному пользователю недоступна', async () => {
    expect((await fixture('user-1')).statusCode).toBe(403);
  });

  it('роль из токена прав не даёт', async () => {
    const forged = app.jwt.sign({ sub: 'user-1', role: 'ADMIN' });
    const res = await app.inject({
      method: 'POST', url: '/admin/live/fixture-intent',
      headers: { authorization: `Bearer ${forged}` },
      payload: { userId: 'user-1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('администратору доступна вне production', async () => {
    const res = await fixture('admin-1');
    expect(res.statusCode).toBe(201);
    expect(res.json().submitted).toBe(false);
  });

  it('создаёт черновик, а не одобренное намерение', async () => {
    await fixture('admin-1');
    // Одобрение — действие человека, и подделывать его служебным
    // путём нельзя.
    expect(intents[0]).toMatchObject({ state: 'DRAFT', origin: 'ADMIN_DEVNET_FIXTURE' });
  });

  it('лишнее поле в теле отвергается', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/live/fixture-intent',
      headers: { authorization: `Bearer ${token('admin-1')}` },
      payload: { userId: 'user-1', rawAmount: '999' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════ Что не выходит наружу ═══════════════════════════════

describe('границы ответа', () => {
  it('намерение не отдаёт ни подписи, ни сообщения', async () => {
    await decide(confirmBody());
    const res = await app.inject({
      method: 'GET', url: `/live/intents/${intents[0]!.id}`,
      headers: { authorization: `Bearer ${token('user-1')}` },
    });

    const body = res.json();
    expect(body.signature).toBeUndefined();
    expect(body.messageHash).toBeUndefined();
    expect(body.recentBlockhash).toBeUndefined();
    expect(body.submitted).toBe(false);
  });

  it('наружу идёт стадия, а не внутреннее состояние', async () => {
    await decide(confirmBody());
    const res = await app.inject({
      method: 'GET', url: '/live/intents',
      headers: { authorization: `Bearer ${token('user-1')}` },
    });
    expect(res.json().intents[0].stage).toBe('SIGNING');
    expect(res.json().intents[0].state).toBeUndefined();
  });

  it('чужое намерение недоступно', async () => {
    await decide(confirmBody());
    const res = await app.inject({
      method: 'GET', url: `/live/intents/${intents[0]!.id}`,
      headers: { authorization: `Bearer ${token('user-2')}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('в модуле нет ни отправки, ни приватного ключа', () => {
    const source = readFileSync(new URL('./live-intents.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(
      /sendTransaction|sendRawTransaction|broadcast|submitTransaction|privateKey|secretKey/i,
    );
  });
});

// ═════════════════════════ Blockhash: Phase 4F ═══════════════════════════════

describe('blockhash приходит только от сервера', () => {
  it('без сети подтверждение отказывает, а не создаёт заглушку', async () => {
    blockhashAvailable = false;

    const res = await decide(confirmBody());

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('BLOCKHASH_UNAVAILABLE');
    // Главное: намерения не появилось. Отказ, а не запись «на потом».
    expect(intents).toHaveLength(0);
  });

  it('отказ не тратит предложение', async () => {
    blockhashAvailable = false;
    await decide(confirmBody());

    /*
     * Состояние не изменилось — повтор после починки сети работает.
     *
     * Иначе сетевой сбой сжигал бы предложение человека: он нажал
     * «подтвердить», получил ошибку и больше подтвердить не может.
     */
    expect(proposals.get('p1')!.status).toBe('CREATED');

    blockhashAvailable = true;
    const retry = await decide(confirmBody());
    expect(retry.statusCode).toBe(200);
    expect(intents).toHaveLength(1);
  });

  it('в намерение попадает значение из сети, а не тридцать две единицы', async () => {
    await decide(confirmBody());

    const intent = intents[0]!;
    expect(intent.recentBlockhash).toBe('GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1X');
    expect(intent.lastValidBlockHeight).toBe('284000000');
    // Высота строкой: значение растёт за пределы точного целого в JS.
    expect(typeof intent.lastValidBlockHeight).toBe('string');
  });

  it('blockhash из тела запроса отвергается, а не подставляется', async () => {
    const res = await decide({
      ...confirmBody(),
      recentBlockhash: 'ЧужойBlockhashИзБраузера',
      lastValidBlockHeight: '999999999',
    });

    // Схема `.strict()`: поле не игнорируется молча, а отвергается.
    expect(res.statusCode).toBe(400);
    expect(intents).toHaveLength(0);
  });

  it('заглушки нет в исходнике источника намерений', () => {
    const source = readFileSync(
      new URL('../services/intent-source.ts', import.meta.url), 'utf8',
    );
    /*
     * Проверяется исходник целиком, включая комментарии.
     *
     * Заглушка, оставленная «на всякий случай» в закомментированном
     * коде, возвращается в строй одним снятием слэшей.
     */
    expect(source).not.toContain('1'.repeat(32));
  });

  it('маршрут не читает blockhash из запроса', () => {
    const source = readFileSync(new URL('./live-intents.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/(body|req)\.[a-zA-Z]*[Bb]lockhash/);
    expect(source).not.toMatch(/(body|req)\.lastValidBlockHeight/);
    // Источник ровно один — фабрика.
    expect(source).toContain('createBlockhashSource()');
  });
});
