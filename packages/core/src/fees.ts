import { D, ZERO, Decimal, bps, ceilTo, type Numeric } from './money.js';

/**
 * Performance fee 10% — удерживается ТОЛЬКО при выходе из позиции
 * и ТОЛЬКО с положительного PnL копитрейд-объёма.
 *
 * Правила, зафиксированные здесь (их же надо показать пользователю в оферте):
 *  1. База = реализованная прибыль после сетевых комиссий и комиссий свопа.
 *  2. Убыточный выход комиссию не порождает (fee = 0), а не отрицательную.
 *  3. Если позиция набрана частично вручную, частично копированием —
 *     комиссия берётся только с копируемой доли.
 *  4. Опционально: перенос убытков (loss carry-forward). Без него пользователь
 *     платит с прибыльной сделки, даже если суммарно в минусе — это законно,
 *     но конфликтно. Настройка lossCarryForwardUsd закрывает вопрос.
 *  5. Комиссия удерживается из выручки в валюте котировки (USDC/SOL),
 *     а не списывается отдельной транзакцией — меньше газа и меньше сбоев.
 */
export interface PerformanceFeeInput {
  /** Валовая реализованная прибыль по всей продаже, USD. Может быть отрицательной. */
  realizedPnlUsd: Numeric;
  /** Доля продажи, относящаяся к копитрейду (0..1). */
  copiedShare: Numeric;
  /** Ставка в базисных пунктах. 1000 = 10%. */
  feeBps: number;
  /** Накопленный непокрытый убыток подписчика по данной подписке, USD (>= 0). */
  lossCarryForwardUsd?: Numeric;
  /** Включить перенос убытков. По умолчанию выключено (комиссия с каждого профита). */
  useLossCarryForward?: boolean;
  /** Доля лидера в комиссии, bps от суммы комиссии. Остальное — платформе. */
  leaderShareBps?: number;
}

export interface PerformanceFeeResult {
  /** Прибыль, с которой реально считалась комиссия. */
  basisPnlUsd: Decimal;
  feeUsd: Decimal;
  leaderShareUsd: Decimal;
  platformShareUsd: Decimal;
  /** Новый остаток непокрытого убытка. */
  lossCarryForwardUsd: Decimal;
  /** Прибыль, остающаяся пользователю. */
  netPnlUsd: Decimal;
  reason: 'charged' | 'no_profit' | 'no_copied_volume' | 'offset_by_losses';
}

export function calcPerformanceFee(input: PerformanceFeeInput): PerformanceFeeResult {
  const grossPnl = D(input.realizedPnlUsd);
  const share = D(input.copiedShare).clamp(0, 1);
  const carry = D(input.lossCarryForwardUsd ?? 0).abs();
  const leaderBps = input.leaderShareBps ?? 0;

  const nothing = (reason: PerformanceFeeResult['reason'], newCarry: Decimal): PerformanceFeeResult => ({
    basisPnlUsd: ZERO,
    feeUsd: ZERO,
    leaderShareUsd: ZERO,
    platformShareUsd: ZERO,
    lossCarryForwardUsd: newCarry,
    netPnlUsd: grossPnl,
    reason,
  });

  if (share.lte(0)) return nothing('no_copied_volume', carry);

  // Убыток копируемой доли пополняет "долг", если включён перенос убытков.
  if (grossPnl.lte(0)) {
    const added = input.useLossCarryForward ? carry.plus(grossPnl.abs().mul(share)) : carry;
    return nothing('no_profit', added);
  }

  const copiedProfit = grossPnl.mul(share);

  let basis = copiedProfit;
  let newCarry = carry;
  if (input.useLossCarryForward && carry.gt(0)) {
    if (carry.gte(copiedProfit)) {
      return nothing('offset_by_losses', carry.minus(copiedProfit));
    }
    basis = copiedProfit.minus(carry);
    newCarry = ZERO;
  }

  // Округление комиссии вверх до цента: пыль не теряется, но и не завышается.
  const feeUsd = ceilTo(bps(basis, input.feeBps), 2);
  const leaderShareUsd = ceilTo(bps(feeUsd, leaderBps), 2);
  const platformShareUsd = feeUsd.minus(leaderShareUsd);

  return {
    basisPnlUsd: basis,
    feeUsd,
    leaderShareUsd,
    platformShareUsd,
    lossCarryForwardUsd: newCarry,
    netPnlUsd: grossPnl.minus(feeUsd),
    reason: 'charged',
  };
}

/**
 * Альтернативная модель: high-water mark по подписке.
 * Комиссия берётся только с прироста суммарного PnL над историческим максимумом.
 * Оставлено в кодовой базе — переключается настройкой подписки.
 */
export function calcHighWaterMarkFee(params: {
  cumulativePnlUsd: Numeric;
  highWaterMarkUsd: Numeric;
  feeBps: number;
}): { feeUsd: Decimal; newHighWaterMarkUsd: Decimal } {
  const cum = D(params.cumulativePnlUsd);
  const hwm = D(params.highWaterMarkUsd);
  if (cum.lte(hwm)) return { feeUsd: ZERO, newHighWaterMarkUsd: hwm };
  const gain = cum.minus(hwm);
  return { feeUsd: ceilTo(bps(gain, params.feeBps), 2), newHighWaterMarkUsd: cum };
}

/** Комиссия платформы за своп, снимается с входящей суммы до маршрутизации. */
export function calcSwapFee(amountInUsd: Numeric, feeBps: number): Decimal {
  if (feeBps <= 0) return ZERO;
  return ceilTo(bps(amountInUsd, feeBps), 6);
}
