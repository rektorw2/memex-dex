import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { POLICY_VERSION, buildIntentMessage, IntentBuildError } from './transaction-intent-builder.js';
import { signIntent, type IntentRecord, type SigningStore } from './transaction-intent-signing.js';
import {
  UnavailableSolanaSigner,
  SignerError,
  ed25519PublicKeyFromDer,
  ed25519PublicKeyFromPem,
  verifyEd25519,
  publicKeyFingerprint,
  type SignRequest,
  type SolanaMessageSigner,
} from './solana-signer-contract.js';
import { AwsKmsSolanaSigner, GcpKmsSolanaSigner, crc32c } from './kms-ed25519-adapters.js';

/**
 * Контур подписи.
 *
 * Проверяется не «вызвалась ли функция», а последствия: сколько
 * подписей получилось, что именно подписали и можно ли это
 * отправить. Последнее — нельзя, и это тоже проверяется.
 */

/** Настоящая пара ключей Ed25519: подпись обязана проверяться по-настоящему. */
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUBLIC_DER = KEYS.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const PUBLIC_RAW = ed25519PublicKeyFromDer(PUBLIC_DER);
const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

const request = (over: Record<string, unknown> = {}) => ({
  purpose: 'DEVNET_SELF_TRANSFER',
  network: 'devnet',
  ownerAddress: OWNER,
  destinationAddress: OWNER,
  rawAmount: '1000000',
  mint: null,
  feeLimitLamports: '5000',
  slippageBps: 50,
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: '5000',
  ...over,
});

/** Подписывает по-настоящему тем же ключом, чей публичный отдаёт. */
class RealSigner implements SolanaMessageSigner {
  signCalls = 0;
  constructor(
    private readonly version = '1',
    private readonly publicKey: Uint8Array = PUBLIC_RAW,
  ) {}
  async identity() {
    return {
      provider: 'aws-kms' as const,
      keyId: 'test-key',
      version: this.version,
      algorithm: 'ED25519_SHA_512',
      publicKey: this.publicKey,
    };
  }
  async signMessage(req: SignRequest) {
    this.signCalls += 1;
    const signature = crypto.sign(null, Buffer.from(req.message), KEYS.privateKey);
    return { signature: new Uint8Array(signature), keyVersion: this.version };
  }
  async health() {
    return { ok: true, code: null };
  }
}

class FakeStore implements SigningStore {
  state: 'APPROVED' | 'SIGNING' | 'SIGNED' | 'FAILED' = 'APPROVED';
  signature: string | null = null;
  keyVersion: string | null = null;
  failure: string | null = null;
  attempts: Array<{ id: string; outcome: string; code: string | null }> = [];
  /** Строки, у которых менялся баланс. Должна остаться пустой. */
  moneyTouched: string[] = [];

  async claim(_intentId: string, _by: string) {
    // Захват возможен ровно один раз: второй запрос получает false.
    if (this.state !== 'APPROVED') return false;
    this.state = 'SIGNING';
    return true;
  }
  async recordAttemptStart(_intentId: string, _by: string) {
    const id = `attempt-${this.attempts.length + 1}`;
    this.attempts.push({ id, outcome: 'CLAIMED', code: null });
    return id;
  }
  async finishAttempt(attemptId: string, outcome: string, code: string | null) {
    const attempt = this.attempts.find((item) => item.id === attemptId);
    if (attempt) Object.assign(attempt, { outcome, code });
  }
  async markSigned(_intentId: string, signature: string, keyVersion: string) {
    this.state = 'SIGNED';
    this.signature = signature;
    this.keyVersion = keyVersion;
  }
  async markFailed(_intentId: string, code: string) {
    // Захваченное намерение остаётся закрытым: оживить нельзя.
    if (this.state === 'SIGNING') this.state = 'FAILED';
    this.failure = code;
  }
  async existingSignature() {
    return this.signature ? { signature: this.signature, keyVersion: this.keyVersion! } : null;
  }
}

const intent = (over: Partial<IntentRecord> = {}): IntentRecord => {
  const built = buildIntentMessage(request());
  return {
    id: 'intent-1',
    userId: 'user-1',
    state: 'APPROVED',
    approved: built.facts,
    request: request(),
    expiresAt: 10_000,
    lastValidBlockHeight: '5000',
    approvedKeyVersion: '1',
    walletPublicKey: PUBLIC_RAW,
    ...over,
  };
};

