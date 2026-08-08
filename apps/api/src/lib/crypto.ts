import crypto from 'node:crypto';
import { env } from './env.js';

/**
 * Envelope encryption для приватных ключей кастодиальных кошельков.
 *
 * Схема:
 *   приватный ключ --AES-256-GCM(DEK)--> ciphertext
 *   DEK           --KMS master key---->  wrappedDek
 *
 * В БД лежат ciphertext + wrappedDek + nonce + authTag. Дамп базы без доступа
 * к KMS бесполезен. Каждый кошелёк получает свой DEK — компрометация одного
 * не раскрывает остальные.
 *
 * local-провайдер существует только для локальной разработки.
 */

export interface EncryptedKey {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  kmsKeyId: string;
}

interface KmsProvider {
  readonly keyId: string;
  wrapDek(dek: Buffer): Promise<Buffer>;
  unwrapDek(wrapped: Buffer): Promise<Buffer>;
}

class LocalKms implements KmsProvider {
  readonly keyId = 'local-dev';
  private master: Buffer;

  constructor(masterKeyB64?: string) {
    if (!masterKeyB64) {
      throw new Error('KMS_LOCAL_MASTER_KEY не задан. Сгенерируйте: openssl rand -base64 32');
    }
    this.master = Buffer.from(masterKeyB64, 'base64');
    if (this.master.length !== 32) throw new Error('KMS_LOCAL_MASTER_KEY должен быть 32 байта');
  }

  async wrapDek(dek: Buffer): Promise<Buffer> {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.master, nonce);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
  }

  async unwrapDek(wrapped: Buffer): Promise<Buffer> {
    const nonce = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.master, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/**
 * Заготовка под AWS KMS. Реализация: GenerateDataKey / Decrypt.
 * Мастер-ключ никогда не покидает HSM.
 */
class AwsKms implements KmsProvider {
  constructor(readonly keyId: string) {}
  async wrapDek(_dek: Buffer): Promise<Buffer> {
    throw new Error('AwsKms: подключите @aws-sdk/client-kms и реализуйте GenerateDataKey');
  }
  async unwrapDek(_wrapped: Buffer): Promise<Buffer> {
    throw new Error('AwsKms: подключите @aws-sdk/client-kms и реализуйте Decrypt');
  }
}

function getKms(): KmsProvider {
  switch (env.KMS_PROVIDER) {
    case 'aws-kms':
      return new AwsKms(env.AWS_KMS_KEY_ID ?? '');
    case 'gcp-kms':
      throw new Error('GCP KMS провайдер не реализован');
    default:
      return new LocalKms(env.KMS_LOCAL_MASTER_KEY);
  }
}

const kms = getKms();

export async function encryptPrivateKey(privateKey: Uint8Array): Promise<EncryptedKey> {
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedDek = await kms.wrapDek(dek);
  dek.fill(0); // затираем DEK в памяти

  return { ciphertext, nonce, authTag, wrappedDek, kmsKeyId: kms.keyId };
}

/**
 * Расшифровка выдаёт ключ во временный буфер. Вызывающий код ОБЯЗАН
 * затереть его после подписи — см. withPrivateKey.
 */
async function decryptPrivateKey(e: EncryptedKey): Promise<Buffer> {
  const dek = await kms.unwrapDek(e.wrappedDek);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, e.nonce);
  decipher.setAuthTag(e.authTag);
  const key = Buffer.concat([decipher.update(e.ciphertext), decipher.final()]);
  dek.fill(0);
  return key;
}

/** Единственный разрешённый способ работы с приватным ключом. */
export async function withPrivateKey<T>(
  e: EncryptedKey,
  fn: (key: Buffer) => Promise<T>,
): Promise<T> {
  const key = await decryptPrivateKey(e);
  try {
    return await fn(key);
  } finally {
    key.fill(0);
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
