import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createCdpJwt, canSignWithKey } from './coinbase-auth.js';

/**
 * Подпись запросов к Coinbase.
 *
 * Ключи здесь настоящие по форме и полностью выдуманные по содержанию:
 * генерируются на месте, никуда не уходят и ничего не открывают.
 * Проверяется, что токен подписан правильно и ограничен ровно тем
 * запросом, для которого выпущен.
 */

const NOW_SECONDS = Math.floor(Date.UTC(2026, 7, 22, 12, 0, 0) / 1000);

function ecKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function ed25519Base64(): string {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  // Coinbase отдаёт Ed25519 в виде 64 байт: 32 секретных плюс 32
  // открытых, в base64.
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

  return Buffer.concat([seed, pub]).toString('base64');
}

function decode(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')),
  };
}

describe('токен доступа к Coinbase', () => {
  it('подписывает PEM-ключ алгоритмом ES256', () => {
    const jwt = createCdpJwt({
      keyId: 'organizations/x/apiKeys/y',
      keySecret: ecKey(),
      method: 'POST',
      host: 'api.developer.coinbase.com',
      path: '/onramp/v1/token',
      nowSeconds: NOW_SECONDS,
    });

    const { header, payload } = decode(jwt);

    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('organizations/x/apiKeys/y');
    expect(payload.iss).toBe('cdp');
    expect(payload.sub).toBe('organizations/x/apiKeys/y');
  });

  it('подписывает ключ Ed25519 алгоритмом EdDSA', () => {
    const jwt = createCdpJwt({
      keyId: 'test-key-id',
      keySecret: ed25519Base64(),
      method: 'GET',
      host: 'api.developer.coinbase.com',
      path: '/onramp/v1/buy/user/mx_ref/transactions',
      nowSeconds: NOW_SECONDS,
    });

    expect(decode(jwt).header.alg).toBe('EdDSA');
  });

  it('привязывает токен к одному методу и одному пути', () => {
    // Токен, годный для любого адреса, — это ключ, а не токен.
    const jwt = createCdpJwt({
      keyId: 'k',
      keySecret: ecKey(),
      method: 'POST',
      host: 'api.developer.coinbase.com',
      path: '/onramp/v1/token',
      nowSeconds: NOW_SECONDS,
    });

    expect(decode(jwt).payload.uris).toEqual([
      'POST api.developer.coinbase.com/onramp/v1/token',
    ]);
  });

  it('живёт две минуты и не дольше', () => {
    const jwt = createCdpJwt({
      keyId: 'k',
      keySecret: ecKey(),
      method: 'GET',
      host: 'api.developer.coinbase.com',
      path: '/x',
      nowSeconds: NOW_SECONDS,
    });

    const { payload } = decode(jwt);

    expect(payload.nbf).toBe(NOW_SECONDS);
    expect(Number(payload.exp) - Number(payload.nbf)).toBe(120);
  });

  it('каждый раз выпускает новый токен', () => {
    // Одноразовость держится на nonce: два одинаковых токена
    // означали бы, что перехваченный можно повторить.
    const key = ecKey();

    const args = {
      keyId: 'k',
      keySecret: key,
      method: 'GET' as const,
      host: 'api.developer.coinbase.com',
      path: '/x',
      nowSeconds: NOW_SECONDS,
    };

    expect(createCdpJwt(args)).not.toBe(createCdpJwt(args));
  });

  it('проверяет ключ, не подписывая настоящий запрос', () => {
    expect(canSignWithKey(ecKey())).toBe(true);
    expect(canSignWithKey(ed25519Base64())).toBe(true);
    expect(canSignWithKey('очевидно не ключ')).toBe(false);
    expect(canSignWithKey('')).toBe(false);
  });

  it('не молчит, когда ключ не годится', () => {
    expect(() =>
      createCdpJwt({
        keyId: 'k',
        keySecret: 'мусор вместо ключа',
        method: 'GET',
        host: 'api.developer.coinbase.com',
        path: '/x',
        nowSeconds: NOW_SECONDS,
      }),
    ).toThrow();
  });
});
