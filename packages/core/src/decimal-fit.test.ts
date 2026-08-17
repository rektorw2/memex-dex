import { describe, it, expect } from 'vitest';
import {
  fitsDecimal,
  decimalOrNull,
  priceChangeOrNull,
  sharePctOrNull,
  DECIMAL_COLUMN,
} from './decimal-fit.js';

describe('вместимость колонки', () => {
  it('обычные значения помещаются', () => {
    expect(fitsDecimal(12.5, 12, 4)).toBe(true);
    expect(fitsDecimal(-99.9999, 12, 4)).toBe(true);
    expect(fitsDecimal(0, 12, 4)).toBe(true);
  });

  it('граница ровно на пределе не помещается', () => {
    // numeric(12, 4) вмещает значения строго меньше 10^8.
    expect(fitsDecimal(99_999_999.9999, 12, 4)).toBe(true);
    expect(fitsDecimal(100_000_000, 12, 4)).toBe(false);
  });

  it('округление вверх на границе учитывается', () => {
    // Postgres округляет до нужного знака и только потом проверяет.
    // Проверка до округления пропустила бы именно этот случай.
    expect(fitsDecimal(99_999_999.99996, 12, 4)).toBe(false);
  });

  it('отрицательное переполнение ловится так же', () => {
    expect(fitsDecimal(-100_000_000, 12, 4)).toBe(false);
  });

  it('не-числа не помещаются никуда', () => {
    expect(fitsDecimal(NaN, 12, 4)).toBe(false);
    expect(fitsDecimal(Infinity, 12, 4)).toBe(false);
    expect(fitsDecimal(-Infinity, 24, 8)).toBe(false);
  });
});

describe('значение для записи', () => {
  it('null остаётся null', () => {
    expect(decimalOrNull(null, DECIMAL_COLUMN.percent)).toBeNull();
    expect(decimalOrNull(undefined, DECIMAL_COLUMN.percent)).toBeNull();
  });

  it('помещающееся значение возвращается как есть, без округления', () => {
    // Округлять здесь нельзя: это работа базы, а наше дело —
    // не подменить число другим.
    expect(decimalOrNull(1234.56789, DECIMAL_COLUMN.percent)).toBe(1234.56789);
  });

  it('непомещающееся становится null, а не максимумом', () => {
    // Обрезание записало бы 99 999 999,9999 — число, которого
    // не было, и отличить его от настоящего потом нечем.
    const huge = 500_000_000;

    expect(decimalOrNull(huge, DECIMAL_COLUMN.percent)).toBeNull();
    expect(decimalOrNull(huge, DECIMAL_COLUMN.percent)).not.toBe(99_999_999.9999);
  });
});

describe('изменение цены за сутки', () => {
  it('обычный рост и падение проходят', () => {
    expect(priceChangeOrNull(45.2)).toBe(45.2);
    expect(priceChangeOrNull(-92.7)).toBe(-92.7);
  });

  it('рост в тысячу раз проходит', () => {
    // +99 900 % — это x1000. Для меметокена обычное дело,
    // и терять такое значение нельзя.
    expect(priceChangeOrNull(99_900)).toBe(99_900);
  });

  it('рост в миллион раз не влезает и даёт null', () => {
    // Токен, стоивший 10^-15, при выходе на биржу даёт именно такие
    // числа. Значение настоящее, но в колонку не помещается —
    // и раньше оно роняло весь update целиком.
    expect(priceChangeOrNull(150_000_000)).toBeNull();
  });

  it('бесконечность из деления на ноль даёт null', () => {
    // Цена сутки назад равна нулю — деление даёт Infinity.
    expect(priceChangeOrNull(1 / 0)).toBeNull();
    expect(priceChangeOrNull(0 / 0)).toBeNull();
  });
});

describe('доля в процентах', () => {
  it('от нуля до ста проходит', () => {
    expect(sharePctOrNull(0)).toBe(0);
    expect(sharePctOrNull(100)).toBe(100);
    expect(sharePctOrNull(37.5)).toBe(37.5);
  });

  it('базисные пункты вместо процентов отвергаются', () => {
    // 10 000 в колонке «процент сожжённой ликвидности» было бы
    // прочитано как полная безопасность — то есть ошибка провайдера
    // превратилась бы в ложное разрешение покупать.
    expect(sharePctOrNull(10_000)).toBeNull();
  });

  it('отрицательная доля отвергается', () => {
    expect(sharePctOrNull(-1)).toBeNull();
  });
});
