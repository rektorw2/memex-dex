/**
 * Помещается ли число в колонку базы.
 *
 * Postgres не обрезает переполнение, а отвергает запись целиком:
 * `numeric field overflow`. Одно поле, вышедшее за границу, роняет
 * весь `update`, и вместе с ним теряются все остальные поля токена —
 * цена, ликвидность, объём. Токен перестаёт обновляться вовсе, а
 * в журнале видно только ошибку про «precision 12, scale 4», по
 * которой не понять, какое поле виновато.
 *
 * Особенно это касается меметокенов. Изменение цены за сутки у них
 * не ограничено ничем: токен, стоивший 10⁻¹⁵, при выходе на бирже
 * даёт рост в сотни миллионов процентов. Число настоящее, но в
 * колонку `Decimal(12, 4)` оно не влезает.
 *
 * Правило здесь одно и оно неочевидное: непомещающееся значение
 * становится null, а не обрезается до максимума. Обрезание записало
 * бы 99 999 999,9999 % — число, которого не было, и отличить его
 * от настоящего потом нечем. null означает «не знаем», и это
 * правда: представить это значение в имеющейся колонке мы не можем.
 */

/** Границы, встречающиеся в схеме. Имена по смыслу, а не по цифрам. */
export const DECIMAL_COLUMN = {
  /** priceChange24h, poolAgeHours, кратности. */
  percent: { precision: 12, scale: 4 },
  /** lpBurnedPct, topHolderPct — доли от нуля до ста. */
  share: { precision: 8, scale: 4 },
  /** Денежные величины. */
  money: { precision: 24, scale: 8 },
} as const;

/**
 * Помещается ли число в numeric(precision, scale).
 *
 * Проверка идёт после округления до нужного числа знаков — именно
 * так поступает Postgres, и значение 99 999 999,99996 округляется
 * им до 100 000 000, то есть до переполнения. Проверять до
 * округления значило бы пропустить ровно пограничный случай.
 */
export function fitsDecimal(value: number, precision: number, scale: number): boolean {
  if (!Number.isFinite(value)) return false;

  const limit = 10 ** (precision - scale);
  const rounded = Math.round(value * 10 ** scale) / 10 ** scale;

  return Math.abs(rounded) < limit;
}

/**
 * Значение, пригодное для записи, либо null.
 *
 * Ни исключения, ни обрезания: вызывающий получает либо число,
 * которое точно запишется, либо честное «неизвестно».
 */
export function decimalOrNull(
  value: number | null | undefined,
  column: { precision: number; scale: number },
): number | null {
  if (value == null) return null;
  return fitsDecimal(value, column.precision, column.scale) ? value : null;
}

/**
 * Изменение цены за сутки, пригодное для записи.
 *
 * Отдельная обёртка, потому что это самое частое место переполнения
 * во всём проекте: у свежего меметокена рост измеряется не десятками
 * процентов, а порядками.
 */
export function priceChangeOrNull(value: number | null | undefined): number | null {
  return decimalOrNull(value, DECIMAL_COLUMN.percent);
}

/**
 * Доля в процентах от нуля до ста.
 *
 * Значение вне этого диапазона — не «большая доля», а признак того,
 * что провайдер прислал базисные пункты или долю единицы вместо
 * процентов. Записывать его нельзя ни в каком виде: 10 000 в колонке
 * «процент сожжённой ликвидности» будет прочитано как полная
 * безопасность.
 */
export function sharePctOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return decimalOrNull(value, DECIMAL_COLUMN.share);
}
