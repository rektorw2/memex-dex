import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import jwt from '@fastify/jwt';

/**
 * Граница между публичным и закрытым.
 *
 * Терминал открыт гостю: цена токена одинакова для всех, и требовать
 * регистрацию за то, что человек увидит на любом агрегаторе, значит
 * терять его на первом же экране.
 *
 * Но открытым стало ровно чтение рынка. Всё, что относится к человеку —
 * его портфель, его кошельки, его заявки — по-прежнему требует входа,
 * и всё, что двигает деньги, требует ещё и плана.
 *
 * Проверяются настоящие модули маршрутов — `tokens`, `portfolio`
 * и `orders`, — а не их пересказ. Это принципиально: половина ошибок
 * доступа живёт не в правилах, а в том, как правила подключены
 * к маршруту. Забытый `preHandler` и снятый одной строкой гейт
 * на образцах не видны вовсе.
 */

const SECRET = 'тестовый-секрет-достаточной-длины-для-подписи';
const fetchTokenCandles = vi.hoisted(() => vi.fn());

const token = {
  id: 'tok-1',
  chain: 'SOLANA',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'WIF',
  name: 'dogwifhat',
  decimals: 9,
  priceUsd: '2.5',
  priceChange24h: '42.5',
  liquidityUsd: '250000',
  volume24hUsd: '900000',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-22T00:00:00Z'),
  riskScore: 20,
  riskLevel: 'LOW',
  verified: true,
  logoUrl: null,
  research: null,
  marketCapUsd: null,
  holders: null,
  poolCreatedAt: null,
  checkedAt: new Date('2026-08-22T00:00:00Z'),
  rulesVersion: 1,

  // Поля состояния проверки и возраста котировки. Заготовка обязана
  // повторять форму строки: без них ответ считал бы токен
  // непроверенным, и тест проверял бы не то, что написано в названии.
  riskCodes: [] as string[],
  scamCheckedAt: new Date('2026-08-22T00:00:00Z'),
  scamRulesVersion: 1,
  scamCheckAttempts: 0,
  scamCheckNextAt: null,
  scamProviderError: false,
  priceUpdatedAt: new Date('2026-08-22T00:00:00Z'),
};

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    // Роль читается политикой служебного доступа. Обычный
    // пользователь — значит, тарифные правила работают как обычно.
    user: { findUnique: async () => ({ role: 'USER' }) },
    token: {
      findMany: async () => [token],
      findUnique: async () => token,
      count: async () => 1,
      aggregate: async () => ({ _sum: {}, _count: 1, _avg: {}, _max: {}, _min: {} }),
      groupBy: async () => [],
    },
    candle: { findMany: async () => [], count: async () => 0 },
    call: { findMany: async () => [] },
    trade: { findMany: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }) },
    position: { count: async () => 0 },
  },
  serializable: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/okx-market.js', () => ({
  MARKET_DATA_SOURCE: 'okx',
  fetchTokenCandles,
}));

// Заглушки для зависимостей заявок: сюда запрос не доходит вовсе —
// его отклоняют до исполнения, — но модуль их импортирует.
vi.mock('../services/execution.js', () => ({ executeOrder: async () => ({ ok: true }) }));
vi.mock('../services/order-intake.js', () => ({
  placeOrderForUser: async () => ({ ok: true, order: { id: 'o1' } }),
  cancelOrderForUser: async () => ({ ok: true }),
}));
vi.mock('../services/balances.js', () => ({ availableFor: async () => 0 }));
vi.mock('../lib/env.js', () => ({
  env: { EXECUTION_MODE: 'paper', NODE_ENV: 'test', DEX_SLIPPAGE_BPS: 100 },
}));

// Настоящие модули, а не их пересказ: проверка доступа живёт
// не в правилах, а в том, как правила подключены к маршруту,
// и забытый preHandler виден только на настоящем модуле.
const { tokenRoutes } = await import('./tokens.js');
const { portfolioRoutes } = await import('./portfolio.js');
const { orderRoutes } = await import('./orders.js');

