import { describe, it, expect } from 'vitest';
import {
  decideMirrorPending,
  shouldCancelMirror,
  type PendingOrderInput,
  type MirrorContext,
} from './copy-pending.js';

const NOW = new Date('2026-08-15T12:00:00Z');

const leader = (over: Partial<PendingOrderInput> = {}): PendingOrderInput => ({
  type: 'LIMIT',
  side: 'BUY',
  limitPriceUsd: '0.00042',
  triggerPriceUsd: null,
  trailingBps: null,
  expiresAt: null,
  ...over,
});

const ctx = (over: Partial<MirrorContext> = {}): MirrorContext => ({
  mode: 'MIRROR',
  allocationUsd: '100',
  freeQuoteUsd: '1000',
  lockedUsd: '0',
  maxLockedShare: 0.5,
  equityUsd: '2000',
  now: NOW,
  ...over,
});

describe('decideMirrorPending — режим', () => {
  it('в режиме ON_FILL не зеркалит', () => {
    const d = decideMirrorPending(leader(), ctx({ mode: 'ON_FILL' }));
    expect(d.mirror).toBe(false);
    expect(d.order).toBeNull();
    expect(d.reason).toContain('при исполнении');
  });

  it('в режиме MIRROR ставит такой же ордер', () => {
    const d = decideMirrorPending(leader(), ctx());
    expect(d.mirror).toBe(true);
    expect(d.order!.type).toBe('LIMIT');
    expect(d.order!.side).toBe('BUY');
    expect(d.order!.amountUsd).toBe('100');
  });

  it('цена берётся ровно та же, без поправок', () => {
    // Смещение «чтобы наверняка исполнилось» превращает копию
    // в другую сделку — подписчик подписывался не на это.
    const d = decideMirrorPending(leader({ limitPriceUsd: '0.00042' }), ctx());
    expect(Number(d.order!.limitPriceUsd)).toBe(0.00042);
  });
});

describe('decideMirrorPending — что не зеркалится', () => {
  it('скользящий стоп не копируется', () => {
    // Он считается от пика позиции подписчика, а тот свой:
    // подписчик мог войти позже и по другой цене.
    const d = decideMirrorPending(
      leader({ type: 'TRAILING_STOP', trailingBps: 500, limitPriceUsd: null, triggerPriceUsd: '0.001' }),
      ctx(),
    );
    expect(d.mirror).toBe(false);
    expect(d.reason).toContain('пика вашей позиции');
  });

  it('истёкший ордер лидера не копируется', () => {
    const d = decideMirrorPending(
      leader({ expiresAt: new Date(NOW.getTime() - 1000) }),
      ctx(),
    );
    expect(d.mirror).toBe(false);
    expect(d.reason).toContain('истёк');
  });

  it('ордер без цены не копируется', () => {
    expect(decideMirrorPending(leader({ limitPriceUsd: null }), ctx()).mirror).toBe(false);
    expect(decideMirrorPending(leader({ limitPriceUsd: '0' }), ctx()).mirror).toBe(false);
    expect(decideMirrorPending(leader({ limitPriceUsd: '-1' }), ctx()).mirror).toBe(false);
  });

  it('нулевой размер по настройкам подписки блокирует копию', () => {
    const d = decideMirrorPending(leader(), ctx({ allocationUsd: '0' }));
    expect(d.mirror).toBe(false);
    expect(d.reason).toContain('Нулевой размер');
  });
});

describe('decideMirrorPending — средства', () => {
  it('нехватка свободных средств блокирует покупку', () => {
    const d = decideMirrorPending(leader(), ctx({ allocationUsd: '500', freeQuoteUsd: '100' }));
    expect(d.mirror).toBe(false);
    expect(d.reason).toContain('Недостаточно свободных средств');
  });

  it('продажа не требует свободной котировочной валюты', () => {
    // Продаётся уже имеющийся токен — остаток в долларах тут ни при чём.
    const d = decideMirrorPending(leader({ side: 'SELL' }), ctx({ freeQuoteUsd: '0' }));
    expect(d.mirror).toBe(true);
  });

  it('предел заморозки не даёт связать весь капитал', () => {
    // Десяток лимиток лидера иначе съедает все средства подписчика,
    // и на выход из открытых позиций денег не остаётся.
    const d = decideMirrorPending(
      leader(),
      ctx({ equityUsd: '1000', lockedUsd: '480', allocationUsd: '100', maxLockedShare: 0.5 }),
    );
    expect(d.mirror).toBe(false);
    expect(d.reason).toContain('предел заморозки');
  });

  it('на границе предела заморозки ордер ещё проходит', () => {
    const d = decideMirrorPending(
      leader(),
      ctx({ equityUsd: '1000', lockedUsd: '400', allocationUsd: '100', maxLockedShare: 0.5 }),
    );
    expect(d.mirror).toBe(true);
  });

  it('без предела заморозка не проверяется', () => {
    const d = decideMirrorPending(
      leader(),
      ctx({ equityUsd: '1000', lockedUsd: '900', maxLockedShare: null }),
    );
    expect(d.mirror).toBe(true);
  });

  it('нулевой капитал не ломает расчёт предела', () => {
    const d = decideMirrorPending(leader(), ctx({ equityUsd: '0', lockedUsd: '0' }));
    expect(d.mirror).toBe(true);
  });
});

describe('decideMirrorPending — стоп-лосс', () => {
  it('стоп зеркалится по цене срабатывания, а не по лимитной', () => {
    const d = decideMirrorPending(
      leader({ type: 'STOP_LOSS', side: 'SELL', limitPriceUsd: null, triggerPriceUsd: '0.0002' }),
      ctx(),
    );
    expect(d.mirror).toBe(true);
    expect(d.order!.limitPriceUsd).toBeNull();
    expect(Number(d.order!.triggerPriceUsd)).toBe(0.0002);
  });

  it('срок жизни наследуется от лидера', () => {
    const exp = new Date(NOW.getTime() + 864e5);
    const d = decideMirrorPending(leader({ expiresAt: exp }), ctx());
    // Ордер, переживший источник, сработает по обстоятельствам,
    // которых лидер уже не разделяет.
    expect(d.order!.expiresAt).toEqual(exp);
  });
});

describe('shouldCancelMirror', () => {
  it('отмена, истечение и отклонение у лидера снимают копию', () => {
    expect(shouldCancelMirror('CANCELLED').cancel).toBe(true);
    expect(shouldCancelMirror('EXPIRED').cancel).toBe(true);
    expect(shouldCancelMirror('REJECTED').cancel).toBe(true);
  });

  it('исполнение и открытое состояние копию не снимают', () => {
    expect(shouldCancelMirror('FILLED').cancel).toBe(false);
    expect(shouldCancelMirror('OPEN').cancel).toBe(false);
  });

  it('причина отмены заполняется', () => {
    expect(shouldCancelMirror('CANCELLED').reason).toContain('отменил');
  });
});
