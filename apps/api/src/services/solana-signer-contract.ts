import crypto from 'node:crypto';
import { SOLANA_MAX_TRANSACTION_BYTES } from '@memex/core';

/**
 * Подпись сообщения Solana управляемым ключом.
 *
 * Контракт намеренно узкий — четыре операции и ни одной лишней:
 * узнать публичный ключ, узнать идентификатор и версию, подписать
 * собранное сервером сообщение, проверить доступность.
 *
 * Чего здесь нет и не должно появиться:
 *
 * — возврата приватного ключа. Ключ, который можно прочитать,
 *   рано или поздно прочитают и скопируют;
 * — приёма приватного ключа. Хранилище, которому ключ передают
 *   снаружи, хранилищем не является;
 * — метода «подписать произвольные байты». Такой метод превращает
 *   весь контур проверок в украшение: достаточно вызвать его в обход;
 * — записи сообщения целиком в журнал. Полная транзакция в логах
 *   означает, что содержимое чужих переводов лежит там, где его
 *   читают все.
 *
 * Отдельный интерфейс, а не расширение существующего `ProductionKms`:
 * тот работает с ключами шифрования и умеет `signDigest`. Ed25519 в
 * чистом виде подписывает **сообщение**, а не его хеш, и подставить
 * одно вместо другого — значит получить подпись, которую Solana
 * отвергнет, потратив вызов KMS.
 */

export type SignerProvider = 'aws-kms' | 'gcp-kms' | 'unavailable';

export interface SignerKeyIdentity {
  provider: SignerProvider;
  /**
   * Идентификатор ключа.
   *
   * Наружу за пределы сервера не выходит: полное имя ресурса
   * рассказывает о внутреннем устройстве облака больше, чем нужно
   * кому бы то ни было.
   */
  keyId: string;
  version: string;
  algorithm: string;
  /** Публичный ключ Ed25519, ровно 32 байта. */
  publicKey: Uint8Array;
}

export interface SignRequest {
  /**
   * Сообщение, собранное сервером.
   *
   * Именно сообщение транзакции, а не подписанная транзакция и не
   * её хеш: Ed25519 в чистом виде подписывает исходные байты.
   */
  message: Uint8Array;
  /** Идентификатор намерения. Нужен журналу, не подписи. */
  intentId: string;
  /** Версия ключа, на которую рассчитывал вызывающий. */
  expectedKeyVersion: string;
}

export interface SignResult {
  signature: Uint8Array;
  keyVersion: string;
}

export class SignerError extends Error {
  constructor(
    readonly code: string,
    /**
     * Можно ли повторить.
     *
     * Для подписи это не про удобство: неоднозначный ответ повторять
     * нельзя, потому что первая попытка могла удаться, и вторая
     * подпись под тем же намерением — уже вторая транзакция.
     */
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'SignerError';
  }
}

export interface SolanaMessageSigner {
  identity(): Promise<SignerKeyIdentity>;
  signMessage(request: SignRequest): Promise<SignResult>;
  health(): Promise<{ ok: boolean; code: string | null }>;
}

/**
 * Честная заглушка.
 *
 * Возвращает «не настроен», а не имитирует подпись. Локальный ключ
 * вместо KMS дал бы контур, который выглядит защищённым и не
 * является таковым: проверить это было бы можно только после утечки.
 */
export class UnavailableSolanaSigner implements SolanaMessageSigner {
  constructor(private readonly code: string = 'SIGNER_NOT_CONFIGURED') {}

  async identity(): Promise<SignerKeyIdentity> {
    throw new SignerError(this.code, false);
  }

  async signMessage(_request: SignRequest): Promise<SignResult> {
    throw new SignerError(this.code, false);
  }

  async health() {
    return { ok: false, code: this.code };
  }
}

// ─────────────────────────── Разбор форматов ─────────────────────────────────

/**
 * Публичный ключ Ed25519 из DER SubjectPublicKeyInfo.
 *
 * AWS отдаёт DER, Google — тот же DER внутри PEM. Структура
 * фиксированная: 12 байт заголовка с идентификатором алгоритма
 * 1.3.101.112 и 32 байта ключа.
 *
 * Разбирается строго. Ключ, вынутый «примерно оттуда», станет чужим
 * адресом кошелька, и обнаружится это на первом переводе.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyFromDer(der: Uint8Array): Uint8Array {
  const buffer = Buffer.from(der);
  if (buffer.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new SignerError('SIGNER_PUBLIC_KEY_MALFORMED', false);
  }
  if (!buffer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    // Другой префикс — другой алгоритм. Молча взять хвост значило бы
    // принять ключ ECDSA за ключ Ed25519.
    throw new SignerError('SIGNER_PUBLIC_KEY_NOT_ED25519', false);
  }
  return new Uint8Array(buffer.subarray(ED25519_SPKI_PREFIX.length));
}

export function ed25519PublicKeyFromPem(pem: string): Uint8Array {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(pem);
  if (!match) throw new SignerError('SIGNER_PUBLIC_KEY_MALFORMED', false);
  return ed25519PublicKeyFromDer(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64'));
}

/**
 * Подпись из ответа провайдера.
 *
 * Ожидаются сырые 64 байта. Ни AWS, ни Google не описывают кодировку
 * подписи EdDSA в документации, поэтому длина проверяется явно:
 * подпись другой длины — повод остановиться, а не додумать формат.
 */
export function ed25519SignatureFrom(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new SignerError('SIGNER_SIGNATURE_MALFORMED', false);
  return new Uint8Array(raw);
}

/**
 * Локальная проверка подписи.
 *
 * Обязательна. Провайдер мог подписать другой ключевой версией,
 * вернуть чужой ответ или ответить успехом на неудачу — и всё это
 * выяснится либо здесь, за один вызов, либо в цепочке, где
 * исправлять уже нечего.
 */
export function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    // Непригодный ключ — это «не проверено», а не «проверено успешно».
    return false;
  }
}

/** Короткий отпечаток ключа для журнала и диагностики. */
export function publicKeyFingerprint(publicKey: Uint8Array): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKey)).digest('hex');
  return digest.slice(0, 16);
}

/**
 * Годится ли сообщение для подписи.
 *
 * Проверка размера стоит до вызова KMS: провайдер откажет и сам, но
 * его отказ будет стоить вызова и придёт кодом, по которому не видно
 * причины.
 */
export function assertSignableMessage(message: Uint8Array): void {
  if (message.length === 0) throw new SignerError('SIGNER_MESSAGE_EMPTY', false);
  if (message.length > SOLANA_MAX_TRANSACTION_BYTES) {
    throw new SignerError('SIGNER_MESSAGE_TOO_LARGE', false);
  }
}