vi.mock('../services/subscriptions.js', () => ({
  activeSubscription: async () => null,
  isGrantable: () => true,
}));

vi.mock('../services/trial.js', () => ({ trialOf: async () => null }));
vi.mock('../services/email-verify.js', () => ({ isEmailVerified: async () => false }));
vi.mock('../services/service-access.js', () => ({
  hasServiceAccess: async () => false,
  accountFacts: async () => ({ serviceAccess: false, emailVerified: false }),
}));

let app: FastifyInstance;

beforeEach(async () => {
  fetchTokenCandles.mockReset();
  fetchTokenCandles.mockResolvedValue([
    {
      openTime: new Date('2026-08-21T23:45:00Z'),
      open: 2.1,
      high: 2.3,
      low: 2,
      close: 2.2,
      volumeUsd: 100,
    },
    {
      openTime: new Date('2026-08-21T23:50:00Z'),
      open: 2.2,
      high: 2.6,
      low: 2.1,
      close: 2.5,
      volumeUsd: 200,
    },
  ]);

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
  });

  await app.register(tokenRoutes, { prefix: '/api' });
  await app.register(portfolioRoutes, { prefix: '/api' });
  await app.register(orderRoutes, { prefix: '/api' });

  await app.ready();
});

/** Запрос без единого заголовка авторизации. */
const anon = (url: string) => app.inject({ method: 'GET', url });

/** Заявка на покупку, полная и корректная по схеме. */
const BUY_ORDER = {
  chain: 'SOLANA',
  tokenInId: 'usdc-1',
  tokenOutId: 'tok-1',
  side: 'BUY',
  type: 'MARKET',
  amountIn: '10',
  slippageBps: 100,
};

describe('гостю открыто чтение рынка', () => {
  it.each([
    ['/api/tokens', 'список токенов'],
    ['/api/tokens?search=wif', 'поиск'],
    ['/api/tokens?sort=gainers', 'лидеры роста'],
    ['/api/tokens/tok-1', 'карточка токена'],
    ['/api/tokens/tok-1/overview', 'обзор токена'],
    ['/api/tokens/tok-1/live-price', 'живая цена'],
    ['/api/tokens/tok-1/candles?interval=1h', 'свечи для графика'],
    ['/api/tokens/tok-1/candles?interval=1s', 'секундный график'],
    ['/api/market/summary', 'сводка рынка'],
    ['/api/tokens/check-status', 'состояние проверки витрины'],
  ])('%s — %s', async (url) => {
    const r = await anon(url);

    // Важно именно отсутствие 401 и 403: содержимое проверяется
    // другими тестами, здесь вопрос один — пускают ли вообще.
    expect([401, 403], `${url} закрыт гостю`).not.toContain(r.statusCode);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('ни один ответ не содержит кода апгрейда', async () => {
    // Заглушка «нужен план» на публичном маршруте означала бы,
    // что гейт вернулся незаметно.
    for (const url of ['/api/tokens', '/api/tokens/tok-1/overview', '/api/market/summary']) {
      const body = (await anon(url)).body;
      expect(body, url).not.toContain('UPGRADE_REQUIRED');
    }
  });

  it('живая цена не кешируется и несёт фактическое время наблюдения', async () => {
    const response = await anon('/api/tokens/tok-1/live-price');

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      priceUsd: '2.5',
      priceChange24h: '42.5',
      observedAt: token.priceUpdatedAt.toISOString(),
    });
  });

  it('секундный график появляется сразу из текущей цены', async () => {
    const response = await anon('/api/tokens/tok-1/candles?interval=1s');
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.state).toBe('ready');
    expect(body.candles).toHaveLength(1);
    expect(body.candles[0]).toMatchObject({
      open: 2.5,
      high: 2.5,
      low: 2.5,
      close: 2.5,
    });
  });

  it('старший таймфрейм получает настоящую историю по адресу без poolAddress', async () => {
    const response = await anon('/api/tokens/tok-1/candles?interval=5m');
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(fetchTokenCandles).toHaveBeenCalledWith('SOLANA', token.address, '5m', 299);
    expect(body.state).toBe('ready');
    expect(body.candles.length).toBeGreaterThanOrEqual(2);
    expect(body.candles.slice(0, 2)).toEqual([
      expect.objectContaining({ open: 2.1, high: 2.3, low: 2, close: 2.2 }),
      expect.objectContaining({ open: 2.2, high: 2.6, low: 2.1, close: 2.5 }),
    ]);
  });

  it('не принимает отсутствующий в интерфейсе минутный таймфрейм', async () => {
    const response = await anon('/api/tokens/tok-1/candles?interval=1m');

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('1s, 5m, 15m, 1h, 4h, 1d');
  });

  it('внутреннее распределение правил не открыто гостю', async () => {
    // Сводный check-status нужен интерфейсу, но карта конкретных
    // защитных правил — административная диагностика.
    expect((await anon('/api/tokens/risk-breakdown')).statusCode).toBe(401);
  });
});

