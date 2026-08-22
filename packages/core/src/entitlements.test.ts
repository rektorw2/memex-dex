import { describe, it, expect } from 'vitest';
import {
  entitlementFor,
  entitlementOf,
  effectivePlan,
  can,
  capabilityList,
  requiredPlanFor,
  stoppedByDowngrade,
  isTrialActive,
  isSubscriptionActive,
  trialRemainingSeconds,
  trialExpiresAt,
  planRank,
  canSellOwnedAsset,
  canWithdraw,
  cancelsProtectiveExitsOnDowngrade,
  NEVER_REVOKED,
  TRIAL_DURATION_MS,
  TRIAL_DURATION_HOURS,
  SUBSCRIPTION_CATALOG,
  subscriptionPriceFor,
  type PlanCode,
  type Capability,
} from './entitlements.js';

const NOW = 1_800_000_000_000;
const ALL_PLANS: PlanCode[] = ['EXPIRED', 'TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO'];

describe('цены подписок', () => {
  it('фиксирует три объявленные цены в USDC', () => {
    expect(Object.fromEntries(Object.entries(SUBSCRIPTION_CATALOG).map(([k, v]) => [k, v.price]))).toEqual({
      PRO: { amount: '50.00', currency: 'USDC' },
      SEMI_AUTO: { amount: '100.00', currency: 'USDC' },
      FULL_AUTO: { amount: '200.00', currency: 'USDC' },
    });
  });

  it('цена доступна по коду плана', () => {
    expect(subscriptionPriceFor('PRO')).toEqual({ amount: '50.00', currency: 'USDC' });
    expect(subscriptionPriceFor('SEMI_AUTO')).toEqual({ amount: '100.00', currency: 'USDC' });
    expect(subscriptionPriceFor('FULL_AUTO')).toEqual({ amount: '200.00', currency: 'USDC' });
  });
});

describe('деньги пользователя не запираются', () => {
  it('каждый план разрешает продать своё, вывести и посмотреть баланс', () => {
    // Самая важная проверка файла. Если она когда-нибудь упадёт,
    // это значит, что новый план забыл про чужие деньги.
    for (const plan of ALL_PLANS) {
      const e = entitlementFor(plan);

      for (const c of NEVER_REVOKED) {
        expect(can(e, c), `${plan} потерял ${c}`).toBe(true);
      }
    }
  });

  it('без плана остаются ровно неотбираемые права', () => {
    expect(capabilityList(entitlementFor('EXPIRED'))).toEqual([...NEVER_REVOKED].sort());
  });

  it('продажа и вывод не зависят ни от чего', () => {
    expect(canSellOwnedAsset()).toBe(true);
    expect(canWithdraw()).toBe(true);
  });

  it('защитные выходы не снимаются при понижении', () => {
    expect(cancelsProtectiveExitsOnDowngrade()).toBe(false);
    expect(stoppedByDowngrade('FULL_AUTO', 'EXPIRED')).not.toContain('PROTECTIVE_EXIT');
  });

  it('после окончания всего закрывается покупка, но не продажа', () => {
    const e = entitlementFor('EXPIRED');

    expect(can(e, 'MANUAL_TRADE')).toBe(false);
    expect(can(e, 'AUTO_BUY')).toBe(false);
    expect(can(e, 'SELL_OWN_ASSET')).toBe(true);
  });
});

