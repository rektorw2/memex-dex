/**
 * Разбор состояния риска в ответе Radar.
 *
 * Проверяется стык между воркером и API: воркер пишет полноту
 * приставками в `riskCodes`, API разбирает их обратно. Расхождение
 * здесь не даёт ошибки — оно даёт неверную надпись на карточке,
 * а именно из-за неверной надписи всё это и переделывалось.
 *
 * Отдельно и главное: запись, сделанная старым алгоритмом, не должна
 * оказаться «низким риском» из-за сохранённого старого балла.
 */

import { describe, it, expect } from 'vitest';
import { requiredChecksCount } from '@memex/core';
import { riskStateFields } from './radar-risk-state.js';

const CHECKED = new Date('2026-08-17T02:00:00.000Z');

describe('новые записи', () => {
  it('незакрытый набор — недостаточно данных без числа', () => {
    const r = riskStateFields(
      'ETHEREUM',
      'insufficient_data',
      ['COMPLETENESS_20', 'MISSING_SELL_TAX', 'MISSING_MINT_AUTHORITY'],
      5,
      CHECKED,
    );

    expect(r.riskState).toBe('insufficient_data');
    // Балл есть в базе, но наружу не идёт: пять из ста по одной
    // проверке — это не оценка риска.
    expect(r.riskStateScore).toBeNull();
    expect(r.missingChecks).toEqual(['sell_tax', 'mint_authority']);
  });

  it('закрытый набор отдаёт число', () => {
    const r = riskStateFields('ETHEREUM', 'low', ['COMPLETENESS_100'], 8, CHECKED);

    expect(r.riskState).toBe('low');
    expect(r.riskStateScore).toBe(8);
    expect(r.missingChecks).toEqual([]);
  });

  it('размер набора берётся по сети из ядра', () => {
    const evm = riskStateFields('BNB', 'low', ['COMPLETENESS_100'], 4, CHECKED);
    const sol = riskStateFields('SOLANA', 'low', ['COMPLETENESS_100'], 4, CHECKED);

    expect(evm.requiredChecksCount).toBe(requiredChecksCount('ETHEREUM'));
    expect(sol.requiredChecksCount).toBe(requiredChecksCount('SOLANA'));
  });

  it('закрытых считается вычитанием и согласовано с обязательными', () => {
    const r = riskStateFields(
      'SOLANA',
      'insufficient_data',
      ['COMPLETENESS_40', 'MISSING_FREEZE_AUTHORITY', 'MISSING_HOLDER_COUNT', 'MISSING_LIQUIDITY_LOCKED'],
      3,
      CHECKED,
    );

    expect(r.completedChecksCount + r.missingChecks.length).toBe(r.requiredChecksCount);
  });

  it('критический риск сохраняет число и причины', () => {
    const r = riskStateFields('SOLANA', 'critical', ['HONEYPOT', 'COMPLETENESS_60'], 100, CHECKED);

    expect(r.riskState).toBe('critical');
    expect(r.riskStateScore).toBe(100);
    expect(r.criticalReasons).toContain('HONEYPOT');
  });

  it('устаревший результат сохраняет число', () => {
    // Прятать посчитанное — потеря сведений; надпись про устаревание
    // делает интерфейс, а не API.
    const r = riskStateFields('ETHEREUM', 'stale', ['COMPLETENESS_100'], 22, CHECKED);

    expect(r.riskState).toBe('stale');
    expect(r.riskStateScore).toBe(22);
  });

  it('проверка в процессе не отдаёт числа', () => {
    const r = riskStateFields('ETHEREUM', 'checking', ['COMPLETENESS_40'], 12, CHECKED);

    expect(r.riskState).toBe('checking');
    expect(r.riskStateScore).toBeNull();
  });

  it('время проверки отдаётся в ISO', () => {
    const r = riskStateFields('ETHEREUM', 'low', ['COMPLETENESS_100'], 5, CHECKED);
    expect(r.riskUpdatedAt).toBe(CHECKED.toISOString());
  });
});

describe('записи старого алгоритма', () => {
  it('прежний уровень «low» не остаётся низким риском', () => {
    // Это и есть та ошибка, из-за которой всё переделывалось:
    // низкий балл означал мало проверок, а не безопасность.
    const r = riskStateFields('ETHEREUM', 'low', ['YOUNG_POOL'], 5, CHECKED);

    expect(r.riskState).not.toBe('low');
    expect(r.riskState).toBe('insufficient_data');
    expect(r.riskStateScore).toBeNull();
  });

  it('прежний «verified» тоже не проходит без вердикта полноты', () => {
    const r = riskStateFields('ETHEREUM', 'verified', [], 2, CHECKED);

    expect(r.riskState).toBe('insufficient_data');
    expect(r.riskStateScore).toBeNull();
  });

  it('запись без балла считается непроверенной', () => {
    const r = riskStateFields('SOLANA', 'pending', [], null, null);

    expect(r.riskState).toBe('checking');
    expect(r.riskStateScore).toBeNull();
  });

  it('прежний «blocked» становится критическим', () => {
    // Здесь сведения были: источник подтвердил запрет. Терять их
    // при переходе нельзя.
    const r = riskStateFields('ETHEREUM', 'blocked', ['HONEYPOT'], 100, CHECKED);

    expect(r.riskState).toBe('critical');
  });

  it('старая запись не получает выдуманной полноты', () => {
    const r = riskStateFields('ETHEREUM', 'low', ['YOUNG_POOL'], 5, CHECKED);

    expect(r.riskCompletenessPercent).toBeNull();
  });
});

describe('разбор кодов идемпотентен', () => {
  it('повторный разбор тех же кодов даёт тот же результат', () => {
    // Пересчёт воркера перезаписывает коды; разбор обязан быть
    // устойчивым, иначе состояние карточки менялось бы от прохода
    // к проходу без изменения данных.
    const codes = ['COMPLETENESS_60', 'MISSING_HONEYPOT', 'MISSING_SELL_TAX', 'FEW_HOLDERS'];

    const a = riskStateFields('ETHEREUM', 'insufficient_data', codes, 30, CHECKED);
    const b = riskStateFields('ETHEREUM', 'insufficient_data', [...codes], 30, CHECKED);

    expect(a).toEqual(b);
  });

  it('порядок кодов не влияет на результат', () => {
    const a = riskStateFields('ETHEREUM', 'insufficient_data', ['MISSING_HONEYPOT', 'COMPLETENESS_80'], 9, CHECKED);
    const b = riskStateFields('ETHEREUM', 'insufficient_data', ['COMPLETENESS_80', 'MISSING_HONEYPOT'], 9, CHECKED);

    expect(a.completedChecksCount).toBe(b.completedChecksCount);
    expect(a.missingChecks).toEqual(b.missingChecks);
  });
});
