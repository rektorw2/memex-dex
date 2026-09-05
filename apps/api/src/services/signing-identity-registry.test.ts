import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AUDIT_FORBIDDEN_KEYS } from '@memex/core';

/**
 * Реестр ключа подписи.
 *
 * Проверяется единственная вещь, которую сервер не может проверить
 * сам: что ключ, отвечающий на вызовы, — наш. Всё остальное здесь
 * производно от неё.
 */

const KEYS = crypto.generateKeyPairSync('ed25519');
const DER = KEYS.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const RAW = new Uint8Array(DER.subarray(12));

const OTHER = crypto.generateKeyPairSync('ed25519');
const OTHER_RAW = new Uint8Array(
  (OTHER.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12),
);

let row: Record<string, any> | null;
let audit: Array<Record<string, any>>;

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    signingIdentity: {
      findUnique: async () => row,
      upsert: async (a: any) => {
        row = row ? { ...row, ...a.update } : { id: a.where.id, ...a.create };
        return row;
      },
      updateMany: async (a: any) => {
        if (!row) return { count: 0 };
        // Состояние в условии: два параллельных цикла иначе запишут
        // паузу дважды и с разными причинами.
        const not = a.where.state?.not;
        if (not && row.state === not) return { count: 0 };
        Object.assign(row, a.data);
        return { count: 1 };
      },
    },
    auditLog: { create: async (a: any) => { audit.push(a.data); return a.data; } },
  };
  return {
    prisma,
    serializable: async <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };
});

vi.mock('./signer-factory.js', async () => {
  const actual = await vi.importActual<typeof import('./signer-factory.js')>('./signer-factory.js');
  return {
    ...actual,
    createSolanaSigner: () => fakeSigner(RAW),
    expectedFingerprint: () => expected,
  };
});

let expected: string | null;

const {
  discoverSigningIdentity,
  registerSigningIdentity,
  revokeSigningIdentity,
  verifyAgainstRegistry,
  readRegisteredIdentity,
  IdentityRegistryError,
} = await import('./signing-identity-registry.js');
const { identityFactsFrom } = await import('./signer-factory.js');

function fakeSigner(publicKey: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    async identity() {
      return { publicKey, version: '1', algorithm: 'ED25519_SHA_512', ...over };
    },
    async signMessage() { throw new Error('не должно вызываться'); },
    async health() { return { ok: true, code: null }; },
  } as any;
}

const facts = (publicKey: Uint8Array, over: Partial<{ keyVersion: string; algorithm: string }> = {}) =>
  identityFactsFrom({
    publicKey,
    keyVersion: over.keyVersion ?? '1',
    algorithm: over.algorithm ?? 'ED25519_SHA_512',
  });

beforeEach(() => {
  row = null;
  audit = [];
  expected = null;
});

// ═══════════════════════════ Привязка ════════════════════════════════════════

