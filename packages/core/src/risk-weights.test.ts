import { describe, it, expect } from 'vitest';
import {
  REASON_WEIGHTS,
  weightOf,
  CRITICAL_WEIGHT,
  HIGH_TOP10_CRITICAL_WEIGHT,
  DEV_SOLD_PARTIAL_WEIGHT,
} from './risk-weights.js';
import {
  assessRisk,
  CRITICAL_CODES,
  DEFAULT_RISK_CONFIG as CFG,
  type Reason,
  type ReasonCode,
} from './risk-model.js';

/**
 * Почему фильтр «Проверенные» был пуст.
 *
 * Не из-за сбоев проверки, а из-за арифметики. Веса калибровались
 * в версии правил 4; версии 5–8 добавили полтора десятка кодов,
 * а границу `lowRiskMaxScore` не сдвигали. Сумма выросла, порог
 * остался, и в строгий режим перестало попадать почти всё.
 *
 * Здесь проверяется главное свойство пересчёта: норма рынка
 * не складывается в приговор, а настоящая находка из строгого режима
 * выводит. Пороги при этом не тронуты — их значения проверяются
 * отдельно ниже.
 */

const reason = (code: ReasonCode, weight = weightOf(code)): Reason => ({
  code,
  message: code,
  weight,
});

const levelOf = (codes: ReasonCode[], extra: Reason[] = []) =>
  assessRisk({
    reasons: [...codes.map((c) => reason(c)), ...extra],
    securityChecked: true,
    isVerifiedAsset: false,
  });

/** Свойства, которые есть у большинства живых мем-коинов. */
const MARKET_NORM: ReasonCode[] = [
  'MINT_AUTHORITY_ACTIVE',
  'UNLOCKED_LIQUIDITY',
  'HIGH_TOP10_CONCENTRATION',
];

describe('норма рынка не складывается в приговор', () => {
  it('обычный мем-коин проходит строгий режим', () => {
    /*
     * Ровно тот профиль, на котором фильтр и ломался: эмиссия
     * не отозвана и ликвидность не залочена. При прежних весах
     * это давало 40 при пороге 30, то есть обычный токен объявлялся
     * рискованнее среднего по рынку — что невозможно по определению.
     */
    const r = levelOf(['MINT_AUTHORITY_ACTIVE', 'UNLOCKED_LIQUIDITY']);

    expect(r.score).toBeLessThanOrEqual(CFG.lowRiskMaxScore);
    expect(r.level).toBe('low');
  });

  it('три обычных свойства вместе ещё умещаются в низкий риск', () => {
    const r = levelOf(MARKET_NORM);
    expect(r.level).toBe('low');
  });

  it('каждое обычное свойство по отдельности заметно дешевле порога', () => {
    // Одно свойство не должно съедать бюджет: иначе второе выбивает
    // токен независимо от того, что это за второе.
    for (const code of MARKET_NORM) {
      expect(weightOf(code), code).toBeLessThan(CFG.lowRiskMaxScore / 2);
    }
  });
});

describe('настоящая находка из строгого режима выводит', () => {
  it.each<[string, ReasonCode[]]>([
    ['метка Jupiter', ['JUPITER_SUSPICIOUS']],
    ['создатель вышел полностью', ['DEV_SOLD_HOLDINGS']],
    ['история создателя', ['DEV_RUG_HISTORY']],
    ['связанные кошельки', ['HIGH_BUNDLE_HOLDING', 'MINT_AUTHORITY_ACTIVE']],
    ['доля создателя', ['HIGH_DEV_HOLDING', 'UNLOCKED_LIQUIDITY']],
    ['копия чужого тикера', ['MINOR_CLONE', 'UNLOCKED_LIQUIDITY']],
    ['претензия на биржевую бумагу', ['UNVERIFIED_RWA_CLAIM']],
  ])('%s', (_name, codes) => {
    expect(levelOf(codes).level).not.toBe('low');
  });

  it('находка перевешивает всю норму рынка', () => {
    // Смысл пересчёта не в том, чтобы всё стало «низким»,
    // а в том, чтобы разница была видна.
    const norm = levelOf(MARKET_NORM);
    const withFinding = levelOf([...MARKET_NORM, 'JUPITER_SUSPICIOUS']);

    expect(norm.level).toBe('low');
    expect(withFinding.level).not.toBe('low');
  });
});