const environment = (over: Record<string, unknown> = {}) => ({
  currentBlockHeight: '4000',
  safetyLatchHealthy: true,
  now: 1_000,
  ...over,
});

let store: FakeStore;

beforeEach(() => {
  store = new FakeStore();
});

const run = (over: Record<string, unknown> = {}) =>
  signIntent({
    intent: intent(),
    actorId: 'user-1',
    signer: new RealSigner(),
    store,
    environment: environment(),
    workerId: 'worker-a',
    ...over,
  });

// ═══════════════════════ Успешный путь ═══════════════════════════════════════

describe('подпись намерения', () => {
  it('подписывает и проверяет локально', async () => {
    const result = await run();

    expect(result.status).toBe('signed');
    expect(store.state).toBe('SIGNED');
  });

  it('подпись действительно проверяется ключом', async () => {
    const built = buildIntentMessage(request());
    const result = await run();

    if (result.status !== 'signed') throw new Error('ожидалась подпись');
    const signature = Buffer.from(result.signature, 'base64');
    expect(verifyEd25519(built.message, signature, PUBLIC_RAW)).toBe(true);
  });

  it('состояние SIGNED не превращается в отправленное', async () => {
    await run();

    // В хранилище нет ни поля отправки, ни перехода к ней.
    expect(Object.keys(store)).not.toContain('submitted');
    expect(store.moneyTouched).toEqual([]);
  });
});

// ═══════════════════════ Идемпотентность и гонки ═════════════════════════════

describe('одно намерение — одна подпись', () => {
  it('повторный запрос возвращает ту же подпись, не подписывая заново', async () => {
    const signer = new RealSigner();
    const first = await run({ signer });
    const second = await run({ signer });

    expect(second.status).toBe('already-signed');
    // Сеть теряет ответы, и клиент повторяет запрос — это норма.
    // Вторая подпись нормой не является.
    expect(signer.signCalls).toBe(1);
    if (first.status !== 'signed' || second.status !== 'already-signed') throw new Error('состояния');
    expect(second.signature).toBe(first.signature);
  });

  it('два параллельных запроса дают одну подпись', async () => {
    const signer = new RealSigner();
    const [a, b] = await Promise.all([run({ signer }), run({ signer })]);

    const signed = [a, b].filter((result) => result.status === 'signed');
    expect(signed).toHaveLength(1);
    expect(signer.signCalls).toBe(1);
  });

  it('проигравший захват получает свой код, а не подпись', async () => {
    store.state = 'SIGNING';
    const result = await run();

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.code).toBe('CLAIM_LOST');
  });

  it('KMS вызывается только после захвата', async () => {
    const signer = new RealSigner();
    store.state = 'SIGNING';
    await run({ signer });

    // Захват после вызова означал бы две подписи при гонке.
    expect(signer.signCalls).toBe(0);
  });
});

// ═══════════════════════ Отказы ══════════════════════════════════════════════

describe('когда подписывать нельзя', () => {
  it('чужое намерение', async () => {
    const result = await run({ actorId: 'user-2' });
    expect(result).toMatchObject({ status: 'refused', code: 'NOT_OWNER' });
  });

  it('истёкшее намерение', async () => {
    const result = await run({ environment: environment({ now: 99_999 }) });
    expect(result).toMatchObject({ code: 'INTENT_EXPIRED' });
  });

  it('устаревший blockhash', async () => {
    const result = await run({ environment: environment({ currentBlockHeight: '5001' }) });
    expect(result).toMatchObject({ code: 'BLOCKHASH_EXPIRED' });
  });

  it('изменённая сумма после одобрения', async () => {
    const approved = buildIntentMessage(request({ rawAmount: '999' })).facts;
    const result = await run({ intent: intent({ approved }) });

    expect(result).toMatchObject({ status: 'refused' });
    if (result.status === 'refused') {
      expect(['MONEY_FIELDS_CHANGED', 'MESSAGE_HASH_MISMATCH']).toContain(result.code);
    }
    expect(store.state).not.toBe('SIGNED');
  });

  it('смена версии ключа', async () => {
    const result = await run({ signer: new RealSigner('7') });
    expect(result).toMatchObject({ code: 'KEY_VERSION_CHANGED' });
  });

  it('публичный ключ не совпадает с кошельком', async () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const otherRaw = ed25519PublicKeyFromDer(
      other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
    );
    const result = await run({ signer: new RealSigner('1', otherRaw) });

    expect(result).toMatchObject({ code: 'PUBLIC_KEY_MISMATCH' });
  });

  it('поднятая защёлка', async () => {
    const result = await run({ environment: environment({ safetyLatchHealthy: false }) });
    expect(result).toMatchObject({ code: 'SAFETY_LATCH_RAISED' });
  });

  it('недоступный KMS', async () => {
    const result = await run({ signer: new UnavailableSolanaSigner() });
    expect(result).toMatchObject({ status: 'refused', code: 'SIGNER_NOT_CONFIGURED' });
  });

  it('неверная подпись не принимается', async () => {
    const broken: SolanaMessageSigner = {
      ...new RealSigner(),
      async identity() {
        return {
          provider: 'aws-kms' as const, keyId: 'k', version: '1',
          algorithm: 'ED25519_SHA_512', publicKey: PUBLIC_RAW,
        };
      },
      async signMessage() {
        // Валидная по форме, но не та подпись.
        return { signature: new Uint8Array(64), keyVersion: '1' };
      },
      async health() { return { ok: true, code: null }; },
    };
    const result = await run({ signer: broken });

    expect(result).toMatchObject({ code: 'SIGNATURE_INVALID' });
    expect(store.state).toBe('FAILED');
  });
});

