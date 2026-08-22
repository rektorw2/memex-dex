import { describe, it, expect } from 'vitest';
import {
  SUBSCRIPTION_CATALOG,
  SUBSCRIPTION_TERM_DAYS,
  SUBSCRIPTION_TERM_MS,
  catalogEntryFor,
  catalogList,
  subscriptionPriceFor,
  isPaidPlan,
  paidPeriodEnd,
  renewalPeriodEnd,
  sameMoney,
} from './subscription-catalog.js';

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe('каталог', () => {
  it('три плана с ценами в USDC', () => {
    expect(catalogList().map((e) => [e.plan, e.price.amount, e.price.currency])).toEqual([
      ['PRO', '50.00', 'USDC'],
      ['SEMI_AUTO', '100.00', 'USDC'],
      ['FULL_AUTO', '200.00', 'USDC'],
    ]);
  });

  it('USDT в каталоге не осталось', () => {
    expect(JSON.stringify(SUBSCRIPTION_CATALOG)).not.toContain('USDT');
  });

  it('срок ровно тридцать суток у каждого плана', () => {
    // Не «месяц»: месяц бывает 28, 29, 30 и 31 день, и спор о трёх
    // днях однажды пришлось бы разбирать вручную.
    expect(SUBSCRIPTION_TERM_DAYS).toBe(30);
    expect(SUBSCRIPTION_TERM_MS).toBe(30 * DAY);

    for (const e of catalogList()) expect(e.termDays).toBe(30);
  });

  it('платят долларами, получают USDC в Solana', () => {
    for (const e of catalogList()) {
      expect(e.sourceCurrency).toBe('USD');
      expect(e.price.currency).toBe('USDC');
      expect(e.settlementChain).toBe('SOLANA');
    }
  });

  it('суммы — строки с двумя знаками', () => {
    // Сумма уходит в платёжную систему как есть; «50» вместо «50.00» —
    // лишний повод для расхождения при сверке.
    for (const e of catalogList()) {
      expect(typeof e.price.amount).toBe('string');
      expect(typeof e.sourceAmount).toBe('string');
      expect(e.price.amount).toMatch(/^\d+\.\d{2}$/);
      expect(e.sourceAmount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('нигде в каталоге нет числа с плавающей точкой', () => {
    const walk = (v: unknown): void => {
      if (typeof v === 'number') throw new Error('в каталоге появилось число');
      if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };

    for (const e of catalogList()) {
      walk({ ...e, termDays: undefined });
    }
  });

  it('цена и запись достаются по коду плана', () => {
    expect(subscriptionPriceFor('SEMI_AUTO')).toEqual({ amount: '100.00', currency: 'USDC' });
    expect(catalogEntryFor('FULL_AUTO').sourceAmount).toBe('200.00');
  });

  it('покупаемые планы отличаются от прочих', () => {
    expect(isPaidPlan('PRO')).toBe(true);
    expect(isPaidPlan('TRIAL')).toBe(false);
    expect(isPaidPlan('EXPIRED')).toBe(false);
    expect(isPaidPlan('чужая строка')).toBe(false);
  });
});

describe('срок оплаченного периода', () => {
  it('тридцать суток от момента оплаты', () => {
    expect(paidPeriodEnd(NOW)).toBe(NOW + 30 * DAY);
  });

  it('продление действующей подписки не сжигает остаток', () => {
    // Человек, заплативший заранее, теряет остаток, если считать
    // от «сейчас», — и справедливо считает это обманом.
    const expiresAt = NOW + 10 * DAY;

    expect(renewalPeriodEnd(NOW, expiresAt)).toBe(expiresAt + 30 * DAY);
  });

  it('продление истёкшей считается от текущего момента', () => {
    const expired = NOW - 5 * DAY;

    expect(renewalPeriodEnd(NOW, expired)).toBe(NOW + 30 * DAY);
  });

  it('без прежней подписки — тоже от текущего момента', () => {
    expect(renewalPeriodEnd(NOW, null)).toBe(NOW + 30 * DAY);
  });

  it('ровно в момент истечения отсчёт идёт от сейчас', () => {
    expect(renewalPeriodEnd(NOW, NOW)).toBe(NOW + 30 * DAY);
  });

  it('два продления подряд дают шестьдесят суток', () => {
    const first = renewalPeriodEnd(NOW, null);
    const second = renewalPeriodEnd(NOW, first);

    expect(second - NOW).toBe(60 * DAY);
  });
});

describe('сравнение сумм', () => {
  it('запись не меняет величину', () => {
    expect(sameMoney('50.00', '50')).toBe(true);
    expect(sameMoney('50.00', '50.000')).toBe(true);
    expect(sameMoney('050.00', '50')).toBe(true);
    expect(sameMoney(' 50.00 ', '50.00')).toBe(true);
  });

  it('разные суммы не совпадают', () => {
    expect(sameMoney('50.00', '50.01')).toBe(false);
    expect(sameMoney('50.00', '500.00')).toBe(false);
    expect(sameMoney('50.00', '5.00')).toBe(false);
  });

  it('минус ноль равен нулю', () => {
    expect(sameMoney('-0.00', '0')).toBe(true);
  });

  it('мусор не совпадает ни с чем', () => {
    expect(sameMoney('пятьдесят', '50.00')).toBe(false);
    expect(sameMoney('', '0')).toBe(false);
    expect(sameMoney('50,00', '50.00')).toBe(false);
    expect(sameMoney('1e2', '100')).toBe(false);
  });

  it('большие суммы не теряют точность', () => {
    // Через parseFloat эти две суммы стали бы одинаковыми.
    expect(sameMoney('9007199254740993.00', '9007199254740992.00')).toBe(false);
  });
});
