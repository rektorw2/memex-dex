import crypto from 'node:crypto';
import bs58 from 'bs58';
import type { BlockhashFacts, SigningIdentityFacts } from '@memex/core';
import { env } from '../lib/env.js';
import { AwsKmsSolanaSigner, GcpKmsSolanaSigner } from './kms-ed25519-adapters.js';
import { AwsKmsTransport } from './kms-aws-transport.js';
import { SolanaBlockhashProvider } from './solana-blockhash-provider.js';
import { FetchSolanaRpcClient } from './solana-rpc-deposit-source.js';
import { signingStateFromConfig } from './signing-state.js';
import {
  publicKeyFingerprint,
  UnavailableSolanaSigner,
  type SolanaMessageSigner,
} from './solana-signer-contract.js';

/**
 * Единственное место, где выбирается подписант.
 *
 * Выбор в одном месте, а не по месту вызова: разбросанные условия
 * рано или поздно разойдутся, и один путь начнёт подписывать там,
 * где другой отказывает.
 *
 * По умолчанию возвращается честный отказ. Не заглушка, которая
 * что-то подписывает локальным ключом, — такой контур выглядит
 * защищённым и не является им, а проверить это можно будет только
 * после утечки.
 *
 * Транспорт создаётся лениво самим адаптером: пока провайдер не
 * выбран, SDK не загружается и учётные данные не ищутся.
 */

let cachedTransport: AwsKmsTransport | null = null;
let cachedBlockhash: SolanaBlockhashProvider | null = null;

/**
 * Подписант по текущей конфигурации.
 *
 * Три независимых условия, а не одно: провайдер, разрешение
 * подписывать и наличие ключа. Любое невыполненное даёт отказ.
 */
export function createSolanaSigner(): SolanaMessageSigner {
  /*
   * Общий расчёт, а не собственная проверка флага.
   *
   * Конфигурационный вариант: фабрику зовут и до готовности базы.
   * Он строже полного — неизвестное считается непроверенным, и
   * фабрика скорее откажет, чем выдаст подписанта авансом.
   */
  if (!signingStateFromConfig().facts.signingEnabled) {
    return new UnavailableSolanaSigner('SIGNER_DISABLED');
  }

  switch (env.SOLANA_SIGNER_PROVIDER) {
    case 'aws-kms': {
      if (!env.AWS_REGION) return new UnavailableSolanaSigner('SIGNER_REGION_NOT_CONFIGURED');
      if (!env.SOLANA_SIGNER_KEY_ID) {
        return new UnavailableSolanaSigner('SIGNER_KEY_NOT_CONFIGURED');
      }
      cachedTransport ??= new AwsKmsTransport({
        region: env.AWS_REGION,
        keyId: env.SOLANA_SIGNER_KEY_ID,
      });
      return new AwsKmsSolanaSigner({
        keyId: env.SOLANA_SIGNER_KEY_ID,
        keyVersion: env.SOLANA_SIGNER_KEY_VERSION ?? '1',
        transport: cachedTransport,
      });
    }
    case 'gcp-kms':
      /*
       * Google остаётся без аутентифицированного транспорта.
       *
       * Протокольный слой готов и проверен, но живого вызова не
       * было. Отдавать адаптер без транспорта значит обещать
       * работоспособность, которой не подтверждали.
       */
      return new GcpKmsSolanaSigner({
        keyVersionName: env.SOLANA_SIGNER_KEY_ID ?? '',
        keyVersion: env.SOLANA_SIGNER_KEY_VERSION ?? '1',
        transport: null,
      });
    default:
      return new UnavailableSolanaSigner('SIGNER_NOT_CONFIGURED');
  }
}

