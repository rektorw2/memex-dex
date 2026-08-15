import { D, type Numeric } from './money.js';

/**
 * План автоматического выхода из позиции.
 *
 * Считается сразу после покупки: заходя в мем-коин, разумно заранее знать,
 * где выходишь, потому что в момент роста решение принимается хуже всего.
 *
 * Главное свойство плана — он покрывает ровно 100% купленного количества
 * и ни процентом больше. Сумма долей, превышающая единицу, означала бы
 * попытку продать то, чего нет: часть ордеров отклонилась бы при
 * срабатывании, и какая именно — зависело бы от порядка обработки.
 */

export interface ExitStep {
  /** Во сколько раз цена должна вырасти относительно входа. */
  multiple: number;
  /** Какую долю позиции продать, 0-1. */
  fraction: number;
}

export interface AutoExitPlan {
  /** Цена входа, USD. */
  entryPriceUsd: string;
  steps: Array<{
    multiple: number;
    /** Цена срабатывания, USD. */
    triggerPriceUsd: string;
    /** Количество токена к продаже. */
    quantity: string;
    /** Доля позиции, 0-1. */
    fraction: number;
  }>;
  /** Стоп-лосс, если задан. */
  stopLoss: { triggerPriceUsd: string; quantity: string } | null;
  warnings: string[];
}

/**
 * Настройка по умолчанию: продать всё при трёхкратном росте.
 *
 * Одна цель вместо лестницы — сознательный выбор владельца, а не
 * рекомендация. У него есть заметный недостаток, о котором план
 * предупреждает явно: рост в 2.9 раза не заберётся вообще.
 */
export const DEFAULT_EXIT_STEPS: ExitStep[] = [{ multiple: 3, fraction: 1 }];

export interface AutoExitInput {
  entryPriceUsd: Numeric;
  /** Купленное количество токена. */
  quantity: Numeric;
  steps?: ExitStep[];
  /** Стоп-лосс в процентах ниже входа. 0 или null — без стопа. */
  stopLossPct?: number | null;
}

export function planAutoExit(input: AutoExitInput): AutoExitPlan {
  const warnings: string[] = [];
  const entry = D(input.entryPriceUsd);
  const qty = D(input.quantity);

  if (!entry.isFinite() || entry.lte(0) || !qty.isFinite() || qty.lte(0)) {
    return {
      entryPriceUsd: entry.toString(),
      steps: [],
      stopLoss: null,
      warnings: ['Нет цены входа или количества — план не построен'],
    };
  }

  const raw = (input.steps?.length ? input.steps : DEFAULT_EXIT_STEPS)
    .filter((s) => Number.isFinite(s.multiple) && s.multiple > 1)
    .filter((s) => Number.isFinite(s.fraction) && s.fraction > 0)
    .sort((a, b) => a.multiple - b.multiple);

  if (raw.length === 0) {
    return {
      entryPriceUsd: entry.toString(),
      steps: [],
      stopLoss: null,
      warnings: ['Все цели отброшены: кратность должна быть больше 1, доля — больше 0'],
    };
  }

  const totalFraction = raw.reduce((s, x) => s + x.fraction, 0);
  if (totalFraction > 1.000001) {
    warnings.push(
      `Сумма долей ${(totalFraction * 100).toFixed(0)}% превышает размер позиции — доли уменьшены пропорционально`,
    );
  }

  // Нормировка вниз, но не вверх. Если владелец задал продажу 60%
  // позиции, остаток он оставляет намеренно — дополнять план до сотни
  // за него было бы решением за него.
  const scale = totalFraction > 1 ? 1 / totalFraction : 1;

  let allocated = D(0);
  const steps = raw.map((s, i) => {
    const fraction = s.fraction * scale;
    const isLast = i === raw.length - 1;
    const nearlyAll = totalFraction * scale >= 0.999999;

    // Последней цели отдаётся остаток, чтобы округления не оставили
    // «хвост» из нескольких токенов, который потом висит в позиции
    // и мешает считать её закрытой.
    const quantity =
      isLast && nearlyAll ? qty.minus(allocated) : qty.times(fraction);

    allocated = allocated.plus(quantity);

    return {
      multiple: s.multiple,
      triggerPriceUsd: entry.times(s.multiple).toString(),
      quantity: quantity.toString(),
      fraction,
    };
  });

  if (steps.length === 1 && steps[0]!.fraction >= 0.999999) {
    warnings.push(
      `Единственная цель — ${steps[0]!.multiple}×: рост меньше этого не будет зафиксирован вообще`,
    );
  }

  let stopLoss: AutoExitPlan['stopLoss'] = null;
  const slPct = input.stopLossPct ?? 0;

  if (slPct > 0 && slPct < 100) {
    stopLoss = {
      triggerPriceUsd: entry.times(1 - slPct / 100).toString(),
      // Стоп продаёт всю позицию: частичный стоп оставляет остаток
      // без защиты, а именно от неё стоп и нужен.
      quantity: qty.toString(),
    };
    warnings.push(
      'Стоп и цели покрывают одно и то же количество: при срабатывании ' +
        'одного из них остальные ордера нужно снять, иначе позиция уйдёт в минус',
    );
  } else if (slPct !== 0) {
    warnings.push('Стоп-лосс не поставлен: процент должен быть от 1 до 99');
  }

  return { entryPriceUsd: entry.toString(), steps, stopLoss, warnings };
}

/**
 * Пересчёт оставшихся ордеров после частичного выхода.
 *
 * Нужен, когда сработала одна из целей: остальные ордера выставлены
 * на количество, которого уже нет. Без пересчёта они отклонятся при
 * срабатывании — то есть именно тогда, когда нужны.
 */
export function rescaleRemaining(
  remainingQuantity: Numeric,
  pending: Array<{ id: string; quantity: Numeric }>,
): Array<{ id: string; quantity: string }> {
  const left = D(remainingQuantity);
  if (left.lte(0)) return pending.map((p) => ({ id: p.id, quantity: '0' }));

  const planned = pending.reduce((s, p) => s.plus(D(p.quantity)), D(0));
  if (planned.lte(0) || planned.lte(left)) {
    return pending.map((p) => ({ id: p.id, quantity: D(p.quantity).toString() }));
  }

  const k = left.div(planned);
  let allocated = D(0);

  return pending.map((p, i) => {
    const isLast = i === pending.length - 1;
    const q = isLast ? left.minus(allocated) : D(p.quantity).times(k);
    allocated = allocated.plus(q);
    return { id: p.id, quantity: q.toString() };
  });
}
