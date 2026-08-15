import { describe, it, expect } from 'vitest';
import { planAutoExit, rescaleRemaining, DEFAULT_EXIT_STEPS } from './auto-exit.js';

describe('planAutoExit — по умолчанию', () => {
  it('ставит одну цель на 3× со всей позицией', () => {
    const p = planAutoExit({ entryPriceUsd: '0.001', quantity: '1000000' });

    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.multiple).toBe(3);
    expect(Number(p.steps[0]!.triggerPriceUsd)).toBeCloseTo(0.003, 12);
    expect(p.steps[0]!.quantity).toBe('1000000');
  });

  it('предупреждает, что рост меньше 3× не будет зафиксирован', () => {
    const p = planAutoExit({ entryPriceUsd: '1', quantity: '100' });
    // Это главный недостаток одной цели, и о нём надо сказать явно,
    // а не оставлять выясняться на практике.
    expect(p.warnings.some((w) => w.includes('не будет зафиксирован'))).toBe(true);
  });

  it('умолчание — ровно 3× на 100%', () => {
    expect(DEFAULT_EXIT_STEPS).toEqual([{ multiple: 3, fraction: 1 }]);
  });
});

describe('planAutoExit — лестница', () => {
  it('считает цены и количества по каждой цели', () => {
    const p = planAutoExit({
      entryPriceUsd: '2',
      quantity: '300',
      steps: [
        { multiple: 2, fraction: 0.5 },
        { multiple: 3, fraction: 0.3 },
        { multiple: 5, fraction: 0.2 },
      ],
    });

    expect(p.steps.map((s) => Number(s.triggerPriceUsd))).toEqual([4, 6, 10]);
    expect(p.steps.map((s) => Number(s.quantity))).toEqual([150, 90, 60]);
  });

  it('сумма количеств равна позиции без остатка', () => {
    // Иначе в позиции висит «хвост» из нескольких токенов,
    // и она не считается закрытой.
    const p = planAutoExit({
      entryPriceUsd: '0.000000123',
      quantity: '1000000000',
      steps: [
        { multiple: 2, fraction: 1 / 3 },
        { multiple: 3, fraction: 1 / 3 },
        { multiple: 5, fraction: 1 / 3 },
      ],
    });

    const total = p.steps.reduce((s, x) => s + Number(x.quantity), 0);
    expect(total).toBeCloseTo(1_000_000_000, 6);
  });

  it('цели упорядочиваются по возрастанию независимо от ввода', () => {
    const p = planAutoExit({
      entryPriceUsd: '1',
      quantity: '100',
      steps: [
        { multiple: 5, fraction: 0.2 },
        { multiple: 2, fraction: 0.5 },
        { multiple: 3, fraction: 0.3 },
      ],
    });
    expect(p.steps.map((s) => s.multiple)).toEqual([2, 3, 5]);
  });

  it('сумма долей больше 100% ужимается пропорционально', () => {
    const p = planAutoExit({
      entryPriceUsd: '1',
      quantity: '100',
      steps: [
        { multiple: 2, fraction: 0.8 },
        { multiple: 3, fraction: 0.8 },
      ],
    });

    const total = p.steps.reduce((s, x) => s + Number(x.quantity), 0);
    // Продать больше, чем есть, нельзя — часть ордеров отклонилась бы
    // при срабатывании, и какая именно, зависело бы от порядка.
    expect(total).toBeCloseTo(100, 6);
    expect(p.warnings.some((w) => w.includes('превышает размер позиции'))).toBe(true);
  });

  it('сумма долей меньше 100% не дополняется', () => {
    // Остаток оставлен намеренно — дополнять план значит решать за владельца.
    const p = planAutoExit({
      entryPriceUsd: '1',
      quantity: '100',
      steps: [{ multiple: 3, fraction: 0.6 }],
    });

    expect(Number(p.steps[0]!.quantity)).toBeCloseTo(60, 6);
    expect(p.warnings.some((w) => w.includes('превышает'))).toBe(false);
  });
});

