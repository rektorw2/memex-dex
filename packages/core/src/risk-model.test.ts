import { describe, it, expect } from 'vitest';
import {
  assessRisk,
  isListable,
  DEFAULT_RISK_CONFIG,
  CRITICAL_CODES,
  RISK_LEVELS,
  RISK_LABELS,
  SAFE_LEVELS,
  TRADEABLE_LEVELS,
  type Reason,
} from './risk-model.js';

const r = (code: any, weight: number): Reason => ({ code, message: 'тест', weight });

describe('assessRisk — критические причины', () => {
  it('любая критическая причина даёт blocked', () => {
    for (const code of CRITICAL_CODES) {
      const res = assessRisk({
        reasons: [r(code, 100)],
        securityChecked: true,
        isVerifiedAsset: false,
      });
      expect(res.level, code).toBe('blocked');
      expect(res.score, code).toBe(100);
    }
  });

  it('подтверждённый актив со сломанной продажей всё равно blocked', () => {
    // Реестр говорит «мы знаем этот токен», а не «с ним всё хорошо».
    const res = assessRisk({
      reasons: [r('HONEYPOT', 100)],
      securityChecked: true,
      isVerifiedAsset: true,
    });
    expect(res.level).toBe('blocked');
  });

  it('критическая причина важнее незавершённой проверки', () => {
    const res = assessRisk({
      reasons: [r('FAKE_SYMBOL', 100)],
      securityChecked: false,
      isVerifiedAsset: false,
    });
    expect(res.level).toBe('blocked');
  });
});

describe('assessRisk — незавершённая проверка', () => {
  it('без проверки уровень pending, а не оценка риска', () => {
    // «Средний риск» звучит как вывод, а вывода нет.
    const res = assessRisk({ reasons: [], securityChecked: false, isVerifiedAsset: false });
    expect(res.level).toBe('pending');
  });

  it('pending не попадает ни в основную выдачу, ни в строгую', () => {
    expect(isListable('pending', false)).toBe(false);
    expect(isListable('pending', true)).toBe(false);
  });

  it('подтверждённость не отменяет отсутствие проверки', () => {
    const res = assessRisk({ reasons: [], securityChecked: false, isVerifiedAsset: true });
    expect(res.level).toBe('pending');
  });
});

describe('assessRisk — уровни', () => {
  it('подтверждённый актив без замечаний — verified', () => {
    const res = assessRisk({ reasons: [], securityChecked: true, isVerifiedAsset: true });
    expect(res.level).toBe('verified');
  });

  it('неподтверждённый без замечаний — low, а не verified', () => {
    // «Не нашли проблем» слабее, чем «знаем этот токен».
    const res = assessRisk({ reasons: [], securityChecked: true, isVerifiedAsset: false });
    expect(res.level).toBe('low');
  });

  it('замечания поднимают уровень по порогам', () => {
    const low = assessRisk({
      reasons: [r('YOUNG_POOL', 10)],
      securityChecked: true, isVerifiedAsset: false,
    });
    const medium = assessRisk({
      reasons: [r('UNLOCKED_LIQUIDITY', 20), r('SUSPICIOUS_VOLUME', 20)],
      securityChecked: true, isVerifiedAsset: false,
    });
    const high = assessRisk({
      reasons: [r('MINT_AUTHORITY_ACTIVE', 30), r('ONE_SIDED_TRADING', 35)],
      securityChecked: true, isVerifiedAsset: false,
    });

    expect(low.level).toBe('low');
    expect(medium.level).toBe('medium');
    expect(high.level).toBe('high');
  });

  it('оценка не превышает 100', () => {
    const res = assessRisk({
      reasons: Array.from({ length: 10 }, () => r('YOUNG_POOL', 30)),
      securityChecked: true, isVerifiedAsset: false,
    });
    expect(res.score).toBe(100);
  });

  it('подтверждённый актив с замечанием теряет verified', () => {
    const res = assessRisk({
      reasons: [r('YOUNG_POOL', 10)],
      securityChecked: true, isVerifiedAsset: true,
    });
    expect(res.level).toBe('low');
  });
});

describe('isListable', () => {
  it('строгий режим пропускает только verified и low', () => {
    expect(isListable('verified', true)).toBe(true);
    expect(isListable('low', true)).toBe(true);
    expect(isListable('medium', true)).toBe(false);
    expect(isListable('high', true)).toBe(false);
    expect(isListable('blocked', true)).toBe(false);
  });

  it('обычный режим добавляет medium', () => {
    expect(isListable('medium', false)).toBe(true);
    expect(isListable('high', false)).toBe(false);
    expect(isListable('blocked', false)).toBe(false);
  });
});

describe('модель в целом', () => {
  it('у каждого уровня есть подпись', () => {
    for (const l of RISK_LEVELS) {
      expect(RISK_LABELS[l], l).toBeTruthy();
    }
  });

  it('строгий набор — подмножество обычного', () => {
    for (const l of SAFE_LEVELS) {
      expect(TRADEABLE_LEVELS, l).toContain(l);
    }
  });

  it('пороги заданы в возрастающем порядке', () => {
    expect(DEFAULT_RISK_CONFIG.lowRiskMaxScore).toBeLessThan(
      DEFAULT_RISK_CONFIG.mediumRiskMaxScore,
    );
    expect(DEFAULT_RISK_CONFIG.elevatedSellTaxPct).toBeLessThan(
      DEFAULT_RISK_CONFIG.maxSellTaxPct,
    );
    expect(DEFAULT_RISK_CONFIG.highConcentrationPct).toBeLessThan(
      DEFAULT_RISK_CONFIG.criticalConcentrationPct,
    );
  });

  it('коды причин возвращаются отдельным массивом', () => {
    const res = assessRisk({
      reasons: [r('YOUNG_POOL', 10), r('FEW_HOLDERS', 10)],
      securityChecked: true, isVerifiedAsset: false,
    });
    expect(res.codes).toEqual(['YOUNG_POOL', 'FEW_HOLDERS']);
  });
});
