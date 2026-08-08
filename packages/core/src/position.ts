import { D, ZERO, Decimal, type Numeric } from './money.js';

/**
 * Учёт позиции по методу средневзвешенной стоимости (WAC).
 *
 * Почему WAC, а не FIFO: мем-коины покупаются десятками мелких докупок,
 * FIFO-лоты дали бы взрывной рост числа записей и спорные расчёты комиссии
 * при частичных выходах. WAC даёт один детерминированный avgCost на позицию,
 * который легко показать пользователю и воспроизвести при споре.
 */
export interface PositionState {
  quantity: Decimal;
  avgCostUsd: Decimal;
  costBasisUsd: Decimal;
  realizedPnlUsd: Decimal;
  /** Какая часть quantity набрана через копитрейдинг — с неё берётся performance fee. */
  copiedQuantity: Decimal;
}

export function emptyPosition(): PositionState {
  return {
    quantity: ZERO,
    avgCostUsd: ZERO,
    costBasisUsd: ZERO,
    realizedPnlUsd: ZERO,
    copiedQuantity: ZERO,
  };
}

export interface BuyInput {
  quantity: Numeric;
  priceUsd: Numeric;
  /** Комиссии сети и свопа увеличивают себестоимость — иначе PnL завышен. */
  feesUsd?: Numeric;
  isCopied?: boolean;
}

export function applyBuy(pos: PositionState, input: BuyInput): PositionState {
  const qty = D(input.quantity);
  if (qty.lte(0)) throw new Error('applyBuy: quantity должно быть > 0');

  const cost = qty.mul(D(input.priceUsd)).plus(D(input.feesUsd ?? 0));
  const newQty = pos.quantity.plus(qty);
  const newBasis = pos.costBasisUsd.plus(cost);

  return {
    quantity: newQty,
    costBasisUsd: newBasis,
    avgCostUsd: newQty.gt(0) ? newBasis.div(newQty) : ZERO,
    realizedPnlUsd: pos.realizedPnlUsd,
    copiedQuantity: input.isCopied ? pos.copiedQuantity.plus(qty) : pos.copiedQuantity,
  };
}

export interface SellResult {
  position: PositionState;
  /** Валовая прибыль сделки до performance fee. */
  realizedPnlUsd: Decimal;
  /** Себестоимость проданной доли. */
  costRemovedUsd: Decimal;
  proceedsUsd: Decimal;
  /** Сколько из проданного количества было набрано через копитрейд. */
  copiedQtySold: Decimal;
  /** Доля проданного объёма, относящаяся к копитрейду (0..1). */
  copiedShare: Decimal;
}

export interface SellInput {
  quantity: Numeric;
  priceUsd: Numeric;
  feesUsd?: Numeric;
}

export function applySell(pos: PositionState, input: SellInput): SellResult {
  const qty = D(input.quantity);
  if (qty.lte(0)) throw new Error('applySell: quantity должно быть > 0');
  if (qty.gt(pos.quantity)) throw new Error('applySell: недостаточное количество в позиции');

  const proceeds = qty.mul(D(input.priceUsd)).minus(D(input.feesUsd ?? 0));
  const costRemoved = pos.avgCostUsd.mul(qty);
  const pnl = proceeds.minus(costRemoved);

  const remainingQty = pos.quantity.minus(qty);
  // Продаём пропорционально: если 40% позиции набрано копированием,
  // то и 40% каждой продажи считается копитрейд-объёмом.
  const copiedShare = pos.quantity.gt(0) ? pos.copiedQuantity.div(pos.quantity) : ZERO;
  const copiedQtySold = copiedShare.mul(qty);

  const position: PositionState = {
    quantity: remainingQty,
    // avgCost не меняется при продаже — это ключевое свойство WAC
    avgCostUsd: remainingQty.gt(0) ? pos.avgCostUsd : ZERO,
    costBasisUsd: remainingQty.gt(0) ? pos.costBasisUsd.minus(costRemoved) : ZERO,
    realizedPnlUsd: pos.realizedPnlUsd.plus(pnl),
    copiedQuantity: pos.copiedQuantity.minus(copiedQtySold),
  };

  return {
    position,
    realizedPnlUsd: pnl,
    costRemovedUsd: costRemoved,
    proceedsUsd: proceeds,
    copiedQtySold,
    copiedShare,
  };
}

export function unrealizedPnlUsd(pos: PositionState, markPriceUsd: Numeric): Decimal {
  return D(markPriceUsd).mul(pos.quantity).minus(pos.costBasisUsd);
}
