import { D, type Numeric } from './money.js';

/**
 * Комиссия за вывод средств.
 *
 * Отличается от комиссии за успех и не заменяет её: та берётся с прибыли
 * по копируемым сделкам, эта — с суммы вывода независимо от результата.
 * Человек, потерявший деньги на торговле, платит её тоже.
 *
 * Именно поэтому расчёт возвращает не одно число, а разбор: сколько
 * списывается с баланса, сколько удерживается, сколько дойдёт до адреса.
 * Показывать только «5%» недостаточно — при выводе остатка человек
 * должен видеть точную сумму, которая придёт, до подтверждения.
 */

export interface WithdrawalQuote {
  /** Сколько списывается с баланса. */
  grossAmount: string;
  /** Комиссия платформы. */
  feeAmount: string;
  /** Сколько уйдёт на адрес. */
  netAmount: string;
  feeBps: number;
  /** Комиссия в долларах, если известна цена. */
  feeUsd: string | null;
  netUsd: string | null;
  /** Причина отказа. null — вывод возможен. */
  error: string | null;
}

export interface WithdrawalInput {
  /** Запрошенная сумма. Трактуется по режиму ниже. */
  amount: Numeric;
  /** Доступный остаток на балансе. */
  available: Numeric;
  feeBps: number;
  /** Цена токена в долларах, если известна. */
  priceUsd?: Numeric | null;
  /** Минимальная сумма вывода в токене. */
  minAmount?: Numeric | null;
  /**
   * Что означает запрошенная сумма.
   *
   * GROSS — списать ровно её, комиссия внутри: человек указал, сколько
   *   готов потратить, и получит меньше.
   * NET — человек хочет получить ровно её, комиссия сверху.
   *
   * Различие существенное: при выводе «всего остатка» правильный режим
   * только GROSS, иначе запрос всегда превышает баланс на величину
   * комиссии и отклоняется без внятной причины.
   */
  mode?: 'GROSS' | 'NET';
}

const FAIL = (error: string, feeBps: number): WithdrawalQuote => ({
  grossAmount: '0',
  feeAmount: '0',
  netAmount: '0',
  feeBps,
  feeUsd: null,
  netUsd: null,
  error,
});

export function quoteWithdrawal(input: WithdrawalInput): WithdrawalQuote {
  const feeBps = Number.isFinite(input.feeBps) ? Math.max(0, Math.min(10_000, input.feeBps)) : 0;
  const amount = D(input.amount);
  const available = D(input.available);

  if (!amount.isFinite() || amount.lte(0)) {
    return FAIL('Сумма должна быть больше нуля', feeBps);
  }

  const mode = input.mode ?? 'GROSS';

  // При NET комиссия начисляется сверх запрошенного, поэтому с баланса
  // спишется больше, чем человек ввёл. Делитель, а не умножение:
  // net = gross × (1 − f), значит gross = net ÷ (1 − f).
  const feeRate = D(feeBps).div(10_000);

  let gross = amount;
  if (mode === 'NET') {
    if (feeRate.gte(1)) return FAIL('Комиссия не может быть 100% и выше', feeBps);
    gross = amount.div(D(1).minus(feeRate));
  }

  const fee = gross.times(feeRate);
  const net = gross.minus(fee);

  if (gross.gt(available)) {
    return FAIL(
      mode === 'NET'
        ? `Не хватает средств: чтобы получить ${amount.toString()}, нужно списать ${gross.toString()}, доступно ${available.toString()}`
        : `Не хватает средств: запрошено ${gross.toString()}, доступно ${available.toString()}`,
      feeBps,
    );
  }

  const min = input.minAmount != null ? D(input.minAmount) : null;
  if (min && min.gt(0) && net.lt(min)) {
    // Проверяем итоговую сумму, а не списываемую: смысл минимума в том,
    // чтобы на адрес не ушла пыль дороже сетевой комиссии.
    return FAIL(
      `После удержания на адрес придёт ${net.toString()}, это меньше минимума ${min.toString()}`,
      feeBps,
    );
  }

  if (net.lte(0)) {
    return FAIL('После удержания комиссии не остаётся ничего', feeBps);
  }

  const price = input.priceUsd != null ? D(input.priceUsd) : null;
  const hasPrice = price != null && price.isFinite() && price.gt(0);

  return {
    grossAmount: gross.toString(),
    feeAmount: fee.toString(),
    netAmount: net.toString(),
    feeBps,
    feeUsd: hasPrice ? fee.times(price).toFixed(2) : null,
    netUsd: hasPrice ? net.times(price).toFixed(2) : null,
    error: null,
  };
}

/**
 * Максимум, который можно вывести с текущим остатком.
 *
 * Отдельная функция, потому что кнопка «весь остаток» — самый частый
 * способ наткнуться на отказ: человек подставляет доступную сумму,
 * а комиссия сверху делает запрос невыполнимым. Здесь сразу режим GROSS,
 * и результат заведомо проходит проверку.
 */
export function maxWithdrawal(available: Numeric, feeBps: number): {
  grossAmount: string;
  netAmount: string;
} {
  const avail = D(available);
  if (!avail.isFinite() || avail.lte(0)) return { grossAmount: '0', netAmount: '0' };

  const feeRate = D(Math.max(0, Math.min(10_000, feeBps))).div(10_000);
  return {
    grossAmount: avail.toString(),
    netAmount: avail.times(D(1).minus(feeRate)).toString(),
  };
}