// ═══════════════════════ Неоднозначный ответ ═════════════════════════════════

describe('неоднозначный ответ провайдера', () => {
  const ambiguous: SolanaMessageSigner = {
    async identity() {
      return {
        provider: 'aws-kms' as const, keyId: 'k', version: '1',
        algorithm: 'ED25519_SHA_512', publicKey: PUBLIC_RAW,
      };
    },
    async signMessage(): Promise<never> {
      throw new SignerError('SIGNER_AMBIGUOUS', false);
    },
    async health() { return { ok: true, code: null }; },
  };

  it('не приводит к повторной подписи', async () => {
    const result = await run({ signer: ambiguous });

    // Разорванное соединение не говорит, создалась подпись или нет.
    // Повтор «на всякий случай» и есть тот случай, когда под одним
    // намерением оказываются две подписи.
    expect(result).toMatchObject({ code: 'SIGNER_AMBIGUOUS' });
    expect(store.attempts.at(-1)?.outcome).toBe('AMBIGUOUS');
  });

  it('оставляет след для ручного разбора', async () => {
    await run({ signer: ambiguous });

    expect(store.attempts).toHaveLength(1);
    expect(store.failure).toBe('SIGNER_AMBIGUOUS');
  });

  it('повтор после неоднозначности не подписывает автоматически', async () => {
    await run({ signer: ambiguous });
    const second = await run({ signer: ambiguous });

    expect(second.status).toBe('refused');
    expect(store.signature).toBeNull();
  });
});

// ═══════════════════════ Сборка сообщения ════════════════════════════════════

