import { describe, it, expect } from 'vitest';
import {
  assessRisk,
  isListable,
  DEFAULT_RISK_CONFIG,
  SAFE_LEVELS,
  TRADEABLE_LEVELS,
  type Reason,
} from './risk-model.js';

/**
 * Сквозная проверка допуска в витрину.
 *
 * Отдельные правила проверяются в других файлах; здесь проверяется
 * то, ради чего они существуют, — попадёт токен в список или нет.
 * Это единственный уровень, на котором ошибка видна пользователю,
 * и единственный, где её стоит закреплять тестом.
 */

const r = (code: string, weight: number, message = ''): Reason =>
  ({ code, message, weight }) as Reason;

/** Обычная проверка: источники ответили, подделкой не является. */
const checked = (reasons: Reason[]) =>
  assessRisk({ reasons, securityChecked: true, isVerifiedAsset: false });

describe('полная блокировка', () => {
  const blocking: Array<[string, Reason]> = [
    ['ловушка', r('HONEYPOT', 100)],
    ['продажа не прошла', r('SELL_FAILED', 100)],
    ['продать можно не всё', r('CANNOT_SELL_ALL', 100)],
    ['налог на продажу выше предела', r('HIGH_SELL_TAX', 100)],
    ['вредоносный контракт', r('MALICIOUS_CONTRACT', 100)],
    ['баланс изменяем', r('BALANCE_MUTABLE', 100)],
    ['чёрный список переводов', r('TRANSFER_BLACKLIST', 100)],
    ['подделка под известный тикер', r('FAKE_SYMBOL', 100)],
    ['подделка под биржевую бумагу', r('FAKE_RWA_TICKER', 100)],
    ['ликвидности недостаточно', r('LOW_LIQUIDITY', 100)],
    ['создатель владеет выпуском', r('CREATOR_CONTROLS_SUPPLY', 100)],
    ['заморозка активна', r('FREEZE_AUTHORITY_ACTIVE', 100)],
    ['высокий риск по версии OKX', r('OKX_HIGH_RISK', 100)],
    ['критическая находка RugCheck', r('RUGCHECK_CRITICAL', 100)],
    ['Jupiter исключил токен', r('JUPITER_BANNED', 100)],
    ['числа неправдоподобны', r('IMPLAUSIBLE_METRICS', 100)],
    ['источники расходятся в цене', r('SOURCE_PRICE_MISMATCH', 100)],
  ];

  for (const [name, reason] of blocking) {
    it(`${name} — токен скрыт`, () => {
      const res = checked([reason]);
      expect(res.level).toBe('blocked');
      expect(isListable(res.level, true)).toBe(false);
      expect(isListable(res.level, false)).toBe(false);
    });
  }

  it('история создателя прячет токен, но не называет его уличённым', () => {
    // Разница не педантичная. «Заблокирован» означает найденное
    // нарушение, а брошенные прежде токены — прогноз о будущем.
    // Из выдачи такой токен исчезает в обоих случаях, но называть
    // прогноз фактом мы не станем.
    const res = checked([r('DEV_RUG_HISTORY', 100)]);
    expect(res.level).toBe('high');
    expect(isListable(res.level, false)).toBe(false);
    expect(isListable(res.level, true)).toBe(false);
  });

  it('критическая причина перевешивает подтверждённость', () => {
    // Даже токен из реестра, у которого сломалась продажа,
    // торговать нельзя.
    const res = assessRisk({
      reasons: [r('SELL_FAILED', 100)],
      securityChecked: true,
      isVerifiedAsset: true,
    });
    expect(res.level).toBe('blocked');
  });
});