describe('ключ не привязывается сам', () => {
  it('до регистрации реестр пуст', async () => {
    expect(await readRegisteredIdentity()).toBeNull();
  });

  it('осмотр ничего не записывает', async () => {
    const found = await discoverSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
    });

    /*
     * Длина адреса плавает: base58 от 32 байт даёт 43 или 44 знака
     * в зависимости от ведущих нулей. Жёсткая 44 давала редкие
     * ложные падения — примерно одно на несколько десятков прогонов.
     */
    expect(found.facts.solanaAddress.length).toBeGreaterThanOrEqual(43);
    expect(found.facts.solanaAddress.length).toBeLessThanOrEqual(44);
    expect(found.facts.solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    // Главное: успешный вызов KMS сам по себе не привязывает ключ.
    expect(await readRegisteredIdentity()).toBeNull();
  });

  it('совпадение с ожидаемым не заменяет решение человека', async () => {
    expected = facts(RAW).fingerprint;

    const found = await discoverSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
    });

    expect(found.matchesExpected).toBe(true);
    // Совпало — и всё равно не зарегистрировано.
    expect(await readRegisteredIdentity()).toBeNull();
  });

  it('регистрация требует эхо увиденного отпечатка', async () => {
    await expect(registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: 'не-тот-отпечаток',
    })).rejects.toThrow('CONFIRMATION_STALE');

    expect(await readRegisteredIdentity()).toBeNull();
  });

  it('подтверждение верным отпечатком сохраняет привязку', async () => {
    const identity = await registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: facts(RAW).fingerprint,
    });

    expect(identity.state).toBe('REGISTERED');
    expect(identity.solanaAddress).toBe(facts(RAW).solanaAddress);
    expect(identity.registeredAt).not.toBeNull();
  });

  it('другой ключ поверх зарегистрированного не проходит', async () => {
    row = {
      id: 'solana-signing-identity', state: 'REGISTERED', provider: 'aws-kms',
      fingerprint: facts(OTHER_RAW).fingerprint,
      solanaAddress: facts(OTHER_RAW).solanaAddress,
      keyVersion: '1', algorithm: 'ED25519_SHA_512', network: 'devnet',
      registeredAt: new Date(), pausedReason: null,
    };

    /*
     * Молчаливая замена стёрла бы единственный след того, что ключ
     * поменялся. Смена проходит через явный отзыв.
     */
    await expect(registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: facts(RAW).fingerprint,
    })).rejects.toThrow('IDENTITY_ALREADY_REGISTERED');
  });

  it('после отзыва регистрация нового ключа проходит', async () => {
    row = {
      id: 'solana-signing-identity', state: 'REGISTERED', provider: 'aws-kms',
      fingerprint: facts(OTHER_RAW).fingerprint,
      solanaAddress: facts(OTHER_RAW).solanaAddress,
      keyVersion: '1', algorithm: 'ED25519_SHA_512', network: 'devnet',
      registeredAt: new Date(), pausedReason: null,
    };

    expect(await revokeSigningIdentity({
      actorId: 'admin-1', network: 'devnet', reasonCode: 'KEY_ROTATION',
    })).toBe(true);

    const identity = await registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: facts(RAW).fingerprint,
    });
    expect(identity.fingerprint).toBe(facts(RAW).fingerprint);
  });

  it('повторный отзыв не создаёт второго события', async () => {
    expect(await revokeSigningIdentity({
      actorId: 'admin-1', network: 'devnet', reasonCode: 'X',
    })).toBe(false);
    expect(audit.filter((a) => a.action === 'SIGNING_KEY_REVOKED')).toHaveLength(0);
  });
});

// ═══════════════════════════ Сверка и пауза ══════════════════════════════════

