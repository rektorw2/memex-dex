/**
 * Состояния и форматирование результата.
 *
 * Главная проверяемая мысль во всём наборе: отсутствие числа никогда
 * не превращается в ноль. «$0.00» означает измеренный результат,
 * равный нулю, и подставлять его вместо «ещё не считали» — значит
 * сообщать человеку неправду в том месте, где он принимает решение
 * деньгами.
 */

import { describe, it, expect } from 'vitest';
import {
  pnlView,
  totalPnl,
  formatSignedUsd,
  formatExactUsd,
  formatUsdMagnitude,
  roiPercent,
  STALE_AFTER_MS,
} from './pnl-display.js';

describe('состояния', () => {
  it('покупка без закрытия — открытая позиция, а не ноль', () => {
    const v = pnlView({ valueUsd: null, isOpen: true });

    expect(v.state).toBe('open_position');
    expect(v.valueUsd).toBeNull();
    expect(v.label).toBe('Открытая позиция');
    expect(v.label).not.toContain('0.00');
  });

  it('продажа до пересчёта — ожидание, а не отсутствие результата', () => {
    const v = pnlView({ valueUsd: null, isPending: true });

    expect(v.state).toBe('pending');
    expect(v.label).toBe('PnL рассчитывается');
  });

  it('осиротевшая продажа — недостаток истории', () => {
    const v = pnlView({ valueUsd: null, hasIncompleteHistory: true });

    expect(v.state).toBe('incomplete_history');
    expect(v.label).toBe('Недостаточно истории');
  });

  it('неполная история важнее ожидания расчёта', () => {
    // Такую позицию можно пересчитывать сколько угодно — точнее
    // она не станет. Показывать «рассчитывается» значит обещать
    // результат, которого не будет.
    const v = pnlView({ valueUsd: null, isPending: true, hasIncompleteHistory: true });

    expect(v.state).toBe('incomplete_history');
  });

  it('величина при неполной истории не показывается', () => {
    // Даже если число посчиталось, доверять ему нельзя:
    // себестоимость неизвестна, и «прибыль» здесь — это выручка.
    const v = pnlView({ valueUsd: 1200, hasIncompleteHistory: true });

    expect(v.state).toBe('incomplete_history');
    expect(v.valueUsd).toBeNull();
  });

  it('известная величина показывается', () => {
    const v = pnlView({ valueUsd: 49.03 });

    expect(v.state).toBe('available');
    expect(v.valueUsd).toBe(49.03);
    expect(v.sign).toBe(1);
  });

  it('открытая позиция с известным нереализованным результатом показывает число', () => {
    const v = pnlView({ valueUsd: -12.5, isOpen: true, kind: 'unrealized' });

    expect(v.state).toBe('available');
    expect(v.sign).toBe(-1);
  });

  it('нет данных и нет причины — неприменимо, а не ноль', () => {
    const v = pnlView({ valueUsd: null });

    expect(v.state).toBe('not_applicable');
    expect(v.label).toBe('—');
  });

  it('все состояния различимы по названию', () => {
    const labels = new Set([
      pnlView({ valueUsd: null, isOpen: true }).label,
      pnlView({ valueUsd: null, isPending: true }).label,
      pnlView({ valueUsd: null, hasIncompleteHistory: true }).label,
      pnlView({ valueUsd: null }).label,
      pnlView({ valueUsd: 1 }).label,
    ]);

    expect(labels.size).toBe(5);
  });
});

describe('устаревание', () => {
  it('свежий расчёт не помечается', () => {
    const now = 1_000_000;
    const v = pnlView({ valueUsd: 10, computedAt: now - 1_000, now });

    expect(v.isStale).toBe(false);
  });

  it('давний расчёт помечается, но величину не прячет', () => {
    // Спрятать посчитанное значит потерять информацию; показать
    // без пометки — выдать вчерашнее за сегодняшнее.
    const now = 1_000_000;
    const v = pnlView({ valueUsd: 10, computedAt: now - STALE_AFTER_MS - 1, now });

    expect(v.isStale).toBe(true);
    expect(v.valueUsd).toBe(10);
  });
});

describe('нечисловые значения', () => {
  it('NaN не доходит до строки', () => {
    // «NaN» в колонке прибыли выглядит как сбой всего приложения.
    const v = pnlView({ valueUsd: NaN });

    expect(v.state).toBe('not_applicable');
    expect(v.label).toBe('—');
  });

  it('бесконечность не доходит до строки', () => {
    expect(pnlView({ valueUsd: Infinity }).state).toBe('not_applicable');
    expect(pnlView({ valueUsd: -Infinity }).state).toBe('not_applicable');
  });

  it('undefined равен отсутствию', () => {
    expect(pnlView({ valueUsd: undefined }).state).toBe('not_applicable');
  });
});

