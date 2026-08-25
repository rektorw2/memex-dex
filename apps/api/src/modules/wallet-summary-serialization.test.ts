import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Круг «база → API → экран» на нейтральных исходах.
 *
 * Проверяется настоящий маршрут, а не пересказ его правил. Дефект,
 * ради которого написан этот файл, жил не в расчёте, а в переводе
 * сохранённого в ответ: знаменатель доли попаданий не хранился,
 * и сериализация восстанавливала его выражением
 *
 *     scorableOutcomes = max(wins2x, rugs)
 *
 * Десять оценённых токенов с одной победой, одним rug и восемью
 * обычными исходами превращались в выборку из одного, а доля
 * попаданий 10% — в 100%. Расчёт при этом был исправен: цифры
 * ломались по дороге наружу.
 */

const WALLET = 'GXUC1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB928f';

const dec = (v: string | number) => ({ toString: () => String(v) });

/** Строка кошелька такой, какой её пишет пересчёт. */
const walletRow = (over: Record<string, unknown> = {}) => ({
  id: 'w-1',
  chain: 'SOLANA',
  address: WALLET,
  knownAs: null,

  // Десять токенов: одна победа, один rug, восемь обычных исходов.
  tokensBought: 10,
  wins2x: 1,
  wins5x: 0,
  rugs: 1,
  volumeUsd: dec('500'),
  avgPeakMultiple: dec('1.2'),
  medianEntryHours: dec('2'),
  score: 40,
  label: 'smart',

  scorableOutcomes: 10,
  pendingOutcomes: 0,
  ambiguousOutcomes: 0,
  scoreVersion: 2,
  scoreComputedAt: new Date('2026-08-25T10:00:00Z'),
  scoreConfidence: 'medium',
  scoreCoverage: 'complete',
  scoreReason: null,

  firstSeenAt: new Date('2026-08-01T00:00:00Z'),
  lastActiveAt: new Date('2026-08-25T09:00:00Z'),
  trades: [],
  ...over,
});

let rows: Record<string, unknown>[] = [];
let activityRows: Record<string, unknown>[] = [];
let activityFindArgs: any = null;

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    traderWallet: {
      findMany: async () => rows,
      findUnique: async () => rows[0] ?? null,
      count: async () => rows.length,
    },
    walletTrade: { findMany: async () => [] },
    walletActivity: {
      findMany: async (args: unknown) => {
        activityFindArgs = args;
        return activityRows;
      },
    },
    walletEconomicTrade: { findMany: async () => [] },
    token: { findMany: async () => [] },
    radarEvent: { findMany: async () => [] },
  };

  return { prisma, serializable: vi.fn() };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Права проверены отдельными тестами доступа; здесь важен перевод
// сохранённого в ответ, а не кто имеет право его увидеть.
vi.mock('../services/entitlement.js', () => ({
  entitlementOfRequest: async () => ({ features: ['SMART_WALLETS_ACCESS'] }),
  denyIfMissing: () => false,
}));

vi.mock('../workers/wallet-tracker.js', () => ({
  walletActivityForToken: async () => [],
  collectTrades: async () => ({}),
  settleOutcomes: async () => 0,
  rescoreWallets: async () => 0,
}));

const { walletIntelRoutes } = await import('./wallets-intel.js');

let app: FastifyInstance;

beforeEach(async () => {
  rows = [];
  activityRows = [];
  activityFindArgs = null;
  app = Fastify();
  // Административные маршруты этого модуля объявляют `app.requireAdmin`.
  // Здесь проверяется чтение, но без заглушки Fastify откажется
  // зарегистрировать плагин целиком.
  app.decorate('requireAdmin', async () => undefined);
  await app.register(walletIntelRoutes);
  await app.ready();
});

async function firstWallet(): Promise<any> {
  const res = await app.inject({ method: 'GET', url: '/wallets/top' });
  expect(res.statusCode).toBe(200);
  return res.json().wallets[0];
}

