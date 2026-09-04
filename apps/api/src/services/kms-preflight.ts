import {
  checkBlockhash,
  type BlockhashFacts,
  type SigningIdentityFacts,
} from '@memex/core';
import {
  SignerError,
  verifyEd25519,
  type SolanaMessageSigner,
} from './solana-signer-contract.js';
import { buildIntentMessage } from './transaction-intent-builder.js';
import { SolanaBlockhashProvider, BlockhashError } from './solana-blockhash-provider.js';
import { identityFactsFrom, solanaAddressFromPublicKey } from './signer-factory.js';

/**
 * Проверка контура подписи.
 *
 * По умолчанию не подписывает ничего. Она отвечает на вопросы,
 * ответы на которые нужны до первой подписи: тот ли это ключ, тем
 * ли алгоритмом он умеет, тот ли адрес из него получается и жива ли
 * сеть, из которой возьмётся blockhash.
 *
 * Настоящий вызов `Sign` требует отдельного разрешения. Разделение
 * не формальность: «проверить узел» и «подписать» — разные решения,
 * и объединять их одним флагом значит однажды подписать, собираясь
 * только посмотреть.
 *
 * Даже с разрешением подписывается перевод самому себе на ноль
 * лампортов. Такая транзакция не двигает денег ни при каком исходе,
 * и её подпись доказывает ровно то, что нужно доказать: KMS выдаёт
 * подпись, которую проверяет Ed25519.
 *
 * Отправки нет. Транспорт broadcast сюда не импортируется.
 */

export type PreflightStepName =
  | 'CONFIG'
  | 'PROVIDER_HEALTH'
  | 'KEY_METADATA'
  | 'PUBLIC_KEY'
  | 'SOLANA_ADDRESS'
  | 'EXPECTED_MATCH'
  | 'DEVNET_RPC'
  | 'BLOCKHASH'
  | 'SIGN'
  | 'SIGNATURE_VERIFY';

export type StepOutcome = 'PASS' | 'FAIL' | 'SKIPPED';

export interface PreflightStep {
  name: PreflightStepName;
  outcome: StepOutcome;
  /** Машинный код. Ни имени ресурса, ни адреса узла, ни ключа. */
  code: string | null;
  /** Безопасная деталь: отпечаток, адрес Solana, число. */
  detail: string | null;
  latencyMs: number | null;
}

export interface KmsPreflightReport {
  provider: string;
  network: string;
  /** Итог: без настоящего вызова — не `READY`, а честное состояние. */
  status: 'READY' | 'NOT_CONFIGURED' | 'NOT_RUN' | 'FAILED' | 'IMPLEMENTED_NOT_VALIDATED';
  steps: PreflightStep[];
  identity: SigningIdentityFacts | null;
  /** Выполнялся ли настоящий вызов Sign. */
  signAttempted: boolean;
}

export interface KmsPreflightOptions {
  provider: string;
  network: string;
  signer: SolanaMessageSigner;
  /** Провайдер blockhash. Null — сеть не настроена. */
  blockhash: SolanaBlockhashProvider | null;
  expectedFingerprint: string | null;
  /** Отдельное разрешение на настоящий вызов Sign. */
  allowSign: boolean;
  /**
   * Разрешает ли общий расчёт вызов KMS вообще.
   *
   * Обязательный параметр, а не значение по умолчанию: пропущенный
   * необязательный флаг безопасности рано или поздно окажется
   * пропущенным в том вызове, где он и был нужен.
   *
   * `KMS_PREFLIGHT_ALLOW_SIGN` не заменяет его и не перекрывает.
   * Иначе «разрешаю подписать при проверке» стало бы обходом всех
   * условий сразу: сети, ключа, защёлки и канонического флага.
   */
  signingAllowed: boolean;
  now?: () => number;
}

