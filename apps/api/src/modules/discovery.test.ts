import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';

/**
 * Что попадает в подборки Terminal и Radar.
 *
 * Проверяется настоящий модуль маршрутов: фильтры живут в аргументах
 * запроса к Prisma, и пересказ их в тесте доказывал бы правильность
 * пересказа. Поэтому подделка базы записывает, с каким `where` её
 * позвали, и утверждения делаются об этом.
 */

const HOUR = 3_600_000;

/**
 * Отсчёт от настоящего времени, а не от фиксированной даты.
 *
 * Возраст рынка маршрут считает от `Date.now()`, и прибитая
 * константа проверяла бы разницу между двумя разными «сейчас».
 */
const NOW = Date.now();

/** Аргументы последнего запроса списка токенов. */
let lastFindMany: Record<string, unknown> | null = null;

/** Что вернуть на следующий запрос. */
let rows: Record<string, unknown>[] = [];

const token = (over: Record<string, unknown> = {}) => ({
  id: 'tok-1',
  chain: 'SOLANA',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'WIF',
  name: 'dogwifhat',
  decimals: 9,
  isQuote: false,
  isVerified: true,
  isHidden: false,
  priceUsd: '2.5',
  priceChange24h: '42.5',
  liquidityUsd: '250000',
  volume24hUsd: '900000',
  fdvUsd: null,
  poolAddress: 'pool-1',
  poolCreatedAt: new Date(NOW - 2 * HOUR),
  firstSeenAt: new Date(NOW - HOUR),
  createdAt: new Date(NOW - HOUR),
  riskScore: 20,
  riskLevel: 'low',
  riskCodes: [],
  isRegistered: true,
  logoUrl: null,
  source: 'auto',
  research: null,
  holders: null,
  buys24h: null,
  sells24h: null,
  topHolderPct: null,
  scamVerdict: null,
  scamCheckedAt: null,
  scamRulesVersion: 8,
  metricsUpdated: null,
  ...over,
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    token: {
      findMany: async (args: Record<string, unknown>) => {
        lastFindMany = args;
        return rows;
      },
      findUnique: async () => null,
      count: async () => 0,
      aggregate: async () => ({ _sum: {}, _count: 0 }),
      groupBy: async () => [],
      createMany: async () => ({ count: 0 }),
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

vi.mock('../services/okx-market.js', () => ({ MARKET_DATA_SOURCE: 'okx' }));

vi.mock('../lib/env.js', () => ({
  env: { MIN_LIQUIDITY_USD: 15_000, RADAR_MIN_LIQUIDITY_USD: 20_000, NODE_ENV: 'test' },
}));

/** Продвигаемые токены DexScreener. */
let boosted: Record<string, unknown>[] = [];

vi.mock('../services/dexscreener.js', () => ({
  fetchBoostedTokens: async () => boosted,
}));

const { tokenRoutes } = await import('./tokens.js');

let app: FastifyInstance;

beforeEach(async () => {
  lastFindMany = null;
  rows = [];
  boosted = [];

  const { resetCache } = await import('../lib/cache.js');
  resetCache();

  const { resetIngestThrottleForTests } = await import('./tokens.js');
  resetIngestThrottleForTests();

  app = Fastify();

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

const get = (url: string) => app.inject({ method: 'GET', url });

/** Условие `where` последнего запроса списка. */
const where = () => (lastFindMany?.where ?? {}) as Record<string, unknown>;

/** Порог ликвидности из последнего запроса. */
const floorOf = (): number => {
  const cond = where().liquidityUsd as { gte?: number } | undefined;
  expect(cond, 'порог ликвидности должен стоять в запросе').toBeDefined();
  return cond!.gte!;
};

// ─────────────────────────────── Ликвидность ─────────────────────────────────

describe('порог ликвидности', () => {
  it('применяется к сортировке по объёму', async () => {
    // Раньше порог стоял только у сортировок по изменению цены,
    // а остальные списки шли без него вовсе.
    await get('/api/tokens?sort=volume');

    expect(where().liquidityUsd).toEqual({ gte: 15_000 });
  });

  it.each(['volume', 'liquidity', 'new', 'gainers', 'losers'])(
    'применяется к сортировке %s',
    async (sort) => {
      await get(`/api/tokens?sort=${sort}`);

      expect(floorOf()).toBeGreaterThanOrEqual(15_000);
    },
  );

  it('у сортировок по изменению цены он строже', async () => {
    await get('/api/tokens?sort=gainers');
    expect(floorOf()).toBe(100_000);
  });

  it('клиент может попросить строже', async () => {
    await get('/api/tokens?sort=volume&minLiquidity=500000');
    expect(floorOf()).toBe(500_000);
  });

  it('клиент не может попросить мягче', async () => {
    await get('/api/tokens?sort=volume&minLiquidity=100');
    expect(floorOf()).toBe(15_000);
  });

  it('ноль не отключает фильтр', async () => {
    // Прежняя проверка на истинность делала ровно это, и в подборки
    // попадали пулы дешевле доллара.
    await get('/api/tokens?sort=volume&minLiquidity=0');
    expect(floorOf()).toBe(15_000);
  });

  it('порог не пропустил бы токен дешевле доллара', async () => {
    await get('/api/tokens?sort=volume');

    expect(floorOf()).toBeGreaterThan(1);
  });
});

// ─────────────────────────────── Возраст ─────────────────────────────────────

describe('фильтр «Новые»', () => {
  it('отбирает по возрасту рынка, а не по времени импорта', async () => {
    await get('/api/tokens?sort=new');

    // В условии — время пула, а не создания записи.
    expect(where().poolCreatedAt).toBeDefined();
    expect(where().createdAt).toBeUndefined();
  });

  it('сортирует по возрасту рынка', async () => {
    await get('/api/tokens?sort=new');

    const order = (lastFindMany?.orderBy ?? []) as Record<string, unknown>[];
    expect(order[0]).toEqual({ poolCreatedAt: 'desc' });
  });

  it('по умолчанию отсекает старше суток', async () => {
    await get('/api/tokens?sort=new');

    const cond = where().poolCreatedAt as { not: null; gte: Date };
    const cutoffAgeMs = Date.now() - cond.gte.getTime();

    // Сутки с запасом на время выполнения теста.
    expect(cutoffAgeMs).toBeGreaterThan(23.9 * HOUR);
    expect(cutoffAgeMs).toBeLessThan(24.1 * HOUR);
  });

  it('токен без известного возраста не попадает в новые', async () => {
    // `not: null` — это и есть отсечка неизвестного возраста.
    await get('/api/tokens?sort=new');

    expect((where().poolCreatedAt as { not: null }).not).toBeNull();
  });

  it('предел возраста можно сузить запросом', async () => {
    await get('/api/tokens?sort=new&maxAgeHours=2');

    const cond = where().poolCreatedAt as { gte: Date };
    const ageMs = Date.now() - cond.gte.getTime();

    expect(ageMs).toBeGreaterThan(1.9 * HOUR);
    expect(ageMs).toBeLessThan(2.1 * HOUR);
  });

  it('отсечка по возрасту не применяется к другим сортировкам', async () => {
    await get('/api/tokens?sort=volume');
    expect(where().poolCreatedAt).toBeUndefined();
  });

  it('ответ несёт возраст и его источник', async () => {
    rows = [token()];

    const body = (await get('/api/tokens?sort=volume')).json();

    expect(body[0].marketAgeSource).toBe('pool');
    expect(body[0].marketAgeLabel).toBe('2 ч');
  });

  it('неизвестный возраст назван неизвестным', async () => {
    rows = [token({ poolCreatedAt: null, firstSeenAt: null })];

    const body = (await get('/api/tokens?sort=volume')).json();

    expect(body[0].marketAgeSource).toBe('unknown');
    expect(body[0].marketAgeMs).toBeNull();
    expect(body[0].marketAgeLabel).toBe('возраст неизвестен');
  });
});

// ────────────────────────────── DexScreener ──────────────────────────────────

describe('вкладка DexScreener', () => {
  beforeEach(() => {
    boosted = [
      {
        chain: 'SOLANA',
        address: 'NewTokenAddress1111111111111111111111111111',
        description: 'свежий',
        iconUrl: null,
        boostAmount: 500,
      },
    ];
  });

  it('непроверенные не исчезают при строгом режиме', async () => {
    // Раньше `safeOnly` удалял их молча, и при семнадцати ожидающих
    // человек видел пустой экран и решал, что вкладка сломана.
    const body = (await get('/api/tokens/dexscreener?safeOnly=true')).json();

    expect(body.pending).toHaveLength(1);
    expect(body.unchecked).toBe(1);
  });

  it('ожидающие лежат отдельно от проверенных', async () => {
    const body = (await get('/api/tokens/dexscreener?safeOnly=true')).json();

    // Смешать их значило бы дать прочесть pending как «проверено».
    expect(body.tokens).toHaveLength(0);
    expect(body.pending[0].riskLevel).toBeNull();
  });

  it('в строгом режиме замечания не показываются', async () => {
    const body = (await get('/api/tokens/dexscreener?safeOnly=true')).json();
    expect(body.flagged).toEqual([]);
  });

  it('честное число ожидающих, а не ноль', async () => {
    const body = (await get('/api/tokens/dexscreener?safeOnly=true')).json();
    expect(body.unchecked).toBe(1);
  });
});
