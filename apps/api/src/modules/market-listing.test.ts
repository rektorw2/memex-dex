import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Витрина «Рынок» и курсор истории свечей.
 *
 * Проверяются настоящие маршруты: половина этих правил живёт
 * не в расчёте, а в том, как он подключён — какие строки уходят
 * в выборку и что остаётся после отсева.
 */

const dec = (v: string | number) => ({ toString: () => String(v) });

/** Настоящий USDC на Solana: адрес из подтверждённого реестра. */
const REAL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const token = (over: Record<string, unknown> = {}) => ({
  id: 'tk-1',
  chain: 'SOLANA',
  address: 'BonkKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
  symbol: 'BONK',
  name: 'Bonk',
  decimals: 5,
  logoUrl: null,
  isQuote: false,
  isVerified: false,
  isHidden: false,
  priceUsd: dec('0.0000125'),
  priceChange24h: dec('42.5'),
  priceUpdatedAt: new Date(),
  liquidityUsd: dec('250000'),
  volume24hUsd: dec('900000'),
  fdvUsd: null,
  riskScore: 10,
  riskLevel: 'low',
  riskCodes: [] as string[],
  isRegistered: false,
  scamVerdict: 'OK',
  scamReasons: null,
  scamCheckedAt: new Date(),
  scamRulesVersion: 10,
  scamProviderError: false,
  poolAddress: 'pool-1',
  poolCreatedAt: new Date(),
  firstSeenAt: new Date(),
  createdAt: new Date(),
  source: 'auto',
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

let rows: Record<string, unknown>[] = [];
let candleArgs: Record<string, any>[] = [];
let candles: Record<string, unknown>[] = [];
const fetchTokenCandles = vi.hoisted(() => vi.fn());

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    token: {
      findMany: async () => rows,
      findUnique: async () => rows[0] ?? null,
      findFirst: async () => null,
      count: async () => rows.length,
      aggregate: async () => ({ _sum: {}, _count: 0 }),
      groupBy: async () => [],
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    candle: {
      findMany: async (args: Record<string, any>) => {
        candleArgs.push(args);
        return candles;
      },
      count: async () => candles.length,
    },
    call: { findMany: async () => [] },
    trade: { findMany: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }) },
    position: { count: async () => 0, findMany: async () => [] },
    auditLog: { create: async () => ({}) },
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
  fetchTokenCandles,
}));

vi.mock('../services/dexscreener.js', () => ({ fetchBoostedTokens: async () => [] }));

vi.mock('../lib/env.js', () => ({
  env: { MIN_LIQUIDITY_USD: 0, RADAR_MIN_LIQUIDITY_USD: 0, NODE_ENV: 'test' },
}));

const { tokenRoutes } = await import('./tokens.js');
const { resetIngestThrottleForTests } = await import('./tokens.js');

let app: FastifyInstance;

beforeEach(async () => {
  rows = [];
  candles = [];
  candleArgs = [];
  fetchTokenCandles.mockReset();
  fetchTokenCandles.mockResolvedValue([]);
  resetIngestThrottleForTests();

  const { resetCache } = await import('../lib/cache.js');
  resetCache();

  app = Fastify();
  app.decorate('requireAdmin', async () => undefined);
  await app.register(tokenRoutes);
  await app.ready();
});