describe('сборка сообщения', () => {
  it('собирается детерминированно', () => {
    expect(buildIntentMessage(request()).messageHash)
      .toBe(buildIntentMessage(request()).messageHash);
  });

  it('версия политики входит в факты', () => {
    expect(buildIntentMessage(request()).facts.policyVersion).toBe(POLICY_VERSION);
  });

  it('mainnet не собирается', () => {
    // Запрет живёт в списке разрешённых сетей, а не в условии,
    // которое можно смягчить.
    expect(() => buildIntentMessage(request({ network: 'mainnet-beta' })))
      .toThrowError(expect.objectContaining({ code: 'NETWORK_NOT_ALLOWED' }));
  });

  it('произвольная операция не собирается', () => {
    for (const purpose of ['SWAP', 'WITHDRAW', 'arbitrary']) {
      expect(() => buildIntentMessage(request({ purpose })), purpose)
        .toThrowError(expect.objectContaining({ code: 'PURPOSE_NOT_ALLOWED' }));
    }
  });

  it('получатель, отличный от отправителя, не собирается', () => {
    expect(() => buildIntentMessage(request({ destinationAddress: OWNER.replace(/^9/, '8') })))
      .toThrow(IntentBuildError);
  });

  it('превышение потолка комиссии останавливает сборку', () => {
    expect(() => buildIntentMessage(request({ feeLimitLamports: '999999999' })))
      .toThrowError(expect.objectContaining({ code: 'FEE_LIMIT_EXCEEDED' }));
  });

  it('превышение проскальзывания останавливает сборку', () => {
    expect(() => buildIntentMessage(request({ slippageBps: 5000 })))
      .toThrowError(expect.objectContaining({ code: 'SLIPPAGE_EXCEEDED' }));
  });

  it('сумма числом не принимается', () => {
    // u64 через number теряет точность ещё до сборки.
    expect(() => buildIntentMessage(request({ rawAmount: 1000000 as unknown as string })))
      .toThrow(IntentBuildError);
  });

  it('сумма с плавающей точкой не принимается', () => {
    for (const bad of ['1.5', '1e6', '-1', '', ' 1 ']) {
      expect(() => buildIntentMessage(request({ rawAmount: bad })), bad).toThrow(IntentBuildError);
    }
  });

  it('u64 на верхней границе собирается без потери точности', () => {
    const max = '18446744073709551615';
    expect(buildIntentMessage(request({ rawAmount: max })).facts.rawAmount).toBe(max);
  });

  it('за верхней границей u64 не собирается', () => {
    expect(() => buildIntentMessage(request({ rawAmount: '18446744073709551616' })))
      .toThrow(IntentBuildError);
  });

  it('в фактах остаётся хеш, а не сообщение', () => {
    const built = buildIntentMessage(request());
    expect(JSON.stringify(built.facts)).not.toContain(Buffer.from(built.message).toString('base64'));
  });

  it('разрешена только системная программа', () => {
    expect(buildIntentMessage(request()).programIds)
      .toEqual(['11111111111111111111111111111111']);
  });
});

// ═══════════════════════ Форматы провайдеров ═════════════════════════════════

describe('разбор ответов провайдеров', () => {
  it('публичный ключ из DER читается', () => {
    expect(ed25519PublicKeyFromDer(PUBLIC_DER)).toHaveLength(32);
  });

  it('публичный ключ из PEM читается', () => {
    const pem = KEYS.publicKey.export({ format: 'pem', type: 'spki' }) as string;
    expect(Buffer.from(ed25519PublicKeyFromPem(pem))).toEqual(Buffer.from(PUBLIC_RAW));
  });

  it('ключ другого алгоритма отвергается', () => {
    // Молча взять хвост значило бы принять ECDSA за Ed25519.
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    expect(() => ed25519PublicKeyFromDer(der)).toThrow(SignerError);
  });

  it('подпись неверной длины отвергается', () => {
    expect(verifyEd25519(new Uint8Array(32), new Uint8Array(63), PUBLIC_RAW)).toBe(false);
  });

  it('отпечаток ключа короткий и не является ключом', () => {
    const fingerprint = publicKeyFingerprint(PUBLIC_RAW);
    expect(fingerprint).toHaveLength(16);
    expect(Buffer.from(PUBLIC_RAW).toString('hex')).not.toContain(fingerprint);
  });

  it('CRC32C считается по полиному Castagnoli', () => {
    // Обычный CRC32 дал бы другое значение, и Google отверг бы
    // каждый запрос с «контрольная сумма не совпала».
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe306_9283);
  });
});

