import { describe, it, expect } from 'vitest';
import {
  allowsKmsCall,
  legacySigningFlagVerdict,
  signingBlockers,
  signingPublicView,
  transactionSigningState,
  type TransactionSigningInput,
} from './transaction-signing-state.js';

/**
 * Единственный расчёт состояния подписи.
 *
 * Раньше готовность считалась в шести местах по разным наборам
 * переменных, и наборы разошлись. Проверяется поэтому не «функция
 * возвращает строку», а то, что каждое препятствие действительно
 * останавливает подпись и что порядок препятствий осмысленный.
 */

const READY: TransactionSigningInput = {
  signingEnabled: true,
  signerProvider: 'aws-kms',
  providerSupported: true,
  keyConfigured: true,
  identity: 'OK',
  expectedKeyMatches: true,
  network: 'devnet',
  networkVerified: true,
  signatureValidated: false,
  safetyLatchHealthy: true,
  hasAmbiguousAttempt: false,
  withdrawalsEnabled: false,
  broadcastAvailable: false,
};

const state = (over: Partial<TransactionSigningInput> = {}) =>
  transactionSigningState({ ...READY, ...over });

describe('состояние подписи', () => {
  it('полный набор условий даёт готовность к devnet', () => {
    expect(state()).toBe('READY_TO_SIGN_DEVNET');
    expect(allowsKmsCall(state())).toBe(true);
  });

  it('проверенная подпись отличается от готовности', () => {
    expect(state({ signatureValidated: true })).toBe('SIGNATURE_VALIDATED');
    // Проверенная подпись не означает отправку: это разные события.
    expect(allowsKmsCall(state({ signatureValidated: true }))).toBe(true);
  });

  it('выключенный флаг отвечает раньше всего остального', () => {
    /*
     * Порядок здесь и есть защита. При выключенном контуре на
     * остальные вопросы нельзя отвечать: ответ потребовал бы
     * обращения к провайдеру, а обращаться запрещено.
     */
    expect(state({ signingEnabled: false, identity: 'FINGERPRINT_CHANGED' })).toBe('DISABLED');
    expect(state({ signingEnabled: false, network: 'mainnet-beta' })).toBe('DISABLED');
    expect(allowsKmsCall('DISABLED')).toBe(false);
  });

  it('провайдер не выбран — не настроено', () => {
    expect(state({ signerProvider: 'unavailable', providerSupported: false }))
      .toBe('NOT_CONFIGURED');
  });

  it('неподдержанный провайдер не считается настроенным', () => {
    expect(state({ signerProvider: 'azure-kv', providerSupported: false }))
      .toBe('NOT_CONFIGURED');
  });

  it('ключ не задан — не настроено', () => {
    expect(state({ keyConfigured: false })).toBe('NOT_CONFIGURED');
  });

  it('ключ не подтверждён человеком', () => {
    expect(state({ identity: 'NOT_REGISTERED' })).toBe('IDENTITY_UNVERIFIED');
  });

  it('сменившийся ключ ставит паузу, а не «не настроено»', () => {
    // Разница существенная: «не настроено» чинят настройкой, паузу
    // разбирают руками.
    expect(state({ identity: 'FINGERPRINT_CHANGED' })).toBe('PAUSED');
    expect(state({ identity: 'KEY_VERSION_CHANGED' })).toBe('PAUSED');
    expect(state({ identity: 'ALGORITHM_CHANGED' })).toBe('PAUSED');
  });

  it('расхождение с независимым ожиданием ставит паузу', () => {
    expect(state({ expectedKeyMatches: false })).toBe('PAUSED');
  });

  it('незаданное ожидание не считается расхождением', () => {
    // `null` — это «не задано», а не «не совпало».
    expect(state({ expectedKeyMatches: null })).toBe('READY_TO_SIGN_DEVNET');
  });

  it('поднятая защёлка ставит паузу раньше проверки ключа', () => {
    /*
     * Защёлка означает, что чтению цепочки нельзя доверять. Отвечать
     * «ключ не подтверждён» в этом состоянии значило бы отправить
     * человека настраивать ключ вместо разбора расхождения.
     */
    expect(state({ safetyLatchHealthy: false, identity: 'NOT_REGISTERED' })).toBe('PAUSED');
  });

  it('неоднозначная попытка важнее любой готовности', () => {
    // Возможно, подпись уже существует. Вторая создала бы вторую.
    expect(state({ hasAmbiguousAttempt: true })).toBe('REVIEW_REQUIRED');
  });

  it('mainnet не бывает готовым', () => {
    expect(state({ network: 'mainnet-beta' })).toBe('NETWORK_UNVERIFIED');
    expect(state({ network: 'testnet' })).toBe('NETWORK_UNVERIFIED');
  });

  it('непроверенный узел не считается сетью', () => {
    expect(state({ networkVerified: false })).toBe('NETWORK_UNVERIFIED');
  });

  it('включённые выводы вместе с подписью требуют разбора', () => {
    expect(state({ withdrawalsEnabled: true })).toBe('REVIEW_REQUIRED');
  });

  it('доступная отправка требует разбора', () => {
    // Подписанное ушло бы в сеть, а этот контур не проверен.
    expect(state({ broadcastAvailable: true })).toBe('REVIEW_REQUIRED');
  });

  it('ни одно состояние, кроме двух, не разрешает вызов KMS', () => {
    const all = [
      'DISABLED', 'NOT_CONFIGURED', 'IDENTITY_UNVERIFIED', 'NETWORK_UNVERIFIED',
      'PAUSED', 'REVIEW_REQUIRED', 'READY_TO_SIGN_DEVNET', 'SIGNATURE_VALIDATED',
    ] as const;

    const allowed = all.filter((value) => allowsKmsCall(value));
    expect(allowed).toEqual(['READY_TO_SIGN_DEVNET', 'SIGNATURE_VALIDATED']);
  });
});

