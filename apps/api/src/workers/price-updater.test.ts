import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Цены Terminal и Radar.
 *
 * Главный дефект был не в частоте. Воркер брал
 * `where: { isVerified: true }`, а импортёр заводит токены строкой
 * `isVerified: false` — намеренно, проверка остаётся за человеком.
 * Из этого следовало, что вся витрина и весь радар не обновлялись
 * никогда: не «редко», как это выглядело снаружи, а вовсе.
 *
 * Поэтому проверяется настоящий модуль с поддельной базой, а не
 * пересказ логики: пересказ повторил бы условие отбора вместе
 * с ошибкой.
 */

/** Аргументы запросов к базе — по ним и делаются утверждения. */
let findManyArgs: Record<string, unknown>[] = [];
let updateManyArgs: Record<string, unknown>[] = [];

/** Что база отдаёт на запрос списка токенов. */
let tokenRows: Record<string, unknown>[] = [];

/** Сколько строк «обновилось»: ноль означает, что запись отклонена. */
let updateCount = 1;

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    token: {
      findMany: async (args: Record<string, unknown>) => {
        findManyArgs.push(args);
        return tokenRows;
      },
      updateMany: async (args: Record<string, unknown>) => {
        updateManyArgs.push(args);
        return { count: updateCount };
      },
    },
    call: { updateMany: async () => ({ count: 0 }) },
    position: { findMany: async () => [] },
  },
  serializable: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Пакетный источник цен. */
let batchPrices = new Map<string, { priceUsd: number }>();
let priceInfoCalls = 0;
let priceInfoFreshFlags: Array<boolean | undefined> = [];
let batchReportOverride: {
  requested: number;
  fetched: number;
  missing: number;
  transient: number;
  rateLimited: number;
  retryAfterMs: number | null;
} | null = null;

vi.mock('../services/okx-market.js', () => ({
  fetchPriceInfo: async (
    tokens: { chain: string; address: string }[],
    opts?: { fresh?: boolean },
  ) => {
    priceInfoCalls++;
    priceInfoFreshFlags.push(opts?.fresh);
    return {
      prices: batchPrices,
      report: batchReportOverride ?? {
        requested: tokens.length,
        fetched: batchPrices.size,
        missing: Math.max(0, tokens.length - batchPrices.size),
        transient: 0,
        rateLimited: 0,
        retryAfterMs: null,
      },
    };
  },
  MARKET_DATA_SOURCE: 'okx',
}));

/** Поштучный источник: считаем обращения, чтобы видеть параллелизм. */
let rpcCalls: string[] = [];
let rpcPrice: number | null = null;
let rpcError: Error | null = null;

vi.mock('../chains/index.js', () => ({
  getAdapter: () => ({
    getPriceUsd: async (address: string) => {
      rpcCalls.push(address);
      if (rpcError) throw rpcError;
      return rpcPrice;
    },
  }),
}));

const mod = await import('./price-updater.js');
const { updateColdPrices, updateHotPrices, resetPriceUpdaterForTests } = mod;
const { markHot, resetHotTokensForTests } = await import('./hot-tokens.js');

const token = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  chain: 'SOLANA',
  address: `Addr${id}`,
  symbol: id.toUpperCase(),
  ...over,
});

beforeEach(() => {
  findManyArgs = [];
  updateManyArgs = [];
  tokenRows = [];
  updateCount = 1;
  batchPrices = new Map();
  priceInfoCalls = 0;
  priceInfoFreshFlags = [];
  batchReportOverride = null;
  rpcCalls = [];
  rpcPrice = null;
  rpcError = null;
  resetPriceUpdaterForTests();
  resetHotTokensForTests();
});

/** Условие отбора последнего холодного запроса. */
const coldWhere = () => (findManyArgs[0]?.where ?? {}) as Record<string, unknown>;