describe('расхождение останавливает подпись', () => {
  const registered = () => {
    row = {
      id: 'solana-signing-identity', state: 'REGISTERED', provider: 'aws-kms',
      fingerprint: facts(RAW).fingerprint,
      solanaAddress: facts(RAW).solanaAddress,
      keyVersion: '1', algorithm: 'ED25519_SHA_512', network: 'devnet',
      registeredAt: new Date(), pausedReason: null,
    };
  };

  it('тот же ключ — без паузы', async () => {
    registered();
    const result = await verifyAgainstRegistry({
      facts: facts(RAW), actorId: null, network: 'devnet',
    });

    expect(result.verdict).toBe('OK');
    expect(result.paused).toBe(false);
  });

  it('сменившийся ключ ставит паузу', async () => {
    registered();
    const result = await verifyAgainstRegistry({
      facts: facts(OTHER_RAW), actorId: null, network: 'devnet',
    });

    expect(result.verdict).toBe('FINGERPRINT_CHANGED');
    expect(result.paused).toBe(true);
    expect(row!.state).toBe('PAUSED');
  });

  it('сменившаяся версия ключа тоже ставит паузу', async () => {
    registered();
    const result = await verifyAgainstRegistry({
      facts: facts(RAW, { keyVersion: '2' }), actorId: null, network: 'devnet',
    });

    expect(result.verdict).toBe('KEY_VERSION_CHANGED');
    expect(row!.state).toBe('PAUSED');
  });

  it('вторая сверка не пишет второго события о той же паузе', async () => {
    registered();
    await verifyAgainstRegistry({ facts: facts(OTHER_RAW), actorId: null, network: 'devnet' });
    await verifyAgainstRegistry({ facts: facts(OTHER_RAW), actorId: null, network: 'devnet' });

    expect(audit.filter((a) => a.action === 'SIGNING_READINESS_PAUSED')).toHaveLength(1);
  });

  it('незарегистрированный ключ не подписывает, но и не «ломается»', async () => {
    const result = await verifyAgainstRegistry({
      facts: facts(RAW), actorId: null, network: 'devnet',
    });

    // Не пауза: паузу снимает человек, а здесь снимать нечего.
    expect(result.verdict).toBe('NOT_REGISTERED');
    expect(result.paused).toBe(false);
  });

  it('пауза не снимается сама при возврате прежнего ключа', async () => {
    registered();
    await verifyAgainstRegistry({ facts: facts(OTHER_RAW), actorId: null, network: 'devnet' });

    const back = await verifyAgainstRegistry({
      facts: facts(RAW), actorId: null, network: 'devnet',
    });

    /*
     * Ключ вернулся — но между «сменился» и «вернулся» кто-то
     * подписывал чужим. Снятие паузы должно быть решением человека,
     * а не следствием того, что подмена закончилась.
     */
    expect(back.verdict).toBe('PAUSED');
    expect(row!.state).toBe('PAUSED');
  });
});

// ═══════════════════════════ Журнал ══════════════════════════════════════════

describe('журнал не рассказывает лишнего', () => {
  it('в записях нет ни имени ресурса, ни сырого ключа', async () => {
    await registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: facts(RAW).fingerprint,
    });

    for (const record of audit) {
      const text = JSON.stringify(record);
      expect(text).not.toContain('arn:');
      expect(text).not.toContain(Buffer.from(RAW).toString('base64'));
      for (const key of AUDIT_FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(record.after ?? {}, key)).toBe(false);
      }
    }
  });

  it('регистрация и осмотр записываются разными действиями', async () => {
    await registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: facts(RAW).fingerprint,
    });

    const actions = audit.map((a) => a.action);
    expect(actions).toContain('SIGNING_KEY_DISCOVERED');
    expect(actions).toContain('SIGNING_KEY_REGISTERED');
  });

  it('отпечаток в журнале есть, публичного ключа нет', async () => {
    await registerSigningIdentity({
      actorId: 'admin-1', provider: 'aws-kms', network: 'devnet',
      confirmedFingerprint: facts(RAW).fingerprint,
    });

    const record = audit.find((a) => a.action === 'SIGNING_KEY_REGISTERED')!;
    const after = record.after as Record<string, unknown>;
    expect(after.keyFingerprint).toBe(facts(RAW).fingerprint);
    expect(after.publicKey).toBeUndefined();
  });

  it('в модуле нет отправки и приватных ключей', () => {
    const source = readFileSync(
      new URL('./signing-identity-registry.ts', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(
      /sendTransaction|sendRawTransaction|broadcast|privateKey|secretKey|accessKeyId/i,
    );
    // Идентификатор ресурса в таблицу не пишется.
    expect(source).not.toMatch(/keyArn|keyResourceName|SOLANA_SIGNER_KEY_ID/);
  });

  it('автоматической привязки нет в исходнике', () => {
    const source = readFileSync(
      new URL('./signing-identity-registry.ts', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    /*
     * Регистрация обязана требовать эхо. Проверяется, что подпись
     * функции его принимает: без параметра «подтверждение человека»
     * превращается в вызов сервера самому себе.
     */
    expect(source).toContain('confirmedFingerprint');
  });
});