describe('пробный период', () => {
  it('длится ровно сто двадцать часов', () => {
    expect(TRIAL_DURATION_HOURS).toBe(120);
    expect(TRIAL_DURATION_MS).toBe(120 * 3_600_000);
    expect(trialExpiresAt(NOW)).toBe(NOW + TRIAL_DURATION_MS);
  });

  it('открывает радар, терминал и ручную покупку', () => {
    const e = entitlementFor('TRIAL');

    expect(can(e, 'RADAR_ACCESS')).toBe(true);
    expect(can(e, 'TERMINAL_ACCESS')).toBe(true);
    expect(can(e, 'MANUAL_TRADE')).toBe(true);
    expect(can(e, 'WALLET_DEPOSIT')).toBe(true);
  });

  it('не открывает смарт-кошельки, копирование и автоматику', () => {
    // Показать автоматическую торговлю бесплатно значит дать машине
    // распоряжаться деньгами до того, как человек решил, доверяет ли он ей.
    const e = entitlementFor('TRIAL');

    for (const c of [
      'SMART_WALLETS_ACCESS',
      'LEADER_COPY_BUY',
      'SEMI_AUTO_TRADE',
      'AUTO_BUY',
      'AUTO_EXIT',
      'STRATEGY_AUTOMATION',
    ] as Capability[]) {
      expect(can(e, c), `пробный период не должен давать ${c}`).toBe(false);
    }
  });

  it('действует внутри срока и не действует за ним', () => {
    const trial = { startedAt: NOW, expiresAt: NOW + TRIAL_DURATION_MS };

    expect(isTrialActive(trial, NOW)).toBe(true);
    expect(isTrialActive(trial, NOW + TRIAL_DURATION_MS - 1)).toBe(true);
    expect(isTrialActive(trial, NOW + TRIAL_DURATION_MS)).toBe(false);
  });

  it('за миллисекунду до конца ещё открыт, в момент конца уже закрыт', () => {
    const trial = { startedAt: NOW, expiresAt: NOW + TRIAL_DURATION_MS };

    expect(effectivePlan({ trial }, NOW + TRIAL_DURATION_MS - 1)).toBe('TRIAL');
    expect(effectivePlan({ trial }, NOW + TRIAL_DURATION_MS)).toBe('EXPIRED');
  });

  it('не начавшийся период прав не даёт', () => {
    const trial = { startedAt: NOW + 1000, expiresAt: NOW + 1000 + TRIAL_DURATION_MS };

    expect(isTrialActive(trial, NOW)).toBe(false);
  });

  it('остаток считается в секундах и не уходит в минус', () => {
    const trial = { startedAt: NOW, expiresAt: NOW + TRIAL_DURATION_MS };

    expect(trialRemainingSeconds(trial, NOW)).toBe(TRIAL_DURATION_HOURS * 3600);
    expect(trialRemainingSeconds(trial, NOW + TRIAL_DURATION_MS)).toBe(0);
    expect(trialRemainingSeconds(trial, NOW + TRIAL_DURATION_MS + 10_000)).toBe(0);
    expect(trialRemainingSeconds(null, NOW)).toBe(0);
  });
});

describe('приоритет планов', () => {
  const trial = { startedAt: NOW, expiresAt: NOW + TRIAL_DURATION_MS };

  it('оплата важнее действующего пробного периода', () => {
    // Иначе купивший в первый день терял бы часть возможностей
    // до конца пробного периода.
    const plan = effectivePlan(
      { trial, subscription: { plan: 'PRO', expiresAt: null } },
      NOW,
    );

    expect(plan).toBe('PRO');
  });

  it('порядок старшинства соблюдён', () => {
    expect(planRank('FULL_AUTO')).toBeGreaterThan(planRank('SEMI_AUTO'));
    expect(planRank('SEMI_AUTO')).toBeGreaterThan(planRank('PRO'));
    expect(planRank('PRO')).toBeGreaterThan(planRank('TRIAL'));
    expect(planRank('TRIAL')).toBeGreaterThan(planRank('EXPIRED'));
  });

  it('истёкшая подписка уступает действующему пробному периоду', () => {
    const plan = effectivePlan(
      { trial, subscription: { plan: 'FULL_AUTO', expiresAt: NOW - 1 } },
      NOW,
    );

    expect(plan).toBe('TRIAL');
  });

  it('истёкший пробный период не мешает платному плану', () => {
    const old = { startedAt: NOW - 10 * TRIAL_DURATION_MS, expiresAt: NOW - 1000 };
    const plan = effectivePlan(
      { trial: old, subscription: { plan: 'SEMI_AUTO', expiresAt: null } },
      NOW,
    );

    expect(plan).toBe('SEMI_AUTO');
  });

  it('без договоров действующий план — EXPIRED', () => {
    expect(effectivePlan({}, NOW)).toBe('EXPIRED');
    expect(effectivePlan({ subscription: null, trial: null }, NOW)).toBe('EXPIRED');
  });

  it('отменённая подписка прав не даёт', () => {
    expect(
      isSubscriptionActive({ plan: 'PRO', expiresAt: null, cancelled: true }, NOW),
    ).toBe(false);
  });

  it('ещё не начавшаяся подписка прав не даёт', () => {
    expect(
      isSubscriptionActive({ plan: 'PRO', startsAt: NOW + 1, expiresAt: null }, NOW),
    ).toBe(false);
  });

  it('подписка ровно в момент истечения уже не действует', () => {
    expect(isSubscriptionActive({ plan: 'PRO', expiresAt: NOW }, NOW)).toBe(false);
    expect(isSubscriptionActive({ plan: 'PRO', expiresAt: NOW + 1 }, NOW)).toBe(true);
  });
});