describe('холодный круг охватывает витрину', () => {
  it('не требует isVerified', () => {
    /*
     * Тот самый дефект. Импортёр ставит `isVerified: false`, и отбор
     * по `isVerified: true` означал, что автоимпортированные токены —
     * то есть весь терминал и весь радар — не обновлялись ни разу.
     */
    void updateColdPrices();

    expect(coldWhere()).not.toHaveProperty('isVerified');
  });

  it('берёт видимые торгуемые токены', async () => {
    await updateColdPrices();

    expect(coldWhere().isHidden).toBe(false);
    expect(coldWhere().isQuote).toBe(false);
  });

  it('идёт по кругу, а не по одному и тому же срезу', async () => {
    /*
     * Прежний `take: 500` без сортировки означал произвольный
     * и всегда один и тот же срез: хвост витрины не обновлялся,
     * даже будучи проверенным.
     */
    tokenRows = Array.from({ length: 200 }, (_, i) => token(`t-${String(i).padStart(3, '0')}`));

    await updateColdPrices();
    await updateColdPrices();

    const second = (findManyArgs[1]?.where ?? {}) as { id?: { gt?: string } };
    expect(second.id?.gt).toBe('t-199');
  });

  it('короткая страница замыкает круг', async () => {
    tokenRows = [token('only')];

    await updateColdPrices();
    await updateColdPrices();

    // Второй проход начинается сначала, а не за пределами списка.
    expect((findManyArgs[1]?.where ?? {}) as Record<string, unknown>).not.toHaveProperty('id');
  });
});

describe('источники цен', () => {
  it('сначала пакетный запрос', async () => {
    // Сто токенов за вызов вместо ста вызовов.
    tokenRows = [token('a'), token('b')];
    batchPrices = new Map([
      ['SOLANA:Addra', { priceUsd: 1 }],
      ['SOLANA:Addrb', { priceUsd: 2 }],
    ]);

    await updateColdPrices();

    expect(priceInfoCalls).toBe(1);
    expect(priceInfoFreshFlags).toEqual([true]);
    expect(rpcCalls).toEqual([]);
  });

  it('поштучно дозапрашивается только то, чего пакет не знает', async () => {
    tokenRows = [token('a'), token('b')];
    batchPrices = new Map([['SOLANA:Addra', { priceUsd: 1 }]]);
    rpcPrice = 5;

    await updateColdPrices();

    expect(rpcCalls).toEqual(['Addrb']);
  });

  it('недоступная цена не пишется', async () => {
    tokenRows = [token('a')];
    rpcPrice = null;

    await updateColdPrices();

    expect(updateManyArgs).toEqual([]);
  });

  it('нулевая и отрицательная цена не пишутся', async () => {
    // Ноль в колонке цены читается как факт, а это ошибка источника.
    tokenRows = [token('a')];
    rpcPrice = 0;

    await updateColdPrices();

    expect(updateManyArgs).toEqual([]);
  });

  it('сбой источника не роняет проход', async () => {
    tokenRows = [token('a'), token('b')];
    batchPrices = new Map([['SOLANA:Addrb', { priceUsd: 3 }]]);
    rpcError = new Error('RPC временно недоступен');

    const result = await updateColdPrices();

    expect(result.written).toBe(1);
    expect(result.report.transient).toBe(1);
  });
});

describe('запись не затирает более свежее', () => {
  it('условие свежести стоит в самом запросе', async () => {
    /*
     * Горячий и холодный проходы идут одновременно, ответы приходят
     * вразнобой. Без условия запоздавший ответ холодного круга
     * перезаписал бы цену, полученную горячим циклом секундой позже,
     * и снаружи это выглядело бы как скачок цены назад — худшее,
     * что может показать торговый экран.
     *
     * Условие обязано быть в `where`, а не в коде: проверка и запись
     * должны быть одной командой.
     */
    tokenRows = [token('a')];
    rpcPrice = 1;

    await updateColdPrices();

    const where = updateManyArgs[0]!.where as { OR?: unknown[] };
    expect(where.OR).toBeDefined();
    expect(JSON.stringify(where.OR)).toContain('priceUpdatedAt');
  });

  it('отклонённая запись не считается обновлением', async () => {
    tokenRows = [token('a')];
    rpcPrice = 1;
    updateCount = 0;

    expect((await updateColdPrices()).written).toBe(0);
  });

  it('время наблюдения одно на весь проход', async () => {
    // Иначе токены одного прохода получили бы разные отметки,
    // и порядок записи стал бы зависеть от скорости провайдера.
    tokenRows = [token('a'), token('b')];
    batchPrices = new Map([
      ['SOLANA:Addra', { priceUsd: 1 }],
      ['SOLANA:Addrb', { priceUsd: 2 }],
    ]);

    await updateColdPrices();

    const stamps = updateManyArgs.map((a) => (a.data as { priceUpdatedAt: Date }).priceUpdatedAt);
    expect(stamps[0]).toEqual(stamps[1]);
  });

  it('возраст цены пишется отдельно от metricsUpdated', async () => {
    // `metricsUpdated` двигает и проверка контракта, и по нему нельзя
    // отличить свежую котировку от свежей строки.
    tokenRows = [token('a')];
    rpcPrice = 1;

    await updateColdPrices();

    const data = updateManyArgs[0]!.data as Record<string, unknown>;
    expect(data).toHaveProperty('priceUpdatedAt');
    expect(data).toHaveProperty('priceUsd');
  });
});

