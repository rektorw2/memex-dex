import {
  allowsKmsCall,
  signingBlockers,
  signingPublicView,
  transactionSigningState,
  type IdentityVerdict,
  type SigningPublicView,
  type TransactionSigningInput,
  type TransactionSigningState,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { readFundingSafetyState } from './prisma-solana-reconciliation-repository.js';
import { expectedFingerprint } from './signer-factory.js';

/**
 * Сборка входа для расчёта состояния подписи. Одна на весь сервис.
 *
 * Раньше готовность собиралась по месту: startup guards смотрели
 * свой набор переменных, воркер свой, интерфейс третий. Наборы
 * разошлись — и появилось состояние, в котором экран говорил
 * «подпись выключена», а воркер был готов вызвать KMS. Расхождение
 * такого рода не косметическое: человек принимает решения по
 * картинке, а деньги двигает код.
 *
 * Поэтому источник один. Читатели получают готовое состояние и
 * не имеют права пересчитывать его по частям.
 *
 * Функция ходит в базу за защёлкой, реестром ключа и неоднозначными
 * попытками. При выключенном контуре она не ходит никуда: выключено
 * — значит выключено, и лишний запрос из выключенной функции это
 * тоже поведение, которого не ждут.
 */

export interface SigningStateSnapshot {
  state: TransactionSigningState;
  publicView: SigningPublicView;
  /** Разрешён ли настоящий вызов `Sign`. */
  allowsKmsCall: boolean;
  blockers: string[];
  /** Безопасные факты для диагностики. Ни ключа, ни узла, ни ARN. */
  facts: {
    signingEnabled: boolean;
    signerProvider: string;
    network: string;
    identityState: string;
    keyFingerprint: string | null;
    solanaAddress: string | null;
    networkVerified: boolean;
    signatureValidated: boolean;
    withdrawalsEnabled: boolean;
    broadcastAvailable: boolean;
  };
}

/**
 * Отправки нет и не появится по флагу.
 *
 * Константа, а не переменная окружения: транспорта broadcast в
 * проекте не существует, и настройка, которой можно было бы
 * «включить отправку», создавала бы ложное впечатление, что за ней
 * что-то стоит.
 */
export const BROADCAST_AVAILABLE = false;

/** Поддерживаемые провайдеры подписи. Список закрытый. */
const SUPPORTED_PROVIDERS = new Set(['aws-kms', 'gcp-kms']);

export async function readSigningState(): Promise<SigningStateSnapshot> {
  const { input, identity } = await collectInput();
  return snapshotOf(input, identity);
}

/**
 * Расчёт без обращения к базе.
 *
 * Нужен startup guards: они выполняются до того, как соединение с
 * базой вообще существует, и обязаны получать то же состояние, что
 * и все остальные.
 */
export function signingStateFromConfig(): SigningStateSnapshot {
  const input: TransactionSigningInput = {
    ...configPart(),
    /*
     * На старте о ключе и защёлке ничего не известно.
     *
     * Подставляется самое строгое допущение: ключ не подтверждён.
     * Оптимистичное «наверное, всё в порядке» здесь означало бы
     * разрешить старт тому, что потом окажется неготовым.
     */
    identity: 'NOT_REGISTERED',
    expectedKeyMatches: null,
    networkVerified: Boolean(env.SOLANA_PREFLIGHT_RPC_URL),
    signatureValidated: false,
    safetyLatchHealthy: true,
    hasAmbiguousAttempt: false,
  };
  return snapshotOf(input, null);
}

/** Безопасные приметы зарегистрированного ключа. Ни ARN, ни самого ключа. */
interface IdentityMarks {
  fingerprint: string;
  solanaAddress: string;
}

/** Часть входа, которая берётся только из конфигурации. */
function configPart() {
  return {
    // Канонический флаг. Устаревший сюда не попадает даже как «или».
    signingEnabled: env.SOLANA_SIGNING_ENABLED,
    signerProvider: env.SOLANA_SIGNER_PROVIDER,
    providerSupported: SUPPORTED_PROVIDERS.has(env.SOLANA_SIGNER_PROVIDER),
    keyConfigured: Boolean(env.SOLANA_SIGNER_KEY_ID && env.SOLANA_SIGNER_KEY_VERSION),
    network: env.SOLANA_NETWORK,
    withdrawalsEnabled: env.WITHDRAWALS_ENABLED,
    broadcastAvailable: BROADCAST_AVAILABLE,
  };
}

async function collectInput(): Promise<{
  input: TransactionSigningInput;
  identity: IdentityMarks | null;
}> {
  const config = configPart();

  /*
   * Выключенный контур в базу не ходит.
   *
   * Три запроса ради ответа «выключено» — это и лишняя нагрузка, и
   * ложный след в журнале запросов от функции, которая ничего не
   * делает.
   */
  if (!config.signingEnabled) {
    return {
      input: {
        ...config,
        identity: 'NOT_REGISTERED',
        expectedKeyMatches: null,
        networkVerified: false,
        signatureValidated: false,
        safetyLatchHealthy: true,
        hasAmbiguousAttempt: false,
      },
      identity: null,
    };
  }

  const [identityRow, safety, ambiguous, validated] = await Promise.all([
    prisma.signingIdentity.findUnique({ where: { id: 'solana-signing-identity' } }),
    readFundingSafetyState(),
    prisma.signingAttempt.count({ where: { outcome: 'AMBIGUOUS' } }),
    prisma.signingAttempt.count({ where: { outcome: 'SUCCEEDED' } }),
  ]);

  return {
    input: {
      ...config,
      identity: identityVerdictOf(identityRow?.state ?? null),
      expectedKeyMatches: expectedMatch(identityRow?.fingerprint ?? null),
      networkVerified: Boolean(env.SOLANA_PREFLIGHT_RPC_URL),
      signatureValidated: validated > 0,
      safetyLatchHealthy: safety === 'HEALTHY' || safety === 'DEGRADED',
      hasAmbiguousAttempt: ambiguous > 0,
    },
    identity: identityRow
      ? { fingerprint: identityRow.fingerprint, solanaAddress: identityRow.solanaAddress }
      : null,
  };
}

/**
 * Состояние строки реестра в вердикт сверки.
 *
 * `PAUSED` в базе означает, что расхождение уже нашли и записали;
 * повторять сверку здесь не нужно — нужно не подписывать.
 */
function identityVerdictOf(state: string | null): IdentityVerdict {
  if (state === 'REGISTERED') return 'OK';
  if (state === 'PAUSED') return 'PAUSED';
  return 'NOT_REGISTERED';
}

/**
 * Совпадает ли ключ с независимым ожиданием из конфигурации.
 *
 * `null` — ожидание не задано. Это не совпадение и не расхождение,
 * и превращать его в «да» значило бы засчитать непроверенное.
 */
function expectedMatch(registeredFingerprint: string | null): boolean | null {
  if (!env.AWS_KMS_EXPECTED_PUBLIC_KEY) return null;
  if (!registeredFingerprint) return null;
  /*
   * Отпечаток считает фабрика — там же, где он вычисляется для
   * живого ключа. Второй расчёт того же значения рядом однажды
   * разойдётся с первым, и сверка начнёт сравнивать несравнимое.
   */
  const expected = expectedFingerprint();
  return expected == null ? null : expected === registeredFingerprint;
}

function snapshotOf(
  input: TransactionSigningInput,
  identity: IdentityMarks | null,
): SigningStateSnapshot {
  const state = transactionSigningState(input);
  return {
    state,
    publicView: signingPublicView(state),
    allowsKmsCall: allowsKmsCall(state),
    blockers: signingBlockers(input),
    facts: {
      signingEnabled: input.signingEnabled,
      signerProvider: input.signerProvider,
      network: input.network,
      identityState: input.identity,
      keyFingerprint: identity?.fingerprint ?? null,
      solanaAddress: identity?.solanaAddress ?? null,
      networkVerified: input.networkVerified,
      signatureValidated: input.signatureValidated,
      withdrawalsEnabled: input.withdrawalsEnabled,
      broadcastAvailable: input.broadcastAvailable,
    },
  };
}