describe('непроверенное не считается безопасным', () => {
  it('без ответа источников — pending', () => {
    const res = assessRisk({ reasons: [], securityChecked: false, isVerifiedAsset: false });
    expect(res.level).toBe('pending');
  });

  it('pending не попадает ни в строгий режим, ни в обычный', () => {
    // Незавершённая проверка — это отсутствие сведений, а не сведения
    // об отсутствии проблем.
    expect(isListable('pending', true)).toBe(false);
    expect(isListable('pending', false)).toBe(false);
    expect(SAFE_LEVELS).not.toContain('pending');
    expect(TRADEABLE_LEVELS).not.toContain('pending');
  });

  it('недоступность источника не улучшает оценку', () => {
    const res = assessRisk({
      reasons: [r('SECURITY_DATA_UNAVAILABLE', 0)],
      securityChecked: false,
      isVerifiedAsset: false,
    });
    expect(res.level).toBe('pending');
  });

  it('критическая причина сильнее незавершённой проверки', () => {
    const res = assessRisk({
      reasons: [r('HONEYPOT', 100)],
      securityChecked: false,
      isVerifiedAsset: false,
    });
    expect(res.level).toBe('blocked');
  });
});

describe('обычный мем-коин проходит', () => {
  it('незалоченный пул и половина у топ-10 — низкий риск', () => {
    // Для этого рынка и то и другое норма. Если такой токен не проходит,
    // фильтр бесполезен: не проходит никто.
    const res = checked([r('UNLOCKED_LIQUIDITY', 15), r('HIGH_TOP10_CONCENTRATION', 10)]);
    expect(res.level).toBe('low');
    expect(isListable(res.level, true)).toBe(true);
  });

  it('молодой пул с малым числом держателей ещё проходит', () => {
    const res = checked([r('YOUNG_POOL', 5), r('FEW_HOLDERS', 10), r('SINGLE_SOURCE', 10)]);
    expect(res.level).toBe('low');
  });

  it('без единого замечания — низкий риск', () => {
    expect(checked([]).level).toBe('low');
  });

  it('подтверждённый актив без замечаний получает отдельный уровень', () => {
    const res = assessRisk({ reasons: [], securityChecked: true, isVerifiedAsset: true });
    expect(res.level).toBe('verified');
  });
});

describe('сомнительное прячется из строгого режима, но не пропадает', () => {
  it('активная эмиссия вместе с незалоченным пулом — средний риск', () => {
    const res = checked([r('MINT_AUTHORITY_ACTIVE', 25), r('UNLOCKED_LIQUIDITY', 15)]);
    expect(res.level).toBe('medium');
    expect(isListable(res.level, true)).toBe(false);
    // Но при снятом строгом фильтре виден — вместе с жёлтым щитом.
    expect(isListable(res.level, false)).toBe(true);
  });

  it('покупки без продаж — средний риск', () => {
    expect(checked([r('ONE_SIDED_TRADING', 35)]).level).toBe('medium');
  });

  it('претензия на бумагу без подтверждения не пускает в строгий режим', () => {
    // Не блокируем: мы не проверили, а не нашли нарушение. Но и
    // безопасным назвать не можем.
    const res = checked([r('UNVERIFIED_RWA_CLAIM', 40)]);
    expect(res.level).toBe('medium');
    expect(isListable(res.level, true)).toBe(false);
  });

  it('накрутка и захват предложения — высокий риск, скрыт везде', () => {
    const res = checked([
      r('SUSPICIOUS_VOLUME', 20),
      r('HIGH_TOP10_CONCENTRATION', 25),
      r('MINT_AUTHORITY_ACTIVE', 25),
    ]);
    expect(res.level).toBe('high');
    expect(isListable(res.level, false)).toBe(false);
  });
});

describe('оценка риска', () => {
  it('баллы складываются и ограничены сотней', () => {
    const res = checked([r('A' as never, 60), r('B' as never, 70)]);
    expect(res.score).toBe(100);
  });

  it('коды доступны отдельно от текста', () => {
    // По русскому тексту нельзя ни отфильтровать, ни посчитать.
    const res = checked([r('YOUNG_POOL', 5, 'Пулу 2 ч')]);
    expect(res.codes).toEqual(['YOUNG_POOL']);
  });

  it('пороги остаются согласованными между собой', () => {
    expect(DEFAULT_RISK_CONFIG.lowRiskMaxScore).toBeLessThan(
      DEFAULT_RISK_CONFIG.mediumRiskMaxScore,
    );
  });

  it('строгий режим строго уже обычного', () => {
    for (const l of SAFE_LEVELS) {
      expect(TRADEABLE_LEVELS).toContain(l);
    }
    expect(SAFE_LEVELS.length).toBeLessThan(TRADEABLE_LEVELS.length);
  });
});
