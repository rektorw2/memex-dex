import { describe, it, expect } from 'vitest';
import {
  confidenceOf,
  progressToScore,
  winRateView,
  formatMultiple,
  formatEntryTime,
  categorize,
  CATEGORY_LABELS,
  HIGH_CONFIDENCE_TRADES,
  MEDIUM_CONFIDENCE_TRADES,
} from './wallet-confidence.js';

describe('уверенность отделена от оценки', () => {
  it('одна удачная сделка не даёт высокой уверенности', () => {
    // Главное требование всей страницы: везение не должно выглядеть
    // как мастерство.
    expect(confidenceOf(1).level).toBe('low');
  });

  it('пороги различают три состояния', () => {
    expect(confidenceOf(0).level).toBe('none');
    expect(confidenceOf(4).level).toBe('low');
    expect(confidenceOf(MEDIUM_CONFIDENCE_TRADES).level).toBe('medium');
    expect(confidenceOf(HIGH_CONFIDENCE_TRADES).level).toBe('high');
    expect(confidenceOf(40).level).toBe('high');
  });

  it('у каждого состояния есть объяснение, а не только цвет', () => {
    for (const n of [0, 2, 7, 30]) {
      const c = confidenceOf(n);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.explanation.length).toBeGreaterThan(20);
    }
  });

  it('отсутствие данных отличается от плохих данных', () => {
    expect(confidenceOf(0).label).toContain('Нет завершённых');
    expect(confidenceOf(2).label).toContain('Собираем');
  });
});

describe('прогресс вместо плашки «оценки нет»', () => {
  it('показывает, сколько осталось', () => {
    const p = progressToScore(3);
    expect(p.text).toBe(`3 из ${MEDIUM_CONFIDENCE_TRADES} сделок для первой оценки`);
    expect(p.ratio).toBeCloseTo(3 / MEDIUM_CONFIDENCE_TRADES);
  });

  it('не переполняется', () => {
    expect(progressToScore(99).ratio).toBe(1);
    expect(progressToScore(null).done).toBe(0);
  });
});

describe('доля удачных сделок', () => {
  it('обычный случай', () => {
    expect(winRateView(3, 5).text).toBe('3/5 · 60%');
  });

  it('невозможное значение помечается, а не подгоняется', () => {
    // «3 из 2» на экране подрывает доверие ко всей странице.
    const v = winRateView(3, 2);
    expect(v.isImpossible).toBe(true);
    expect(v.pct).toBeNull();
  });

  it('пустая выборка не притворяется нулевой долей', () => {
    expect(winRateView(0, 0).text).toBe('нет завершённых');
    expect(winRateView(0, 0).pct).toBeNull();
  });
});

describe('форматирование', () => {
  it('кратность', () => {
    expect(formatMultiple(3.63)).toBe('3.6×');
    expect(formatMultiple(12.4)).toBe('12×');
    expect(formatMultiple(null)).toBe('—');
    expect(formatMultiple(0)).toBe('—');
  });

  it('вход в первые минуты не превращается в «0.0 ч»', () => {
    // Ноль с десятичной долей читался как сбой измерения, хотя
    // означал самое ценное свойство кошелька.
    expect(formatEntryTime(0.005)).toBe('<1 мин');
    expect(formatEntryTime(0.2)).toBe('12 мин');
    expect(formatEntryTime(2)).toBe('2.0 ч');
    expect(formatEntryTime(72)).toBe('3.0 дн');
    expect(formatEntryTime(null)).toBe('—');
  });
});

describe('категории', () => {
  it('крупный объём делает кошелёк китом', () => {
    expect(categorize({ settled: 20, volumeUsd: 90_000, medianEntryHours: 20, score: 60 })).toBe('whale');
  });

  it('быстрый вход делает ранним', () => {
    expect(categorize({ settled: 8, volumeUsd: 1_000, medianEntryHours: 0.5, score: 40 })).toBe('early');
  });

  it('стабильный требует и истории, и результата', () => {
    expect(categorize({ settled: 30, volumeUsd: 100, medianEntryHours: 50, score: 70 })).toBe('steady');
    // Длинная история без результата стабильным не делает.
    expect(categorize({ settled: 30, volumeUsd: 100, medianEntryHours: 50, score: 10 })).not.toBe('steady');
  });

  it('короткая история — новый', () => {
    expect(categorize({ settled: 2, volumeUsd: 100, medianEntryHours: 50, score: null })).toBe('new');
  });

  it('у всех категорий есть русская подпись', () => {
    for (const key of Object.keys(CATEGORY_LABELS)) {
      expect(CATEGORY_LABELS[key as never].length).toBeGreaterThan(0);
    }
  });
});