describe('горячий цикл', () => {
  it('пустой список никого не трогает', async () => {
    expect((await updateHotPrices()).written).toBe(0);
    expect(findManyArgs).toEqual([]);
  });

  it('берёт открытые карточки', async () => {
    markHot('wif');
    tokenRows = [token('wif')];
    rpcPrice = 1;

    await updateHotPrices();

    const where = (findManyArgs[0]?.where ?? {}) as { id?: { in?: string[] } };
    expect(where.id?.in).toContain('wif');
  });

  it('не превращает отсутствующую пакетную цену в RPC-залп каждую секунду', async () => {
    markHot('wif');
    tokenRows = [token('wif')];
    rpcPrice = 1;

    await updateHotPrices();

    expect(priceInfoCalls).toBe(1);
    expect(rpcCalls).toEqual([]);
  });
});

describe('общий backoff провайдера', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('429 соблюдает Retry-After и останавливает оба цикла', async () => {
    tokenRows = [token('a')];
    batchReportOverride = {
      requested: 1,
      fetched: 0,
      missing: 0,
      transient: 0,
      rateLimited: 1,
      retryAfterMs: 120_000,
    };

    const first = await updateColdPrices();
    expect(first.verdict).toMatchObject({
      kind: 'backoff',
      reason: 'rate-limit',
      delayMs: 120_000,
      honoredRetryAfter: true,
    });
    expect(priceInfoCalls).toBe(1);
    expect(rpcCalls).toEqual([]);

    markHot('a');
    await updateHotPrices();
    await updateColdPrices();

    // Во время общей паузы ни hot, ни cold не создают новый залп.
    expect(priceInfoCalls).toBe(1);

    vi.advanceTimersByTime(120_000);
    batchReportOverride = null;
    rpcPrice = 1;
    markHot('a');

    await updateHotPrices();
    expect(priceInfoCalls).toBe(2);
  });

  it('частичный успех записывается перед отступом', async () => {
    tokenRows = [token('a'), token('b')];
    batchPrices = new Map([['SOLANA:Addra', { priceUsd: 1 }]]);
    batchReportOverride = {
      requested: 2,
      fetched: 1,
      missing: 0,
      transient: 0,
      rateLimited: 1,
      retryAfterMs: 60_000,
    };

    const result = await updateColdPrices();

    expect(result.written).toBe(1);
    expect(updateManyArgs).toHaveLength(1);
    expect(result.verdict.kind).toBe('backoff');
  });

  it('одна отсутствующая цена не включает backoff', async () => {
    tokenRows = [token('a')];
    rpcPrice = null;

    const result = await updateColdPrices();

    expect(result.verdict).toEqual({ kind: 'ok' });
    expect(result.report.missing).toBeGreaterThan(0);
  });

  it('успешный проход после паузы сбрасывает рост задержки', async () => {
    tokenRows = [token('a')];
    batchReportOverride = {
      requested: 1,
      fetched: 0,
      missing: 0,
      transient: 0,
      rateLimited: 1,
      retryAfterMs: 30_000,
    };

    const first = await updateColdPrices();
    expect(first.verdict.kind).toBe('backoff');

    vi.advanceTimersByTime(30_000);
    batchReportOverride = null;
    rpcPrice = 1;
    expect((await updateColdPrices()).verdict).toEqual({ kind: 'ok' });

    // Следующий отказ снова начинается с базовой задержки, а не со второй ступени.
    batchReportOverride = {
      requested: 1,
      fetched: 0,
      missing: 0,
      transient: 1,
      rateLimited: 0,
      retryAfterMs: null,
    };
    rpcError = new Error('RPC недоступен');

    const again = await updateColdPrices();
    expect(again.verdict.kind).toBe('backoff');
    if (again.verdict.kind === 'backoff') {
      expect(again.verdict.delayMs).toBeLessThanOrEqual(30_000);
    }
  });
});
