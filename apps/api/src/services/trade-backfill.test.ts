import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Свёртка старых дублей.
 *
 * Проверяется настоящий сервис с поддельной базой, повторяющей
 * ограничения, которые здесь важны: ключ уникален, `updateMany`
 * задевает ровно перечисленные строки, транзакция выполняет тело.
 *
 * Главное свойство — идемпотентность. Второй проход, сложивший
 * каноническую строку с её же источниками, удвоил бы объём позиции,
 * и заметить это на экране было бы нечем.
 */

/** Таблица `WalletEconomicTrade` в памяти. */
let table = new Map<string, Record<string, unknown>>();
let lockHeld = false;

const dec = (v: string | number) => ({
  toString: () => String(v),
});

vi.mock('../lib/prisma.js', () => {
  const matches = (row: Record<string, unknown>, where: Record<string, any>): boolean => {
    for (const [field, cond] of Object.entries(where)) {
      if (cond == null) continue;

      if (field === 'reconciliation' && cond.in) {
        if (!cond.in.includes(row.reconciliation)) return false;
        continue;
      }

      if (field === 'key' && cond?.in) {
        if (!cond.in.includes(row.key)) return false;
        continue;
      }

      if (field === 'key' && cond?.gt != null) {
        if (String(row.key) <= String(cond.gt)) return false;
        continue;
      }

      if (field === 'tradedAt' && cond instanceof Date) {
        if ((row.tradedAt as Date).getTime() !== cond.getTime()) return false;
        continue;
      }

      if (typeof cond === 'object' && !(cond instanceof Date)) continue;
      if (row[field] !== cond) return false;
    }
    return true;
  };

  const model = {
    findMany: async (args: any = {}) => {
      /*
       * Сортировка тем же сравнением, что и фильтр `key > cursor`.
       *
       * `localeCompare` упорядочивает без учёта регистра, а фильтр
       * сравнивает байты. В подделке это давало страницу, которая
       * возвращала уже пройденную строку, — в Postgres обе операции
       * идут одной коллацией, и такого расхождения нет.
       */
      let rows = [...table.values()].filter((r) => matches(r, args.where ?? {}));
      rows.sort((a, b) => (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0));

      return args.take ? rows.slice(0, args.take) : rows;
    },
    update: async (args: any) => {
      const row = table.get(args.where.key);
      if (!row) throw new Error('NOT_FOUND');
      table.set(args.where.key, { ...row, ...args.data });
      return row;
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const row of [...table.values()]) {
        if (matches(row, args.where ?? {})) {
          table.set(String(row.key), { ...row, ...args.data });
          count++;
        }
      }
      return { count };
    },
  };

  const prisma: any = {
    walletEconomicTrade: model,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(prisma),
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('pg_try_advisory_lock')) {
        if (lockHeld) return [{ locked: false }];
        lockHeld = true;
        return [{ locked: true }];
      }
      if (sql.includes('pg_advisory_unlock')) {
        lockHeld = false;
        return [{}];
      }
      return [];
    },
  };

  return { prisma, serializable: vi.fn() };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { backfillEconomicTrades } = await import('./trade-backfill.js');

const WALLET = 'GXUC1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB928f';
const PUMP = 's8WsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
const AT = new Date(1_756_000_000_000);

/** Строка, записанная прежними правилами: суммы в ключе. */
const legacyRow = (n: number, over: Record<string, unknown> = {}) => {
  const amount = String(1_000_000 * n);
  const valueUsd = String(12.5 * n);

  return {
    key: `SOLANA|${WALLET}|${PUMP}|BUY|${AT.getTime()}|${amount}|${valueUsd}|0.0000125`,
    chain: 'SOLANA',
    walletAddress: WALLET,
    tokenAddress: PUMP,
    tokenSymbol: 'PUMP',
    side: 'BUY',
    amount: dec(amount),
    valueUsd: dec(valueUsd),
    price: dec('0.0000125'),
    marketCapUsd: dec('41000'),
    providerPnlUsd: null,
    tradedAt: AT,
    fillCount: 1,
    reconciliation: 'canonical',
    supersededBy: null,
    source: 'okx_dex_history',
    ...over,
  };
};

