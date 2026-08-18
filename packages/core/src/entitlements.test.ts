/**
 * Права по плану подписки.
 *
 * Проверяется прежде всего то, чего быть не должно: бесплатный план
 * без автоматики, истёкшая подписка без платных возможностей,
 * и разделение плана с ролью. Ошибка в любую из этих сторон
 * означает, что кто-то получил доступ к чужим деньгам.
 */

import { describe, it, expect } from 'vitest';
import {
  entitlementFor,
  entitlementOf,
  effectivePlan,
  can,
  isRealtime,
  stoppedByDowngrade,
  canSellOwnedAsset,
  cancelsProtectiveExitsOnDowngrade,
  FREE_DELAY_SECONDS,
  type PlanCode,
} from './entitlements.js';

const NOW = 1_800_000_000_000;

describe('бесплатный план', () => {
  const free = entitlementFor('FREE');

  it('видит радар и кошельки, но с задержкой', () => {
    expect(can(free, 'RADAR_DELAYED')).toBe(true);
    expect(can(free, 'SMART_WALLETS_DELAYED')).toBe(true);
    expect(can(free, 'RADAR_REALTIME')).toBe(false);
    expect(can(free, 'SMART_WALLETS_REALTIME')).toBe(false);
  });

  it('задержка ровно три минуты', () => {
    expect(free.delaySeconds).toBe(FREE_DELAY_SECONDS);
    expect(free.delaySeconds).toBe(180);
    expect(isRealtime(free)).toBe(false);
  });

  it('не торгует ни вручную, ни автоматически', () => {
    expect(can(free, 'MANUAL_TRADE')).toBe(false);
    expect(can(free, 'LEADER_COPY_BUY')).toBe(false);
    expect(can(free, 'AUTOMATED_SIGNAL_BUY')).toBe(false);
    expect(can(free, 'AUTOMATED_EXITS')).toBe(false);
  });

  it('не получает мгновенных уведомлений', () => {
    // Уведомление о скрытом событии — это и есть утечка события.
    expect(can(free, 'REALTIME_NOTIFICATIONS')).toBe(false);
  });
});

describe('мгновенный план', () => {
  const rt = entitlementFor('REALTIME');

  it('данные без задержки', () => {
    expect(rt.delaySeconds).toBe(0);
    expect(isRealtime(rt)).toBe(true);
    expect(can(rt, 'RADAR_REALTIME')).toBe(true);
  });

  it('копирование покупок не входит', () => {
    // Плата за скорость данных не равна плате за торговлю.
    expect(can(rt, 'LEADER_COPY_BUY')).toBe(false);
    expect(can(rt, 'MANUAL_TRADE')).toBe(false);
  });

  it('автоматики нет', () => {
    expect(can(rt, 'AUTOMATED_SIGNAL_BUY')).toBe(false);
    expect(can(rt, 'AUTOMATED_EXITS')).toBe(false);
  });
});

describe('полуавтоматический план', () => {
  const semi = entitlementFor('SEMI_AUTO');

  it('копирует покупку и позволяет продать вручную', () => {
    expect(can(semi, 'LEADER_COPY_BUY')).toBe(true);
    expect(can(semi, 'MANUAL_TRADE')).toBe(true);
  });

  it('автоматических выходов нет — продаёт человек', () => {
    // Это и есть смысл плана: покупку копируем, решение о продаже
    // остаётся за человеком.
    expect(can(semi, 'AUTOMATED_EXITS')).toBe(false);
    expect(can(semi, 'AUTOMATED_SIGNAL_BUY')).toBe(false);
    expect(can(semi, 'AUTOMATION_SETTINGS')).toBe(false);
  });

  it('включает всё из мгновенного плана', () => {
    const rt = entitlementFor('REALTIME');

    for (const c of rt.capabilities) expect(can(semi, c)).toBe(true);
  });
});

describe('полностью автоматический план', () => {
  const full = entitlementFor('FULL_AUTO');

  it('автоматика и выходы разрешены', () => {
    expect(can(full, 'AUTOMATED_SIGNAL_BUY')).toBe(true);
    expect(can(full, 'AUTOMATED_EXITS')).toBe(true);
    expect(can(full, 'AUTOMATION_SETTINGS')).toBe(true);
  });

  it('включает всё из полуавтоматического', () => {
    const semi = entitlementFor('SEMI_AUTO');

    for (const c of semi.capabilities) expect(can(full, c)).toBe(true);
  });
});

