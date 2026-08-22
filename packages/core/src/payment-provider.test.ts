import { describe, it, expect } from 'vitest';
import {
  providerProfile,
  providerProfiles,
  providerHas,
  buildPartnerUserRef,
  isPartnerUserRef,
  PROVIDER_CAPABILITY,
  PARTNER_REF_MAX_LENGTH,
} from './payment-provider.js';

/**
 * Возможности провайдеров и ссылка покупателя.
 *
 * Правила детерминированные, без базы и без сети: их разъезд
 * с интерфейсом стоит дороже, чем кажется, — на странице оплаты
 * появляется шаг, которого у провайдера нет, или пропадает нужный.
 */

describe('возможности провайдера', () => {
  it('у Bridge есть отдельная проверка личности и банковские реквизиты', () => {
    const p = providerProfile('BRIDGE');

    expect(p.capabilities).toContain(PROVIDER_CAPABILITY.hostedKyc);
    expect(p.capabilities).toContain(PROVIDER_CAPABILITY.bankInstructions);
    expect(p.kycInsideCheckout).toBe(false);
  });

  it('у Coinbase проверка внутри оплаты и реквизитов нет', () => {
    const p = providerProfile('COINBASE');

    expect(p.capabilities).toContain(PROVIDER_CAPABILITY.hostedCheckout);
    expect(p.capabilities).not.toContain(PROVIDER_CAPABILITY.hostedKyc);
    expect(p.capabilities).not.toContain(PROVIDER_CAPABILITY.bankInstructions);
    expect(p.kycInsideCheckout).toBe(true);
  });

  it('различает «проверки нет» и «проверка есть, но мы её не видим»', () => {
    // Оба провайдера проверяют личность. Отсутствие `hostedKyc`
    // у Coinbase означает не отсутствие проверки, а отсутствие
    // отдельного шага, — и признак `kycInsideCheckout` это говорит.
    expect(providerHas('COINBASE', PROVIDER_CAPABILITY.hostedKyc)).toBe(false);
    expect(providerProfile('COINBASE').kycInsideCheckout).toBe(true);
  });

  it('оба провайдера умеют события и перечитывание', () => {
    for (const p of providerProfiles()) {
      expect(p.capabilities).toContain(PROVIDER_CAPABILITY.webhooks);
      expect(p.capabilities).toContain(PROVIDER_CAPABILITY.polling);
    }
  });
});

describe('ссылка покупателя', () => {
  it('укладывается в ограничение провайдера', () => {
    const ref = buildPartnerUserRef('a'.repeat(64));
    expect(ref.length).toBeLessThanOrEqual(PARTNER_REF_MAX_LENGTH);
    expect(isPartnerUserRef(ref)).toBe(true);
  });

  it('распознаёт свои и отвергает чужие', () => {
    expect(isPartnerUserRef(buildPartnerUserRef('0123456789abcdef0123456789abcdef01234567'))).toBe(
      true,
    );

    expect(isPartnerUserRef('')).toBe(false);
    expect(isPartnerUserRef('mx_')).toBe(false);
    expect(isPartnerUserRef('u1')).toBe(false);
    expect(isPartnerUserRef('myron@example.com')).toBe(false);
    expect(isPartnerUserRef('mx_' + 'a'.repeat(200))).toBe(false);
  });

  it('не содержит ничего о человеке', () => {
    // Ссылка уходит в адресную строку и к провайдеру. Идентификатор
    // пользователя или почта в ней означали бы раздачу этих сведений
    // всем, кто увидит экран.
    const ref = buildPartnerUserRef('deadbeef'.repeat(5));
    expect(ref).not.toContain('@');
    expect(ref.slice(3)).toMatch(/^[0-9a-zA-Z]+$/);
  });

  it('разная на каждый вызов при разном входе', () => {
    const a = buildPartnerUserRef('1'.repeat(40));
    const b = buildPartnerUserRef('2'.repeat(40));
    expect(a).not.toBe(b);
  });
});