describe('лестница планов', () => {
  it('каждый следующий план включает предыдущий', () => {
    const chain: PlanCode[] = ['TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO'];

    for (let i = 1; i < chain.length; i++) {
      const lower = entitlementFor(chain[i - 1]!);
      const higher = entitlementFor(chain[i]!);

      for (const c of lower.capabilities) {
        expect(can(higher, c), `${chain[i]} потерял ${c} из ${chain[i - 1]}`).toBe(true);
      }
    }
  });

  it('PRO добавляет к пробному только смарт-кошельки', () => {
    const added = [...entitlementFor('PRO').capabilities].filter(
      (c) => !entitlementFor('TRIAL').capabilities.has(c),
    );

    expect(added).toEqual(['SMART_WALLETS_ACCESS']);
  });

  it('SEMI_AUTO добавляет копирование и полуавтомат', () => {
    const added = [...entitlementFor('SEMI_AUTO').capabilities]
      .filter((c) => !entitlementFor('PRO').capabilities.has(c))
      .sort();

    expect(added).toEqual(['LEADER_COPY_BUY', 'SEMI_AUTO_TRADE']);
  });

  it('SEMI_AUTO не даёт автоматических выходов — продажа остаётся ручной', () => {
    expect(can(entitlementFor('SEMI_AUTO'), 'AUTO_EXIT')).toBe(false);
    expect(can(entitlementFor('FULL_AUTO'), 'AUTO_EXIT')).toBe(true);
  });

  it('FULL_AUTO добавляет автоматику целиком', () => {
    const added = [...entitlementFor('FULL_AUTO').capabilities]
      .filter((c) => !entitlementFor('SEMI_AUTO').capabilities.has(c))
      .sort();

    expect(added).toEqual(['AUTO_BUY', 'AUTO_EXIT', 'STRATEGY_AUTOMATION']);
  });
});

describe('какой план нужен', () => {
  it('отказ можно объяснить именем плана', () => {
    // «Нужен PRO» помогает, «доступ запрещён» — нет.
    expect(requiredPlanFor('SMART_WALLETS_ACCESS')).toBe('PRO');
    expect(requiredPlanFor('LEADER_COPY_BUY')).toBe('SEMI_AUTO');
    expect(requiredPlanFor('AUTO_BUY')).toBe('FULL_AUTO');
    expect(requiredPlanFor('RADAR_ACCESS')).toBe('TRIAL');
  });

  it('неотбираемые права не требуют плана', () => {
    expect(requiredPlanFor('SELL_OWN_ASSET')).toBe('EXPIRED');
    expect(requiredPlanFor('WALLET_WITHDRAW')).toBe('EXPIRED');
  });
});

describe('что останавливается при понижении', () => {
  it('переход с полной автоматики на ничего перечисляется поимённо', () => {
    const lost = stoppedByDowngrade('FULL_AUTO', 'EXPIRED');

    expect(lost).toContain('AUTO_BUY');
    expect(lost).toContain('RADAR_ACCESS');
    expect(lost).toContain('MANUAL_TRADE');
    expect(lost).not.toContain('WALLET_WITHDRAW');
  });

  it('повышение ничего не отнимает', () => {
    expect(stoppedByDowngrade('TRIAL', 'PRO')).toEqual([]);
    expect(stoppedByDowngrade('PRO', 'FULL_AUTO')).toEqual([]);
  });

  it('с пробного периода на ничего теряются поиск и покупка', () => {
    expect(stoppedByDowngrade('TRIAL', 'EXPIRED').sort()).toEqual([
      'MANUAL_TRADE',
      'RADAR_ACCESS',
      'TERMINAL_ACCESS',
      'WALLET_DEPOSIT',
    ]);
  });
});

describe('права по договорам целиком', () => {
  it('действующий пробный период даёт набор пробного плана', () => {
    const e = entitlementOf(
      { trial: { startedAt: NOW, expiresAt: NOW + TRIAL_DURATION_MS } },
      NOW + 1000,
    );

    expect(e.plan).toBe('TRIAL');
    expect(can(e, 'RADAR_ACCESS')).toBe(true);
  });

  it('через сто двадцать часов радар закрывается', () => {
    const trial = { startedAt: NOW, expiresAt: NOW + TRIAL_DURATION_MS };
    const e = entitlementOf({ trial }, NOW + TRIAL_DURATION_MS);

    expect(e.plan).toBe('EXPIRED');
    expect(can(e, 'RADAR_ACCESS')).toBe(false);
    expect(can(e, 'SELL_OWN_ASSET')).toBe(true);
  });
});
