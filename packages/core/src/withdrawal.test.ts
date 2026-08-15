import { describe, it, expect } from 'vitest';
import { quoteWithdrawal, maxWithdrawal } from './withdrawal.js';

const FEE = 500; // 5%

describe('quoteWithdrawal — режим GROSS', () => {
  it('удерживает комиссию из запрошенной суммы', () => {
    const q = quoteWithdrawal({ amount: '100', available: '1000', feeBps: FEE });

    expect(q.error).toBeNull();
    expect(Number(q.grossAmount)).toBe(100);
    expect(Number(q.feeAmount)).toBe(5);
    expect(Number(q.netAmount)).toBe(95);
  });

  it('списываемое и полученное сходятся с комиссией', () => {
    const q = quoteWithdrawal({ amount: '137.42', available: '1000', feeBps: FEE });
    expect(Number(q.feeAmount) + Number(q.netAmount)).toBeCloseTo(Number(q.grossAmount), 12);
  });

  it('весь остаток выводится без отказа', () => {
    // Самый частый способ упереться в отказ: человек подставляет
    // доступную сумму, а комиссия сверху делает запрос невыполнимым.
    const q = quoteWithdrawal({ amount: '1000', available: '1000', feeBps: FEE });
    expect(q.error).toBeNull();
    expect(Number(q.netAmount)).toBe(950);
  });
});

describe('quoteWithdrawal — режим NET', () => {
  it('начисляет комиссию сверх запрошенного', () => {
    const q = quoteWithdrawal({ amount: '95', available: '1000', feeBps: FEE, mode: 'NET' });

    expect(q.error).toBeNull();
    expect(Number(q.netAmount)).toBeCloseTo(95, 10);
    expect(Number(q.grossAmount)).toBeCloseTo(100, 10);
    expect(Number(q.feeAmount)).toBeCloseTo(5, 10);
  });

  it('обратим с режимом GROSS', () => {
    const gross = quoteWithdrawal({ amount: '250', available: '1000', feeBps: FEE });
    const net = quoteWithdrawal({
      amount: gross.netAmount,
      available: '1000',
      feeBps: FEE,
      mode: 'NET',
    });
    expect(Number(net.grossAmount)).toBeCloseTo(250, 10);
  });

  it('отказ объясняет, сколько нужно списать', () => {
    const q = quoteWithdrawal({ amount: '1000', available: '1000', feeBps: FEE, mode: 'NET' });
    expect(q.error).toContain('нужно списать');
  });
});

describe('quoteWithdrawal — отказы', () => {
  it('нулевая и отрицательная сумма', () => {
    expect(quoteWithdrawal({ amount: '0', available: '100', feeBps: FEE }).error).toBeTruthy();
    expect(quoteWithdrawal({ amount: '-5', available: '100', feeBps: FEE }).error).toBeTruthy();
  });

  it('превышение остатка', () => {
    const q = quoteWithdrawal({ amount: '101', available: '100', feeBps: FEE });
    expect(q.error).toContain('Не хватает средств');
  });

  it('минимум проверяется по итоговой сумме, а не по списываемой', () => {
    // Смысл минимума в том, чтобы на адрес не ушла пыль дороже
    // сетевой комиссии, поэтому сравнивать надо то, что придёт.
    const q = quoteWithdrawal({
      amount: '10',
      available: '1000',
      feeBps: FEE,
      minAmount: '9.6',
    });
    expect(q.error).toContain('меньше минимума');

    const ok = quoteWithdrawal({
      amount: '10',
      available: '1000',
      feeBps: FEE,
      minAmount: '9.4',
    });
    expect(ok.error).toBeNull();
  });

  it('комиссия 100% не даёт вывести ничего', () => {
    const q = quoteWithdrawal({ amount: '100', available: '1000', feeBps: 10_000 });
    expect(q.error).toBeTruthy();
  });
});

describe('quoteWithdrawal — суммы в долларах', () => {
  it('считаются, когда цена известна', () => {
    const q = quoteWithdrawal({ amount: '100', available: '1000', feeBps: FEE, priceUsd: '2' });
    expect(q.feeUsd).toBe('10.00');
    expect(q.netUsd).toBe('190.00');
  });

  it('остаются пустыми без цены', () => {
    const q = quoteWithdrawal({ amount: '100', available: '1000', feeBps: FEE });
    expect(q.feeUsd).toBeNull();
    expect(q.netUsd).toBeNull();

    const zero = quoteWithdrawal({ amount: '100', available: '1000', feeBps: FEE, priceUsd: '0' });
    expect(zero.feeUsd).toBeNull();
  });
});

describe('quoteWithdrawal — нулевая комиссия', () => {
  it('без комиссии приходит вся сумма', () => {
    const q = quoteWithdrawal({ amount: '100', available: '1000', feeBps: 0 });
    expect(Number(q.feeAmount)).toBe(0);
    expect(Number(q.netAmount)).toBe(100);
  });
});

describe('maxWithdrawal', () => {
  it('весь остаток за вычетом комиссии', () => {
    const m = maxWithdrawal('1000', FEE);
    expect(Number(m.grossAmount)).toBe(1000);
    expect(Number(m.netAmount)).toBe(950);
  });

  it('результат заведомо проходит проверку', () => {
    const m = maxWithdrawal('777.77', FEE);
    const q = quoteWithdrawal({ amount: m.grossAmount, available: '777.77', feeBps: FEE });
    expect(q.error).toBeNull();
    expect(Number(q.netAmount)).toBeCloseTo(Number(m.netAmount), 12);
  });

  it('нулевой и отрицательный остаток', () => {
    expect(maxWithdrawal('0', FEE)).toEqual({ grossAmount: '0', netAmount: '0' });
    expect(maxWithdrawal('-1', FEE)).toEqual({ grossAmount: '0', netAmount: '0' });
  });
});