describe('planAutoExit — некорректный ввод', () => {
  it('без цены или количества план пустой', () => {
    expect(planAutoExit({ entryPriceUsd: '0', quantity: '100' }).steps).toHaveLength(0);
    expect(planAutoExit({ entryPriceUsd: '1', quantity: '0' }).steps).toHaveLength(0);
    expect(planAutoExit({ entryPriceUsd: '-1', quantity: '100' }).steps).toHaveLength(0);
  });

  it('цель с кратностью 1 и меньше отбрасывается', () => {
    // Продажа по цене входа — это не тейк-профит.
    const p = planAutoExit({
      entryPriceUsd: '1',
      quantity: '100',
      steps: [
        { multiple: 1, fraction: 0.5 },
        { multiple: 0.5, fraction: 0.5 },
      ],
    });
    expect(p.steps).toHaveLength(0);
    expect(p.warnings[0]).toContain('больше 1');
  });

  it('нулевые и отрицательные доли отбрасываются', () => {
    const p = planAutoExit({
      entryPriceUsd: '1',
      quantity: '100',
      steps: [
        { multiple: 2, fraction: 0 },
        { multiple: 3, fraction: 1 },
      ],
    });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.multiple).toBe(3);
  });
});

describe('planAutoExit — стоп-лосс', () => {
  it('считается от цены входа и покрывает всю позицию', () => {
    const p = planAutoExit({
      entryPriceUsd: '100',
      quantity: '10',
      stopLossPct: 35,
    });

    expect(Number(p.stopLoss!.triggerPriceUsd)).toBeCloseTo(65, 10);
    // Частичный стоп оставил бы остаток без защиты — а нужен он
    // именно для защиты.
    expect(p.stopLoss!.quantity).toBe('10');
  });

  it('предупреждает о пересечении стопа и целей по количеству', () => {
    const p = planAutoExit({ entryPriceUsd: '1', quantity: '100', stopLossPct: 30 });
    expect(p.warnings.some((w) => w.includes('снять'))).toBe(true);
  });

  it('без стопа и при неверном проценте стоп не ставится', () => {
    expect(planAutoExit({ entryPriceUsd: '1', quantity: '1' }).stopLoss).toBeNull();
    expect(planAutoExit({ entryPriceUsd: '1', quantity: '1', stopLossPct: 0 }).stopLoss).toBeNull();
    expect(planAutoExit({ entryPriceUsd: '1', quantity: '1', stopLossPct: 100 }).stopLoss).toBeNull();
    expect(planAutoExit({ entryPriceUsd: '1', quantity: '1', stopLossPct: 150 }).stopLoss).toBeNull();
  });
});

describe('rescaleRemaining', () => {
  it('ужимает оставшиеся ордера под фактический остаток', () => {
    // Сработала одна цель — остальные выставлены на количество,
    // которого уже нет.
    const r = rescaleRemaining('50', [
      { id: 'a', quantity: '60' },
      { id: 'b', quantity: '40' },
    ]);

    const total = r.reduce((s, x) => s + Number(x.quantity), 0);
    expect(total).toBeCloseTo(50, 6);
    expect(Number(r[0]!.quantity)).toBeCloseTo(30, 6);
  });

  it('не увеличивает ордера, если остатка хватает', () => {
    const r = rescaleRemaining('200', [
      { id: 'a', quantity: '60' },
      { id: 'b', quantity: '40' },
    ]);
    expect(r.map((x) => Number(x.quantity))).toEqual([60, 40]);
  });

  it('при нулевом остатке обнуляет всё', () => {
    const r = rescaleRemaining('0', [{ id: 'a', quantity: '60' }]);
    expect(Number(r[0]!.quantity)).toBe(0);
  });

  it('пустой список не ломается', () => {
    expect(rescaleRemaining('100', [])).toEqual([]);
  });
});
