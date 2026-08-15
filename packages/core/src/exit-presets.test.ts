import { describe, it, expect } from 'vitest';
import {
  EXIT_PRESETS,
  DEFAULT_EXIT_PRESET,
  findExitPreset,
  describePlanChange,
} from './exit-presets.js';
import { planAutoExit } from './auto-exit.js';

describe('EXIT_PRESETS — устройство планов', () => {
  it('у каждого плана уникальный ключ и понятная подпись', () => {
    const keys = EXIT_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const p of EXIT_PRESETS) {
      expect(p.label).toBeTruthy();
      // Описание читают до выбора — оно должно объяснять, что произойдёт.
      expect(p.description.length).toBeGreaterThan(15);
    }
  });

  it('доли внутри каждого плана не превышают позицию', () => {
    // Иначе план требует продать больше, чем есть, и часть ордеров
    // отклонится при срабатывании.
    for (const p of EXIT_PRESETS) {
      const total = p.steps.reduce((s, x) => s + x.fraction, 0);
      expect(total, `план ${p.key}`).toBeLessThanOrEqual(1.000001);
    }
  });

  it('стоп есть только у планов с одной целью', () => {
    // У лестницы стоп делил бы с целями то же количество токенов —
    // ровно тот конфликт, ради ухода от которого планы сделаны
    // взаимоисключающими.
    for (const p of EXIT_PRESETS) {
      if (p.stopLossPct != null) {
        expect(p.steps.length, `план ${p.key}`).toBe(1);
      }
    }
  });

  it('план по умолчанию существует', () => {
    expect(findExitPreset(DEFAULT_EXIT_PRESET)).not.toBeNull();
  });

  it('«без плана» не ставит ничего', () => {
    const none = findExitPreset('none')!;
    expect(none.steps).toHaveLength(0);
    expect(none.stopLossPct).toBeNull();
  });
});

describe('EXIT_PRESETS — совместимость с расчётом плана', () => {
  it('каждый план строится без предупреждений о превышении', () => {
    for (const p of EXIT_PRESETS) {
      if (p.steps.length === 0) continue;

      const plan = planAutoExit({
        entryPriceUsd: '0.001',
        quantity: '100000',
        steps: p.steps,
        stopLossPct: p.stopLossPct,
      });

      expect(
        plan.warnings.some((w) => w.includes('превышает размер позиции')),
        `план ${p.key}`,
      ).toBe(false);

      const sold = plan.steps.reduce((s, x) => s + Number(x.quantity), 0);
      expect(sold, `план ${p.key}`).toBeLessThanOrEqual(100000.000001);
    }
  });

  it('одиночная цель забирает всю позицию', () => {
    for (const key of ['x2', 'x3', 'x5']) {
      const p = findExitPreset(key)!;
      const plan = planAutoExit({
        entryPriceUsd: '1',
        quantity: '1000',
        steps: p.steps,
        stopLossPct: p.stopLossPct,
      });
      expect(Number(plan.steps[0]!.quantity), key).toBeCloseTo(1000, 6);
    }
  });

  it('цели считаются от цены входа, а не от текущей', () => {
    // «Взять 3×» после роста означает трёхкратный рост от входа,
    // а не от цены на момент смены плана.
    const p = findExitPreset('x3')!;
    const plan = planAutoExit({ entryPriceUsd: '2', quantity: '100', steps: p.steps });
    expect(Number(plan.steps[0]!.triggerPriceUsd)).toBeCloseTo(6, 10);
  });
});

describe('describePlanChange', () => {
  it('пустая позиция не даёт менять план', () => {
    const r = describePlanChange('x2', 'x3', 2, 0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('пуста');
  });

  it('неизвестный план отвергается', () => {
    expect(describePlanChange('x2', 'x99', 1, 100).allowed).toBe(false);
  });

  it('повторный выбор того же плана не проходит', () => {
    const r = describePlanChange('x3', 'x3', 2, 100);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('уже активен');
  });

  it('сообщает, сколько ордеров будет снято', () => {
    // Смена плана — это отмена уже стоящих ордеров, и человек должен
    // понимать это до нажатия, а не узнавать из журнала после.
    const r = describePlanChange('ladder', 'x3', 3, 100);
    expect(r.allowed).toBe(true);
    expect(r.cancels).toBe(3);
    expect(r.reason).toContain('3');
  });

  it('переход на «без плана» снимает всё и ничего не ставит', () => {
    const r = describePlanChange('x3', 'none', 2, 100);
    expect(r.allowed).toBe(true);
    expect(r.cancels).toBe(2);
    expect(r.reason).toContain('Новые не ставятся');
  });

  it('первая установка плана ничего не снимает', () => {
    const r = describePlanChange(null, 'x3', 0, 100);
    expect(r.allowed).toBe(true);
    expect(r.cancels).toBe(0);
    expect(r.reason).toContain('стоп');
  });

  it('у лестницы упоминаются цели, но не стоп', () => {
    const r = describePlanChange(null, 'ladder', 0, 100);
    expect(r.reason).toContain('3');
    expect(r.reason).not.toContain('стоп');
  });
});
