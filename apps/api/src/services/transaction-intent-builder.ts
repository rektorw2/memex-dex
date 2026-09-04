import crypto from 'node:crypto';
import { PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import {
  ALLOWED_INTENT_PURPOSES,
  isAllowedPurpose,
  programAllowed,
  SOLANA_MAX_TRANSACTION_BYTES,
  type IntentFailureCode,
  type IntentMoneyFacts,
  type IntentPurpose,
} from '@memex/core';

/**
 * Сборка сообщения транзакции на сервере.
 *
 * Клиент присылает намерение: что за операция, сколько, кому. Байты
 * транзакции он не присылает никогда. Разница принципиальная —
 * проверить чужую готовую структуру сложнее, чем построить свою, и
 * первый же неучтённый способ её закодировать превращает проверку
 * в формальность.
 *
 * Список операций закрытый и на этом этапе состоит из проверочных
 * переводов самому себе. Универсальной передачи инструкций нет: она
 * бы означала «подпишем что скажут», сколько бы проверок ни стояло
 * вокруг.
 *
 * Версия политики входит в подписываемый набор фактов. Если правила
 * поменялись между одобрением и подписью, человек соглашался на
 * другие условия, и намерение надо собирать заново.
 */

/** Версия правил сборки. Меняется вместе с любым правилом ниже. */
export const POLICY_VERSION = 'phase4d-1';

export interface IntentRequest {
  purpose: string;
  network: string;
  /** Владелец кошелька, он же отправитель. */
  ownerAddress: string;
  /** Получатель. На этом этапе обязан совпадать с отправителем. */
  destinationAddress: string;
  /** Сумма в минимальных единицах, строкой. */
  rawAmount: string;
  mint: string | null;
  feeLimitLamports: string;
  slippageBps: number;
  recentBlockhash: string;
  lastValidBlockHeight: string;
}

export interface BuiltIntentMessage {
  facts: IntentMoneyFacts;
  /** Сериализованное сообщение. Наружу целиком не отдаётся. */
  message: Uint8Array;
  messageHash: string;
  programIds: readonly string[];
}

export class IntentBuildError extends Error {
  constructor(readonly code: IntentFailureCode) {
    super(code);
    this.name = 'IntentBuildError';
  }
}

/** Максимальная комиссия, которую вообще позволено задать. */
export const MAX_FEE_LIMIT_LAMPORTS = 100_000n;
/** Верхняя граница проскальзывания: 5%. */
export const MAX_SLIPPAGE_BPS = 500;

/**
 * Разрешённые сети.
 *
 * Mainnet отсутствует намеренно. На этом этапе подписывать боевую
 * сеть не разрешено, и запрет живёт в списке, а не в условии,
 * которое можно случайно смягчить.
 */
export const ALLOWED_INTENT_NETWORKS: readonly string[] = ['devnet'];

export function buildIntentMessage(request: IntentRequest): BuiltIntentMessage {
  if (!isAllowedPurpose(request.purpose)) throw new IntentBuildError('PURPOSE_NOT_ALLOWED');
  if (!ALLOWED_INTENT_NETWORKS.includes(request.network)) {
    throw new IntentBuildError('NETWORK_NOT_ALLOWED');
  }

  const purpose: IntentPurpose = request.purpose;
  const amount = parseRawAmount(request.rawAmount);
  const feeLimit = parseRawAmount(request.feeLimitLamports);

  if (feeLimit > MAX_FEE_LIMIT_LAMPORTS) throw new IntentBuildError('FEE_LIMIT_EXCEEDED');
  if (
    !Number.isSafeInteger(request.slippageBps) ||
    request.slippageBps < 0 ||
    request.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new IntentBuildError('SLIPPAGE_EXCEEDED');
  }

  /*
   * Получатель обязан совпадать с отправителем.
   *
   * Проверочная транзакция не должна уметь двигать деньги наружу.
   * Пока контур не проверен целиком, единственный безопасный
   * получатель — тот же кошелёк.
   */
  if (request.destinationAddress !== request.ownerAddress) {
    throw new IntentBuildError('PROGRAM_NOT_ALLOWED');
  }

  const owner = parseAddress(request.ownerAddress);
  const destination = parseAddress(request.destinationAddress);

  const instructions = purpose === 'DEVNET_SELF_TRANSFER'
    ? [SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: destination,
        // `lamports` принимает bigint: через number сумма выше
        // 2^53 потеряла бы точность ещё до сборки.
        lamports: amount,
      })]
    : splSelfTransfer();

  /*
   * Каждый program ID сверяется со списком уже после сборки.
   *
   * Проверять до сборки недостаточно: инструкцию строит библиотека,
   * и опечатка в её вызове дала бы обращение к другой программе,
   * пройдя мимо проверки намерения.
   */
  const programIds = instructions.map((instruction) => instruction.programId.toBase58());
  for (const programId of programIds) {
    if (!programAllowed(purpose, programId)) throw new IntentBuildError('PROGRAM_NOT_ALLOWED');
  }

  const compiled = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: request.recentBlockhash,
    instructions,
  }).compileToV0Message();

  const message = compiled.serialize();
  if (message.length > SOLANA_MAX_TRANSACTION_BYTES) {
    throw new IntentBuildError('MESSAGE_TOO_LARGE');
  }

  const messageHash = hashMessage(message);

  return {
    facts: {
      network: request.network,
      purpose,
      mint: request.mint,
      rawAmount: amount.toString(),
      sourceAddress: request.ownerAddress,
      destinationAddress: request.destinationAddress,
      feeLimitLamports: feeLimit.toString(),
      slippageBps: request.slippageBps,
      allowedProgramIds: [...programIds].sort(),
      messageHash,
      policyVersion: POLICY_VERSION,
    },
    message,
    messageHash,
    programIds,
  };
}

/**
 * Хеш сообщения.
 *
 * Хранится вместо самого сообщения: сравнить достаточно, а полная
 * транзакция в базе и в журнале — это содержимое чужих переводов
 * там, где его читают все.
 */
export function hashMessage(message: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(message)).digest('hex');
}

/**
 * Разбор суммы.
 *
 * Только строка из цифр. `number` не принимается вовсе: u64
 * не помещается в число с плавающей точкой, и «почти та же сумма»
 * в деньгах не бывает.
 */
export function parseRawAmount(value: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new IntentBuildError('MONEY_FIELDS_CHANGED');
  }
  const amount = BigInt(value);
  // u64: верхняя граница количества в Solana.
  if (amount > 18_446_744_073_709_551_615n) throw new IntentBuildError('MONEY_FIELDS_CHANGED');
  return amount;
}

function parseAddress(value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new IntentBuildError('PROGRAM_NOT_ALLOWED');
  }
}

/**
 * Перевод SPL самому себе.
 *
 * На этом этапе не собирается: инструкция требует адреса токен-
 * аккаунтов, а их получение — это обращение к сети, которого в
 * сборщике быть не должно. Честный отказ лучше инструкции,
 * собранной по предположению об адресах.
 */
function splSelfTransfer(): never {
  throw new IntentBuildError('PURPOSE_NOT_ALLOWED');
}

export { ALLOWED_INTENT_PURPOSES };