describe('форматирование', () => {
  it('прибыль со знаком плюс', () => {
    expect(formatSignedUsd(120.5)).toBe('+$120.50');
  });

  it('убыток с типографским минусом', () => {
    // Не дефис: в моноширинном наборе он теряется рядом с цифрами,
    // а спутать прибыль с убытком дороже всего.
    expect(formatSignedUsd(-120.5)).toBe('−$120.50');
    expect(formatSignedUsd(-120.5)).not.toContain('-');
  });

  it('ровный ноль без знака', () => {
    expect(formatSignedUsd(0)).toBe('$0.00');
  });

  it('отрицательный ноль не становится убытком', () => {
    // -0 возникает от округления мелкого минуса и означает
    // отсутствие убытка, а не убыток.
    expect(formatSignedUsd(-0)).toBe('$0.00');
    expect(pnlView({ valueUsd: -0 }).sign).toBe(0);
    expect(pnlView({ valueUsd: -0 }).label).not.toContain('−');
  });

  it('меньше цента не округляется до нуля', () => {
    expect(formatSignedUsd(0.004)).toBe('+<$0.01');
    expect(formatSignedUsd(-0.004)).toBe('−<$0.01');
  });

  it('ровно цент показывается числом', () => {
    expect(formatSignedUsd(0.01)).toBe('+$0.01');
  });

  it('крупные величины компактны и без научной записи', () => {
    expect(formatSignedUsd(1_500)).toBe('+$1.5K');
    expect(formatSignedUsd(2_400_000)).toBe('+$2.4M');
    expect(formatSignedUsd(3_100_000_000)).toBe('+$3.1B');

    for (const v of [1e7, 1e10, 1e15]) {
      expect(formatSignedUsd(v)).not.toMatch(/e\+|e-/i);
    }
  });

  it('очень большая величина остаётся читаемой', () => {
    expect(formatUsdMagnitude(1.5e12)).toBe('$1500B');
  });

  it('полная величина для подсказки с разделителями', () => {
    expect(formatExactUsd(1234567.891)).toBe('+$1,234,567.89');
    expect(formatExactUsd(-42)).toBe('−$42.00');
    expect(formatExactUsd(0)).toBe('$0.00');
  });

  it('нечисловое не печатается', () => {
    expect(formatSignedUsd(NaN)).toBe('—');
    expect(formatExactUsd(Infinity)).toBe('—');
  });
});

describe('общий результат', () => {
  it('складывается, когда обе части известны', () => {
    const total = totalPnl(pnlView({ valueUsd: 100 }), pnlView({ valueUsd: -30 }));

    expect(total.state).toBe('available');
    expect(total.valueUsd).toBe(70);
  });

  it('не складывается, если одна часть неизвестна', () => {
    // Подставить ноль вместо неизвестного значит выдать половину
    // ответа за целый — а решение по нему принимают такое же.
    const total = totalPnl(pnlView({ valueUsd: 100 }), pnlView({ valueUsd: null }));

    expect(total.state).toBe('not_applicable');
    expect(total.valueUsd).toBeNull();
  });

  it('ожидание расчёта передаётся в общий результат', () => {
    const total = totalPnl(pnlView({ valueUsd: 100 }), pnlView({ valueUsd: null, isPending: true }));

    expect(total.state).toBe('pending');
  });

  it('неполная история важнее ожидания и в сумме', () => {
    const total = totalPnl(
      pnlView({ valueUsd: null, isPending: true }),
      pnlView({ valueUsd: null, hasIncompleteHistory: true }),
    );

    expect(total.state).toBe('incomplete_history');
  });

  it('сумма противоположных величин даёт чистый ноль', () => {
    const total = totalPnl(pnlView({ valueUsd: 50 }), pnlView({ valueUsd: -50 }));

    expect(total.valueUsd).toBe(0);
    expect(total.label).toBe('$0.00');
  });
});

describe('доходность', () => {
  it('считается от известного вложения', () => {
    expect(roiPercent(50, 200)).toBe(25);
  });

  it('от нулевого вложения не считается', () => {
    // Это не бесконечная доходность, а отсутствие ответа.
    expect(roiPercent(50, 0)).toBeNull();
  });

  it('от неизвестного вложения не считается', () => {
    expect(roiPercent(50, null)).toBeNull();
  });

  it('нечисловые значения не дают процента', () => {
    expect(roiPercent(NaN, 100)).toBeNull();
    expect(roiPercent(50, Infinity)).toBeNull();
  });
});