function seed(rows: Record<string, unknown>[]): void {
  table = new Map(rows.map((r) => [String(r.key), r]));
}

beforeEach(() => {
  table = new Map();
  lockHeld = false;
});

describe('пробный прогон ничего не меняет', () => {
  it('база остаётся прежней', async () => {
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);
    const before = JSON.stringify([...table.keys()].sort());

    const r = await backfillEconomicTrades();

    expect(r.applied).toBe(false);
    expect(r.canonicalWritten).toBe(0);
    expect(r.supersededWritten).toBe(0);
    expect(JSON.stringify([...table.keys()].sort())).toBe(before);
  });

  it('показывает, сколько строк схлопнется', async () => {
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);

    const r = await backfillEconomicTrades();

    expect(r.scanned).toBe(3);
    expect(r.groups).toBe(1);
    expect(r.multiFillGroups).toBe(1);
    // Три строки одной покупки: одна станет канонической, две свёрнутыми.
    expect(r.wouldSupersede).toBe(2);
    expect(r.walletsAffected).toBe(1);
  });

  it('оставляет все строки нетронутыми по состоянию', async () => {
    seed([legacyRow(1), legacyRow(2)]);

    await backfillEconomicTrades();

    for (const row of table.values()) {
      expect(row.reconciliation).toBe('canonical');
      expect(row.supersededBy).toBeNull();
    }
  });
});

describe('запись сворачивает группу', () => {
  it('одна каноническая строка и две свёрнутые', async () => {
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);

    const r = await backfillEconomicTrades({ apply: true });

    expect(r.canonicalWritten).toBe(1);
    expect(r.supersededWritten).toBe(2);

    const rows = [...table.values()];
    expect(rows.filter((x) => x.reconciliation === 'canonical')).toHaveLength(1);
    expect(rows.filter((x) => x.reconciliation === 'superseded')).toHaveLength(2);
  });

  it('суммы складываются в каноническую строку', async () => {
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);

    await backfillEconomicTrades({ apply: true });

    const canonical = [...table.values()].find((x) => x.reconciliation === 'canonical')!;

    // 1 000 000 + 2 000 000 + 3 000 000
    expect(String(canonical.amount)).toBe('6000000');
    expect(String(canonical.valueUsd)).toBe('75');
    expect(canonical.fillCount).toBe(3);
  });

  it('история не удаляется', async () => {
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);

    await backfillEconomicTrades({ apply: true });

    expect(table.size).toBe(3);
  });

  it('свёрнутые ссылаются на каноническую', async () => {
    seed([legacyRow(1), legacyRow(2)]);

    await backfillEconomicTrades({ apply: true });

    const canonical = [...table.values()].find((x) => x.reconciliation === 'canonical')!;
    const superseded = [...table.values()].filter((x) => x.reconciliation === 'superseded');

    for (const s of superseded) expect(s.supersededBy).toBe(canonical.key);
  });
});

