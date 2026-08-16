import { describe, it, expect } from 'vitest';
import {
  assessCoverage,
  checkCompleteness,
  scorableTokens,
  coveragePercent,
  toScaled,
  fromScaled,
  canonicalDecimal,
  PROVIDER_MAX_RECORDS,
} from './ledger-completeness.js';
import { canonicalKey } from './okx-dex-history.js';
import type { CanonicalTrade } from './okx-dex-history.js';

const trade = (o: Partial<CanonicalTrade>): CanonicalTrade => ({
  key: Math.random().toString(36),
  chain: 'SOLANA', wallet: 'W', tokenAddress: 'T', tokenSymbol: null,
  side: 'BUY', amount: '100', valueUsd: '1000', price: '10',
  marketCapUsd: null, providerPnlUsd: null, tradedAt: 1_000, ...o,
});

describe('полнота выгрузки', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => trade({ tradedAt: i }));

  it('курсор исчерпан — история полная', () => {
    const c = assessCoverage({ trades: many(50), pagesFetched: 1, cursorExhausted: true, pageLimitReached: false });
    expect(c.status).toBe('complete');
  });

  it('потолок провайдера при неисчерпанном курсоре — обрезано', () => {
    const c = assessCoverage({
      trades: many(PROVIDER_MAX_RECORDS), pagesFetched: 10,
      cursorExhausted: false, pageLimitReached: false,
    });
    expect(c.status).toBe('truncated');
    expect(c.maxRowsReached).toBe(true);
  });

  it('повтор курсора считается обрезанием', () => {
    // Провайдер зациклился — дальше страниц не будет.
    const c = assessCoverage({
      trades: many(20), pagesFetched: 3, cursorExhausted: false,
      pageLimitReached: false, cursorRepeated: true,
    });
    expect(c.status).toBe('truncated');
  });

  it('предел страниц — обрезано', () => {
    const c = assessCoverage({ trades: many(300), pagesFetched: 3, cursorExhausted: false, pageLimitReached: true });
    expect(c.status).toBe('truncated');
  });

  it('сбой важнее всего остального', () => {
    const c = assessCoverage({
      trades: many(PROVIDER_MAX_RECORDS), pagesFetched: 10,
      cursorExhausted: false, pageLimitReached: true, failed: true,
    });
    expect(c.status).toBe('failed');
  });

  it('границы окна сохраняются', () => {
    const c = assessCoverage({
      trades: [trade({ tradedAt: 500 }), trade({ tradedAt: 900 })],
      pagesFetched: 1, cursorExhausted: true, pageLimitReached: false,
    });
    expect(c.earliestSyncedAt).toBe(500);
    expect(c.latestSyncedAt).toBe(900);
  });
});

describe('осиротевшие продажи', () => {
  it('продажа без покупки помечается', () => {
    // Иначе она считается прибылью целиком: продал на тысячу,
    // вложил ноль. Кошелёк с обрезанной историей становится гением.
    const c = checkCompleteness([trade({ side: 'SELL', amount: '100', tradedAt: 5 })]);
    expect(c[0]!.hasOrphanSell).toBe(true);
    expect(c[0]!.incompleteCostBasis).toBe(true);
  });

  it('продажа сверх купленного помечается', () => {
    const c = checkCompleteness([
      trade({ side: 'BUY', amount: '50', tradedAt: 1 }),
      trade({ side: 'SELL', amount: '120', tradedAt: 2 }),
    ]);
    expect(c[0]!.hasOrphanSell).toBe(true);
    expect(c[0]!.unexplainedSoldAmount).toBe('70');
  });

  it('обычная последовательность проходит', () => {
    const c = checkCompleteness([
      trade({ side: 'BUY', amount: '100', tradedAt: 1 }),
      trade({ side: 'SELL', amount: '100', tradedAt: 2 }),
    ]);
    expect(c[0]!.hasOrphanSell).toBe(false);
  });

  it('частичная продажа не считается осиротевшей', () => {
    const c = checkCompleteness([
      trade({ side: 'BUY', amount: '100', tradedAt: 1 }),
      trade({ side: 'SELL', amount: '30', tradedAt: 2 }),
    ]);
    expect(c[0]!.hasOrphanSell).toBe(false);
  });

  it('порядок по времени учитывается, а не порядок в массиве', () => {
    const c = checkCompleteness([
      trade({ side: 'SELL', amount: '100', tradedAt: 2 }),
      trade({ side: 'BUY', amount: '100', tradedAt: 1 }),
    ]);
    expect(c[0]!.hasOrphanSell).toBe(false);
  });

  it('токены разделяются', () => {
    const c = checkCompleteness([
      trade({ tokenAddress: 'A', side: 'BUY', amount: '10', tradedAt: 1 }),
      trade({ tokenAddress: 'A', side: 'SELL', amount: '10', tradedAt: 2 }),
      trade({ tokenAddress: 'B', side: 'SELL', amount: '5', tradedAt: 3 }),
    ]);
    expect(c.find((x) => x.tokenAddress === 'A')!.hasOrphanSell).toBe(false);
    expect(c.find((x) => x.tokenAddress === 'B')!.hasOrphanSell).toBe(true);
  });

  it('в оценку идут только токены с полной себестоимостью', () => {
    const c = checkCompleteness([
      trade({ tokenAddress: 'A', side: 'BUY', amount: '10', tradedAt: 1 }),
      trade({ tokenAddress: 'B', side: 'SELL', amount: '5', tradedAt: 2 }),
    ]);
    const ok = scorableTokens(c);
    expect(ok.has('A')).toBe(true);
    expect(ok.has('B')).toBe(false);
    expect(coveragePercent(c)).toBe(50);
  });

  it('точность на восемнадцати знаках не даёт ложных расхождений', () => {
    // В double такое количество округляется, и позиция, закрытая
    // ровно в ноль, выглядела бы незакрытой на пылинку.
    const amount = '1000000.123456789012345678';
    const c = checkCompleteness([
      trade({ side: 'BUY', amount, tradedAt: 1 }),
      trade({ side: 'SELL', amount, tradedAt: 2 }),
    ]);
    expect(c[0]!.hasOrphanSell).toBe(false);
  });
});

describe('канонизация чисел', () => {
  it('разное написание одного значения совпадает', () => {
    expect(canonicalDecimal('1')).toBe(canonicalDecimal('1.0'));
    expect(canonicalDecimal('1')).toBe(canonicalDecimal('1.000000'));
    expect(canonicalDecimal('0.500')).toBe(canonicalDecimal('.5'));
  });

  it('значащие знаки сохраняются', () => {
    expect(canonicalDecimal('1000000.123456789012345678')).toBe('1000000.123456789012345678');
  });

  it('туда и обратно без потерь', () => {
    for (const v of ['0', '1', '0.000000000000000001', '999999999.999999999999999999']) {
      expect(fromScaled(toScaled(v))).toBe(canonicalDecimal(v));
    }
  });

  it('мусор даёт ноль, а не исключение', () => {
    expect(toScaled('чепуха')).toBe(0n);
    expect(toScaled('')).toBe(0n);
  });

  it('одна сделка с разным форматированием даёт один ключ', () => {
    // Иначе повтор создаёт вторую запись и удваивает объём позиции.
    const base = { chain: 'SOLANA' as const, wallet: 'W', tokenAddress: 'T', side: 'BUY', tradedAt: 1_000 };
    expect(canonicalKey({ ...base, amount: '100', valueUsd: '1000', price: '10' }))
      .toBe(canonicalKey({ ...base, amount: '100.000', valueUsd: '1000.00', price: '10.0' }));
  });
});
