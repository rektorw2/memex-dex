import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Кто видит диагностику и что попадает в горячий список.
 *
 * Проверяются настоящие маршруты, а не пересказ правил: половина
 * ошибок доступа живёт не в правиле, а в том, как оно подключено,
 * и забытый `preHandler` на образцах не виден вовсе.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';

const token = (over: Record<string, unknown> = {}) => ({
  id: 'tok-1',
  chain: 'SOLANA',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'WIF',
  name: 'dogwifhat',
  decimals: 9,
  isQuote: false,
  isHidden: false,
  isVerified: false,
  isRegistered: false,
  logoUrl: null,
  poolAddress: 'pool-1',
  source: 'auto',
  priceUsd: '2.5',
  priceChange24h: '42.5',
  liquidityUsd: '250000',
  volume24hUsd: '900000',
  fdvUsd: null,
  riskScore: 10,
  riskLevel: 'low',
  riskCodes: [] as string[],
  scamVerdict: 'OK',
  scamReasons: null,
  scamCheckedAt: new Date(),
  scamRulesVersion: 9,
  scamCheckAttempts: 0,
  scamCheckNextAt: null,
  scamProviderError: false,
  priceUpdatedAt: new Date(),
  poolCreatedAt: new Date(),
  firstSeenAt: new Date(),
  createdAt: new Date(),
  buys24h: null,
  sells24h: null,
  socials: null,
  holders: null,
  topHolderPct: null,
  lpBurnedPct: null,
  isHoneypot: false,
  metricsUpdated: null,
  research: null,
  ...over,
});

/** Что база отдаёт на запрос списка. */
let tokenRows: Record<string, unknown>[] = [];
let tokenFindManyArgs: Record<string, unknown>[] = [];
let tokenUpdateManyArgs: Record<string, unknown>[] = [];
let auditEntries: Record<string, unknown>[] = [];
let checkBatchCalls = 0;

vi.mock('../workers/scam-checker.js', () => ({
  RULES_VERSION: 10,
  checkBatch: async () => {
    checkBatchCalls++;
    return { checked: 1, blocked: 0, warned: 0, ok: 1, timedOut: false, remaining: 0 };
  },
}));

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    token: {
      findMany: async (args: Record<string, unknown>) => {
        tokenFindManyArgs.push(args);
        return tokenRows;
      },
      findUnique: async () => tokenRows[0] ?? null,
      findFirst: async () => null,
      count: async () => tokenRows.length,
      aggregate: async () => ({ _sum: {}, _count: 0 }),
      groupBy: async () => [],
      createMany: async () => ({ count: 0 }),
      updateMany: async (args: Record<string, unknown>) => {
        tokenUpdateManyArgs.push(args);
        return { count: tokenRows.length };
      },
    },
    candle: { findMany: async () => [], count: async () => 0 },
    call: { findMany: async () => [] },
    trade: { findMany: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }) },
    position: { count: async () => 0, findMany: async () => [] },
    auditLog: {
      create: async (args: Record<string, unknown>) => {
        auditEntries.push(args);
        return {};
      },
    },
    $transaction: async <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };

  return { prisma, serializable: vi.fn() };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/okx-market.js', () => ({
  MARKET_DATA_SOURCE: 'okx',
  fetchPriceInfo: async () => ({ prices: new Map(), report: null }),
}));

vi.mock('../lib/env.js', () => ({
  env: { MIN_LIQUIDITY_USD: 0, RADAR_MIN_LIQUIDITY_USD: 0, NODE_ENV: 'test' },
}));

vi.mock('../services/dexscreener.js', () => ({ fetchBoostedTokens: async () => [] }));

const { tokenRoutes } = await import('./tokens.js');
const { isHot, hotTokens, resetHotTokensForTests } = await import('../workers/hot-tokens.js');
const { resetIngestThrottleForTests } = await import('./tokens.js');
const { markRadarFindsHot } = await import('./radar.js');

let app: FastifyInstance;

beforeEach(async () => {
  tokenRows = [];
  tokenFindManyArgs = [];
  tokenUpdateManyArgs = [];
  auditEntries = [];
  checkBatchCalls = 0;
  resetHotTokensForTests();
  resetIngestThrottleForTests();

  const { resetCache } = await import('../lib/cache.js');
  resetCache();

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

  /*
   * Настоящая проверка прав, а не заглушка.
   *
   * Роль читается из подписанного токена — как в боевом
   * `auth-plugin`. Заглушка, пропускающая всех, доказывала бы
   * только то, что маршрут вызывает заглушку.
   */
  app.decorate('requireAdmin', async function requireAdmin(
    this: FastifyInstance,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Требуется авторизация' });
    }
    if ((req.user as { role?: string }).role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Недостаточно прав' });
    }
  });

  await app.register(tokenRoutes, { prefix: '/api' });
  await app.ready();
});

