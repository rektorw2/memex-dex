import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Chain } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { encryptPrivateKey } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/**
 * Создание и импорт кастодиальных кошельков.
 *
 * Приватный ключ живёт в памяти ровно столько, сколько нужно на вычисление
 * адреса и шифрование, после чего буфер затирается. В базу попадает только
 * шифротекст, зашифрованный DEK, который сам зашифрован мастер-ключом KMS.
 *
 * Solana использует ed25519, EVM — secp256k1: это разные семейства кривых,
 * и один ключ не подходит обеим сетям. Поэтому кошелёк заводится под
 * конкретную сеть, а не «один на всё».
 */

const EVM_CHAINS: Chain[] = ['BNB', 'ETHEREUM', 'BASE', 'ROBINHOOD'];

export function isEvmChain(chain: Chain): boolean {
  return EVM_CHAINS.includes(chain);
}

interface KeyMaterial {
  address: string;
  /** Сырой приватный ключ. Вызывающий обязан затереть после использования. */
  secret: Uint8Array;
}

function generateSolana(): KeyMaterial {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), secret: kp.secretKey };
}

function generateEvm(): KeyMaterial {
  const pk = generatePrivateKey(); // 0x + 64 hex
  const account = privateKeyToAccount(pk);
  return { address: account.address, secret: Buffer.from(pk.slice(2), 'hex') };
}

/**
 * Разбор импортируемого ключа.
 *
 * Форматы намеренно поддержаны те же, что показывают кошельки при экспорте:
 * Phantom отдаёт base58, MetaMask — hex. Требовать от человека конвертации
 * значит гарантированно получать ключи, вставленные не туда.
 */
function parseSolanaKey(input: string): KeyMaterial {
  const raw = input.trim();

  let secret: Uint8Array;
  if (raw.startsWith('[')) {
    // Формат массива байт из solana-keygen
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error('Ожидается массив из 64 байт');
    }
    secret = Uint8Array.from(arr);
  } else {
    const decoded = bs58.decode(raw);
    if (decoded.length !== 64) {
      throw new Error('Приватный ключ Solana должен быть 64 байта в base58');
    }
    secret = decoded;
  }

  const kp = Keypair.fromSecretKey(secret);
  return { address: kp.publicKey.toBase58(), secret };
}

function parseEvmKey(input: string): KeyMaterial {
  const raw = input.trim();
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Приватный ключ EVM должен быть 64 шестнадцатеричных символа');
  }

  const account = privateKeyToAccount(hex as `0x${string}`);
  return { address: account.address, secret: Buffer.from(hex.slice(2), 'hex') };
}

/** Затирание секрета в памяти. Не даёт гарантий на уровне ОС, но убирает
 *  очевидный след из кучи до сборки мусора. */
function wipe(secret: Uint8Array): void {
  secret.fill(0);
}

export interface CreatedWallet {
  id: string;
  chain: Chain;
  address: string;
  createdAt: Date;
}

async function persist(
  userId: string,
  chain: Chain,
  material: KeyMaterial,
): Promise<CreatedWallet> {
  try {
    const existing = await prisma.wallet.findUnique({
      where: { chain_address: { chain, address: material.address } },
    });
    if (existing) {
      throw new Error('Кошелёк с таким адресом уже заведён в системе');
    }

    const enc = await encryptPrivateKey(material.secret);

    const wallet = await prisma.wallet.create({
      data: {
        userId,
        chain,
        kind: 'HOT_TRADING',
        address: material.address,
        // Prisma ожидает Uint8Array; node:crypto отдаёт Buffer, который
        // с ним совместим на рантайме, но не по типам.
        encryptedKey: new Uint8Array(enc.ciphertext),
        keyNonce: new Uint8Array(enc.nonce),
        keyAuthTag: new Uint8Array(enc.authTag),
        wrappedDek: new Uint8Array(enc.wrappedDek),
        kmsKeyId: enc.kmsKeyId,
      },
      select: { id: true, chain: true, address: true, createdAt: true },
    });

    logger.info({ userId, chain, address: material.address }, 'кошелёк заведён');
    return wallet;
  } finally {
    // Секрет затирается при любом исходе, включая ошибку записи в базу.
    wipe(material.secret);
  }
}

export async function createWallet(userId: string, chain: Chain): Promise<CreatedWallet> {
  const material = isEvmChain(chain) ? generateEvm() : generateSolana();
  return persist(userId, chain, material);
}

export async function importWallet(
  userId: string,
  chain: Chain,
  privateKey: string,
): Promise<CreatedWallet> {
  let material: KeyMaterial;
  try {
    material = isEvmChain(chain) ? parseEvmKey(privateKey) : parseSolanaKey(privateKey);
  } catch (e: any) {
    // Текст исключения библиотеки может содержать фрагмент ключа —
    // наружу отдаём только собственное сообщение.
    throw new Error(
      e?.message?.includes('должен') || e?.message?.includes('Ожидается')
        ? e.message
        : 'Не удалось разобрать приватный ключ. Проверьте формат и сеть.',
    );
  }

  return persist(userId, chain, material);
}

/** Кошельки пользователя. Приватные ключи не покидают сервер ни в каком виде. */
export async function listWallets(userId: string) {
  return prisma.wallet.findMany({
    where: { userId, isActive: true },
    select: { id: true, chain: true, address: true, kind: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}
