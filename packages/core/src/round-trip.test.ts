import { describe, it, expect } from 'vitest';
import {
  judgeRoundTrip,
  TRAP_RETURN_RATIO,
  COSTLY_RETURN_RATIO,
} from './round-trip.js';

describe('judgeRoundTrip — блокировка', () => {
  it('нет маршрута на покупку', () => {
    const d = judgeRoundTrip({ canBuy: false, canSell: false, returnRatio: null });
    expect(d.verdict).toBe('BLOCK');
    expect(d.reason).toContain('торговать нечем');
  });

  it('купить можно, продать нельзя — определение ловушки', () => {
    // Здесь не нужны ни списки безопасности, ни статистика сделок:
    // проверка выполнена напрямую.
    const d = judgeRoundTrip({ canBuy: true, canSell: false, returnRatio: 0 });
    expect(d.verdict).toBe('BLOCK');
    expect(d.reason).toContain('продать нельзя');
  });

  it('возврат меньше половины — изъятие, а не комиссия', () => {
    const d = judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: 0.1 });
    expect(d.verdict).toBe('BLOCK');
    expect(d.lossPct).toBeCloseTo(90, 6);
    expect(d.reason).toContain('изъятие');
  });

  it('порог ловушки срабатывает ровно на границе', () => {
    expect(
      judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: TRAP_RETURN_RATIO - 0.001 })
        .verdict,
    ).toBe('BLOCK');
    expect(
      judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: TRAP_RETURN_RATIO }).verdict,
    ).toBe('WARN');
  });
});

describe('judgeRoundTrip — предупреждение', () => {
  it('дорогой круг на тонком пуле', () => {
    // Пятнадцать процентов потерь — много, но у честного токена
    // с маленьким пулом бывает, и запрещать это перебор.
    const d = judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: 0.8 });
    expect(d.verdict).toBe('WARN');
    expect(d.lossPct).toBeCloseTo(20, 6);
    expect(d.reason).toContain('тонкий');
  });

  it('граница между предупреждением и нормой', () => {
    expect(
      judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: COSTLY_RETURN_RATIO - 0.001 })
        .verdict,
    ).toBe('WARN');
    expect(
      judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: COSTLY_RETURN_RATIO }).verdict,
    ).toBe('OK');
  });
});

describe('judgeRoundTrip — норма', () => {
  it('обычные потери на двух обменах', () => {
    const d = judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: 0.97 });
    expect(d.verdict).toBe('OK');
    expect(d.lossPct).toBeCloseTo(3, 6);
  });

  it('возврат выше единицы не подаётся как прибыль', () => {
    // Цена сдвинулась между двумя запросами — это погрешность
    // замера, а не заработок, и обещать его нельзя.
    const d = judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: 1.02 });
    expect(d.verdict).toBe('OK');
    expect(d.reason).toContain('погрешности');
    expect(d.reason.toLowerCase()).not.toContain('прибыл');
    expect(d.lossPct).toBe(0);
  });
});

describe('judgeRoundTrip — неизвестность', () => {
  it('неудавшийся замер не выдаётся за проверку', () => {
    // «Не смогли проверить» и «проверили, всё хорошо» — разные вещи,
    // и путать их в этом месте дороже всего.
    for (const ratio of [null, NaN, 0, -1]) {
      const d = judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: ratio });
      expect(d.verdict, String(ratio)).toBe('UNKNOWN');
    }
  });

  it('у неизвестности нет числа потерь', () => {
    const d = judgeRoundTrip({ canBuy: true, canSell: true, returnRatio: null });
    expect(d.lossPct).toBeNull();
  });
});

describe('judgeRoundTrip — пороги', () => {
  it('заданы в разумном порядке', () => {
    expect(TRAP_RETURN_RATIO).toBeLessThan(COSTLY_RETURN_RATIO);
    expect(TRAP_RETURN_RATIO).toBeGreaterThan(0);
    expect(COSTLY_RETURN_RATIO).toBeLessThan(1);
  });
});
