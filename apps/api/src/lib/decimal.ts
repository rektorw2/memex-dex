/**
 * Числа провайдера — в колонки базы.
 *
 * Postgres отвергает переполнение целиком, а не обрезает его:
 * одно поле, вышедшее за границу, роняет весь `update` и уносит
 * с собой цену, ликвидность и объём. Токен после этого просто
 * перестаёт обновляться, и заметно это становится нескоро.
 *
 * Проверка вместимости живёт в ядре и покрыта тестами; здесь только
 * перевод в тип Prisma.
 */

import { Prisma as P } from '@prisma/client';
import {
  decimalOrNull,
  priceChangeOrNull,
  sharePctOrNull,
  DECIMAL_COLUMN,
} from '@memex/core';

/** Число в Decimal. null остаётся null. */
export function decimalOf(value: number | null | undefined): P.Decimal | null {
  return value == null ? null : new P.Decimal(value);
}

/**
 * Значение для колонки с известными границами.
 *
 * Непомещающееся становится null, а не максимумом: обрезание
 * записало бы число, которого не было, и отличить его от настоящего
 * потом нечем.
 */
export function decimalFor(
  value: number | null | undefined,
  column: { precision: number; scale: number },
): P.Decimal | null {
  return decimalOf(decimalOrNull(value, column));
}

/**
 * Уже готовый Decimal, проверенный на вместимость.
 *
 * Нужен там, где значение получено делением самих Decimal — например
 * кратность роста как отношение капитализаций. У токена, начинавшего
 * с капитализации в центы, такое отношение достигает миллиардов,
 * и в колонку кратности оно не влезает.
 *
 * Округление до нужного знака делается до сравнения: Postgres
 * поступает так же, и значение ровно на границе иначе прошло бы
 * проверку, а запись всё равно упала бы.
 */
export function fitDecimal(
  value: P.Decimal | null | undefined,
  column: { precision: number; scale: number },
): P.Decimal | null {
  if (value == null) return null;

  const limit = new P.Decimal(10).pow(column.precision - column.scale);
  const rounded = value.toDecimalPlaces(column.scale);

  return rounded.abs().gte(limit) ? null : value;
}

export { priceChangeOrNull, sharePctOrNull, DECIMAL_COLUMN };
