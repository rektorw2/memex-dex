import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { AwsKmsTransport, classifyAwsError } from './kms-aws-transport.js';
import { AwsKmsSolanaSigner } from './kms-ed25519-adapters.js';
import {
  ed25519PublicKeyFromDer,
  SignerError,
  verifyEd25519,
} from './solana-signer-contract.js';
import { runKmsPreflight } from './kms-preflight.js';
import { SolanaBlockhashProvider } from './solana-blockhash-provider.js';
import { KNOWN_GENESIS_HASHES } from './solana-preflight.js';
import type { SolanaRpcClient } from './solana-rpc-deposit-source.js';

/**
 * Транспорт до AWS KMS.
 *
 * Главное, что здесь проверяется: без выбранного провайдера SDK не
 * загружается вовсе. Это та же беда, что уже была с Prisma —
 * модуль, который всего лишь подключили, идёт искать регион и
 * учётные данные, роняет промис и превращает зелёный прогон
 * в ненулевой код возврата.
 */

const KEYS = crypto.generateKeyPairSync('ed25519');
const PUBLIC_DER = KEYS.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const PUBLIC_RAW = ed25519PublicKeyFromDer(PUBLIC_DER);

/** Счётчик обращений к SDK. Ноль означает, что его не грузили. */
const sdk = vi.hoisted(() => ({ constructed: 0, sends: [] as string[] }));

vi.mock('@aws-sdk/client-kms', () => {
  class KMSClient {
    constructor(_config: { region: string }) {
      sdk.constructed += 1;
    }
    async send(command: { __op: string; input: Record<string, unknown> }) {
      sdk.sends.push(command.__op);
      return respond(command.__op, command.input);
    }
    destroy() {}
  }
  const make = (op: string) =>
    class {
      __op = op;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    KMSClient,
    DescribeKeyCommand: make('DescribeKey'),
    GetPublicKeyCommand: make('GetPublicKey'),
    SignCommand: make('Sign'),
  };
});

/** Ответы поддельного AWS. Переопределяются в отдельных тестах. */
let overrides: Record<string, unknown> = {};

function respond(op: string, input: Record<string, unknown>): Record<string, unknown> {
  if (op in overrides) {
    const value = overrides[op];
    if (value instanceof Error) throw value;
    return value as Record<string, unknown>;
  }
  switch (op) {
    case 'DescribeKey':
      return {
        KeyMetadata: {
          KeyState: 'Enabled',
          KeyUsage: 'SIGN_VERIFY',
          KeySpec: 'ECC_NIST_EDWARDS25519',
        },
      };
    case 'GetPublicKey':
      return {
        KeySpec: 'ECC_NIST_EDWARDS25519',
        KeyUsage: 'SIGN_VERIFY',
        SigningAlgorithms: ['ED25519_SHA_512'],
        PublicKey: new Uint8Array(PUBLIC_DER),
      };
    case 'Sign': {
      const message = Buffer.from(String(input.Message), 'base64');
      return {
        SigningAlgorithm: input.SigningAlgorithm,
        Signature: new Uint8Array(crypto.sign(null, message, KEYS.privateKey)),
      };
    }
    default:
      return {};
  }
}

beforeEach(() => {
  sdk.constructed = 0;
  sdk.sends = [];
  overrides = {};
});

const transport = () => new AwsKmsTransport({ region: 'eu-central-1', keyId: 'key-1' });

const signer = (over: Record<string, unknown> = {}) =>
  new AwsKmsSolanaSigner({
    keyId: 'key-1',
    keyVersion: '1',
    transport: transport(),
    ...over,
  });

// ═══════════════════ Ленивая инициализация ═══════════════════════════════════

