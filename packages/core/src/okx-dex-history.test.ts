import { describe, it, expect } from 'vitest';
import {
  parseHistoryPage,
  canonicalKey,
  sortForLedger,
  dedupeCanonical,
  isLedgerType,
  DEX_HISTORY_TYPE,
} from './okx-dex-history.js';

/** Образец по контракту из документации OKX. */
const page = {
  transactionList: [
    {
      type: '1', chainIndex: '501', tokenContractAddress: 'Tok1', tokenSymbol: 'AAA',
      valueUsd: '1250.50', amount: '1000000.123456789012345678',
      price: '0.00125050', marketCap: '410000', pnlUsd: '0', time: '1786800000000',
    },
    {
      type: '2', chainIndex: '501', tokenContractAddress: 'Tok1', tokenSymbol: 'AAA',
      valueUsd: '3400.00', amount: '1000000.123456789012345678',
      price: '0.00340000', marketCap: '1100000', pnlUsd: '2149.50', time: '1786803600000',
    },
    {
      type: '3', chainIndex: '501', tokenContractAddress: 'Tok2', tokenSymbol: 'BBB',
      valueUsd: '500', amount: '10', price: '50', marketCap: '0', pnlUsd: '0', time: '1786804000000',
    },
    {
      type: '4', chainIndex: '501', tokenContractAddress: 'Tok2', tokenSymbol: 'BBB',
      valueUsd: '500', amount: '10', price: '50', marketCap: '0', pnlUsd: '0', time: '1786804100000',
    },
  ],
  cursor: 'AbCdEf==',
};

const ctx = { chain: 'SOLANA' as const, wallet: 'Wal1' };

describe('разбор истории', () => {
  it('покупки и продажи попадают в расчёт', () => {
    const r = parseHistoryPage(page, ctx);
    expect(r.trades).toHaveLength(2);
    expect(r.trades[0]!.side).toBe('BUY');
    expect(r.trades[1]!.side).toBe('SELL');
  });

  it('переводы в расчёт не попадают', () => {
    // Приход переводом — не покупка: цены входа не было,
    // и любой рост выглядел бы прибылью.
    const r = parseHistoryPage(page, ctx);
    expect(r.skipped.transfer).toBe(2);
    expect(r.trades.some((t) => t.tokenAddress === 'Tok2')).toBe(false);
  });

  it('точность количества не теряется', () => {
    // Восемнадцать знаков после запятой в double превращаются
    // в другое число молча.
    const r = parseHistoryPage(page, ctx);
    expect(r.trades[0]!.amount).toBe('1000000.123456789012345678');
    expect(typeof r.trades[0]!.amount).toBe('string');
  });

  it('курсор отдаётся как есть', () => {
    expect(parseHistoryPage(page, ctx).cursor).toBe('AbCdEf==');
  });

  it('строка без точного количества отбрасывается', () => {
    // Подставлять приблизительное значение нельзя — ради этого
    // модуль и существует.
    const r = parseHistoryPage(
      { transactionList: [{ ...page.transactionList[0], amount: '' }] },
      ctx,
    );
    expect(r.trades).toHaveLength(0);
    expect(r.skipped.missing_amounts).toBe(1);
  });

  it('строка без времени или токена отбрасывается', () => {
    const r = parseHistoryPage(
      { transactionList: [{ ...page.transactionList[0], time: '' }] },
      ctx,
    );
    expect(r.skipped.missing_key_fields).toBe(1);
  });

  it('мусор вместо страницы не роняет разбор', () => {
    expect(parseHistoryPage(null, ctx).trades).toEqual([]);
    expect(parseHistoryPage('строка', ctx).skipped.malformed).toBe(1);
  });

  it('пустая история — законный результат', () => {
    const r = parseHistoryPage({ transactionList: [], cursor: '' }, ctx);
    expect(r.trades).toEqual([]);
    expect(r.cursor).toBeNull();
  });
});

describe('нормализация адресов', () => {
  it('EVM приводится к нижнему регистру', () => {
    const r = parseHistoryPage(
      { transactionList: [{ ...page.transactionList[0], tokenContractAddress: '0xAABBCC' }] },
      { chain: 'ETHEREUM', wallet: '0xDDEEFF' },
    );
    expect(r.trades[0]!.tokenAddress).toBe('0xaabbcc');
    expect(r.trades[0]!.wallet).toBe('0xddeeff');
  });

  it('Solana сохраняет регистр', () => {
    const r = parseHistoryPage(page, ctx);
    expect(r.trades[0]!.tokenAddress).toBe('Tok1');
    expect(r.trades[0]!.wallet).toBe('Wal1');
  });
});

describe('канонический ключ', () => {
  const base = {
    chain: 'SOLANA' as const, wallet: 'W', tokenAddress: 'T', side: 'BUY',
    tradedAt: 1, amount: '10', valueUsd: '100', price: '10',
  };

  it('устойчив', () => {
    expect(canonicalKey(base)).toBe(canonicalKey(base));
  });

  it('символ токена в ключ не входит', () => {
    // Символ не уникален и меняется; идентификатор — адрес контракта.
    expect(canonicalKey(base)).not.toContain('AAA');
  });

  it('различает сделки по любому полю', () => {
    expect(canonicalKey({ ...base, amount: '11' })).not.toBe(canonicalKey(base));
    expect(canonicalKey({ ...base, side: 'SELL' })).not.toBe(canonicalKey(base));
    expect(canonicalKey({ ...base, tradedAt: 2 })).not.toBe(canonicalKey(base));
  });

  it('повторная строка истории даёт тот же ключ', () => {
    const a = parseHistoryPage(page, ctx).trades[0]!;
    const b = parseHistoryPage(page, ctx).trades[0]!;
    expect(a.key).toBe(b.key);
    expect(dedupeCanonical([a, b])).toHaveLength(1);
  });
});

describe('порядок для пересчёта', () => {
  it('по времени', () => {
    const r = parseHistoryPage(page, ctx);
    const sorted = sortForLedger([r.trades[1]!, r.trades[0]!]);
    expect(sorted[0]!.side).toBe('BUY');
  });

  it('при совпадении времени порядок устойчив', () => {
    // Две сделки в одном блоке имеют одно время. Без второго
    // условия пересчёт давал бы разный результат при разном
    // порядке получения страниц.
    const same = { transactionList: [
      { ...page.transactionList[0], amount: '5' },
      { ...page.transactionList[0], amount: '7' },
    ]};
    const t = parseHistoryPage(same, ctx).trades;
    expect(sortForLedger(t).map((x) => x.key))
      .toEqual(sortForLedger([...t].reverse()).map((x) => x.key));
  });
});

describe('виды операций', () => {
  it('только покупка и продажа', () => {
    expect(isLedgerType(DEX_HISTORY_TYPE.buy)).toBe(true);
    expect(isLedgerType(DEX_HISTORY_TYPE.sell)).toBe(true);
    expect(isLedgerType(DEX_HISTORY_TYPE.transferIn)).toBe(false);
    expect(isLedgerType(DEX_HISTORY_TYPE.transferOut)).toBe(false);
    expect(isLedgerType(null)).toBe(false);
  });
});
