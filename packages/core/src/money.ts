import Decimal from 'decimal.js';

// 40 значащих цифр — с запасом для 18-decimals токенов и мем-коинов
// с ценой вида 0.000000000123.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });

export type Numeric = Decimal | string | number;

export const D = (v: Numeric): Decimal => new Decimal(v ?? 0);
export const ZERO = new Decimal(0);
export const BPS_DENOM = new Decimal(10_000);

/** Округление вниз до decimals знаков — всегда в пользу системы при списании. */
export function floorTo(v: Numeric, decimals: number): Decimal {
  return D(v).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
}

/** Округление вверх — используется для комиссий, чтобы не терять пыль. */
export function ceilTo(v: Numeric, decimals: number): Decimal {
  return D(v).toDecimalPlaces(decimals, Decimal.ROUND_UP);
}

export function bps(value: Numeric, basisPoints: number): Decimal {
  return D(value).mul(basisPoints).div(BPS_DENOM);
}

export function applySlippage(amount: Numeric, slippageBps: number): Decimal {
  return D(amount).mul(BPS_DENOM.minus(slippageBps)).div(BPS_DENOM);
}

export function isPositive(v: Numeric): boolean {
  return D(v).gt(0);
}

export { Decimal };
