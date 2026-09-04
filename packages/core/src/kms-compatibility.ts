/**
 * Совместимость управляемых хранилищ ключей с подписью Solana.
 *
 * Solana проверяет подписи по Ed25519 в чистом виде (PureEdDSA,
 * RFC 8032): подписывается само сообщение, а не его хеш. Это не
 * деталь, а граница возможного. Провайдер, умеющий только ECDSA или
 * только HashEdDSA, не может подписать транзакцию Solana — и никакой
 * слой поверх этого не исправит.
 *
 * Отсюда правило: адаптер провайдера не пишется, пока по первичной
 * документации не подтверждено, что провайдер подписывает нужным
 * алгоритмом нужный вход. «Скорее всего умеет» здесь означает
 * «однажды подпишет не то».
 *
 * Все значения ниже взяты из официальной документации вендоров
 * (ссылки в `sources`), а не из памяти и не из статей. То, чего
 * в документации нет, помечено `NOT_VERIFIED` — и обрабатывается
 * защитно, а не додумывается.
 */

export type KmsCompatibilityVerdict =
  /** Подтверждено официально: подписывает Solana-сообщение нативно. */
  | 'SUPPORTED'
  /** Подтверждено официально: не умеет нужный алгоритм. */
  | 'UNSUPPORTED'
  /** Умеет хранить ключ, но подписывать Solana обязан кто-то другой. */
  | 'REQUIRES_EXTERNAL_SIGNER'
  /** В официальной документации не нашлось. Считается неподтверждённым. */
  | 'NOT_VERIFIED';

export interface KmsCapability {
  provider: 'aws-kms' | 'gcp-kms' | 'local';
  /** Название алгоритма так, как его называет вендор. */
  algorithm: string | null;
  /** Подписывается сырое сообщение (PureEdDSA) или предварительно хешированное. */
  inputMode: 'RAW_MESSAGE' | 'PREHASHED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  /** Предел размера подписываемого сообщения в байтах. null — не задокументирован. */
  maxMessageBytes: number | null;
  /** Формат публичного ключа в ответе провайдера. */
  publicKeyFormat: 'DER_SPKI' | 'PEM_SPKI' | 'UNKNOWN';
  /** Формат подписи. Для Ed25519 ожидаются сырые 64 байта. */
  signatureFormat: 'RAW_64' | 'DER' | 'UNKNOWN';
  /** Может ли приватный ключ покинуть хранилище. */
  privateKeyExportable: boolean;
  /** Автоматическая ротация для асимметричных ключей подписи. */
  automaticRotation: boolean;
  verdict: KmsCompatibilityVerdict;
  /** Что именно осталось неподтверждённым. Пусто — всё подтверждено. */
  unverified: readonly string[];
  sources: readonly string[];
}

/**
 * AWS KMS.
 *
 * Ключ `ECC_NIST_EDWARDS25519` с алгоритмом `ED25519_SHA_512`
 * требует `MessageType: RAW` — это и есть PureEdDSA над самим
 * сообщением, то, что нужно Solana.
 *
 * Второй алгоритм того же ключа, `ED25519_PH_SHA_512`, требует
 * `MessageType: DIGEST` и выполняет HashEdDSA. Он несовместим:
 * подпись получится валидной по FIPS 186-5, но Solana её отвергнет,
 * потому что проверяет совсем другое. Различить их обязан код, а не
 * дежурный по памяти.
 */
export const AWS_KMS_ED25519: KmsCapability = {
  provider: 'aws-kms',
  algorithm: 'ED25519_SHA_512',
  inputMode: 'RAW_MESSAGE',
  // «Messages can be 0-4096 bytes» — Sign API. Транзакция Solana
  // ограничена 1232 байтами, то есть помещается с запасом.
  maxMessageBytes: 4096,
  publicKeyFormat: 'DER_SPKI',
  // Документация Sign описывает кодировку для RSA и ECDSA, но про
  // EdDSA молчит. Ожидаются сырые 64 байта, однако это ожидание,
  // а не цитата, — поэтому обрабатывается защитно.
  signatureFormat: 'UNKNOWN',
  privateKeyExportable: false,
  // Асимметричные ключи AWS KMS не поддерживают автоматическую
  // ротацию: новая версия — это новый ключ и новый адрес кошелька.
  automaticRotation: false,
  verdict: 'SUPPORTED',
  unverified: [
    'Кодировка подписи EdDSA в ответе Sign не описана в документации',
  ],
  sources: [
    'https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html',
    'https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html',
  ],
};

/**
 * Google Cloud KMS.
 *
 * `EC_SIGN_ED25519` описан как «EdDSA on the Curve25519 in PureEdDSA
 * mode, which takes raw data as input instead of hashed data» со
 * ссылкой на RFC 8032 §4. Подписываемое передаётся полем `data`;
 * поле `digest` для этого алгоритма неприменимо.
 */
