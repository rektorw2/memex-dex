import { D, ZERO, Decimal, applySlippage, type Numeric } from './money.js';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP';

export interface TriggerableOrder {
  id: string;
  side: OrderSide;
  type: OrderType;
  limitPriceUsd?: Numeric | null;
  triggerPriceUsd?: Numeric | null;
  trailingBps?: number | null;
  /** Экстремум цены с момента постановки — для trailing stop. */
  peakPriceUsd?: Numeric | null;
  expiresAt?: Date | null;
}

export type TriggerDecision =
  | { action: 'execute'; reason: string }
  | { action: 'expire'; reason: string }
  | { action: 'update_peak'; peakPriceUsd: Decimal }
  | { action: 'hold'; reason: string };

/**
 * Чистая функция принятия решения по отложенному ордеру.
 * Вынесена из воркера, чтобы её можно было прогнать на исторических свечах
 * (бэктест) и покрыть тестами без сети и БД.
 */
export function evaluateTrigger(
  order: TriggerableOrder,
  markPriceUsd: Numeric,
  now: Date = new Date(),
): TriggerDecision {
  const price = D(markPriceUsd);
  if (price.lte(0)) return { action: 'hold', reason: 'нет валидной цены' };

  if (order.expiresAt && now >= order.expiresAt) {
    return { action: 'expire', reason: 'срок действия истёк' };
  }

  switch (order.type) {
    case 'MARKET':
      return { action: 'execute', reason: 'рыночный ордер' };

    case 'LIMIT': {
      const limit = D(order.limitPriceUsd ?? 0);
      if (limit.lte(0)) return { action: 'hold', reason: 'не задана лимитная цена' };
      // BUY-лимитка исполняется когда цена упала до лимита или ниже.
      if (order.side === 'BUY' && price.lte(limit)) {
        return { action: 'execute', reason: `цена ${price} <= лимита ${limit}` };
      }
      if (order.side === 'SELL' && price.gte(limit)) {
        return { action: 'execute', reason: `цена ${price} >= лимита ${limit}` };
      }
      return { action: 'hold', reason: 'лимит не достигнут' };
    }

    case 'STOP_LOSS': {
      const trigger = D(order.triggerPriceUsd ?? 0);
      if (trigger.lte(0)) return { action: 'hold', reason: 'не задан стоп' };
      // Стоп-лосс на позиции в лонг: продаём при падении.
      if (price.lte(trigger)) {
        return { action: 'execute', reason: `стоп: ${price} <= ${trigger}` };
      }
      return { action: 'hold', reason: 'стоп не сработал' };
    }

    case 'TAKE_PROFIT': {
      const trigger = D(order.triggerPriceUsd ?? 0);
      if (trigger.lte(0)) return { action: 'hold', reason: 'не задан тейк' };
      if (price.gte(trigger)) {
        return { action: 'execute', reason: `тейк: ${price} >= ${trigger}` };
      }
      return { action: 'hold', reason: 'тейк не достигнут' };
    }

    case 'TRAILING_STOP': {
      const trailBps = order.trailingBps ?? 0;
      if (trailBps <= 0) return { action: 'hold', reason: 'не задан trailing' };
      const peak = D(order.peakPriceUsd ?? 0);
      if (price.gt(peak)) return { action: 'update_peak', peakPriceUsd: price };
      if (peak.lte(0)) return { action: 'update_peak', peakPriceUsd: price };
      const stop = peak.mul(D(10_000).minus(trailBps)).div(10_000);
      if (price.lte(stop)) {
        return { action: 'execute', reason: `trailing: ${price} <= ${stop} (пик ${peak})` };
      }
      return { action: 'hold', reason: 'trailing не сработал' };
    }
  }
}

export interface QuoteCheck {
  expectedOut: Numeric;
  quotedOut: Numeric;
  slippageBps: number;
  priceImpactBps?: number;
  maxPriceImpactBps?: number;
}

export type QuoteVerdict = { ok: true; minOut: Decimal } | { ok: false; reason: string };

/**
 * Защита пользователя перед отправкой транзакции.
 * Мем-коины — это тонкая ликвидность: без этой проверки пользователь
 * регулярно получал бы -40% на входе и не понимал почему.
 */
export function validateQuote(q: QuoteCheck): QuoteVerdict {
  const quoted = D(q.quotedOut);
  const expected = D(q.expectedOut);
  if (quoted.lte(0)) return { ok: false, reason: 'агрегатор не вернул маршрут' };

  const maxImpact = q.maxPriceImpactBps ?? 1500;
  if (q.priceImpactBps != null && q.priceImpactBps > maxImpact) {
    return {
      ok: false,
      reason: `price impact ${(q.priceImpactBps / 100).toFixed(2)}% превышает лимит ${(maxImpact / 100).toFixed(2)}%`,
    };
  }

  if (expected.gt(0)) {
    const deviationBps = expected.minus(quoted).div(expected).mul(10_000);
    if (deviationBps.gt(q.slippageBps)) {
      return {
        ok: false,
        reason: `котировка хуже ожидаемой на ${deviationBps.toFixed(0)} bps при допуске ${q.slippageBps} bps`,
      };
    }
  }

  return { ok: true, minOut: applySlippage(quoted, q.slippageBps) };
}

/** Сколько средств зарезервировать под ордер (locked-баланс). */
export function requiredLock(order: { amountIn: Numeric; filledIn?: Numeric }): Decimal {
  const remaining = D(order.amountIn).minus(D(order.filledIn ?? 0));
  return remaining.gt(0) ? remaining : ZERO;
}