describe('нейтральные исходы доезжают до ответа', () => {
  it('знаменатель остаётся десятью, а не схлопывается в один', async () => {
    rows = [walletRow()];

    const w = await firstWallet();

    expect(w.summary.scorableOutcomes).toBe(10);
    expect(w.summary.observedTokens).toBe(10);
    // Прежнее выражение дало бы здесь единицу.
    expect(w.summary.scorableOutcomes).not.toBe(Math.max(w.summary.wins2x, w.summary.rugs));
  });

  it('доля попаданий десять процентов, а не сто', async () => {
    rows = [walletRow()];

    const w = await firstWallet();

    expect(w.summary.hitRate).toBeCloseTo(0.1, 10);
    expect(w.hitRate).toBeCloseTo(0.1, 10);
    // Прежние поля берутся из той же сводки: второго расчёта нет.
    expect(w.sampleSize).toBe(w.summary.scorableOutcomes);
  });

  it('восемь обычных исходов не превращаются в ожидание', async () => {
    rows = [walletRow()];

    const w = await firstWallet();

    expect(w.summary.pendingOutcomes).toBe(0);
    expect(w.summary.ambiguousOutcomes).toBe(0);
  });

  it('оценка сохраняется, когда выборки хватает', async () => {
    rows = [walletRow()];

    expect((await firstWallet()).summary.score).toBe(40);
  });
});

describe('подпись расчёта не выдумывается при чтении', () => {
  it('время расчёта — сохранённое, а не время запроса', async () => {
    rows = [walletRow()];

    const w = await firstWallet();

    expect(w.summary.computedAt).toBe(Date.parse('2026-08-25T10:00:00Z'));
    // Прежде здесь стоял `Date.now()`, то есть момент открытия страницы.
    expect(Math.abs(w.summary.computedAt - Date.now())).toBeGreaterThan(60_000);
  });

  it('неоднозначные исходы отдаются сохранёнными, а не нулём', async () => {
    rows = [walletRow({ ambiguousOutcomes: 3, scorableOutcomes: 6, pendingOutcomes: 1 })];

    const w = await firstWallet();

    expect(w.summary.ambiguousOutcomes).toBe(3);
    expect(w.summary.pendingOutcomes).toBe(1);
    expect(w.summary.scorableOutcomes).toBe(6);
  });
});

describe('строка, не пересчитанная новыми правилами', () => {
  /** Ровно то, что лежит в боевой базе до `--apply --rescore`. */
  const legacy = (over: Record<string, unknown> = {}) =>
    walletRow({
      tokensBought: 2,
      wins2x: 8,
      wins5x: 3,
      rugs: 0,
      score: 100,
      scorableOutcomes: null,
      pendingOutcomes: null,
      ambiguousOutcomes: null,
      scoreVersion: null,
      scoreComputedAt: null,
      scoreConfidence: null,
      scoreCoverage: null,
      scoreReason: null,
      ...over,
    });

  it('оценка не отдаётся', async () => {
    rows = [legacy()];

    const w = await firstWallet();

    expect(w.summary.score).toBeNull();
    expect(w.score).toBeNull();
  });

  it('состояние честно называется ожиданием пересчёта', async () => {
    rows = [legacy()];

    const w = await firstWallet();

    expect(w.summary.coverage).toBe('stale');
    expect(w.summary.reason).toMatch(/пересч/i);
  });

  it('старые числа не зажимаются и не выдаются за исправленные', async () => {
    rows = [legacy()];

    const w = await firstWallet();

    // Восемь побед при двух токенах — та самая доля в 400%.
    // Ни в каком виде наружу они не уходят.
    expect(w.summary.wins2x).toBe(0);
    expect(w.summary.hitRate).toBeNull();
    expect(w.summary.avgPeakMultiple).toBeNull();
  });

  it('версия прежних правил не подменяется нынешней', async () => {
    rows = [legacy({ scoreVersion: 1, scoreComputedAt: new Date('2026-01-01T00:00:00Z') })];

    const w = await firstWallet();

    expect(w.summary.scoreVersion).toBe(1);
    expect(w.summary.coverage).toBe('stale');
  });

  it('сколько строк ждёт пересчёта — видно снаружи', async () => {
    rows = [legacy()];

    const res = await app.inject({ method: 'GET', url: '/wallets/top' });

    // Пустой список оценок из-за непройденного пересчёта и пустой
    // из-за отсутствия смарт-денег — разные вещи.
    expect(res.json().coverage.walletsAwaitingRecompute).toBe(1);
  });
});