describe('SDK загружается только при обращении', () => {
  it('создание транспорта не создаёт клиент', () => {
    const instance = transport();

    // Конструктор описывает конфигурацию, а не идёт в сеть.
    expect(sdk.constructed).toBe(0);
    expect(instance.instantiated).toBe(false);
  });

  it('создание подписанта не создаёт клиент', () => {
    signer();
    expect(sdk.constructed).toBe(0);
  });

  it('первый вызов создаёт клиент один раз', async () => {
    const instance = transport();
    await instance.call('DescribeKey', { KeyId: 'key-1' });
    await instance.call('GetPublicKey', { KeyId: 'key-1' });

    expect(sdk.constructed).toBe(1);
    expect(instance.instantiated).toBe(true);
  });

  it('без региона клиент не создаётся', async () => {
    const instance = new AwsKmsTransport({ region: '', keyId: 'key-1' });

    await expect(instance.call('DescribeKey', {})).rejects.toThrow('SIGNER_REGION_NOT_CONFIGURED');
    expect(sdk.constructed).toBe(0);
  });

  it('без идентификатора ключа клиент не создаётся', async () => {
    const instance = new AwsKmsTransport({ region: 'eu-central-1', keyId: '' });

    await expect(instance.call('DescribeKey', {})).rejects.toThrow('SIGNER_KEY_NOT_CONFIGURED');
    expect(sdk.constructed).toBe(0);
  });

  it('модуль транспорта не импортирует SDK статически', () => {
    const source = readFileSync(new URL('./kms-aws-transport.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Статический импорт заставил бы SDK искать регион и учётные
    // данные в окружении, где их нет и не должно быть.
    expect(source).not.toMatch(/^import .*@aws-sdk/m);
    expect(source).toContain("await import('@aws-sdk/client-kms')");
  });

  it('фабрика подписанта не создаёт транспорт при выключенной подписи', async () => {
    const factory = readFileSync(new URL('./signer-factory.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Первым делом проверяется разрешение, а не провайдер.
    const body = factory.slice(factory.indexOf('export function createSolanaSigner'));
    expect(body.indexOf('signingStateFromConfig')).toBeLessThan(body.indexOf('AwsKmsTransport'));
  });

  it('фабрика не читает флаг подписи в обход общего расчёта', () => {
    /*
     * Проверяется не наличие условия, а его источник.
     *
     * Собственное чтение `SOLANA_SIGNING_ENABLED` здесь — это второй
     * ответ на вопрос, на который уже отвечает общий расчёт. Именно
     * так и разошлись воркер с интерфейсом: каждый читал своё.
     *
     * Исключение одно: провайдер blockhash получает флаг параметром,
     * потому что это его собственная настройка «ходить ли в сеть».
     */
    const body = readFileSync(new URL('./signer-factory.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const signerBody = body.slice(
      body.indexOf('export function createSolanaSigner'),
      body.indexOf('export function blockhashProvider'),
    );

    expect(signerBody).not.toMatch(/if\s*\(\s*!?\s*env\.SOLANA_SIGNING_ENABLED/);
    expect(signerBody).toContain('signingStateFromConfig');
  });

  it('операция вне списка не выполняется', async () => {
    // Транспорт, вызывающий что угодно по имени, — тот же
    // «подпиши произвольные байты», уровнем ниже.
    await expect(transport().call('ScheduleKeyDeletion', {}))
      .rejects.toThrow('SIGNER_OPERATION_NOT_ALLOWED');
  });

  it('закрытие несозданного клиента ничего не создаёт', () => {
    const instance = transport();
    instance.destroy();
    expect(sdk.constructed).toBe(0);
  });
});

// ═══════════════════ Проверка ключа ══════════════════════════════════════════

describe('проверка ключа до подписи', () => {
  it('исправный ключ читается', async () => {
    const identity = await signer().identity();

    expect(identity.algorithm).toBe('ED25519_SHA_512');
    expect(identity.publicKey).toHaveLength(32);
  });

  it('метаданные запрашиваются раньше публичного ключа', async () => {
    await signer().identity();
    // Отключённый ключ отдаст публичный ключ и промолчит про
    // состояние: спрашивать надо в другом порядке.
    expect(sdk.sends[0]).toBe('DescribeKey');
  });

  it('отключённый ключ отвергается', async () => {
    overrides.DescribeKey = { KeyMetadata: { KeyState: 'Disabled', KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_NIST_EDWARDS25519' } };
    await expect(signer().identity()).rejects.toThrow('SIGNER_KEY_STATE_INVALID');
  });

  it('ключ в очереди на удаление отвергается', async () => {
    overrides.DescribeKey = { KeyMetadata: { KeyState: 'PendingDeletion', KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_NIST_EDWARDS25519' } };
    await expect(signer().identity()).rejects.toThrow('SIGNER_KEY_STATE_INVALID');
  });

  it('незнакомое состояние тоже отвергается', async () => {
    // Список состояний расширяется; «всё, кроме известных плохих»
    // однажды пропустит новое.
    overrides.DescribeKey = { KeyMetadata: { KeyState: 'SomethingNew', KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_NIST_EDWARDS25519' } };
    await expect(signer().identity()).rejects.toThrow('SIGNER_KEY_STATE_INVALID');
  });

  it('ключ шифрования вместо подписи отвергается', async () => {
    overrides.DescribeKey = { KeyMetadata: { KeyState: 'Enabled', KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'ECC_NIST_EDWARDS25519' } };
    await expect(signer().identity()).rejects.toThrow('SIGNER_KEY_USAGE_INVALID');
  });

  it('неверный тип ключа отвергается', async () => {
    overrides.DescribeKey = { KeyMetadata: { KeyState: 'Enabled', KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_NIST_P256' } };
    await expect(signer().identity()).rejects.toThrow('SIGNER_ALGORITHM_NOT_ED25519');
  });

  it('ключ без нужного алгоритма отвергается', async () => {
    overrides.GetPublicKey = {
      KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ED25519_PH_SHA_512'],
      PublicKey: new Uint8Array(PUBLIC_DER),
    };
    // HashEdDSA даёт корректную по стандарту и бесполезную подпись.
    await expect(signer().identity()).rejects.toThrow('SIGNER_ALGORITHM_NOT_ED25519');
  });

  it('испорченный DER отвергается', async () => {
    overrides.GetPublicKey = {
      KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ED25519_SHA_512'],
      PublicKey: new Uint8Array([1, 2, 3]),
    };
    await expect(signer().identity()).rejects.toThrow('SIGNER_PUBLIC_KEY_MALFORMED');
  });

  it('ключ другого алгоритма в DER отвергается', async () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    overrides.GetPublicKey = {
      KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ED25519_SHA_512'],
      PublicKey: new Uint8Array(ec.publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
    };
    await expect(signer().identity()).rejects.toThrow(SignerError);
  });
});

// ═══════════════════ Подпись ═════════════════════════════════════════════════

describe('подпись', () => {
  it('алгоритм и тип сообщения — константы адаптера', async () => {
    let captured: Record<string, unknown> = {};
    // Переопределение не задаётся вовсе: присвоение `undefined`
    // всё равно создаёт ключ, и подделка вернула бы пустой ответ.
    const instance = new AwsKmsTransport({ region: 'eu-central-1', keyId: 'key-1' });
    const original = instance.call.bind(instance);
    instance.call = async (op, payload) => {
      if (op === 'Sign') captured = payload;
      return original(op, payload);
    };

    await new AwsKmsSolanaSigner({ keyId: 'key-1', keyVersion: '1', transport: instance })
      .signMessage({ message: new Uint8Array(32), intentId: 'i', expectedKeyVersion: '1' });

    // Параметр однажды передадут неправильно; константу — нет.
    expect(captured.SigningAlgorithm).toBe('ED25519_SHA_512');
    expect(captured.MessageType).toBe('RAW');
  });

  it('алгоритм и тип сообщения не читаются из запроса', () => {
    /*
     * Проверка поведения здесь недостаточна.
     *
     * Запись вида `request.algorithm ?? КОНСТАНТА` даёт ровно тот же
     * результат, пока никто не передал поле, — и перестаёт давать его
     * в тот день, когда передадут. Поэтому проверяется сам текст:
     * в полезной нагрузке `Sign` должны стоять ссылки на константы
     * адаптера и ничего больше.
     */
    const source = stripComments(
      readFileSync(new URL('./kms-ed25519-adapters.ts', import.meta.url), 'utf8'),
    );
    const payload = source.slice(source.indexOf("call(this.transport(), 'Sign'"));
    const block = payload.slice(0, payload.indexOf('});'));

    expect(block).toMatch(/MessageType:\s*AwsKmsSolanaSigner\.MESSAGE_TYPE,/);
    expect(block).toMatch(/SigningAlgorithm:\s*AwsKmsSolanaSigner\.ALGORITHM,/);
    // Ни развилок, ни значений по умолчанию, ни обращений к запросу.
    expect(block).not.toMatch(/MessageType:[^,]*(\?\?|\?|request|options|intent|payload)/);
    expect(block).not.toMatch(/SigningAlgorithm:[^,]*(\?\?|\?|request|options|intent|payload)/);
    // Pre-hashed режим не упоминается нигде, кроме списка запретов.
    expect(block).not.toContain('DIGEST');
    expect(block).not.toContain('ED25519_PH_SHA_512');
  });

  it('подпись проверяется настоящим ключом', async () => {
    const message = Buffer.from('devnet self transfer fixture');
    const result = await signer().signMessage({
      message: new Uint8Array(message), intentId: 'i', expectedKeyVersion: '1',
    });

    expect(result.signature).toHaveLength(64);
    expect(verifyEd25519(new Uint8Array(message), result.signature, PUBLIC_RAW)).toBe(true);
  });

  it('подпись неверной длины отвергается', async () => {
    overrides.Sign = { SigningAlgorithm: 'ED25519_SHA_512', Signature: new Uint8Array(63) };
    await expect(
      signer().signMessage({ message: new Uint8Array(32), intentId: 'i', expectedKeyVersion: '1' }),
    ).rejects.toThrow('SIGNER_SIGNATURE_MALFORMED');
  });

  it('подпись другим алгоритмом отвергается', async () => {
    overrides.Sign = { SigningAlgorithm: 'ED25519_PH_SHA_512', Signature: new Uint8Array(64) };
    await expect(
      signer().signMessage({ message: new Uint8Array(32), intentId: 'i', expectedKeyVersion: '1' }),
    ).rejects.toThrow('SIGNER_ALGORITHM_MISMATCH');
  });

  it('смена версии ключа останавливает подпись', async () => {
    await expect(
      signer().signMessage({ message: new Uint8Array(32), intentId: 'i', expectedKeyVersion: '9' }),
    ).rejects.toThrow('SIGNER_KEY_VERSION_CHANGED');
  });
});

// ═══════════════════ Классификация ошибок ════════════════════════════════════

describe('ошибки провайдера', () => {
  const table: Array<[string, string]> = [
    ['DisabledException', 'SIGNER_KEY_STATE_INVALID'],
    ['KMSInvalidStateException', 'SIGNER_KEY_STATE_INVALID'],
    ['InvalidKeyUsageException', 'SIGNER_KEY_USAGE_INVALID'],
    ['NotFoundException', 'SIGNER_KEY_NOT_FOUND'],
    ['AccessDeniedException', 'SIGNER_ACCESS_DENIED'],
    ['ThrottlingException', 'SIGNER_RATE_LIMITED'],
    ['CredentialsProviderError', 'SIGNER_CREDENTIALS_UNAVAILABLE'],
    ['DependencyTimeoutException', 'SIGNER_AMBIGUOUS'],
    ['KMSInternalException', 'SIGNER_AMBIGUOUS'],
    ['TimeoutError', 'SIGNER_AMBIGUOUS'],
  ];

  for (const [name, code] of table) {
    it(`${name} → ${code}`, () => {
      const error = Object.assign(new Error('текст с arn:aws:kms:eu-central-1:1234'), { name });
      expect(classifyAwsError(error).code).toBe(code);
    });
  }

  it('неизвестная ошибка считается неоднозначной', () => {
    // Разорванное соединение не отвечает, успела ли подпись
    // создаться. Повторять такое автоматически нельзя.
    expect(classifyAwsError(new Error('boom')).code).toBe('SIGNER_AMBIGUOUS');
  });

  it('неоднозначная ошибка не помечается как повторяемая', () => {
    expect(classifyAwsError(new Error('boom')).retryable).toBe(false);
  });

  it('текст ошибки провайдера наружу не выходит', () => {
    const error = Object.assign(new Error('arn:aws:kms:eu-central-1:111122223333:key/abc'), {
      name: 'AccessDeniedException',
    });
    const classified = classifyAwsError(error);

    expect(classified.message).not.toContain('arn:aws');
    expect(classified.message).not.toContain('111122223333');
  });
});

// ═══════════════════ Blockhash ═══════════════════════════════════════════════

class FakeRpc implements SolanaRpcClient {
  readonly calls: string[] = [];
  constructor(private readonly answer: (method: string) => unknown) {}
  async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    const value = this.answer(method);
    if (value instanceof Error) throw value;
    return value as T;
  }
}

const devnetRpc = (over: Record<string, unknown> = {}) =>
  new FakeRpc((method) => {
    if (method in over) return over[method];
    if (method === 'getGenesisHash') return KNOWN_GENESIS_HASHES.devnet;
    if (method === 'getLatestBlockhash') {
      return { value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 350_000_000 } };
    }
    return null;
  });

describe('blockhash', () => {
  const provider = (rpc: SolanaRpcClient | null, over: Record<string, unknown> = {}) =>
    new SolanaBlockhashProvider(rpc, {
      network: 'devnet',
      signingEnabled: true,
      ...over,
    });

  it('берётся из devnet после проверки сети', async () => {
    const rpc = devnetRpc();
    const facts = await provider(rpc).fetch();

    // Сеть проверяется до значения: чужой blockhash синтаксически
    // неотличим от нужного.
    expect(rpc.calls[0]).toBe('getGenesisHash');
    expect(facts.blockhash).toBeTruthy();
    expect(facts.lastValidBlockHeight).toBe('350000000');
  });

  it('высота хранится строкой', async () => {
    const facts = await provider(devnetRpc()).fetch();
    expect(typeof facts.lastValidBlockHeight).toBe('string');
  });

  it('mainnet-узел отвергается своим кодом', async () => {
    const rpc = devnetRpc({ getGenesisHash: KNOWN_GENESIS_HASHES['mainnet-beta'] });
    await expect(provider(rpc).fetch()).rejects.toThrow('BLOCKHASH_MAINNET_REFUSED');
  });

  it('чужая сеть отвергается', async () => {
    const rpc = devnetRpc({ getGenesisHash: KNOWN_GENESIS_HASHES.testnet });
    await expect(provider(rpc).fetch()).rejects.toThrow('BLOCKHASH_GENESIS_MISMATCH');
  });

  it('не devnet отвергается до сети', async () => {
    const rpc = devnetRpc();
    await expect(provider(rpc, { network: 'mainnet-beta' }).fetch())
      .rejects.toThrow('BLOCKHASH_NETWORK_FORBIDDEN');
    expect(rpc.calls).toEqual([]);
  });

  it('при выключенной подписи в сеть не ходим', async () => {
    const rpc = devnetRpc();
    await expect(provider(rpc, { signingEnabled: false }).fetch())
      .rejects.toThrow('BLOCKHASH_SIGNING_DISABLED');
    // Лишний трафик от выключенной функции — это и счёт, и след.
    expect(rpc.calls).toEqual([]);
  });

  it('свежее значение переиспользуется', async () => {
    const rpc = devnetRpc();
    const instance = provider(rpc);
    await instance.fetch();
    await instance.fetch();

    expect(rpc.calls.filter((c) => c === 'getLatestBlockhash')).toHaveLength(1);
  });

  it('устаревшее значение запрашивается заново', async () => {
    const rpc = devnetRpc();
    let clock = 1_000;
    const instance = provider(rpc, { now: () => clock });
    await instance.fetch();
    clock += 60_000;
    await instance.fetch();

    expect(rpc.calls.filter((c) => c === 'getLatestBlockhash')).toHaveLength(2);
  });

  it('нецелая высота отвергается', async () => {
    const rpc = devnetRpc({ getLatestBlockhash: { value: { blockhash: 'h', lastValidBlockHeight: 1.5 } } });
    await expect(provider(rpc).fetch()).rejects.toThrow('BLOCKHASH_HEIGHT_INVALID');
  });

  it('пустой ответ отвергается', async () => {
    const rpc = devnetRpc({ getLatestBlockhash: { value: {} } });
    await expect(provider(rpc).fetch()).rejects.toThrow('BLOCKHASH_MALFORMED');
  });

  it('без узла blockhash не выдумывается', async () => {
    await expect(provider(null).fetch()).rejects.toThrow('BLOCKHASH_RPC_NOT_CONFIGURED');
  });
});

// ═══════════════════ Preflight ═══════════════════════════════════════════════

describe('проверка контура подписи', () => {
  const run = (over: Record<string, unknown> = {}) =>
    runKmsPreflight({
      provider: 'aws-kms',
      network: 'devnet',
      signer: signer(),
      blockhash: new SolanaBlockhashProvider(devnetRpc(), {
        network: 'devnet', signingEnabled: true,
      }),
      expectedFingerprint: null,
      allowSign: false,
      signingAllowed: true,
      ...over,
    });

  it('запрет общего расчёта не обходится разрешением на подпись', async () => {
    /*
     * Самый опасный сценарий этой задачи: `KMS_PREFLIGHT_ALLOW_SIGN`
     * означает «разрешаю подписать при проверке», и превратить его
     * в обход остальных условий значило бы завести второй способ
     * включить контур — тот, о котором не помнят.
     *
     * Настоящий вызов Sign не должен состояться, даже когда
     * разрешение на него выдано явно.
     */
    const report = await run({ allowSign: true, signingAllowed: false });

    expect(report.signAttempted).toBe(false);
    expect(report.status).toBe('IMPLEMENTED_NOT_VALIDATED');
    expect(report.steps.find((s) => s.name === 'SIGN')?.code).toBe('SIGNING_NOT_ALLOWED');
  });

  it('причина названа общая, а не производная', async () => {
    // «Подпись не разрешена настройкой проверки» увело бы оператора
    // чинить не то: запретил общий расчёт, а не этот флаг.
    const report = await run({ allowSign: false, signingAllowed: false });

    expect(report.steps.find((s) => s.name === 'SIGN')?.code).toBe('SIGNING_NOT_ALLOWED');
  });

  it('без отдельного разрешения не подписывает', async () => {
    const report = await run();

    expect(report.signAttempted).toBe(false);
    expect(report.steps.find((s) => s.name === 'SIGN')?.outcome).toBe('SKIPPED');
  });

  it('без подписи итог не READY', async () => {
    // Провайдер, у которого ни разу не просили подпись, готовым
    // не является, как бы хорошо ни выглядели метаданные.
    expect((await run()).status).toBe('IMPLEMENTED_NOT_VALIDATED');
  });

  it('с разрешением подписывает и проверяет локально', async () => {
    const report = await run({ allowSign: true });

    expect(report.status).toBe('READY');
    expect(report.steps.find((s) => s.name === 'SIGNATURE_VERIFY')?.outcome).toBe('PASS');
  });

  it('mainnet отвергается до любых вызовов', async () => {
    const report = await run({ network: 'mainnet-beta' });

    expect(report.status).toBe('FAILED');
    expect(sdk.sends).toEqual([]);
  });

  it('несовпадение ожидаемого ключа останавливает проверку', async () => {
    const report = await run({ expectedFingerprint: 'совсем-другой' });

    expect(report.status).toBe('FAILED');
    expect(report.steps.find((s) => s.name === 'EXPECTED_MATCH')?.code)
      .toBe('SIGNER_EXPECTED_KEY_MISMATCH');
  });

  it('незаданное ожидание помечается пропуском, а не успехом', async () => {
    const report = await run();
    expect(report.steps.find((s) => s.name === 'EXPECTED_MATCH')?.outcome).toBe('SKIPPED');
  });

  it('без узла сеть не проверяется и подпись не выполняется', async () => {
    const report = await run({ blockhash: null });

    expect(report.status).toBe('NOT_RUN');
    expect(report.steps.find((s) => s.name === 'SIGN')?.outcome).toBe('SKIPPED');
  });

  it('в отчёте есть адрес Solana и отпечаток, но не имя ресурса', async () => {
    const report = await run();
    const serialized = JSON.stringify(report);

    expect(report.identity?.solanaAddress).toBeTruthy();
    expect(report.identity?.fingerprint).toBeTruthy();
    expect(serialized).not.toContain('key-1');
    expect(serialized).not.toMatch(/arn:aws|https?:\/\//);
  });

  it('проверочная транзакция не двигает денег', () => {
    const source = readFileSync(new URL('./kms-preflight.ts', import.meta.url), 'utf8');
    // Перевод самому себе на ноль лампортов.
    expect(source).toContain("rawAmount: '0'");
    expect(source).toContain('ownerAddress: facts.solanaAddress');
    expect(source).toContain('destinationAddress: facts.solanaAddress');
  });

  it('ни один модуль контура не отправляет транзакцию', () => {
    const strip = (file: string) =>
      readFileSync(new URL(file, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const file of [
      './kms-preflight.ts', './kms-aws-transport.ts',
      './solana-blockhash-provider.ts', './signer-factory.ts',
    ]) {
      expect(strip(file), file).not.toMatch(
        /sendTransaction|sendRawTransaction|sendAndConfirm|simulateTransaction|broadcast/i,
      );
    }
  });

  it('приватный ключ в контуре не фигурирует', () => {
    for (const file of ['./kms-aws-transport.ts', './signer-factory.ts', './kms-preflight.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/privateKey|secretKey|accessKeyId|sessionToken/);
    }
  });

  it('учётные данные не передаются в конфигурацию клиента', () => {
    const source = readFileSync(new URL('./kms-aws-transport.ts', import.meta.url), 'utf8');
    const config = source.slice(source.indexOf('new KMSClient('), source.indexOf('new KMSClient(') + 120);

    // Их находит стандартная цепочка SDK. Второй способ хранить
    // секрет однажды разойдётся с первым.
    expect(config).toContain('region');
    expect(config).not.toMatch(/credentials|accessKey|secret/);
  });
});

/** Комментарий не код: иначе тест обвиняет собственное объяснение. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
