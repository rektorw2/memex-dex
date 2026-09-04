import {
  AWS_KMS_ED25519,
  GCP_KMS_ED25519,
  SOLANA_MAX_TRANSACTION_BYTES,
} from '@memex/core';
import {
  assertSignableMessage,
  ed25519PublicKeyFromDer,
  ed25519PublicKeyFromPem,
  ed25519SignatureFrom,
  SignerError,
  type SignRequest,
  type SignResult,
  type SignerKeyIdentity,
  type SolanaMessageSigner,
} from './solana-signer-contract.js';

/**
 * Адаптеры AWS KMS и Google Cloud KMS для подписи Solana.
 *
 * Реализован протокольный слой: какой запрос отправить, как разобрать
 * ответ, что считать ошибкой и какую именно. Аутентифицированный
 * транспорт внедряется снаружи.
 *
 * Разделение не косметическое. Подписывание запросов к облаку — это
 * работа с учётными данными, и писать её вслепую, без возможности
 * выполнить хоть один настоящий вызов, значит выдать непроверенный
 * код за готовый. Протокольная часть, наоборот, проверяется целиком
 * на поддельном транспорте: именно в ней живут ошибки, которые
 * стоят денег, — не тот алгоритм, не тот формат ключа, не та версия.
 *
 * Без транспорта оба адаптера отвечают «не настроен» и ничего не
 * делают. Это не заглушка вместо работы, а отказ работать вполсилы.
 */

