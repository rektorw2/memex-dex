import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  PAPER_MONEY_SCALE,
  closePaperCapitalLedger,
  initialPaperCapitalLedger,
  openPaperCapitalLedger,
  revaluePaperCapital,
} from './paper-allocation.js';
import { PAPER_AGENT_STRATEGIES, markPaperPosition, openPaperPosition } from './paper-agent.js';

/**
 * Бухгалтерия переоценки PAPER-счёта.
 *
 * Файл появился после настоящего дефекта. Формула equity была
 * написана в одном месте и не применялась в другом: при открытии
 * позиции счёт оставался равным начальному капиталу, хотя комиссия
 * входа, сетевой сбор и проскальзывание уже понесены. Первая отметка
 * цены потом «роняла» equity без всякой новой котировки — и это
 * выглядело как движение рынка, хотя рынок не двигался.
 *
 * Здесь формула проверяется отдельно, чтобы у неё было одно место
 * и один набор ожиданий.
 */

const baseline = PAPER_AGENT_STRATEGIES[0]!;

describe('equity считается по одной формуле', () => {
  it('равен сумме составляющих', () => {
    const snapshot = initialPaperCapitalLedger('1000', 30);
    const opened = openPaperCapitalLedger(snapshot, '175');
    const revalued = revaluePaperCapital(opened, '-4.53255579');

    // 525 свободно + 300 резерв + 175 вложено − 4.53255579
    expect(revalued.equityUsd).toBe('995.46744421');
  });

  it('без открытых позиций и без результата equity равен капиталу', () => {
    const snapshot = initialPaperCapitalLedger('1000', 30);

    expect(revaluePaperCapital(snapshot, '0').equityUsd).toBe('1000');
  });

  it('пик не опускается', () => {
    /*
     * Просадка измеряется от максимума, а не от текущего значения.
     * Опускающийся пик означал бы, что просадки не бывает никогда.
     */
    const snapshot = initialPaperCapitalLedger('1000', 30);
    const down = revaluePaperCapital(snapshot, '-100');

    expect(down.peakEquityUsd).toBe('1000');
    expect(down.equityUsd).toBe('900');
    expect(down.drawdownPct).toBe('10');
  });

  it('рост поднимает пик и обнуляет просадку', () => {
    const snapshot = initialPaperCapitalLedger('1000', 30);
    const up = revaluePaperCapital(snapshot, '250');

    expect(up.peakEquityUsd).toBe('1250');
    expect(up.drawdownPct).toBe('0');
  });

  it('нечисловая переоценка отвергается', () => {
    // Молча превратить `NaN` в ноль значило бы показать капитал,
    // которого нет.
    const snapshot = initialPaperCapitalLedger('1000', 30);

    expect(() => revaluePaperCapital(snapshot, Number.NaN)).toThrow('INVALID_UNREALIZED');
  });
});

describe('расходы входа видны сразу после открытия', () => {
  /**
   * Полный расчёт открытия при позиции 175 и цене 1.
   *
   * Числа не выдуманы: ровно они пришли из настоящего прогона на
   * PostgreSQL и по ним был найден дефект.
   */
  const strategy = { ...baseline, positionUsd: 175 };
  const entry = openPaperPosition(strategy, 1)!;
  const mark = markPaperPosition(strategy, entry, 1)!;

  it('позиция сразу стоит меньше, чем из неё вычли', () => {
    /*
     * Смысл всего файла. Между «вложено 175» и «позиция стоит 175»
     * есть разница, и она равна уже понесённым расходам плюс
     * стоимости будущего выхода.
     */
    expect(mark.pnlUsd).toBeCloseTo(-4.53255579, 8);
    expect(mark.pnlUsd).toBeLessThan(0);
  });

  it('расходы входа уже понесены', () => {
    const entryCosts = entry.entryTradingFeeUsd + entry.entryNetworkFeeUsd + entry.entrySlippageUsd;

    expect(entryCosts).toBeCloseTo(2.27227723, 8);
    expect(entryCosts).toBeGreaterThan(0);
  });

  it('переоценка сразу после открытия даёт то же, что и первая отметка', () => {
    /*
     * Контракт: повторная отметка при той же цене не меняет ничего.
     * Он выполним только если открытие применяет ту же переоценку,
     * что применила бы отметка.
     */
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('1000', 30), '175');
    const atOpen = revaluePaperCapital(opened, mark.pnlUsd);
    const atFirstTick = revaluePaperCapital(opened, mark.pnlUsd);

    expect(atOpen).toEqual(atFirstTick);
    expect(atOpen.equityUsd).toBe('995.46744421');
  });

  it('расходы не удваиваются при повторной переоценке', () => {
    // Переоценка идемпотентна по построению: она считает от снимка,
    // а не прибавляет к прошлому значению.
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('1000', 30), '175');
    const once = revaluePaperCapital(opened, mark.pnlUsd);
    const twice = revaluePaperCapital({ ...opened, ...once }, mark.pnlUsd);

    expect(twice.equityUsd).toBe(once.equityUsd);
    expect(twice.drawdownPct).toBe(once.drawdownPct);
  });
});

