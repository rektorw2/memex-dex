import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';

/**
 * Контракт GEMS: это прямой список событий OKX Signal.
 *
 * Самая опасная регрессия здесь — случайно переиспользовать where
 * обычной витрины (`isHidden: false`, riskLevel, liquidity). Тогда
 * новая вкладка снова станет пустой ровно в первые минуты, ради
 * которых она и создавалась.
 */
let query: Record<string, unknown> | null = null;

const rows = [
  {
    id: 'signal-1',
    providerKey: 'okx-signal:key-1',
    chain: 'SOLANA',
    address: 'Gem111111111111111111111111111111111111111',
    symbol: 'GEM',
    name: 'Fresh Gem',
    logoUrl: null,
    signaledAt: new Date('2026-08-23T05:00:00.000Z'),
    receivedAt: new Date('2026-08-23T05:00:00.100Z'),
    walletTypes: ['smart_money'],
    triggerWalletCount: 3,
    amountUsd: { toString: () => '1234.5' },
    soldRatioPct: null,
    priceUsd: { toString: () => '0.001' },
    marketCapUsd: { toString: () => '80000' },
    peakPriceUsd: { toString: () => '0.025' },
    peakObservedAt: new Date('2026-08-23T05:08:00.000Z'),
    holders: 420,
    // Этот токен намеренно скрыт и заблокирован в нашей витрине.
    // GEMS обязан показать само событие независимо от этих полей.
    token: {
      id: 'token-1',
      priceUsd: { toString: () => '0.0012' },
      priceChange24h: { toString: () => '20' },
      priceUpdatedAt: new Date('2026-08-23T05:00:03.000Z'),
      fdvUsd: { toString: () => '96000' },
      volume24hUsd: { toString: () => '15000' },
      holders: 450,
      poolAddress: 'pool-1',
      isVerified: false,
      isHidden: true,
      riskLevel: 'blocked',
      liquidityUsd: null,
    },
  },
];

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    okxSignal: {
      findMany: async (args: Record<string, unknown>) => {
        query = args;
        return rows;
      },
    },
    token: {
      findMany: async () => [],
      findUnique: async () => null,
      count: async () => 0,
      aggregate: async () => ({ _sum: {}, _count: 0 }),
      groupBy: async () => [],
      createMany: async () => ({ count: 0 }),
    },
    candle: { findMany: async () => [] },
    call: { findMany: async () => [] },
    trade: { findMany: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }) },
    position: { count: async () => 0 },
  },
  serializable: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/okx-market.js', () => ({ MARKET_DATA_SOURCE: 'OKX OnchainOS' }));

const { tokenRoutes } = await import('./tokens.js');
const { isHot, resetHotTokensForTests } = await import('../workers/hot-tokens.js');

let app: FastifyInstance;

beforeEach(async () => {
  query = null;
  resetHotTokensForTests();
  app = Fastify();
  // В настоящем сервере Zod преобразуется в 400 общим обработчиком.
  // Плагин в тесте поднимается отдельно, поэтому воспроизводим ровно
  // этот кусок инфраструктуры, а не принимаем внутреннюю ошибку за API.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Некорректные данные' });
    return reply.code(500).send({ error: 'Внутренняя ошибка' });
  });
  app.decorate('requireAdmin', async function requireAdmin(
    this: FastifyInstance,
    _req: FastifyRequest,
    reply: FastifyReply,
  ) {
    return reply.code(401).send({ error: 'Требуется авторизация' });
  });
  await app.register(tokenRoutes, { prefix: '/api' });
  await app.ready();
});

describe('публичная лента GEMS', () => {
  it('доступна гостю и возвращает событие скрытого токена', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tokens/gems' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.source).toBe('OKX Signal');
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({
      id: 'signal-1',
      signalMarketCapUsd: '80000',
      peakPriceUsd: '0.025',
      peakObservedAt: '2026-08-23T05:08:00.000Z',
      token: {
        id: 'token-1',
        symbol: 'GEM',
        priceUsd: '0.0012',
        priceChange24h: '20',
        marketCapUsd: '96000',
        volume24hUsd: '15000',
        hasChart: true,
      },
    });
    /*
     * Просмотр ленты горячим токен не делает.
     *
     * Раньше здесь ожидалось обратное, и это было ошибкой в основании:
     * вкладка GEMS у активного пользователя открыта постоянно,
     * опрашивается раз в три секунды, а метка живёт полторы минуты —
     * то есть горячий набор не пустел никогда, и живой цикл цен
     * обращался к провайдеру круглосуточно.
     *
     * Цену карточкам даёт холодный круг и запись самого сигнала.
     * Горячим токен становится, когда открыт его график.
     */
    expect(isHot('token-1')).toBe(false);
  });

  it('не применяет risk, hidden, liquidity или chain where-фильтры', async () => {
    await app.inject({ method: 'GET', url: '/api/tokens/gems?limit=17' });

    expect(query).toMatchObject({
      take: 17,
      orderBy: [{ signaledAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        providerKey: true,
        peakPriceUsd: true,
        peakObservedAt: true,
        token: {
          select: {
            id: true,
            priceUsd: true,
            priceChange24h: true,
            priceUpdatedAt: true,
            fdvUsd: true,
            liquidityUsd: true,
            volume24hUsd: true,
            holders: true,
            poolAddress: true,
            isVerified: true,
          },
        },
      },
    });
    expect(query).not.toHaveProperty('where');
  });

  it('держит короткий кэш и ограничивает размер ответа', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tokens/gems?limit=200' });

    expect(response.headers['cache-control']).toBe('public, max-age=2, stale-while-revalidate=3');
    expect(query).toHaveProperty('take', 200);
    expect((await app.inject({ method: 'GET', url: '/api/tokens/gems?limit=201' })).statusCode).toBe(400);
  });
});