describe('идемпотентность', () => {
  it('повторный запуск не меняет суммы', async () => {
    /*
     * Главная проверка файла. Второй проход, сложивший каноническую
     * строку с её же источниками, удвоил бы объём позиции — и заметить
     * это на экране было бы нечем.
     */
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);

    await backfillEconomicTrades({ apply: true });
    const afterFirst = String(
      [...table.values()].find((x) => x.reconciliation === 'canonical')!.amount,
    );

    const second = await backfillEconomicTrades({ apply: true });
    const afterSecond = String(
      [...table.values()].find((x) => x.reconciliation === 'canonical')!.amount,
    );

    expect(afterSecond).toBe(afterFirst);
    expect(second.wouldSupersede).toBe(0);
  });

  it('свёрнутые строки во второй проход не берутся', async () => {
    seed([legacyRow(1), legacyRow(2)]);

    await backfillEconomicTrades({ apply: true });
    const second = await backfillEconomicTrades();

    // Просмотрена только каноническая: остальные исключены условием.
    expect(second.scanned).toBe(1);
  });

  it('прерванный проход продолжается корректно', async () => {
    // Первый проход ограничен одной строкой, второй доделывает.
    seed([legacyRow(1), legacyRow(2), legacyRow(3)]);

    await backfillEconomicTrades({ apply: true, limit: 1, batchSize: 1 });
    await backfillEconomicTrades({ apply: true });

    const canonical = [...table.values()].filter((x) => x.reconciliation === 'canonical');

    expect(canonical).toHaveLength(1);
    expect(String(canonical[0]!.amount)).toBe('6000000');
  });

  it('строка, добавленная новым импортом, подхватывается следующим проходом', async () => {
    seed([legacyRow(1), legacyRow(2)]);
    await backfillEconomicTrades({ apply: true });

    // Конкурентный импорт дописал ещё один перевод той же покупки.
    table.set(String(legacyRow(4).key), legacyRow(4));

    await backfillEconomicTrades({ apply: true });

    const canonical = [...table.values()].find((x) => x.reconciliation === 'canonical')!;

    // 3 000 000 (свёрнутые) + 4 000 000 (новый) — источники берутся
    // заново, а не прибавляются к уже агрегированному.
    expect(String(canonical.amount)).toBe('7000000');
  });
});

describe('что не сворачивается', () => {
  it('разное время остаётся разными сделками', async () => {
    seed([
      legacyRow(1),
      legacyRow(2, {
        key: 'other-time',
        tradedAt: new Date(AT.getTime() + 1),
      }),
    ]);

    const r = await backfillEconomicTrades();

    expect(r.groups).toBe(2);
    expect(r.wouldSupersede).toBe(0);
  });

  it('покупка и продажа не смешиваются', async () => {
    seed([legacyRow(1), legacyRow(2, { key: 'sell-row', side: 'SELL' })]);

    const r = await backfillEconomicTrades();

    expect(r.groups).toBe(2);
  });

  it('одиночная уже каноническая строка не трогается', async () => {
    seed([
      legacyRow(1, {
        key: `okx_dex_history|SOLANA|${WALLET}|${PUMP}|BUY|${AT.getTime()}`,
      }),
    ]);

    const r = await backfillEconomicTrades({ apply: true });

    expect(r.canonicalWritten).toBe(0);
  });
});

describe('неоднозначные группы', () => {
  it('нечисловая сумма помечает группу и исключает её из статистики', async () => {
    seed([legacyRow(1), legacyRow(2, { key: 'broken', amount: dec('нет данных') })]);

    const r = await backfillEconomicTrades({ apply: true });

    expect(r.ambiguousGroups).toBe(1);

    const canonical = [...table.values()].find((x) => x.reconciliation === 'ambiguous');
    expect(canonical).toBeDefined();
  });
});

describe('фильтры и защита', () => {
  it('фильтр по кошельку сужает выборку', async () => {
    seed([legacyRow(1), legacyRow(2, { key: 'other-wallet', walletAddress: 'SomeoneElse' })]);

    const r = await backfillEconomicTrades({ wallet: WALLET });

    expect(r.scanned).toBe(1);
  });

  it('два одновременных --apply не запускаются', async () => {
    /*
     * Два процесса, сворачивающих одни и те же группы, увидели бы
     * одинаковый набор источников и записали бы каноническую строку
     * дважды — с разными итогами.
     */
    seed([legacyRow(1)]);
    lockHeld = true;

    await expect(backfillEconomicTrades({ apply: true })).rejects.toThrow(
      'BACKFILL_ALREADY_RUNNING',
    );
  });

  it('пробный прогон блокировку не берёт', async () => {
    // Читать можно и во время записи: чтение ничего не портит.
    seed([legacyRow(1)]);
    lockHeld = true;

    await expect(backfillEconomicTrades()).resolves.toBeDefined();
  });

  it('пустая база обрабатывается без ошибок', async () => {
    const r = await backfillEconomicTrades({ apply: true });

    expect(r.scanned).toBe(0);
    expect(r.groups).toBe(0);
  });
});
