import { describe, it, expect } from 'vitest';
import {
  budgetDecision,
  budgetThresholds,
  forecastBudget,
  isUserFacing,
  slowdownFactor,
  FREE_BUDGET,
  OKX_CALL_PURPOSES,
  type OkxCallPurpose,
} from './okx-budget.js';

/**
 * Кого тормозить у предела квоты.
 *
 * Главное правило: тормозить надо фон, а не человека. Разница между
 * «переоценка каталога подождёт до завтра» и «график перестал
 * обновляться» — это вся разница между экономией и сломанным
 * продуктом.
 */

const basic = FREE_BUDGET.basic;
const premium = FREE_BUDGET.premium;

const decide = (used: number, purpose: OkxCallPurpose, thresholds = basic) =>
  budgetDecision({ tier: 'basic', purpose, used, thresholds });

describe('обычный режим', () => {
  it('до предупреждения работают все', () => {
    for (const purpose of OKX_CALL_PURPOSES) {
      expect(decide(0, purpose), purpose).toEqual({ allow: true, slow: false });
    }
  });

  it('бесплатные endpoint разрешены даже при исчерпанной квоте', () => {
    // Они не расходуют ничего, и притормаживать их значит ухудшать
    // продукт без всякой экономии.
    expect(
      budgetDecision({
        tier: 'free',
        purpose: 'cold-price',
        used: 10_000_000,
        thresholds: basic,
      }),
    ).toEqual({ allow: true, slow: false });
  });
});

describe('предупреждение: фон замедляется, человек нет', () => {
  it('фоновый вызов разрешён, но помечен как медленный', () => {
    expect(decide(basic.warn, 'cold-price')).toEqual({ allow: true, slow: true });
  });

  it('пользовательский вызов идёт в полном темпе', () => {
    expect(decide(basic.warn, 'hot-price')).toEqual({ allow: true, slow: false });
  });
});

describe('резерв: остаток принадлежит пользователю', () => {
  it.each(['cold-price', 'enrichment', 'risk', 'wallets'] as const)(
    'фоновый вызов %s отклоняется',
    (purpose) => {
      expect(decide(basic.reserve, purpose)).toEqual({
        allow: false,
        slow: true,
        reason: 'reserve',
      });
    },
  );

  it.each(['hot-price', 'signal', 'candles'] as const)(
    'пользовательский вызов %s проходит',
    (purpose) => {
      /*
       * Ради этого резерв и существует. Открытый график, лента
       * сигналов и свечи — то, что человек видит; фоновая переоценка
       * каталога может подождать до первого числа.
       */
      expect(decide(basic.reserve, purpose)).toEqual({ allow: true, slow: true });
    },
  );
});

describe('квота исчерпана', () => {
  it('отказ всем, включая пользователя', () => {
    /*
     * Дальше каждый вызов стоит денег. Молча тратить их нельзя даже
     * ради человека: он не просил платить, он просил показать цену.
     * Показать надо последнюю известную, с пометкой «устарела».
     */
    expect(decide(basic.quota, 'hot-price')).toEqual({
      allow: false,
      slow: true,
      reason: 'quota',
    });
  });

  it('причина отличается от резерва', () => {
    const atReserve = decide(basic.reserve, 'cold-price');
    const atQuota = decide(basic.quota, 'cold-price');

    expect(atReserve).toMatchObject({ reason: 'reserve' });
    expect(atQuota).toMatchObject({ reason: 'quota' });
  });
});

describe('Basic и Premium считаются раздельно', () => {
  it('это две независимые квоты, а не общая', () => {
    /*
     * Складывать их нельзя. На бесплатном плане это две сотни тысяч
     * вызовов с разной ценой перерасхода: $0.0001 против $0.0002.
     */
    expect(basic.quota).toBe(100_000);
    expect(premium.quota).toBe(100_000);
    expect(basic.warn).not.toBe(premium.warn);
  });

  it('у Premium пороги строже', () => {
    // Он вдвое дороже сверх квоты и вчетверо меньше на платных планах.
    expect(premium.warn).toBeLessThan(basic.warn);
    expect(premium.reserve).toBeLessThan(basic.reserve);
  });

  it('исчерпание Basic не мешает Premium', () => {
    const premiumOk = budgetDecision({
      tier: 'premium',
      purpose: 'signal',
      used: 0,
      thresholds: premium,
    });

    expect(premiumOk).toEqual({ allow: true, slow: false });
  });

  it('пороги произвольной квоты считаются в тех же долях', () => {
    const t = budgetThresholds('basic', 2_000_000);

    expect(t.warn).toBe(1_600_000);
    expect(t.reserve).toBe(1_800_000);
    expect(t.quota).toBe(2_000_000);
  });
});

describe('множитель замедления', () => {
  it('до предупреждения — обычный темп', () => {
    expect(slowdownFactor(0, basic)).toBe(1);
  });

  it('после предупреждения — вчетверо реже', () => {
    expect(slowdownFactor(basic.warn, basic)).toBe(4);
  });

  it('после резерва — не запускать вовсе', () => {
    expect(slowdownFactor(basic.reserve, basic)).toBe(0);
  });
});

describe('источники расхода', () => {
  it('пользовательскими считаются только видимые человеку', () => {
    expect(isUserFacing('hot-price')).toBe(true);
    expect(isUserFacing('signal')).toBe(true);
    expect(isUserFacing('candles')).toBe(true);

    expect(isUserFacing('cold-price')).toBe(false);
    expect(isUserFacing('enrichment')).toBe(false);
    expect(isUserFacing('risk')).toBe(false);
    expect(isUserFacing('wallets')).toBe(false);
  });
});

describe('прогноз расхода', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('темп пересчитывается в месяц', () => {
    const f = forecastBudget({ used: 1_000, quota: 100_000, observedMs: DAY });

    expect(f.perDay).toBe(1_000);
    expect(f.projectedMonthly).toBe(30_000);
    expect(f.withinQuota).toBe(true);
  });

  it('перерасход виден заранее', () => {
    // Тот самый случай: восемьдесят шесть тысяч в сутки при квоте
    // в сто тысяч на месяц.
    const f = forecastBudget({ used: 86_400, quota: 100_000, observedMs: DAY });

    expect(f.withinQuota).toBe(false);
    expect(f.projectedMonthly).toBeGreaterThan(2_000_000);
    expect(f.daysToExhaustion).toBeLessThan(1);
  });

  it('слишком короткое наблюдение прогноза не даёт', () => {
    /*
     * Минута после деплоя дала бы любое число, и это число выглядело
     * бы как факт. Молчать честнее.
     */
    const f = forecastBudget({ used: 100, quota: 100_000, observedMs: 5_000 });

    expect(f.perDay).toBe(0);
    expect(f.projectedMonthly).toBe(0);
    expect(f.daysToExhaustion).toBeNull();
  });

  it('нулевой расход не кончается никогда', () => {
    const f = forecastBudget({ used: 0, quota: 100_000, observedMs: DAY });
    expect(f.daysToExhaustion).toBeNull();
  });
});