/**
 * Источник blockhash по текущей конфигурации.
 *
 * Живёт рядом с выбором подписанта не для удобства: подписант и
 * blockhash должны включаться и выключаться одним решением. Разведи
 * их по разным местам — и появится состояние «подписывать нельзя, но
 * в сеть ходим», в котором выключенная функция всё равно шлёт
 * запросы и оставляет след.
 *
 * `null` означает «сети нет». Вызывающий обязан отказать, а не
 * подставить значение: заглушка на этом месте однажды окажется в
 * подписанной транзакции.
 */
export function createBlockhashSource(): (() => Promise<BlockhashFacts>) | null {
  if (!signingStateFromConfig().facts.signingEnabled) return null;
  if (env.SOLANA_NETWORK !== 'devnet') return null;
  if (!env.SOLANA_PREFLIGHT_RPC_URL) return null;

  cachedBlockhash ??= new SolanaBlockhashProvider(
    new FetchSolanaRpcClient(env.SOLANA_PREFLIGHT_RPC_URL, 10_000),
    { network: env.SOLANA_NETWORK, signingEnabled: env.SOLANA_SIGNING_ENABLED },
  );
  // Метод связывается с объектом: передавать наружу голую ссылку
  // значит однажды получить `this === undefined` и пустой кэш.
  return () => cachedBlockhash!.fetch();
}

/** Провайдер blockhash для диагностики. Наружу значение не отдаёт. */
export function blockhashProvider(): SolanaBlockhashProvider | null {
  return cachedBlockhash;
}

/** Был ли создан транспорт. Нужно тестам на ленивую инициализацию. */
export function transportInstantiated(): boolean {
  return cachedTransport?.instantiated ?? false;
}

/** Сброс между тестами и при смене конфигурации. */
export function resetSignerFactory(): void {
  cachedTransport?.destroy();
  cachedTransport = null;
  cachedBlockhash = null;
}

/**
 * Адрес Solana из публичного ключа.
 *
 * Адрес — это и есть публичный ключ в base58, без хеширования и
 * без префиксов. Отдельная функция существует, чтобы это
 * преобразование было в одном месте и его нельзя было «улучшить»
 * в одном из вызовов.
 */
export function solanaAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('SOLANA_ADDRESS_REQUIRES_32_BYTES');
  return bs58.encode(Buffer.from(publicKey));
}

/**
 * Факты о ключе для регистрации и сверки.
 *
 * Ресурс KMS сюда не входит намеренно: он остаётся на сервере, а в
 * базу, журнал и диагностику идут отпечаток и адрес.
 */
export function identityFactsFrom(input: {
  publicKey: Uint8Array;
  keyVersion: string;
  algorithm: string;
}): SigningIdentityFacts {
  return {
    fingerprint: publicKeyFingerprint(input.publicKey),
    solanaAddress: solanaAddressFromPublicKey(input.publicKey),
    keyVersion: input.keyVersion,
    algorithm: input.algorithm,
  };
}

/**
 * Отпечаток ожидаемого ключа из конфигурации.
 *
 * Оператор задаёт адрес Solana — его проще сверить глазами, чем
 * шестнадцатеричную строку. Отпечаток считается из него, чтобы
 * сравнение шло по одному и тому же значению с обеих сторон.
 */
export function expectedFingerprint(): string | null {
  const address = env.AWS_KMS_EXPECTED_PUBLIC_KEY?.trim();
  if (!address) return null;
  try {
    const decoded = bs58.decode(address);
    if (decoded.length !== 32) return null;
    return publicKeyFingerprint(new Uint8Array(decoded));
  } catch {
    // Непригодное значение — это «не задано», а не «совпадает».
    return null;
  }
}

/** Хеш конфигурации ключа. Нужен, чтобы заметить подмену настройки. */
export function configFingerprint(): string {
  const parts = [
    env.SOLANA_SIGNER_PROVIDER,
    env.SOLANA_SIGNER_KEY_VERSION ?? '',
    env.SOLANA_NETWORK,
  ];
  // Идентификатор ключа в хеш не входит: он не должен покидать
  // сервер даже в виде хеша, по которому его можно подтвердить.
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