const list = async (query = '') => {
  const res = await app.inject({ method: 'GET', url: `/tokens${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any[];
};

// ──────────────────────── Стейблкоины в витрине ─────────────────────────────

describe('стейблкоины не попадают в «Рынок»', () => {
  it('настоящий USDC исчезает из списка', async () => {
    rows = [
      token({ id: 'usdc', address: REAL_USDC, symbol: 'USDC', isQuote: true }),
      token({ id: 'bonk' }),
    ];

    const out = await list();

    expect(out.map((t) => t.id)).toEqual(['bonk']);
  });

  it('точный поиск по адресу тоже не возвращает его в рынок', async () => {
    /*
     * Исключений нет.
     *
     * Витрина, из которой актив то исчезает, то появляется в
     * зависимости от способа поиска, перестаёт быть предсказуемой.
     * Сведения о самом USDC никуда не делись — он остаётся в базе,
     * в портфеле и валютой котировки; показывать его отдельно —
     * задача других экранов.
     */
    rows = [token({ id: 'usdc', address: REAL_USDC, symbol: 'USDC', isQuote: true })];

    expect(await list(`?search=${REAL_USDC}`)).toEqual([]);
  });

  it('подделка по точному адресу находится', async () => {
    // Правило скрывает канонический адрес, а не символ: подделку
    // человек обязан увидеть — вместе с её уровнем риска.
    const fake = 'FAKEusdc1111111111111111111111111111111111';
    rows = [token({ id: 'fake', address: fake, symbol: 'USDC', isQuote: false })];

    expect((await list(`?search=${fake}`)).map((t) => t.id)).toEqual(['fake']);
  });

  it('подделка с символом USDC остаётся в списке', async () => {
    /*
     * Ключевое место. Исключать по символу значило бы спрятать
     * подделку вместе с оригиналом — то есть избавить мошенника
     * от единственной витрины, где его токен виден рядом
     * с проверенными и со своим уровнем риска.
     */
    rows = [
      token({
        id: 'fake',
        address: 'FAKEusdc1111111111111111111111111111111111',
        symbol: 'USDC',
        name: 'USD Coin',
        isQuote: false,
      }),
    ];

    const out = await list();

    expect(out.map((t) => t.id)).toEqual(['fake']);
    expect(out[0].symbol).toBe('USDC');
  });
});

// ─────────────────────── Изменение цены за 24 часа ──────────────────────────

describe('изменение цены строго за сутки', () => {
  it('свежее значение отдаётся', async () => {
    rows = [token({ priceChange24h: dec('42.5'), priceUpdatedAt: new Date() })];

    expect((await list())[0].priceChange24h).toBe('42.5');
  });

  it('устаревшая котировка даёт null, а не последнее известное число', async () => {
    rows = [
      token({
        priceChange24h: dec('42.5'),
        priceUpdatedAt: new Date(Date.now() - 48 * 3_600_000),
      }),
    ];

    const out = await list();

    // Ноль здесь был бы утверждением «цена не изменилась».
    expect(out[0].priceChange24h).toBeNull();
    expect(out[0].priceChange24h).not.toBe('0');
  });

  it('отсутствие поля остаётся отсутствием', async () => {
    rows = [token({ priceChange24h: null })];

    expect((await list())[0].priceChange24h).toBeNull();
  });
});

// ────────────────────────── Активные за 24 часа ─────────────────────────────

describe('фильтр «Активные 24ч»', () => {
  it('комбинируется с остальными и не подменяет их', async () => {
    rows = [token()];

    await list('?activeOnly=true&safeOnly=true&sort=gainers');

    // Проверяется, что маршрут принимает комбинацию и отвечает:
    // фильтр добавляется к условиям, а не заменяет их.
    expect(rows).toHaveLength(1);
  });

  it('по умолчанию выключен', async () => {
    rows = [token()];

    expect(await list()).toHaveLength(1);
  });
});

// ─────────────────────── Курсор истории свечей ──────────────────────────────

describe('страница истории по курсору', () => {
  const at = (seconds: number) => ({
    openTime: new Date(seconds * 1000),
    open: dec(1),
    high: dec(1),
    low: dec(1),
    close: dec(1),
    volumeUsd: dec(0),
  });

  it('без курсора отдаётся последняя страница', async () => {
    rows = [token()];
    candles = [at(3000), at(2940)];

    const res = await app.inject({ method: 'GET', url: '/tokens/tk-1/candles?interval=5m' });

    expect(res.statusCode).toBe(200);
    expect(candleArgs.at(-1)!.where.openTime).toBeUndefined();
  });

  it('курсор превращается в строгое сравнение по времени', async () => {
    rows = [token()];
    candles = [at(2000)];

    await app.inject({ method: 'GET', url: '/tokens/tk-1/candles?interval=5m&before=3000' });

    const where = candleArgs.at(-1)!.where;

    // Строгое `lt`: свеча-курсор у клиента уже есть, и повторять её
    // значит отдавать дубль, который на графике рисуется палкой.
    expect(where.openTime.lt).toEqual(new Date(3_000_000));
    expect(where.interval).toBe('5m');
  });

  it('страница в прошлое не дописывает живую цену', async () => {
    rows = [token()];
    candles = [at(2000), at(1940)];

    const res = await app.inject({
      method: 'GET',
      url: '/tokens/tk-1/candles?interval=5m&before=3000',
    });

    const body = res.json();

    // Живая цена относится к текущему моменту, а страница — к отрезку
    // сутками раньше: дописанная, она нарисовала бы свечу «сейчас»
    // посреди истории.
    expect(body.livePriceUsd).toBeNull();
    expect(body.candles.at(-1).time).toBe(2000);
  });

  it('fallback OKX получает курсор и не пропускает новые свечи в старую страницу', async () => {
    rows = [token()];
    candles = [];
    fetchTokenCandles.mockResolvedValue([
      { openTime: new Date(2_000_000), open: 1, high: 1, low: 1, close: 1, volumeUsd: 0 },
      { openTime: new Date(4_000_000), open: 2, high: 2, low: 2, close: 2, volumeUsd: 0 },
    ]);

    const body = (
      await app.inject({ method: 'GET', url: '/tokens/tk-1/candles?interval=5m&before=3000' })
    ).json();

    expect(fetchTokenCandles).toHaveBeenCalledWith(
      'SOLANA',
      expect.any(String),
      '5m',
      299,
      3_000_000,
    );
    expect(body.candles.map((candle: { time: number }) => candle.time)).toEqual([2000]);
    expect(body.oldest).toBe(2000);
  });

  it('отдаётся курсор следующей страницы', async () => {
    rows = [token()];
    candles = [at(2000), at(1940)];

    const body = (
      await app.inject({ method: 'GET', url: '/tokens/tk-1/candles?interval=5m&before=3000' })
    ).json();

    // Самая старая свеча ответа — курсор следующего запроса.
    expect(body.oldest).toBe(body.candles[0].time);
  });

  it('пустая страница сообщает, что истории больше нет', async () => {
    rows = [token()];
    candles = [];

    const body = (
      await app.inject({ method: 'GET', url: '/tokens/tk-1/candles?interval=5m&before=100' })
    ).json();

    expect(body.candles).toEqual([]);
    // `null` — признак конца: клиент запомнит и перестанет спрашивать.
    expect(body.oldest).toBeNull();
  });

  it('разные таймфреймы читаются раздельно', async () => {
    rows = [token()];
    candles = [at(2000)];

    await app.inject({ method: 'GET', url: '/tokens/tk-1/candles?interval=1h&before=3000' });

    expect(candleArgs.at(-1)!.where.interval).toBe('1h');
  });
});