describe('адаптеры без учётных данных', () => {
  it('AWS отказывается работать', async () => {
    const signer = new AwsKmsSolanaSigner({ keyId: 'k', keyVersion: '1', transport: null });
    await expect(signer.identity()).rejects.toThrow('SIGNER_NOT_CONFIGURED');
    expect((await signer.health()).ok).toBe(false);
  });

  it('GCP отказывается работать', async () => {
    const signer = new GcpKmsSolanaSigner({ keyVersionName: 'n', keyVersion: '1', transport: null });
    await expect(signer.identity()).rejects.toThrow('SIGNER_NOT_CONFIGURED');
  });

  it('AWS отвергает ключ не того типа', async () => {
    /*
     * Ключ включён и предназначен для подписи — расходится только
     * тип кривой.
     *
     * Без `KeyState` и `KeyUsage` проверка состояния сработала бы
     * раньше проверки алгоритма, и тест доказывал бы не то, что
     * написано в его имени: «отвергает» — да, но по другой причине.
     */
    const signer = new AwsKmsSolanaSigner({
      keyId: 'k', keyVersion: '1',
      transport: {
        async call() {
          return {
            KeyMetadata: { KeyState: 'Enabled', KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_NIST_P256' },
            KeySpec: 'ECC_NIST_P256',
            SigningAlgorithms: ['ECDSA_SHA_256'],
          };
        },
      },
    });
    await expect(signer.identity()).rejects.toThrow('SIGNER_ALGORITHM_NOT_ED25519');
  });

  it('отключённый ключ отвергается раньше проверки алгоритма', async () => {
    // Обратный случай: тип верный, состояние — нет.
    const signer = new AwsKmsSolanaSigner({
      keyId: 'k', keyVersion: '1',
      transport: {
        async call() {
          return {
            KeyMetadata: {
              KeyState: 'Disabled', KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_NIST_EDWARDS25519',
            },
          };
        },
      },
    });
    await expect(signer.identity()).rejects.toThrow('SIGNER_KEY_STATE_INVALID');
  });

  it('AWS отвергает подпись, сделанную другим алгоритмом', async () => {
    const signer = new AwsKmsSolanaSigner({
      keyId: 'k', keyVersion: '1',
      transport: {
        async call(operation) {
          if (operation === 'Sign') {
            // HashEdDSA вместо PureEdDSA: Solana такую отвергнет.
            return {
              SigningAlgorithm: 'ED25519_PH_SHA_512',
              Signature: Buffer.alloc(64).toString('base64'),
            };
          }
          return {};
        },
      },
    });
    await expect(
      signer.signMessage({ message: new Uint8Array(32), intentId: 'i', expectedKeyVersion: '1' }),
    ).rejects.toThrow('SIGNER_ALGORITHM_MISMATCH');
  });

  it('GCP отвергает ответ без подтверждения целостности', async () => {
    const signer = new GcpKmsSolanaSigner({
      keyVersionName: 'n', keyVersion: '1',
      transport: {
        async call(operation) {
          if (operation === 'asymmetricSign') {
            return { signature: Buffer.alloc(64).toString('base64'), verifiedDataCrc32c: false };
          }
          return {};
        },
      },
    });
    await expect(
      signer.signMessage({ message: new Uint8Array(32), intentId: 'i', expectedKeyVersion: '1' }),
    ).rejects.toThrow('SIGNER_INTEGRITY_UNVERIFIED');
  });

  it('чужая ошибка транспорта считается неоднозначной', async () => {
    const signer = new AwsKmsSolanaSigner({
      keyId: 'k', keyVersion: '1',
      transport: { async call(): Promise<never> { throw new Error('ECONNRESET'); } },
    });
    // Разорванное соединение не отвечает, успела ли подпись создаться.
    await expect(signer.identity()).rejects.toThrow('SIGNER_AMBIGUOUS');
  });
});

// ═══════════════════════ Границы контура ═════════════════════════════════════

describe('чего в контуре подписи нет', () => {
  const read = (file: string) =>
    readFileSync(new URL(file, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  const signing = read('./transaction-intent-signing.ts');
  const builder = read('./transaction-intent-builder.ts');
  const contract = read('./solana-signer-contract.ts');
  const adapters = read('./kms-ed25519-adapters.ts');

  it('ни один модуль не отправляет транзакции', () => {
    for (const [name, source] of Object.entries({ signing, builder, contract, adapters })) {
      expect(source, name).not.toMatch(
        /sendTransaction|sendRawTransaction|sendAndConfirm|broadcast|submitTransaction/i,
      );
    }
  });

  it('контур подписи не знает про RPC', () => {
    expect(signing).not.toMatch(/Connection|SOLANA_RPC_URL|fetch\(/);
  });

  it('приватный ключ не фигурирует нигде', () => {
    for (const [name, source] of Object.entries({ signing, builder, contract, adapters })) {
      expect(source, name).not.toMatch(/privateKey|secretKey|Keypair\.|fromSecretKey/);
    }
  });

  it('контракт не предлагает подписать произвольные байты', () => {
    // Такой метод превратил бы весь контур проверок в украшение.
    expect(contract).not.toMatch(/signArbitrary|signRaw|signBytes|signAnything/);
  });

  it('сообщение целиком не попадает в журнал', () => {
    expect(signing).not.toMatch(/logger.*message|console\.(log|error).*message/);
  });

  it('учётные данные не читаются из окружения в этих модулях', () => {
    for (const [name, source] of Object.entries({ contract, adapters, builder })) {
      expect(source, name).not.toMatch(/process\.env/);
    }
  });
});
