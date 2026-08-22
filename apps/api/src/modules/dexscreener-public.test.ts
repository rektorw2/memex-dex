import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';

/**
 * Публичный внешний список и злоупотребления.
 *
 * Маршрут `/tokens/dexscreener` стал доступен без входа, а за ним
 * стоят две дорогие вещи: обращение к чужому API и запись в нашу базу.
 * В прежнем виде обновление страницы гостем запускало обе, то есть
 * страница превращалась в кнопку «сходи к провайдеру и запиши
 * двадцать строк», доступную всякому и без счёта.
 *
 * Здесь проверяется, что чтение и наполнение разведены: сколько бы
 * раз ни обновили страницу, провайдера спросят один раз, а записи
 * не будет вовсе, пока не пройдёт положенный срок.
 */

let boostedCalls = 0;
let createManyCalls = 0;
let createdRows = 0;

const boosted = [
  {
    chain: 'SOLANA',
    address: 'NewTokenAddress1111111111111111111111111111',
    description: 'свежий токен',
    iconUrl: null,
    boostAmount: 500,
  },
];

vi.mock('../services/dexscreener.js', () => ({
  fetchBoostedTokens: async () => {
    boostedCalls++;
    return boosted;
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    token: {
      // Ничего не знаем: значит, каждый адрес — кандидат на запись.
      findMany: async () => [],
      findUnique: async () => null,
      count: async () => 0,
      aggregate: async () => ({ _sum: {}, _count: 0 }),
      groupBy: async () => [],
      createMany: async ({ data }: { data: unknown[] }) => {
        createManyCalls++;
        createdRows += data.length;
        return { count: data.length };
      },
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

vi.mock('../services/okx-market.js', () => ({ MARKET_DATA_SOURCE: 'okx' }));

const { tokenRoutes, resetIngestThrottleForTests, DEXSCREENER_TTL_MS, INGEST_INTERVAL_MS } =
  await import('./tokens.js');

const { resetCache } = await import('../lib/cache.js');

let app: FastifyInstance;

beforeEach(async () => {
  boostedCalls = 0;
  createManyCalls = 0;
  createdRows = 0;

  resetCache();
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

const anon = () => app.inject({ method: 'GET', url: '/api/tokens/dexscreener' });

describe('гость и внешний список', () => {
  it('маршрут открыт без входа', async () => {
    expect((await anon()).statusCode).toBe(200);
  });

  it('десять обновлений подряд дают один запрос к провайдеру', async () => {
    // Раньше каждое обновление уходило наружу. Гость с зажатым F5
    // выбирал бы чужую квоту за минуту.
    for (let i = 0; i < 10; i++) await anon();

    expect(boostedCalls).toBe(1);
  });

  it('ответ помечен сроком жизни для браузера', async () => {
    const r = await anon();

    // Часть обновлений не доходит до нас вовсе — это дешевле
    // любого лимита.
    expect(r.headers['cache-control']).toContain('max-age');
    expect(r.headers['cache-control']).toContain(String(DEXSCREENER_TTL_MS / 1000));
  });
});

describe('наполнение базы отделено от чтения', () => {
  it('десять обновлений подряд дают одну запись', async () => {
    for (let i = 0; i < 10; i++) await anon();

    // Ждём фоновой записи: она намеренно не задерживает ответ.
    await new Promise((r) => setTimeout(r, 20));

    expect(createManyCalls).toBe(1);
  });

  it('за раз заводится не больше двадцати токенов', async () => {
    await anon();
    await new Promise((r) => setTimeout(r, 20));

    expect(createdRows).toBeLessThanOrEqual(20);
  });

  it('после сброса кэша запись всё равно не повторяется', async () => {
    // Кэш ответа и разрешение на запись — разные сроки. Сброс первого
    // не должен открывать второй: иначе достаточно было бы подождать
    // тридцать секунд и обновить страницу снова.
    await anon();
    await new Promise((r) => setTimeout(r, 20));
    expect(createManyCalls).toBe(1);

    resetCache();

    await anon();
    await new Promise((r) => setTimeout(r, 20));

    expect(createManyCalls).toBe(1);
    expect(boostedCalls).toBe(2);
  });

  it('срок между записями заметно больше срока кэша', async () => {
    // Если бы они совпадали, разведение потеряло бы смысл: каждое
    // протухание кэша открывало бы новую запись.
    expect(INGEST_INTERVAL_MS).toBeGreaterThan(DEXSCREENER_TTL_MS * 5);
  });

  it('пустой внешний список не приводит к записи', async () => {
    boosted.length = 0;

    try {
      await anon();
      await new Promise((r) => setTimeout(r, 20));

      expect(createManyCalls).toBe(0);
    } finally {
      boosted.push({
        chain: 'SOLANA',
        address: 'NewTokenAddress1111111111111111111111111111',
        description: 'свежий токен',
        iconUrl: null,
        boostAmount: 500,
      });
    }
  });
});
