import { describe, it, expect } from 'vitest';
import {
  evaluateScanBudget,
  suggestBootstrapSlot,
  validateBootstrapSlot,
  pagesNeededForWindow,
  SLOTS_PER_HOUR,
  SLOTS_PER_DAY,
} from './solana-scan-budget.js';

/**
 * Бюджет просмотра и первый слот.
 *
 * Главное, что здесь проверяется: нехватка бюджета не превращается
 * в молча сокращённое окно. Сокращённое окно неотличимо от
 * просмотренного, и депозит, попавший в отрезанную часть, не
 * найдётся никогда.
 */

const budget = (over: Partial<Parameters<typeof evaluateScanBudget>[0]> = {}) =>
  evaluateScanBudget({
    lookbackSlots: SLOTS_PER_DAY,
    pageSize: 100,
    maxPages: 10,
    expectedSignaturesPerHour: 10,
    ...over,
  });

describe('бюджет просмотра', () => {
  it('вместимость прохода — произведение страницы на число страниц', () => {
    expect(budget().signatureCapacity).toBe(1000);
  });

  it('спокойный адрес за сутки помещается', () => {
    // 24 часа × 10 подписей = 240 при вместимости 1000.
    const result = budget({ expectedSignaturesPerHour: 10 });
    expect(result.status).toBe('FITS');
    expect(result.expectedSignatures).toBe(240);
  });

  it('активный адрес не помещается и это названо прямо', () => {
    const result = budget({ expectedSignaturesPerHour: 100 });
    expect(result.status).toBe('INSUFFICIENT_SCAN_BUDGET');
  });

  it('при нехватке предлагается безопасное окно, а не тишина', () => {
    // Отказ без альтернативы заставляет подбирать числа на глаз.
    const result = budget({ expectedSignaturesPerHour: 100 });
    expect(result.safeLookbackSlots).toBeGreaterThan(0);
    expect(result.safeLookbackSlots).toBeLessThan(SLOTS_PER_DAY);
  });

  it('предложенное безопасное окно действительно помещается', () => {
    const first = budget({ expectedSignaturesPerHour: 100 });
    const second = budget({
      expectedSignaturesPerHour: 100,
      lookbackSlots: first.safeLookbackSlots!,
    });
    expect(second.status).toBe('FITS');
  });

  it('фактическая конфигурация проекта проверяется на настоящих числах', () => {
    /*
     * 216000 слотов ≈ сутки при pageSize 100 и maxPages 10.
     * Вместимость прохода — 1000 подписей, то есть окно выдерживает
     * адрес не активнее ~41 подписи в час. Для депозитного адреса
     * одного пользователя это с запасом, для общего — нет.
     */
    const quiet = evaluateScanBudget({
      lookbackSlots: 216_000, pageSize: 100, maxPages: 10, expectedSignaturesPerHour: 40,
    });
    const busy = evaluateScanBudget({
      lookbackSlots: 216_000, pageSize: 100, maxPages: 10, expectedSignaturesPerHour: 60,
    });

    expect(quiet.status).toBe('FITS');
    expect(busy.status).toBe('INSUFFICIENT_SCAN_BUDGET');
  });

  it('нулевая активность помещается, но окно не выдумывается', () => {
    const result = budget({ expectedSignaturesPerHour: 0 });
    expect(result.status).toBe('FITS');
    expect(result.safeLookbackSlots).toBe(SLOTS_PER_DAY);
  });

  it('бессмысленные значения отклоняются, а не считаются', () => {
    for (const bad of [
      { lookbackSlots: 0 }, { pageSize: 0 }, { maxPages: -1 },
      { expectedSignaturesPerHour: -5 }, { lookbackSlots: 1.5 },
    ]) {
      expect(budget(bad).status, JSON.stringify(bad)).toBe('INVALID_INPUT');
    }
  });

  it('число нужных страниц считается отдельно', () => {
    expect(pagesNeededForWindow(SLOTS_PER_HOUR * 10, 100, 50)).toBe(5);
  });
});

// ─────────────────────────── Первый слот ─────────────────────────────────────

describe('выбор первого слота', () => {
  const FINALIZED = 300_000_000;

  const suggest = (over: Partial<Parameters<typeof suggestBootstrapSlot>[0]> = {}) =>
    suggestBootstrapSlot({
      finalizedSlot: FINALIZED,
      lookbackSlots: SLOTS_PER_HOUR,
      budget: {
        lookbackSlots: SLOTS_PER_HOUR,
        pageSize: 100,
        maxPages: 10,
        expectedSignaturesPerHour: 10,
      },
      ...over,
    });

  it('отступает от finalized на заданное окно', () => {
    const result = suggest();
    expect(result.status).toBe('OK');
    expect(result.suggestedSlot).toBe(FINALIZED - SLOTS_PER_HOUR);
  });

  it('показывает диапазон первого прохода', () => {
    expect(suggest().range).toEqual({ from: FINALIZED - SLOTS_PER_HOUR, to: FINALIZED });
  });

  it('без finalized ничего не предлагает', () => {
    // Отсчёт от confirmed стартовал бы с точки, которой может
    // не остаться в цепочке.
    expect(suggest({ finalizedSlot: null }).status).toBe('FINALIZED_UNKNOWN');
    expect(suggest({ finalizedSlot: null }).suggestedSlot).toBeNull();
  });

  it('отрицательные значения отклоняются', () => {
    expect(suggest({ finalizedSlot: -1 }).status).toBe('NEGATIVE_SLOT');
    expect(suggest({ lookbackSlots: -1 }).status).toBe('NEGATIVE_SLOT');
  });

  it('окно глубже всей цепочки не превращается в ноль', () => {
    // Ноль означал бы «с начала цепочки» — годы истории и
    // гарантированный упор в потолок страниц.
    const result = suggest({ finalizedSlot: 100, lookbackSlots: 1000 });
    expect(result.status).toBe('AHEAD_OF_FINALIZED');
    expect(result.suggestedSlot).toBeNull();
  });

  it('при нехватке бюджета слот не предлагается вовсе', () => {
    const result = suggest({
      budget: {
        lookbackSlots: SLOTS_PER_DAY, pageSize: 10, maxPages: 2, expectedSignaturesPerHour: 500,
      },
    });
    // Значение вместе с предупреждением скопируют, не дочитав.
    expect(result.status).toBe('WINDOW_EXCEEDS_BUDGET');
    expect(result.suggestedSlot).toBeNull();
    expect(result.budget.status).toBe('INSUFFICIENT_SCAN_BUDGET');
  });

  it('расчёт бюджета возвращается вместе с вердиктом', () => {
    expect(suggest().budget.status).toBe('FITS');
  });
});

describe('проверка уже выбранного слота', () => {
  it('слот в прошлом годится', () => {
    expect(validateBootstrapSlot(100, 200)).toBe('OK');
  });

  it('слот из будущего отклоняется', () => {
    // Начать с будущего значит пропустить всё, что придёт до него.
    expect(validateBootstrapSlot(300, 200)).toBe('AHEAD_OF_FINALIZED');
  });

  it('отрицательный и дробный слот отклоняются', () => {
    expect(validateBootstrapSlot(-1, 200)).toBe('NEGATIVE_SLOT');
    expect(validateBootstrapSlot(1.5, 200)).toBe('NEGATIVE_SLOT');
  });

  it('без finalized проверить нечем', () => {
    expect(validateBootstrapSlot(100, null)).toBe('FINALIZED_UNKNOWN');
  });

  it('ровно finalized допустим', () => {
    expect(validateBootstrapSlot(200, 200)).toBe('OK');
  });
});