describe('причины блокировки', () => {
  it('перечисляются все сразу, а не первая', () => {
    /*
     * Оператор, чинящий препятствия по одному, узнаёт о следующем
     * только после перезапуска.
     */
    const blockers = signingBlockers({
      ...READY,
      signingEnabled: false,
      signerProvider: 'unavailable',
      providerSupported: false,
      keyConfigured: false,
    });

    expect(blockers).toContain('SIGNING_DISABLED');
    expect(blockers).toContain('PROVIDER_NOT_SELECTED');
    expect(blockers).toContain('KEY_NOT_CONFIGURED');
  });

  it('готовая конфигурация не даёт причин', () => {
    expect(signingBlockers(READY)).toEqual([]);
  });
});

describe('что видит обычный человек', () => {
  it('инфраструктурные состояния сводятся к понятным словам', () => {
    expect(signingPublicView('DISABLED')).toBe('SIGNING_OFF');
    expect(signingPublicView('NOT_CONFIGURED')).toBe('PREPARING');
    expect(signingPublicView('NETWORK_UNVERIFIED')).toBe('PREPARING');
    expect(signingPublicView('IDENTITY_UNVERIFIED')).toBe('AWAITING_KEY_CONFIRMATION');
    expect(signingPublicView('PAUSED')).toBe('MANUAL_REVIEW');
    expect(signingPublicView('REVIEW_REQUIRED')).toBe('MANUAL_REVIEW');
    expect(signingPublicView('SIGNATURE_VALIDATED')).toBe('SIGNED_NOT_SENT');
  });

  it('нет состояния, в котором человеку обещают отправку', () => {
    const all = [
      'DISABLED', 'NOT_CONFIGURED', 'IDENTITY_UNVERIFIED', 'NETWORK_UNVERIFIED',
      'PAUSED', 'REVIEW_REQUIRED', 'READY_TO_SIGN_DEVNET', 'SIGNATURE_VALIDATED',
    ] as const;

    for (const value of all) {
      expect(signingPublicView(value)).not.toBe('SUBMITTED');
    }
    // Самое «готовое» из публичных состояний прямо говорит: не отправлено.
    expect(signingPublicView('SIGNATURE_VALIDATED')).toBe('SIGNED_NOT_SENT');
  });
});

describe('устаревший флаг', () => {
  it('отсутствие — это не «выключено», а «переменной нет»', () => {
    expect(legacySigningFlagVerdict({ legacyValue: undefined, canonicalValue: false }))
      .toBe('ABSENT');
  });

  it('false принимается ради совместимости', () => {
    // Старое окружение с явным «нет» запускается без изменений.
    expect(legacySigningFlagVerdict({ legacyValue: false, canonicalValue: false }))
      .toBe('COMPATIBLE');
    expect(legacySigningFlagVerdict({ legacyValue: false, canonicalValue: true }))
      .toBe('COMPATIBLE');
  });

  it('true отвергается при любом значении нового флага', () => {
    /*
     * Несовпадение не разрешается оптимистично ни в одну сторону.
     * Тихий синоним включил бы подпись там, где просили о другом.
     */
    expect(legacySigningFlagVerdict({ legacyValue: true, canonicalValue: false }))
      .toBe('REFUSED');
    expect(legacySigningFlagVerdict({ legacyValue: true, canonicalValue: true }))
      .toBe('REFUSED');
  });
});