describe('противоречивая строка не доезжает до экрана', () => {
  it('победы больше знаменателя — строка уходит как ожидающая пересчёта', async () => {
    // Записать такое пересчёт не может: инварианты стоят и там.
    // Но в базу можно попасть скриптом или ручным UPDATE.
    rows = [walletRow({ wins2x: 9, scorableOutcomes: 3 })];

    const w = await firstWallet();

    expect(w.summary.coverage).toBe('stale');
    expect(w.summary.score).toBeNull();
    expect(w.summary.hitRate).toBeNull();
  });
});

describe('Activity отдаёт только локальный PnL', () => {
  it('не публикует число OKX и читает сохранённое локальное', async () => {
    activityRows = [{
      id: 'event-1',
      chain: 'SOLANA',
      walletAddress: WALLET,
      tokenAddress: 'Token1111111111111111111111111111111111',
      tokenSymbol: 'TKN',
      side: 'SELL',
      quoteSymbol: 'USDC',
      quoteAmount: dec(60),
      priceUsd: dec(15),
      marketCapUsd: dec(100_000),
      // Это поле существует в строке, но маршрут его даже не выбирает.
      realizedPnlUsd: dec(999_999),
      txHash: 'tx-1',
      trackerType: 1,
      source: 'okx_websocket',
      tradedAt: new Date('2026-08-25T10:00:00Z'),
      receivedAt: new Date('2026-08-25T10:00:01Z'),
      localRealizedPnlUsd: dec(20),
      localPnlState: 'available',
      pnlVersion: 1,
      pnlComputedAt: new Date('2026-08-25T10:00:02Z'),
    }];

    const response = await app.inject({ method: 'GET', url: '/wallets/activity' });
    expect(response.statusCode).toBe(200);
    const event = response.json().events[0];

    expect(event.realizedPnlUsd).toBe(20);
    expect(event.realizedPnlUsd).not.toBe(999_999);
    expect(event.pnlSource).toBe('local');
    expect(JSON.stringify(event)).not.toContain('providerPnl');
  });

  it('USD-фильтр применяется только к долларовым котировкам', async () => {
    activityRows = [];

    const response = await app.inject({
      method: 'GET',
      url: '/wallets/activity?minVolumeUsd=1000',
    });

    expect(response.statusCode).toBe(200);
    expect(activityFindArgs.where.quoteAmount).toEqual({ gte: 1000 });
    expect(activityFindArgs.where.quoteSymbol.in).toContain('USDC');
    expect(activityFindArgs.where.quoteSymbol.in).toContain('USDT');
    expect(activityFindArgs.where.quoteSymbol.in).not.toContain('SOL');
  });

  it('строка старой версии остаётся pending, а не получает provider PnL', async () => {
    activityRows = [{
      id: 'event-old', chain: 'SOLANA', walletAddress: WALLET,
      tokenAddress: 'Token1111111111111111111111111111111111', tokenSymbol: 'TKN',
      side: 'SELL', quoteSymbol: 'USDC', quoteAmount: dec(60), priceUsd: dec(15),
      marketCapUsd: null, realizedPnlUsd: dec(500), txHash: null, trackerType: 1,
      source: 'okx_rest', tradedAt: new Date(), receivedAt: new Date(),
      localRealizedPnlUsd: null, localPnlState: null, pnlVersion: null, pnlComputedAt: null,
    }];

    const event = (await app.inject({ method: 'GET', url: '/wallets/activity' })).json().events[0];
    expect(event.pnlState).toBe('pending');
    expect(event.realizedPnlUsd).toBeNull();
    expect(event.pnlSource).toBeNull();
  });
});