export const GCP_KMS_ED25519: KmsCapability = {
  provider: 'gcp-kms',
  algorithm: 'EC_SIGN_ED25519',
  inputMode: 'RAW_MESSAGE',
  // Предел размера `data` в документации asymmetricSign не указан.
  maxMessageBytes: null,
  publicKeyFormat: 'PEM_SPKI',
  signatureFormat: 'UNKNOWN',
  privateKeyExportable: false,
  // Ротация у Cloud KMS есть, но для асимметричных ключей новая
  // версия означает новый публичный ключ — то есть другой кошелёк.
  automaticRotation: false,
  verdict: 'SUPPORTED',
  unverified: [
    'Предел размера поля data в asymmetricSign не задокументирован',
    'Кодировка подписи Ed25519 в ответе не описана',
  ],
  sources: [
    'https://cloud.google.com/kms/docs/algorithms',
    'https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys.cryptoKeyVersions/asymmetricSign',
  ],
};

/**
 * Локальный ключ.
 *
 * Технически подписать умеет. Хранилищем ключей не является:
 * ключ лежит рядом с процессом, и любой, кто получил доступ к
 * машине, получил доступ к деньгам. Выдавать его за KMS —
 * единственный способ построить контур, который выглядит
 * защищённым и не является таковым.
 */
export const LOCAL_SIGNER: KmsCapability = {
  provider: 'local',
  algorithm: 'ed25519',
  inputMode: 'RAW_MESSAGE',
  maxMessageBytes: null,
  publicKeyFormat: 'UNKNOWN',
  signatureFormat: 'RAW_64',
  privateKeyExportable: true,
  automaticRotation: false,
  verdict: 'REQUIRES_EXTERNAL_SIGNER',
  unverified: [],
  sources: [],
};

export const KMS_COMPATIBILITY: readonly KmsCapability[] = [
  AWS_KMS_ED25519,
  GCP_KMS_ED25519,
  LOCAL_SIGNER,
];

export function kmsCapability(provider: string): KmsCapability | null {
  return KMS_COMPATIBILITY.find((entry) => entry.provider === provider) ?? null;
}

/**
 * Максимальный размер сообщения Solana.
 *
 * Пакет транзакции ограничен размером IPv6 MTU за вычетом заголовков.
 * Сообщение всегда меньше пакета, поэтому предел годится как верхняя
 * граница: всё, что больше, транзакцией Solana быть не может.
 */
export const SOLANA_MAX_TRANSACTION_BYTES = 1232;

export interface SignerReadiness {
  provider: string;
  /** Заданы ли идентификатор ключа и версия. */
  keyConfigured: boolean;
  /** Совпадает ли публичный ключ KMS с адресом зарегистрированного кошелька. */
  publicKeyMatchesWallet: boolean;
  network: string;
}

export type SignerBlocker =
  | 'PROVIDER_UNKNOWN'
  | 'ALGORITHM_NOT_ED25519'
  | 'PROVIDER_NOT_VERIFIED'
  | 'REQUIRES_EXTERNAL_SIGNER'
  | 'KEY_NOT_CONFIGURED'
  | 'PUBLIC_KEY_MISMATCH'
  | 'MAINNET_NOT_ALLOWED';

/**
 * Что мешает подписывать.
 *
 * Возвращается список, а не первая причина: оператор, чинящий их по
 * одной, узнаёт о следующей только после перезапуска, и так по кругу.
 */
export function signerBlockers(input: SignerReadiness): SignerBlocker[] {
  const blockers: SignerBlocker[] = [];
  const capability = kmsCapability(input.provider);

  if (!capability) {
    blockers.push('PROVIDER_UNKNOWN');
  } else {
    if (capability.verdict === 'REQUIRES_EXTERNAL_SIGNER') {
      blockers.push('REQUIRES_EXTERNAL_SIGNER');
    }
    if (capability.verdict === 'UNSUPPORTED' || capability.inputMode !== 'RAW_MESSAGE') {
      blockers.push('ALGORITHM_NOT_ED25519');
    }
    if (capability.verdict === 'NOT_VERIFIED') blockers.push('PROVIDER_NOT_VERIFIED');
  }

  if (!input.keyConfigured) blockers.push('KEY_NOT_CONFIGURED');
  if (!input.publicKeyMatchesWallet) blockers.push('PUBLIC_KEY_MISMATCH');
  /*
   * Mainnet на этом этапе запрещён отдельной строкой, а не общим
   * флагом готовности: путать «контур не готов» и «мы сознательно
   * не идём в боевую сеть» нельзя, это разные решения.
   */
  if (input.network === 'mainnet-beta') blockers.push('MAINNET_NOT_ALLOWED');

  return blockers;
}

export function canSign(input: SignerReadiness): boolean {
  return signerBlockers(input).length === 0;
}
