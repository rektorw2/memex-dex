import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Переполнение колонки не должно ронять обход кошелька.
 *
 * В Render падало так:
 *
 *     Invalid `prisma.walletEconomicTrade.create()`
 *     22003: numeric field overflow
 *     A field with precision 40, scale 18 must round to an absolute
 *     value less than 10^22
 *
 * Строки провайдера оборачивались в `Decimal` напрямую. `Decimal`
 * о границах колонки не знает — их знает Postgres, и сообщает
 * о нарушении отказом всей вставки. Обход кошелька на этом
 * прерывался: одна битая строка стоила всех остальных.
 */

/** Что дошло до базы. */
let created: Record<string, any>[] = [];
/** Ключи, уже лежащие в базе. */
let existingKeys = new Set<string>();

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    walletEconomicTrade: {
      findUnique: async (args: any) =>
        existingKeys.has(args.where.key) ? { key: args.where.key } : null,
      create: async (args: any) => {
        /*
         * Подделка ведёт себя как Postgres: проверяет границы
         * и отказывает. Иначе тест подтверждал бы, что мы отправили
         * запрос, а не что запрос допустим.
         */
        const limits: Record<string, [number, number]> = {
          amount: [40, 18],
          valueUsd: [30, 10],
          price: [40, 20],
          marketCapUsd: [30, 10],
          providerPnlUsd: [30, 10],
        };

        for (const [field, [precision, scale]] of Object.entries(limits)) {
          const raw = args.data[field];
          if (raw == null) continue;

          const value = Number(raw.toString());
          if (!Number.isFinite(value) || Math.abs(value) >= 10 ** (precision - scale)) {
            const e: any = new Error(
              `numeric field overflow: ${field} precision ${precision}, scale ${scale}`,
            );
            e.code = 'P2000';
            throw e;
          }
        }

        created.push(args.data);
        return args.data;
      },
    },
  };

  return { prisma, serializable: vi.fn() };
});

const warnings: Record<string, unknown>[] = [];

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (payload: Record<string, unknown>) => {
      warnings.push(payload);
    },
  },
}));

const { walletLedgerRepo, tradeFitRejections, resetTradeFitRejections } = await import(
  './wallet-ledger-repo.js'
);

const AT = Date.parse('2026-08-25T10:00:00.000Z');

const trade = (over: Record<string, unknown> = {}) => ({
  key: `k-${Math.random()}`,
  chain: 'SOLANA',
  wallet: 'GXUC1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB928f',
  tokenAddress: 's8WsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump',
  tokenSymbol: 'PUMP',
  side: 'BUY' as const,
  amount: '1000000',
  valueUsd: '75',
  price: '0.000075',
  marketCapUsd: '41000',
  providerPnlUsd: null,
  tradedAt: AT,
  ...over,
});

beforeEach(() => {
  created = [];
  existingKeys = new Set();
  warnings.length = 0;
  resetTradeFitRejections();
});

describe('сделка, не помещающаяся в колонку', () => {
  it('не доходит до базы и не бросает', async () => {
    const result = await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'huge', amount: '1e30' }),
    ] as never);

    expect(result.created).toBe(0);
    expect(result.rejected).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('Postgres 22003 на этом пути больше не возникает', async () => {
    // Подделка бросает ровно там, где бросал бы Postgres.
    // Если проверка перестанет работать, тест упадёт исключением,
    // а не ассертом — и это тоже сигнал.
    await expect(
      walletLedgerRepo.persistCanonicalTrades([trade({ amount: '1e40' })] as never),
    ).resolves.toBeTruthy();
  });

  it('одна плохая между двумя нормальными: обе нормальные записаны', async () => {
    const result = await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'ok-1' }),
      trade({ key: 'bad', price: '1e30' }),
      trade({ key: 'ok-2' }),
    ] as never);

    expect(result.created).toBe(2);
    expect(result.rejected).toBe(1);
    expect(created.map((c) => c.key)).toEqual(['ok-1', 'ok-2']);
  });

  it('причина попадает в счётчик по коду', async () => {
    await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'a', amount: '1e30' }),
      trade({ key: 'b', valueUsd: '1e30' }),
      trade({ key: 'c', amount: '1e30' }),
    ] as never);

    expect(tradeFitRejections()).toEqual({
      AMOUNT_OUT_OF_RANGE: 2,
      VALUE_OUT_OF_RANGE: 1,
    });
  });

  it('в журнал уходит код причины, но не суммы', async () => {
    await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'secret-key', amount: '123456789012345678901234567890' }),
    ] as never);

    const [warn] = warnings;

    expect(warn).toMatchObject({ reason: 'AMOUNT_OUT_OF_RANGE', key: 'secret-key' });
    // Финансовые величины в журнале живут дольше, чем нужно,
    // и попадают туда, куда им попадать незачем.
    expect(JSON.stringify(warn)).not.toContain('123456789012345678901234567890');
  });
});

describe('необязательные поля', () => {
  it('слишком большая капитализация становится null, сделка остаётся', async () => {
    const result = await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'ok', marketCapUsd: '1e30' }),
    ] as never);

    expect(result.created).toBe(1);
    // `null` дальше по цепочке честно читается как «база кратности
    // неизвестна» и выводит исход из оценки. Обрезанное число
    // прошло бы в расчёт как настоящее.
    expect(created[0]!.marketCapUsd).toBeNull();
  });

  it('нормальная капитализация записывается как есть', async () => {
    await walletLedgerRepo.persistCanonicalTrades([trade({ key: 'ok' })] as never);

    expect(created[0]!.marketCapUsd?.toString()).toBe('41000');
  });

  it('PnL провайдера вне границы тоже обнуляется, а не роняет сделку', async () => {
    const result = await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'ok', providerPnlUsd: '-1e30' }),
    ] as never);

    expect(result.created).toBe(1);
    expect(created[0]!.providerPnlUsd).toBeNull();
  });
});

describe('обычный ход не изменился', () => {
  it('нормальные сделки записываются', async () => {
    const result = await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'a' }),
      trade({ key: 'b' }),
    ] as never);

    expect(result.created).toBe(2);
    expect(result.rejected).toBe(0);
  });

  it('дубли по-прежнему считаются отдельно от отказов', async () => {
    existingKeys = new Set(['dup']);

    const result = await walletLedgerRepo.persistCanonicalTrades([
      trade({ key: 'dup' }),
      trade({ key: 'bad', amount: 'NaN' }),
      trade({ key: 'new' }),
    ] as never);

    // Дубль означает «запись уже есть», отказ — «записи не будет».
    // Складывать их в одно число значит спрятать потерю данных.
    expect(result).toMatchObject({ created: 1, duplicates: 1, rejected: 1 });
  });
});