describe('гостю закрыто приватное', () => {
  it('портфель требует входа', async () => {
    expect((await anon('/api/portfolio')).statusCode).toBe(401);
  });

  it('заявка требует входа', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/orders', payload: BUY_ORDER });
    expect(r.statusCode).toBe(401);
  });

  it('вход без плана не открывает покупку', async () => {
    // Сервер защищает действие независимо от того, что нарисовал
    // интерфейс: скрытая кнопка защитой не является.
    const bearer = app.jwt.sign({ sub: 'user-1', role: 'USER' });

    const r = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: BUY_ORDER,
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('UPGRADE_REQUIRED');
    expect(r.json().capability).toBe('MANUAL_TRADE');
  });

  it('продажа своих активов не закрывается отсутствием плана', async () => {
    // NEVER_REVOKED на настоящем маршруте: актив принадлежит человеку,
    // и запереть его в позиции из-за неоплаченного счёта нельзя.
    const bearer = app.jwt.sign({ sub: 'user-1', role: 'USER' });

    const r = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { ...BUY_ORDER, side: 'SELL' },
      headers: { authorization: `Bearer ${bearer}` },
    });

    // До исполнения дело не дойдёт — база подделана, — но отказа
    // по правам быть не должно.
    expect(r.statusCode).not.toBe(403);
  });

  it('портфель открыт вошедшему без плана', async () => {
    // PORTFOLIO_READ тоже не отбирается: не увидев позиций,
    // человек не сможет их продать.
    const bearer = app.jwt.sign({ sub: 'user-1', role: 'USER' });

    const r = await app.inject({
      method: 'GET',
      url: '/api/portfolio',
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(r.statusCode).not.toBe(403);
  });
});

describe('лидер роста', () => {
  it('берётся тем же правилом, что и список в терминале', async () => {
    // Одно определение на всё приложение. Второе разошлось бы
    // с первым, и карточка на главной называла бы лидером не тот
    // токен, который стоит первым в терминале.
    const r = await anon('/api/tokens?sort=gainers&limit=1');

    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });

  it('пустая витрина даёт пустой список, а не выдуманный токен', async () => {
    // Честное пустое состояние. Карточка на первом экране должна
    // сказать «пока нечего показать», а не придумать токен.
    const mod = await import('../lib/prisma.js');
    const original = mod.prisma.token.findMany;
    (mod.prisma.token as { findMany: unknown }).findMany = async () => [];

    try {
      const r = await anon('/api/tokens?sort=gainers&limit=1');

      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual([]);
    } finally {
      (mod.prisma.token as { findMany: unknown }).findMany = original;
    }
  });
});
