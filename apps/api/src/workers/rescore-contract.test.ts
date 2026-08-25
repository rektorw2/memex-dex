import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Полный пересчёт: что он записывает и что оставляет неизменным.
 *
 * Проверяется настоящий `rescoreAllWallets` с поддельной базой.
 * Дефект, ради которого написан этот файл, состоял в том, что
 * пересчёт сохранял только победы и число купленных токенов —
 * знаменатель доли попаданий в базу не попадал вовсе, и чтение
 * потом пыталось восстановить его выражением `max(wins2x, rugs)`,
 * теряя всё, что лежит между rug и удвоением.
 *
 * Второе проверяемое свойство — идемпотентность. Второй прогон
 * подряд обязан не изменить ни одного значимого поля; расчёт,
 * зависящий от чего-то, кроме данных, лучше заметить здесь,
 * чем на боевой базе.
 */

const CHAIN = 'SOLANA';
const WALLET = 'GXUC1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB928f';
const AT = 1_756_000_000_000;
const HOUR = 3_600_000;

const dec = (v: number | string) => ({ toString: () => String(v) });

/** Одна покупка в таблице `WalletTrade`. */
const trade = (token: string, multiple: number | null, at: number) => ({
  chain: CHAIN,
  tokenAddress: token,
  amountUsd: dec(50),
  outcomeMultiple: multiple == null ? null : dec(multiple),
  poolAgeHours: dec(2),
  mcapAtTradeUsd: dec(50_000),
  priceUsd: dec('0.00005'),
  tradedAt: new Date(at),
});

/**
 * Десять токенов: одна победа, восемь обычных исходов, один rug.
 *
 * Обычные исходы — между 0.2x и 2x. Они оцениваемые, но ни победа,
 * ни rug, и именно они терялись при восстановлении знаменателя.
 */
const TRADES = [
  trade('Win111111111111111111111111111111111111', 3, AT),
  ...Array.from({ length: 8 }, (_, i) =>
    trade(`Mid${i}11111111111111111111111111111111`, 0.9 + i * 0.1, AT + (i + 1) * HOUR),
  ),
  trade('Rug111111111111111111111111111111111111', 0.05, AT + 9 * HOUR),
];

/** Таблица `TraderWallet` в памяти. */
let wallets: Record<string, any>[] = [];
let updates: Record<string, unknown>[] = [];

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    traderWallet: {
      findMany: async (args: any = {}) => {
        let rows = [...wallets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        if (args.where?.trades?.some) rows = rows.filter((row) => row.hasTrades !== false);
        if (args.where?.trades?.none) rows = rows.filter((row) => row.hasTrades === false);

        if (args.cursor) {
          const at = rows.findIndex((r) => r.id === args.cursor.id);
          rows = rows.slice(at + (args.skip ?? 0));
        }

        return args.take ? rows.slice(0, args.take) : rows;
      },
      update: async (args: any) => {
        updates.push(args.data);
        const row = wallets.find((w) => w.id === args.where.id)!;
        Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: any) => {
        const rows = wallets.filter((row) => row.hasTrades === false && row.scoreVersion == null);
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
    },
    walletTrade: { findMany: async () => TRADES },
    radarEvent: { findMany: async () => [] },
  };

  return { prisma, serializable: vi.fn() };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/okx-market.js', () => ({
  fetchWalletHistory: async () => [],
  fetchTopTraders: async () => [],
  fetchPriceInfo: async () => ({ prices: new Map(), report: null }),
}));

const { rescoreAllWallets } = await import('./wallet-tracker.js');
const { SCORE_VERSION } = await import('@memex/core');

/** Строка, записанная прежними правилами: подписи расчёта нет. */
const legacyWallet = () => ({
  id: 'w-1',
  chain: CHAIN,
  address: WALLET,
  score: 100,
  tokensBought: 2,
  wins2x: 8,
  wins5x: 3,
  rugs: 0,
  scorableOutcomes: null,
  pendingOutcomes: null,
  ambiguousOutcomes: null,
  scoreVersion: null,
  hasTrades: true,
});