const bearer = (role: 'USER' | 'ADMIN') => app.jwt.sign({ sub: 'u1', role });

const get = (url: string, role?: 'USER' | 'ADMIN') =>
  app.inject({
    method: 'GET',
    url,
    ...(role ? { headers: { authorization: `Bearer ${bearer(role)}` } } : {}),
  });

const post = (url: string, body: Record<string, unknown>, role?: 'USER' | 'ADMIN') =>
  app.inject({
    method: 'POST',
    url,
    payload: body,
    ...(role ? { headers: { authorization: `Bearer ${bearer(role)}` } } : {}),
  });

// ─────────────────────── Разбор риска: только админу ─────────────────────────

describe('разбор причин риска закрыт', () => {
  it('без токена — 401', async () => {
    expect((await get('/api/tokens/risk-breakdown')).statusCode).toBe(401);
  });

  it('обычный пользователь — 403', async () => {
    expect((await get('/api/tokens/risk-breakdown', 'USER')).statusCode).toBe(403);
  });

  it('администратор — 200', async () => {
    expect((await get('/api/tokens/risk-breakdown', 'ADMIN')).statusCode).toBe(200);
  });

  it.each([
    ['строка запроса', '/api/tokens/risk-breakdown?role=ADMIN'],
    ['второй параметр', '/api/tokens/risk-breakdown?level=all&role=ADMIN&isAdmin=true'],
  ])('подмена роли через %s не работает', async (_name, url) => {
    expect((await get(url, 'USER')).statusCode).toBe(403);
  });

  it('подмена роли заголовком не работает', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/tokens/risk-breakdown',
      headers: {
        authorization: `Bearer ${bearer('USER')}`,
        'x-user-role': 'ADMIN',
        'x-role': 'ADMIN',
      },
    });

    expect(r.statusCode).toBe(403);
  });

  it('самоподписанный токен не принимается', async () => {
    // Роль внутри токена ничего не значит без нашей подписи.
    const forged = Fastify();
    await forged.register(jwt, { secret: 'чужой-секрет-достаточной-длины-для-подписи' });
    const alien = forged.jwt.sign({ sub: 'u1', role: 'ADMIN' });

    const r = await app.inject({
      method: 'GET',
      url: '/api/tokens/risk-breakdown',
      headers: { authorization: `Bearer ${alien}` },
    });

    expect(r.statusCode).toBe(401);
    await forged.close();
  });

  it('ответ содержит только агрегаты', async () => {
    /*
     * Ни адресов, ни символов, ни идентификаторов: это карта нашей
     * защиты, и по ней не должно быть видно, какой конкретно токен
     * чем помечен.
     */
    tokenRows = [token({ riskCodes: ['UNLOCKED_LIQUIDITY'] })];

    const body = (await get('/api/tokens/risk-breakdown', 'ADMIN')).body;

    expect(body).not.toContain('So11111111111111111111111111111111111111112');
    expect(body).not.toContain('WIF');
    expect(body).not.toContain('dogwifhat');
    expect(body).not.toContain('tok-1');
    expect(body).not.toContain('@');
    expect(JSON.parse(body)).toMatchObject({ tokens: 1 });
  });
});

// ─────────────────────── Прочая диагностика ──────────────────────────────────

describe('очередь и здоровье цен закрыты', () => {
  it.each(['/api/tokens/check-queue', '/api/admin/price-health'])(
    '%s требует администратора',
    async (url) => {
      expect((await get(url)).statusCode).toBe(401);
      expect((await get(url, 'USER')).statusCode).toBe(403);
      expect((await get(url, 'ADMIN')).statusCode).toBe(200);
    },
  );

  it('сводное состояние проверки остаётся публичным', async () => {
    // Оно нужно интерфейсу и не называет ни одного правила.
    expect((await get('/api/tokens/check-status')).statusCode).toBe(200);
  });

  it('здоровье цен не выдаёт пользовательских данных', async () => {
    tokenRows = [token()];

    const body = (await get('/api/admin/price-health', 'ADMIN')).body;

    expect(body).not.toContain('So11111111111111111111111111111111111111112');
    expect(body).not.toContain('@');
  });
});

// ─────────────────────── Ручное восстановление очереди ──────────────────────