/** Транспорт до провайдера. Реализуется отдельно, вместе с credentials. */
export interface KmsTransport {
  /**
   * Один вызов провайдера.
   *
   * `operation` — логическое имя, `payload` — тело запроса.
   * Возвращается разобранный JSON ответа.
   */
  call(operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AwsSignerOptions {
  /** ARN или идентификатор ключа. Наружу не выходит. */
  keyId: string;
  /** Версия ключа в нашей нумерации: у AWS её нет, ведём сами. */
  keyVersion: string;
  transport: KmsTransport | null;
}

/**
 * AWS KMS.
 *
 * Ключ `ECC_NIST_EDWARDS25519`, алгоритм `ED25519_SHA_512`,
 * `MessageType: RAW`. Именно эта комбинация даёт PureEdDSA над
 * исходным сообщением — то, что проверяет Solana.
 *
 * Второй алгоритм того же ключа, `ED25519_PH_SHA_512`, требует
 * `MessageType: DIGEST` и считает HashEdDSA. Подпись выйдет
 * математически корректной и абсолютно бесполезной: Solana проверяет
 * не то. Поэтому алгоритм и тип сообщения заданы константами и не
 * принимаются параметром — параметр однажды передадут неправильно.
 */
export class AwsKmsSolanaSigner implements SolanaMessageSigner {
  /*
   * Константы адаптера, а не параметры.
   *
   * Алгоритм и тип сообщения не приходят ни из HTTP-запроса, ни из
   * намерения. Параметр однажды передадут неправильно, и подпись
   * выйдет по HashEdDSA — математически верная и отвергаемая Solana.
   */
  static readonly ALGORITHM = 'ED25519_SHA_512';
  static readonly MESSAGE_TYPE = 'RAW';
  static readonly KEY_SPEC = 'ECC_NIST_EDWARDS25519';
  /** Предварительно хешированный вариант. Запрещён навсегда. */
  static readonly FORBIDDEN_ALGORITHM = 'ED25519_PH_SHA_512';

  constructor(private readonly options: AwsSignerOptions) {}

  private transport(): KmsTransport {
    if (!this.options.transport) throw new SignerError('SIGNER_NOT_CONFIGURED', false);
    if (!this.options.keyId) throw new SignerError('SIGNER_KEY_NOT_CONFIGURED', false);
    return this.options.transport;
  }

  /**
   * Состояние ключа.
   *
   * Проверяется равенством `Enabled`, а не перебором плохих
   * состояний: список состояний у AWS расширяется, и «всё, кроме
   * известных плохих» однажды пропустит новое.
   */
  private async assertKeyUsable(): Promise<void> {
    const described = await call(this.transport(), 'DescribeKey', { KeyId: this.options.keyId });
    const metadata = isRecord(described.KeyMetadata) ? described.KeyMetadata : {};

    if (asString(metadata.KeyState) !== 'Enabled') {
      throw new SignerError('SIGNER_KEY_STATE_INVALID', false);
    }
    // Ключ шифрования, применённый для подписи, даст ошибку у
    // провайдера, но узнать об этом лучше до вызова Sign.
    if (asString(metadata.KeyUsage) !== 'SIGN_VERIFY') {
      throw new SignerError('SIGNER_KEY_USAGE_INVALID', false);
    }
    if (asString(metadata.KeySpec) !== AwsKmsSolanaSigner.KEY_SPEC) {
      throw new SignerError('SIGNER_ALGORITHM_NOT_ED25519', false);
    }
  }

  async identity(): Promise<SignerKeyIdentity> {
    await this.assertKeyUsable();
    const response = await call(this.transport(), 'GetPublicKey', { KeyId: this.options.keyId });

    /*
     * Алгоритм подтверждается ответом провайдера, а не настройкой.
     * Ключ мог быть пересоздан другим типом, и узнать об этом лучше
     * до подписи, чем по отвергнутой сетью транзакции.
     *
     * Читается `KeySpec`, а не устаревший `CustomerMasterKeySpec`:
     * в списке значений последнего `ECC_NIST_EDWARDS25519` нет
     * вовсе, и сверка по нему всегда давала бы отказ.
     */
    const spec = asString(response.KeySpec);
    if (spec !== AwsKmsSolanaSigner.KEY_SPEC) {
      throw new SignerError('SIGNER_ALGORITHM_NOT_ED25519', false);
    }
    if (asString(response.KeyUsage) !== 'SIGN_VERIFY') {
      throw new SignerError('SIGNER_KEY_USAGE_INVALID', false);
    }
    const algorithms = Array.isArray(response.SigningAlgorithms)
      ? response.SigningAlgorithms.map(String)
      : [];
    if (!algorithms.includes(AwsKmsSolanaSigner.ALGORITHM)) {
      throw new SignerError('SIGNER_ALGORITHM_NOT_ED25519', false);
    }

    const der = asBytes(response.PublicKey, 'SIGNER_PUBLIC_KEY_MALFORMED');
    const publicKey = ed25519PublicKeyFromDer(der);
    // Разбор DER уже гарантирует 32 байта, но проверка записана
    // явно: она стоит на границе доверия к чужому ответу.
    if (publicKey.length !== 32) throw new SignerError('SIGNER_PUBLIC_KEY_MALFORMED', false);

    return {
      provider: 'aws-kms',
      keyId: this.options.keyId,
      version: this.options.keyVersion,
      algorithm: AwsKmsSolanaSigner.ALGORITHM,
      publicKey,
    };
  }

  async signMessage(request: SignRequest): Promise<SignResult> {
    assertSignableMessage(request.message);
    if (request.expectedKeyVersion !== this.options.keyVersion) {
      // Версия сменилась между одобрением и подписью: подписывать
      // старое намерение новым ключом нельзя, у него другой адрес.
      throw new SignerError('SIGNER_KEY_VERSION_CHANGED', false);
    }
    // Предел AWS — 4096 байт, наш — размер транзакции Solana.
    // Берётся меньший: больший пропустил бы заведомо негодное.
    if (request.message.length > Math.min(AWS_KMS_ED25519.maxMessageBytes ?? Infinity, SOLANA_MAX_TRANSACTION_BYTES)) {
      throw new SignerError('SIGNER_MESSAGE_TOO_LARGE', false);
    }

    const response = await call(this.transport(), 'Sign', {
      KeyId: this.options.keyId,
      Message: Buffer.from(request.message).toString('base64'),
      MessageType: AwsKmsSolanaSigner.MESSAGE_TYPE,
      SigningAlgorithm: AwsKmsSolanaSigner.ALGORITHM,
    });

    // Провайдер сообщает, чем подписал. Если не тем — подпись
    // непригодна, и принимать её нельзя даже «на всякий случай».
    if (asString(response.SigningAlgorithm) !== AwsKmsSolanaSigner.ALGORITHM) {
      throw new SignerError('SIGNER_ALGORITHM_MISMATCH', false);
    }

    return {
      signature: ed25519SignatureFrom(asBytes(response.Signature, 'SIGNER_SIGNATURE_MALFORMED')),
      keyVersion: this.options.keyVersion,
    };
  }

  async health() {
    try {
      await this.identity();
      return { ok: true, code: null };
    } catch (error: unknown) {
      return { ok: false, code: error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE' };
    }
  }
}

export interface GcpSignerOptions {
  /** Полное имя версии ключа. Наружу не выходит. */
  keyVersionName: string;
  keyVersion: string;
  transport: KmsTransport | null;
}

/**
 * Google Cloud KMS.
 *
 * Алгоритм `EC_SIGN_ED25519` описан как PureEdDSA, принимающий
 * сырые данные. Передаётся поле `data`; поле `digest` для этого
 * алгоритма неприменимо, и попытка использовать его дала бы подпись
 * под хешем вместо сообщения.
 */
export class GcpKmsSolanaSigner implements SolanaMessageSigner {
  static readonly ALGORITHM = 'EC_SIGN_ED25519';

  constructor(private readonly options: GcpSignerOptions) {}

  private transport(): KmsTransport {
    if (!this.options.transport) throw new SignerError('SIGNER_NOT_CONFIGURED', false);
    if (!this.options.keyVersionName) throw new SignerError('SIGNER_KEY_NOT_CONFIGURED', false);
    return this.options.transport;
  }

  async identity(): Promise<SignerKeyIdentity> {
    const response = await call(this.transport(), 'getPublicKey', {
      name: this.options.keyVersionName,
    });

    if (asString(response.algorithm) !== GcpKmsSolanaSigner.ALGORITHM) {
      throw new SignerError('SIGNER_ALGORITHM_NOT_ED25519', false);
    }
    const pem = asString(response.pem);
    if (!pem) throw new SignerError('SIGNER_PUBLIC_KEY_MALFORMED', false);

    return {
      provider: 'gcp-kms',
      keyId: this.options.keyVersionName,
      version: this.options.keyVersion,
      algorithm: GcpKmsSolanaSigner.ALGORITHM,
      publicKey: ed25519PublicKeyFromPem(pem),
    };
  }

  async signMessage(request: SignRequest): Promise<SignResult> {
    assertSignableMessage(request.message);
    if (request.expectedKeyVersion !== this.options.keyVersion) {
      throw new SignerError('SIGNER_KEY_VERSION_CHANGED', false);
    }
    // Предел размера `data` в документации не указан. Собственная
    // граница остаётся: неизвестный предел не означает бесконечный.
    if (request.message.length > SOLANA_MAX_TRANSACTION_BYTES) {
      throw new SignerError('SIGNER_MESSAGE_TOO_LARGE', false);
    }

    const data = Buffer.from(request.message);
    const response = await call(this.transport(), 'asymmetricSign', {
      name: this.options.keyVersionName,
      data: data.toString('base64'),
      // Контрольная сумма нужна не для красоты: без неё повреждение
      // при передаче даст подпись под другими байтами, и заметить
      // это можно будет только по чужому переводу.
      dataCrc32c: String(crc32c(data)),
    });

    /*
     * Провайдер сообщает, использовал ли он присланную контрольную
     * сумму. Ответ без подтверждения означает, что целостность
     * данных никто не проверял, — такую подпись принимать нельзя.
     */
    if (response.verifiedDataCrc32c !== true) {
      throw new SignerError('SIGNER_INTEGRITY_UNVERIFIED', true);
    }
    // Имя версии в ответе сверяется с запрошенным: чужой ответ,
    // пришедший по ошибке маршрутизации, не должен стать подписью.
    if (asString(response.name) !== this.options.keyVersionName) {
      throw new SignerError('SIGNER_KEY_VERSION_CHANGED', false);
    }

    const signature = asBytes(response.signature, 'SIGNER_SIGNATURE_MALFORMED');
    const expected = asString(response.signatureCrc32c);
    if (expected && expected !== String(crc32c(Buffer.from(signature)))) {
      throw new SignerError('SIGNER_INTEGRITY_MISMATCH', true);
    }

    return {
      signature: ed25519SignatureFrom(signature),
      keyVersion: this.options.keyVersion,
    };
  }

  async health() {
    try {
      await this.identity();
      return { ok: true, code: null };
    } catch (error: unknown) {
      return { ok: false, code: error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE' };
    }
  }
}

/**
 * Вызов провайдера с приведением ошибок к безопасным кодам.
 *
 * Наружу выходит только код. Сообщение провайдера может содержать
 * имя ресурса, идентификатор проекта и подробности учётной записи —
 * всё то, чего в журнале быть не должно.
 */
async function call(
  transport: KmsTransport,
  operation: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await transport.call(operation, payload);
  } catch (error: unknown) {
    if (error instanceof SignerError) throw error;
    /*
     * Чужая ошибка считается неоднозначной, а не проваленной.
     *
     * Разорванное соединение не отвечает на вопрос, успела ли
     * подпись создаться. Пометить такой случай как «не получилось»
     * и повторить — прямой путь ко второй подписи под тем же
     * намерением.
     */
    throw new SignerError('SIGNER_AMBIGUOUS', false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBytes(value: unknown, code: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string') throw new SignerError(code, false);
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) throw new SignerError(code, false);
  return new Uint8Array(buffer);
}

/**
 * CRC32C (Castagnoli).
 *
 * Google требует именно его, а не обычный CRC32: полиномы разные,
 * и подмена одного другим даёт «контрольная сумма не совпала» на
 * каждом запросе.
 */
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0x82f6_3b78 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** Матрица возможностей для диагностики. Данные — из ядра. */
export const SIGNER_CAPABILITIES = {
  'aws-kms': AWS_KMS_ED25519,
  'gcp-kms': GCP_KMS_ED25519,
} as const;