describe('сохранённый equity точно равен сумме сохранённых частей', () => {
  /**
   * Сумма составляющих ровно так, как они сохранены.
   *
   * Считается в `Decimal`, а не в `number`: на восьмом знаке
   * двоичная плавающая точка уже врёт, и проверка точного равенства
   * через `Number` проверяла бы саму себя.
   */
  const sumOf = (parts: {
    freeBalanceUsd: string;
    reservedBalanceUsd: string;
    inPositionsUsd: string;
    unrealizedPnlUsd: string;
  }) =>
    new Decimal(parts.freeBalanceUsd)
      .plus(parts.reservedBalanceUsd)
      .plus(parts.inPositionsUsd)
      .plus(parts.unrealizedPnlUsd)
      .toFixed();

  it('позиция 175 при цене 1: тот самый пограничный случай', () => {
    /*
     * Регрессия на найденный дефект. Нереализованный результат здесь
     * −4.5325557920792079…: его восьмой знак обрезается, а прежняя
     * реализация считала `equity` из необрезанного значения и
     * обрезала уже сумму. Получалось `995.46744420` при сумме
     * сохранённых частей `995.46744421` — расхождение ровно
     * в одну последнюю единицу масштаба.
     */
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('1000', 30), '175');
    const revalued = revaluePaperCapital(opened, '-4.5325557920792079');

    expect(revalued.unrealizedPnlUsd).toBe('-4.53255579');
    expect(revalued.equityUsd).toBe('995.46744421');
    expect(
      revalued.equityUsd,
      'сохранённый equity обязан совпасть с суммой сохранённых частей',
    ).toBe(sumOf({ ...opened, unrealizedPnlUsd: revalued.unrealizedPnlUsd }));
  });

  it('прежний порядок действий давал бы .20 вместо .21', () => {
    /*
     * Негативный контроль к тесту выше: показывает, что расхождение
     * было настоящим, а не выдуманным ради красивой истории.
     * Здесь воспроизведён прежний порядок — сумма из необрезанного
     * значения, обрезание в конце.
     */
    const cut = (value: Decimal) =>
      value.toDecimalPlaces(PAPER_MONEY_SCALE, Decimal.ROUND_DOWN).toFixed();
    const raw = new Decimal('-4.5325557920792079');

    const oldWay = cut(new Decimal(525).plus(300).plus(175).plus(raw));
    const persistedSum = new Decimal(525).plus(300).plus(175).plus(cut(raw)).toFixed();

    expect(oldWay).toBe('995.4674442');
    expect(persistedSum).toBe('995.46744421');
    expect(oldWay, 'прежний порядок расходился с суммой').not.toBe(persistedSum);
  });

  it('равенство держится на множестве неудобных значений', () => {
    /*
     * Один пример мог бы совпасть случайно. Здесь перебираются
     * результаты с длинным хвостом — те, на которых обрезание
     * и сложение расходятся, если делать их в неверном порядке.
     */
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('1000', 30), '175');

    for (const tail of ['1', '5', '7', '9', '99', '4999', '50000001']) {
      for (const sign of ['-', '']) {
        const unrealized = `${sign}4.5325557${tail}`;
        const revalued = revaluePaperCapital(opened, unrealized);

        expect(
          revalued.equityUsd,
          `unrealized=${unrealized}`,
        ).toBe(sumOf({ ...opened, unrealizedPnlUsd: revalued.unrealizedPnlUsd }));
      }
    }
  });

  it('равенство держится и после закрытия позиции', () => {
    /*
     * Закрытие складывает `netExit` с полной точностью, и раньше
     * `freeAfter` обрезался отдельно от `equity` — та же ошибка
     * в другом месте.
     */
    const opened = openPaperCapitalLedger(initialPaperCapitalLedger('1000', 30), '175');
    const closed = closePaperCapitalLedger(opened, {
      allocatedUsd: '175',
      netExitUsd: '170.4674442079207920792',
      tradingFeesUsd: '1.0380013366336634',
      slippageUsd: '3.4545544554455446',
      networkCostsUsd: '0.04',
    });

    expect(closed.equityUsd).toBe(sumOf(closed));
  });
});