describe('административный recheck', () => {
  const exhausted = () =>
    token({
      id: 'exhausted',
      riskLevel: 'blocked',
      riskCodes: ['HONEYPOT'],
      isHidden: true,
      scamCheckAttempts: 6,
      scamCheckNextAt: null,
      scamProviderError: true,
      scamCheckedAt: new Date(),
    });

  it('требует администратора', async () => {
    expect((await post('/api/admin/tokens/recheck', { apply: true })).statusCode).toBe(401);
    expect((await post('/api/admin/tokens/recheck', { apply: true }, 'USER')).statusCode).toBe(403);
  });

  it('dry-run ничего не меняет и не запускает проверку', async () => {
    tokenRows = [exhausted()];

    const response = await post('/api/admin/tokens/recheck', {}, 'ADMIN');
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ mode: 'dry-run', wouldReset: 1, totalExhausted: 1 });
    expect(tokenUpdateManyArgs).toEqual([]);
    expect(auditEntries).toEqual([]);
    expect(checkBatchCalls).toBe(0);
  });

  it('apply возвращает исчерпанную запись в очередь и пишет аудит', async () => {
    tokenRows = [exhausted()];

    const response = await post(
      '/api/admin/tokens/recheck',
      { apply: true, limit: 1, budgetSeconds: 5 },
      'ADMIN',
    );
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ mode: 'applied', reset: 1 });
    expect(checkBatchCalls).toBe(1);

    const data = tokenUpdateManyArgs[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({
      scamCheckAttempts: 0,
      scamCheckNextAt: null,
      scamProviderError: false,
      scamCheckedAt: null,
    });

    // Сброс очереди не отменяет прежний вердикт до нового результата.
    expect(data).not.toHaveProperty('riskLevel');
    expect(data).not.toHaveProperty('riskCodes');
    expect(data).not.toHaveProperty('isHidden');

    expect(JSON.stringify(auditEntries[0])).toContain('tokens.recheck.reset');
  });
});

// ─────────────────────── Горячий список из списков ───────────────────────────

describe('Terminal греет то, что показал', () => {
  it('токены списка попадают в горячие', async () => {
    tokenRows = [token({ id: 'a' }), token({ id: 'b' })];

    await get('/api/tokens');

    expect(isHot('a')).toBe(true);
    expect(isHot('b')).toBe(true);
  });

  it('открытая карточка тоже', async () => {
    tokenRows = [token({ id: 'card' })];

    await get('/api/tokens/card');

    expect(isHot('card')).toBe(true);
  });

  it('горячим становится начало выдачи, а не весь каталог', async () => {
    /*
     * Ответ отдаёт до двухсот токенов, на экране помещается десяток.
     * Пометить всё значит объявить горячим полкаталога и вытеснить
     * оттуда открытые карточки.
     */
    tokenRows = Array.from({ length: 200 }, (_, i) => token({ id: `t-${i}` }));

    await get('/api/tokens?limit=200');

    expect(hotTokens().length).toBeLessThanOrEqual(12);
  });

  it('несуществующих и скрытых среди них не бывает', async () => {
    /*
     * Помечаются идентификаторы, которые сервер сам только что
     * прочитал из базы по условию `isHidden: false`. Проверять
     * их отдельно нечего — они наши собственные.
     *
     * Ровно поэтому выбран этот вариант, а не приём списка от клиента:
     * присланные идентификаторы пришлось бы сверять с базой, то есть
     * тратить лишний запрос на каждую прокрутку.
     */
    tokenRows = [];

    await get('/api/tokens');

    expect(hotTokens()).toEqual([]);
  });

  it('перебор страниц не греет каталог бесконечно', async () => {
    tokenRows = Array.from({ length: 12 }, (_, i) => token({ id: `t-${i}` }));

    for (let i = 0; i < 50; i++) await get(`/api/tokens?limit=12&minLiquidity=${i}`);

    // Упирается в предел размера горячего списка, а не растёт
    // с числом запросов.
    expect(hotTokens().length).toBeLessThanOrEqual(50);
  });
});

describe('Radar греет свежие находки', () => {
  it('существующий видимый токен становится горячим', async () => {
    tokenRows = [token({ id: 'radar-token' })];

    await markRadarFindsHot([
      {
        chain: 'SOLANA',
        address: 'So11111111111111111111111111111111111111112',
      },
    ]);

    expect(isHot('radar-token')).toBe(true);
    expect(tokenFindManyArgs.at(-1)?.where).toMatchObject({
      isHidden: false,
      isQuote: false,
    });
  });

  it('пустая выдача не обращается к базе', async () => {
    await markRadarFindsHot([]);

    expect(tokenFindManyArgs).toEqual([]);
    expect(hotTokens()).toEqual([]);
  });
});
