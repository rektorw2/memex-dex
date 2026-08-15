import type { ExitStep } from './auto-exit.js';

/**
 * Готовые планы выхода.
 *
 * Ключевое решение: в каждый момент у позиции активен ровно один план.
 * Не «цели плюс стоп плюс ещё что-то» — именно один.
 *
 * Причина не в простоте интерфейса, а в устройстве резервирования.
 * Отложенный ордер замораживает токены под себя, а одни и те же токены
 * нельзя заморозить дважды. Лестница целей вместе со стопом на всю
 * позицию требует зарезервировать больше, чем есть: либо стоп перестаёт
 * покрывать остаток, либо цели не могут сработать. Раньше это решалось
 * пропорциональным пересчётом, и стоп молча начинал защищать две трети
 * позиции вместо всей.
 *
 * Один план убирает конфликт в корне. Передумали — старый снимается
 * целиком, новый ставится от той же цены входа.
 */

export interface ExitPreset {
  key: string;
  label: string;
  /** Что именно произойдёт. Показывается до выбора, а не после. */
  description: string;
  steps: ExitStep[];
  /** Процент ниже входа. null — без стопа. */
  stopLossPct: number | null;
}

/**
 * Стоп задаётся только у планов с одной целью.
 *
 * У лестницы стоп пришлось бы делить с целями то же количество токенов —
 * ровно та ситуация, ради ухода от которой планы и сделаны
 * взаимоисключающими. Лестница защищает себя иначе: первая цель
 * забирает половину позиции рано.
 */
export const EXIT_PRESETS: ExitPreset[] = [
  {
    key: 'x2',
    label: '2×',
    description: 'Продать всё при удвоении. Стоп на −35% от входа',
    steps: [{ multiple: 2, fraction: 1 }],
    stopLossPct: 35,
  },
  {
    key: 'x3',
    label: '3×',
    description: 'Продать всё при трёхкратном росте. Стоп на −35% от входа',
    steps: [{ multiple: 3, fraction: 1 }],
    stopLossPct: 35,
  },
  {
    key: 'x5',
    label: '5×',
    description: 'Продать всё при пятикратном росте. Стоп на −35% от входа',
    steps: [{ multiple: 5, fraction: 1 }],
    stopLossPct: 35,
  },
  {
    key: 'ladder',
    label: 'Лестница',
    description: 'Половина на 2×, треть на 3×, остаток на 5×. Без стопа',
    steps: [
      { multiple: 2, fraction: 0.5 },
      { multiple: 3, fraction: 0.3 },
      { multiple: 5, fraction: 0.2 },
    ],
    stopLossPct: null,
  },
  {
    key: 'none',
    label: 'Без плана',
    description: 'Выход вручную. Позиция останется открытой до вашего решения',
    steps: [],
    stopLossPct: null,
  },
];

export const DEFAULT_EXIT_PRESET = 'x3';

export function findExitPreset(key: string | null | undefined): ExitPreset | null {
  if (!key) return null;
  return EXIT_PRESETS.find((p) => p.key === key) ?? null;
}

/**
 * Можно ли сменить план, и что при этом произойдёт.
 *
 * Отдельная функция, потому что смена плана — это отмена уже стоящих
 * ордеров, и человек должен понимать это до нажатия, а не узнавать
 * из журнала после.
 */
export interface PlanChange {
  allowed: boolean;
  /** Сколько ордеров будет снято. */
  cancels: number;
  reason: string;
}

export function describePlanChange(
  currentKey: string | null,
  nextKey: string,
  openExitOrders: number,
  positionQuantity: number,
): PlanChange {
  const next = findExitPreset(nextKey);

  if (!next) {
    return { allowed: false, cancels: 0, reason: 'Неизвестный план выхода' };
  }

  if (!(positionQuantity > 0)) {
    return { allowed: false, cancels: 0, reason: 'Позиция пуста — выходить не из чего' };
  }

  if (currentKey === nextKey) {
    return { allowed: false, cancels: 0, reason: 'Этот план уже активен' };
  }

  if (openExitOrders === 0) {
    return {
      allowed: true,
      cancels: 0,
      reason:
        next.key === 'none'
          ? 'Плана нет и не будет — выход вручную'
          : `Будет поставлено целей: ${next.steps.length}` +
            (next.stopLossPct ? ' и стоп-лосс' : ''),
    };
  }

  return {
    allowed: true,
    cancels: openExitOrders,
    reason:
      next.key === 'none'
        ? `Будет снято ордеров: ${openExitOrders}. Новые не ставятся`
        : `Будет снято ордеров: ${openExitOrders}, поставлено новых: ` +
          `${next.steps.length + (next.stopLossPct ? 1 : 0)}`,
  };
}