export async function runKmsPreflight(
  options: KmsPreflightOptions,
): Promise<KmsPreflightReport> {
  const now = options.now ?? (() => Date.now());
  const steps: PreflightStep[] = [];
  const report = (
    status: KmsPreflightReport['status'],
    identity: SigningIdentityFacts | null,
    signAttempted = false,
  ): KmsPreflightReport => ({
    provider: options.provider,
    network: options.network,
    status,
    steps,
    identity,
    signAttempted,
  });

  // ── Конфигурация ────────────────────────────────────────────────
  if (options.provider === 'unavailable' || !options.provider) {
    steps.push(fail('CONFIG', 'SIGNER_NOT_CONFIGURED'));
    return report('NOT_CONFIGURED', null);
  }
  /*
   * Боевая сеть отвергается до любых вызовов.
   *
   * Проверять что-либо в mainnet на этом этапе не нужно, а один
   * лишний запрос туда уже оставляет след.
   */
  if (options.network !== 'devnet') {
    steps.push(fail('CONFIG', 'PREFLIGHT_REQUIRES_DEVNET'));
    return report('FAILED', null);
  }
  steps.push(pass('CONFIG', options.provider, null));

  // ── Провайдер ───────────────────────────────────────────────────
  const healthStart = now();
  const health = await options.signer.health();
  steps.push(health.ok
    ? pass('PROVIDER_HEALTH', 'ok', now() - healthStart)
    : fail('PROVIDER_HEALTH', health.code ?? 'SIGNER_UNAVAILABLE', now() - healthStart));
  if (!health.ok) {
    // Без живого провайдера остальное проверять нечем.
    return report(health.code === 'SIGNER_NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'FAILED', null);
  }

  // ── Ключ и адрес ────────────────────────────────────────────────
  const identityStart = now();
  let facts: SigningIdentityFacts;
  try {
    const identity = await options.signer.identity();
    steps.push(pass('KEY_METADATA', identity.algorithm, now() - identityStart));
    steps.push(pass('PUBLIC_KEY', `${identity.publicKey.length} байт`, null));

    facts = identityFactsFrom({
      publicKey: identity.publicKey,
      keyVersion: identity.version,
      algorithm: identity.algorithm,
    });
    // Адрес — публичное значение и единственный способ для человека
    // сверить ключ глазами.
    steps.push(pass('SOLANA_ADDRESS', facts.solanaAddress, null));
  } catch (error: unknown) {
    const code = error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE';
    steps.push(fail('KEY_METADATA', code, now() - identityStart));
    return report('FAILED', null);
  }

  // ── Ожидаемый ключ ──────────────────────────────────────────────
  if (options.expectedFingerprint) {
    const matches = options.expectedFingerprint === facts.fingerprint;
    steps.push(matches
      ? pass('EXPECTED_MATCH', 'совпадает', null)
      : fail('EXPECTED_MATCH', 'SIGNER_EXPECTED_KEY_MISMATCH'));
    if (!matches) return report('FAILED', facts);
  } else {
    // Пропуск, а не успех: непроверенное ожидание ничего не доказывает.
    steps.push(skipped('EXPECTED_MATCH', 'EXPECTED_KEY_NOT_SET'));
  }

  // ── Сеть и blockhash ────────────────────────────────────────────
  if (!options.blockhash) {
    steps.push(skipped('DEVNET_RPC', 'RPC_NOT_CONFIGURED'));
    steps.push(skipped('BLOCKHASH', 'RPC_NOT_CONFIGURED'));
    steps.push(skipped('SIGN', 'RPC_NOT_CONFIGURED'));
    return report('NOT_RUN', facts);
  }

  const blockhashStart = now();
  let blockhash: BlockhashFacts;
  try {
    blockhash = await options.blockhash.fetch();
    steps.push(pass('DEVNET_RPC', 'devnet', now() - blockhashStart));
    // Само значение наружу не идёт: показывается только его свежесть.
    steps.push(pass('BLOCKHASH', `возраст 0 мс`, null));
  } catch (error: unknown) {
    const code = error instanceof BlockhashError ? error.code : 'BLOCKHASH_UNAVAILABLE';
    steps.push(fail('DEVNET_RPC', code, now() - blockhashStart));
    steps.push(skipped('SIGN', 'BLOCKHASH_UNAVAILABLE'));
    return report('FAILED', facts);
  }

  // ── Подпись ─────────────────────────────────────────────────────
  if (!options.signingAllowed) {
    /*
     * Общий расчёт запретил вызов KMS — и точка.
     *
     * Проверка стоит раньше `allowSign` намеренно: сообщение должно
     * назвать настоящую причину. «Подпись не разрешена настройкой
     * проверки» увело бы оператора чинить не то.
     */
    steps.push(skipped('SIGN', 'SIGNING_NOT_ALLOWED'));
    steps.push(skipped('SIGNATURE_VERIFY', 'SIGNING_NOT_ALLOWED'));
    return report('IMPLEMENTED_NOT_VALIDATED', facts);
  }

  if (!options.allowSign) {
    /*
     * Без отдельного разрешения ничего не подписывается, и итог —
     * не `READY`. Провайдер, у которого ни разу не просили подпись,
     * готовым не является, как бы хорошо ни выглядели метаданные.
     */
    steps.push(skipped('SIGN', 'SIGN_NOT_ALLOWED'));
    steps.push(skipped('SIGNATURE_VERIFY', 'SIGN_NOT_ALLOWED'));
    return report('IMPLEMENTED_NOT_VALIDATED', facts);
  }

  /*
   * Заведомо безденежная фикстура: перевод самому себе на ноль.
   *
   * Такая транзакция не двигает средств ни при каком исходе, а
   * подпись под ней доказывает ровно то, что требуется.
   */
  const built = buildIntentMessage({
    purpose: 'DEVNET_SELF_TRANSFER',
    network: 'devnet',
    ownerAddress: facts.solanaAddress,
    destinationAddress: facts.solanaAddress,
    rawAmount: '0',
    mint: null,
    feeLimitLamports: '5000',
    slippageBps: 0,
    recentBlockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });

  const signStart = now();
  let signature: Uint8Array;
  try {
    const signed = await options.signer.signMessage({
      message: built.message,
      intentId: 'kms-preflight',
      expectedKeyVersion: facts.keyVersion,
    });
    signature = signed.signature;
    steps.push(pass('SIGN', `${signature.length} байт`, now() - signStart));
  } catch (error: unknown) {
    const code = error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE';
    steps.push(fail('SIGN', code, now() - signStart));
    steps.push(skipped('SIGNATURE_VERIFY', 'SIGN_FAILED'));
    return report('FAILED', facts, true);
  }

  // Локальная проверка обязательна: успех провайдера не означает
  // пригодной подписи.
  const identity = await options.signer.identity();
  const verified = verifyEd25519(built.message, signature, identity.publicKey);
  steps.push(verified
    ? pass('SIGNATURE_VERIFY', 'подпись верна', null)
    : fail('SIGNATURE_VERIFY', 'SIGNATURE_INVALID'));

  return report(verified ? 'READY' : 'FAILED', facts, true);
}

function pass(name: PreflightStepName, detail: string, latencyMs: number | null): PreflightStep {
  return { name, outcome: 'PASS', code: null, detail, latencyMs };
}

function fail(name: PreflightStepName, code: string, latencyMs: number | null = null): PreflightStep {
  return { name, outcome: 'FAIL', code, detail: null, latencyMs };
}

function skipped(name: PreflightStepName, code: string): PreflightStep {
  return { name, outcome: 'SKIPPED', code, detail: null, latencyMs: null };
}

export { solanaAddressFromPublicKey, checkBlockhash };