describe('автоматический переход со старого контракта', () => {
  it('пересчитывает историю и честно обнуляет пустую старую строку', async () => {
    wallets = [
      legacyWallet(),
      {
        ...legacyWallet(),
        id: 'w-empty',
        hasTrades: false,
        label: 'smart',
      },
    ];

    const { rescoreStaleWallets } = await import('./wallet-tracker.js');
    const result = await rescoreStaleWallets(10);

    expect(result).toBe(2);
    expect(wallets.find((wallet) => wallet.id === 'w-empty')).toMatchObject({
      score: null,
      label: 'none',
      scorableOutcomes: 0,
      scoreVersion: SCORE_VERSION,
      scoreCoverage: 'empty',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ scorableOutcomes: 10, scoreVersion: SCORE_VERSION });
  });
});

beforeEach(() => {
  wallets = [legacyWallet()];
  updates = [];
});

describe('пересчёт записывает весь контракт', () => {
  it('знаменатель сохраняется отдельно от побед', async () => {
    await rescoreAllWallets({ apply: true });

    const [data] = updates as any[];

    expect(data.scorableOutcomes).toBe(10);
    expect(data.wins2x).toBe(1);
    expect(data.rugs).toBe(1);
    // Из победителей знаменатель не выводится ни этим выражением,
    // ни любым другим: победы — подмножество.
    expect(data.scorableOutcomes).not.toBe(Math.max(data.wins2x, data.rugs));
    expect(data.scorableOutcomes).not.toBe(data.wins2x + data.rugs);
  });

  it('разбиение исходов записывается целиком', async () => {
    await rescoreAllWallets({ apply: true });

    const [data] = updates as any[];

    expect(data.pendingOutcomes).toBe(0);
    expect(data.ambiguousOutcomes).toBe(0);
    expect(data.tokensBought).toBe(10);
    expect(
      data.scorableOutcomes + data.pendingOutcomes + data.ambiguousOutcomes,
    ).toBe(data.tokensBought);
  });

  it('подпись расчёта заполняется настоящими значениями', async () => {
    const before = Date.now();

    await rescoreAllWallets({ apply: true });

    const [data] = updates as any[];

    expect(data.scoreVersion).toBe(SCORE_VERSION);
    expect(data.scoreComputedAt).toBeInstanceOf(Date);
    // Время расчёта — момент пересчёта, а не момент чтения страницы.
    expect(data.scoreComputedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.scoreConfidence).toBeTruthy();
    expect(data.scoreCoverage).toBeTruthy();
  });

  it('ожидающие пересчёта строки считаются до записи', async () => {
    const r = await rescoreAllWallets({ apply: true });

    expect(r.staleFound).toBe(1);
    expect(r.updated).toBe(1);
  });

  it('оценка на прежних правилах снимается', async () => {
    // Десять исходов при доле попаданий 10% — оценка возможна,
    // но она считается заново, а не наследуется.
    const r = await rescoreAllWallets({ apply: true });
    const [data] = updates as any[];

    expect(data.score).not.toBe(100);
    expect(r.invariantViolations).toBe(0);
  });
});

describe('повторный прогон', () => {
  it('ничего не меняет', async () => {
    await rescoreAllWallets({ apply: true });
    updates = [];

    const second = await rescoreAllWallets({ apply: true });

    expect(second.scanned).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.staleFound).toBe(0);
  });

  it('записывает те же значения', async () => {
    await rescoreAllWallets({ apply: true });
    const first = { ...(updates[0] as any) };

    updates = [];
    await rescoreAllWallets({ apply: true });
    const second = { ...(updates[0] as any) };

    for (const field of [
      'tokensBought',
      'wins2x',
      'wins5x',
      'rugs',
      'scorableOutcomes',
      'pendingOutcomes',
      'ambiguousOutcomes',
      'score',
      'scoreVersion',
    ]) {
      expect(second[field], field).toEqual(first[field]);
    }
  });

  it('пробный прогон не пишет', async () => {
    const r = await rescoreAllWallets();

    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
    // Строка осталась прежней: подпись расчёта по-прежнему пуста.
    expect(wallets[0]!.scoreVersion).toBeNull();
  });
});