describe('пересчёт весов не ослабил правила', () => {
  it('пороги не тронуты', () => {
    // Поднять границу было бы решением задачи не той стороной:
    // проблема в том, что складывается, а не в том, где черта.
    expect(CFG.lowRiskMaxScore).toBe(30);
    expect(CFG.mediumRiskMaxScore).toBe(60);
  });

  it('критический код блокирует независимо от веса', () => {
    /*
     * Два независимых свойства кода: вес и членство в критических.
     * Путаница между ними уже стоила одной бессмысленной правки —
     * в версии 7 весом понизили JUPITER_SUSPICIOUS, оставив его
     * в критических, где вес не значит ничего.
     */
    const r = assessRisk({
      reasons: [reason('HONEYPOT', 0)],
      securityChecked: true,
      isVerifiedAsset: false,
    });

    expect(r.level).toBe('blocked');
  });

  it('ни один критический код не получил веса в таблице', () => {
    // Таблица описывает некритические коды. Вес критического создал бы
    // ложное впечатление, что его можно перевесить.
    for (const code of CRITICAL_CODES) {
      expect(REASON_WEIGHTS[code], code).toBeUndefined();
    }
  });

  it('подтверждённый актив с замечанием не становится verified', () => {
    const r = assessRisk({
      reasons: [reason('UNLOCKED_LIQUIDITY')],
      securityChecked: true,
      isVerifiedAsset: true,
    });

    expect(r.level).toBe('low');
  });
});

describe('таблица весов', () => {
  it('у каждой записи есть объяснение и оценка распространённости', () => {
    // Вес без них выглядит произволом, и через полгода его либо
    // не тронут вовсе, либо изменят наугад — ровно это и произошло.
    for (const [code, entry] of Object.entries(REASON_WEIGHTS)) {
      expect(entry!.why.length, code).toBeGreaterThan(20);
      expect(entry!.prevalence, code).toBeTruthy();
    }
  });

  it('обычное весит меньше редкого', () => {
    const weights = (p: string) =>
      Object.values(REASON_WEIGHTS)
        .filter((e) => e!.prevalence === p)
        .map((e) => e!.weight);

    expect(Math.max(...weights('обычное'))).toBeLessThan(Math.min(...weights('редкое')));
  });

  it('ни один вес не дотягивает до критического', () => {
    for (const [code, entry] of Object.entries(REASON_WEIGHTS)) {
      expect(entry!.weight, code).toBeLessThan(CRITICAL_WEIGHT);
    }
  });

  it('отсутствие данных не стоит баллов', () => {
    /*
     * Ноль намеренно. Непроверенность уже переводит токен
     * в отдельное состояние; добавлять за неё баллы значит наказывать
     * дважды за одно и то же — токен получал «высокий риск» вместо
     * честного «не проверен».
     */
    expect(weightOf('SECURITY_DATA_UNAVAILABLE')).toBe(0);
    expect(weightOf('MARKET_DATA_UNAVAILABLE')).toBe(0);
  });

  it('неизвестный код весит ноль, а не ломает оценку', () => {
    expect(weightOf('НЕТ_ТАКОГО_КОДА' as ReasonCode)).toBe(0);
  });

  it('степень тяжести отражается в весе', () => {
    // Концентрация за 85% дороже, чем за 50%; частичный выход
    // создателя дешевле полного.
    expect(HIGH_TOP10_CRITICAL_WEIGHT).toBeGreaterThan(weightOf('HIGH_TOP10_CONCENTRATION'));
    expect(DEV_SOLD_PARTIAL_WEIGHT).toBeLessThan(weightOf('DEV_SOLD_HOLDINGS'));
  });
});