describe('накопительность планов', () => {
  it('каждый следующий план не теряет возможностей предыдущего', () => {
    const order: PlanCode[] = ['REALTIME', 'SEMI_AUTO', 'FULL_AUTO'];

    for (let i = 1; i < order.length; i++) {
      const prev = entitlementFor(order[i - 1]!);
      const next = entitlementFor(order[i]!);

      for (const c of prev.capabilities) {
        expect(can(next, c)).toBe(true);
      }
    }
  });

  it('платные возможности не протекают в бесплатный план', () => {
    const free = entitlementFor('FREE');
    const paid = ['MANUAL_TRADE', 'LEADER_COPY_BUY', 'AUTOMATED_SIGNAL_BUY', 'AUTOMATED_EXITS', 'AUTOMATION_SETTINGS', 'REALTIME_NOTIFICATIONS'] as const;

    for (const c of paid) expect(can(free, c)).toBe(false);
  });
});

describe('состояние подписки', () => {
  it('без подписки — бесплатный план', () => {
    expect(effectivePlan(null, NOW)).toBe('FREE');
    expect(effectivePlan({ plan: null, expiresAt: null }, NOW)).toBe('FREE');
  });

  it('действующая подписка даёт свой план', () => {
    expect(effectivePlan({ plan: 'FULL_AUTO', expiresAt: NOW + 86_400_000 }, NOW)).toBe(
      'FULL_AUTO',
    );
  });

  it('бессрочная подписка действует', () => {
    expect(effectivePlan({ plan: 'SEMI_AUTO', expiresAt: null }, NOW)).toBe('SEMI_AUTO');
  });

  it('истёкшая подписка равна бесплатному плану', () => {
    // Отдельного состояния «почти активна» нет намеренно —
    // оно превратилось бы в лазейку.
    expect(effectivePlan({ plan: 'FULL_AUTO', expiresAt: NOW }, NOW)).toBe('FREE');
    expect(effectivePlan({ plan: 'FULL_AUTO', expiresAt: NOW - 1 }, NOW)).toBe('FREE');
  });

  it('отменённая подписка равна бесплатному плану', () => {
    expect(
      effectivePlan({ plan: 'FULL_AUTO', expiresAt: NOW + 999_999, cancelled: true }, NOW),
    ).toBe('FREE');
  });

  it('истёкшая подписка возвращает задержку данных', () => {
    const e = entitlementOf({ plan: 'REALTIME', expiresAt: NOW - 1 }, NOW);

    expect(e.delaySeconds).toBe(180);
    expect(can(e, 'RADAR_REALTIME')).toBe(false);
  });
});

describe('понижение плана', () => {
  it('перечисляет остановленное поимённо', () => {
    // Молчаливое отключение автоматики — худший способ: позиция
    // остаётся открытой, защита перестаёт работать, и узнаёт
    // об этом человек по убытку.
    const stopped = stoppedByDowngrade('FULL_AUTO', 'FREE');

    expect(stopped).toContain('AUTOMATED_SIGNAL_BUY');
    expect(stopped).toContain('AUTOMATED_EXITS');
    expect(stopped).toContain('LEADER_COPY_BUY');
    expect(stopped).toContain('MANUAL_TRADE');
  });

  it('при понижении до полуавтомата останавливается только автоматика', () => {
    const stopped = stoppedByDowngrade('FULL_AUTO', 'SEMI_AUTO');

    expect(stopped).toContain('AUTOMATED_SIGNAL_BUY');
    expect(stopped).not.toContain('MANUAL_TRADE');
    expect(stopped).not.toContain('LEADER_COPY_BUY');
  });

  it('повышение ничего не останавливает', () => {
    expect(stoppedByDowngrade('FREE', 'FULL_AUTO')).toEqual([]);
  });

  it('продажа своего актива разрешена при любом плане', () => {
    // Актив принадлежит человеку, а не платформе. Истёкшая подписка
    // не повод запереть его в позиции.
    expect(canSellOwnedAsset()).toBe(true);
  });

  it('защитные выходы не отменяются при понижении', () => {
    // Активный стоп-лосс — защита уже вложенных денег, а не платная
    // возможность. Снять его молча значит оставить человека без
    // страховки тогда, когда он этого не ждёт.
    expect(cancelsProtectiveExitsOnDowngrade()).toBe(false);
  });
});
