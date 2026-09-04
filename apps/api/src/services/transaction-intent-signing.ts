import {
  checkSigningPreconditions,
  type IntentFailureCode,
  type IntentMoneyFacts,
  type TransactionIntentState,
} from '@memex/core';
import {
  publicKeyFingerprint,
  SignerError,
  verifyEd25519,
  type SolanaMessageSigner,
} from './solana-signer-contract.js';
import { buildIntentMessage, hashMessage, type IntentRequest } from './transaction-intent-builder.js';

/**
 * Подпись намерения.
 *
 * Порядок шагов важнее каждого шага по отдельности, поэтому он
 * записан здесь целиком и в одном месте.
 *
 * 1. Прочитать намерение и убедиться, что просит его владелец.
 * 2. Пересобрать сообщение на сервере заново — не доверяя тому,
 *    что сохранено. Сохранённое могло быть изменено.
 * 3. Сверить хеш пересобранного с одобренным.
 * 4. Перечитать публичный ключ у KMS и сверить с кошельком.
 * 5. Захватить намерение атомарно. Только после этого — KMS.
 * 6. Проверить подпись локально.
 * 7. Записать результат.
 *
 * Вызов KMS стоит **после** захвата намеренно. Захват после вызова
 * означал бы, что два параллельных запроса успевают сделать по
 * подписи, а разбираться с двумя подписями под одним намерением
 * придётся вручную.
 *
 * Отправки здесь нет. `SIGNED` — конечное состояние: транспорта для
 * broadcast этот модуль не импортирует и импортировать не должен.
 */

export interface IntentRecord {
  id: string;
  userId: string;
  state: TransactionIntentState;
  approved: IntentMoneyFacts;
  request: IntentRequest;
  expiresAt: number;
  lastValidBlockHeight: string;
  approvedKeyVersion: string;
  walletPublicKey: Uint8Array;
}

export interface SigningStore {
  /**
   * Атомарный захват намерения.
   *
   * `APPROVED` → `SIGNING` одним оператором. Два параллельных
   * запроса не могут оба получить `true`.
   */
  claim(intentId: string, claimedBy: string, now: Date): Promise<boolean>;
  recordAttemptStart(intentId: string, claimedBy: string): Promise<string>;
  finishAttempt(
    attemptId: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'AMBIGUOUS',
    code: string | null,
    keyVersion: string | null,
  ): Promise<void>;
  markSigned(intentId: string, signature: string, keyVersion: string, fingerprint: string): Promise<void>;
  markFailed(intentId: string, code: IntentFailureCode | string): Promise<void>;
  /** Есть ли уже удавшаяся попытка. Ответ на повторный запрос. */
  existingSignature(intentId: string): Promise<{ signature: string; keyVersion: string } | null>;
}

export interface SigningEnvironment {
  currentBlockHeight: string;
  safetyLatchHealthy: boolean;
  now: number;
}

export type SigningOutcome =
  | { status: 'signed'; signature: string; keyVersion: string; fingerprint: string }
  | { status: 'already-signed'; signature: string; keyVersion: string }
  | { status: 'refused'; code: IntentFailureCode | string };

export async function signIntent(input: {
  intent: IntentRecord;
  actorId: string;
  signer: SolanaMessageSigner;
  store: SigningStore;
  environment: SigningEnvironment;
  workerId: string;
}): Promise<SigningOutcome> {
  const { intent, store, signer, environment } = input;

  /*
   * Повторный запрос отвечает тем же, а не подписывает заново.
   *
   * Сеть теряет ответы, и клиент повторяет запрос — это норма.
   * Вторая подпись под тем же намерением нормой не является.
   */
  const existing = await store.existingSignature(intent.id);
  if (existing) {
    return { status: 'already-signed', signature: existing.signature, keyVersion: existing.keyVersion };
  }

  /*
   * Сообщение собирается заново.
   *
   * Не берётся из базы: сохранённый хеш доказывает лишь то, что
   * когда-то было собрано именно это. Пересборка отвечает на другой
   * вопрос — совпадает ли одобренное с тем, что сервер построил бы
   * сейчас, по текущим правилам.
   */
  let rebuilt;
  try {
    rebuilt = buildIntentMessage(intent.request);
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'WRONG_STATE';
    await store.markFailed(intent.id, code);
    return { status: 'refused', code };
  }

  // Хеш сверяется отдельно от фактов: строка, собранная по тем же
  // фактам, но другой версией кода, даст другой хеш — и это тоже
  // расхождение.
  if (rebuilt.messageHash !== hashMessage(rebuilt.message)) {
    await store.markFailed(intent.id, 'MESSAGE_HASH_MISMATCH');
    return { status: 'refused', code: 'MESSAGE_HASH_MISMATCH' };
  }

  /*
   * Публичный ключ перечитывается у KMS, а не берётся из базы.
   *
   * Ключ мог быть заменён или ротирован; подпись чужим ключом даст
   * транзакцию с чужого адреса, и заметить это по записи в базе,
   * которая её же и утверждает, невозможно.
   */
  let identity;
  try {
    identity = await signer.identity();
  } catch (error: unknown) {
    const code = error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE';
    await store.markFailed(intent.id, code);
    return { status: 'refused', code };
  }

  const matches = equalBytes(identity.publicKey, intent.walletPublicKey);
  const verdict = checkSigningPreconditions({
    state: intent.state,
    ownerId: intent.userId,
    actorId: input.actorId,
    expiresAt: intent.expiresAt,
    now: environment.now,
    lastValidBlockHeight: intent.lastValidBlockHeight,
    currentBlockHeight: environment.currentBlockHeight,
    approved: intent.approved,
    current: rebuilt.facts,
    approvedKeyVersion: intent.approvedKeyVersion,
    currentKeyVersion: identity.version,
    publicKeyMatchesWallet: matches,
    safetyLatchHealthy: environment.safetyLatchHealthy,
  });

  if (!verdict.allowed) {
    // Отказ до захвата: занимать намерение ради отказа незачем.
    if (verdict.reason !== 'ALREADY_SIGNED') {
      await store.markFailed(intent.id, verdict.reason ?? 'WRONG_STATE');
    }
    return { status: 'refused', code: verdict.reason ?? 'WRONG_STATE' };
  }

  const claimed = await store.claim(intent.id, input.workerId, new Date(environment.now));
  if (!claimed) {
    // Кто-то другой уже взял намерение. Второй подписи не будет.
    return { status: 'refused', code: 'CLAIM_LOST' };
  }

  const attemptId = await store.recordAttemptStart(intent.id, input.workerId);

  let signed;
  try {
    signed = await signer.signMessage({
      message: rebuilt.message,
      intentId: intent.id,
      expectedKeyVersion: identity.version,
    });
  } catch (error: unknown) {
    const code = error instanceof SignerError ? error.code : 'SIGNER_UNAVAILABLE';
    /*
     * Неоднозначный ответ не повторяется автоматически.
     *
     * Разорванное соединение не говорит, создалась подпись или нет.
     * Повтор «на всякий случай» и есть тот случай, когда под одним
     * намерением оказываются две подписи. Строка остаётся открытой
     * для ручного разбора.
     */
    const ambiguous = code === 'SIGNER_AMBIGUOUS' || (error instanceof SignerError && error.retryable);
    await store.finishAttempt(attemptId, ambiguous ? 'AMBIGUOUS' : 'FAILED', code, identity.version);
    await store.markFailed(intent.id, ambiguous ? 'SIGNER_AMBIGUOUS' : code);
    return { status: 'refused', code: ambiguous ? 'SIGNER_AMBIGUOUS' : code };
  }

  /*
   * Локальная проверка обязательна.
   *
   * Провайдер мог подписать другой версией ключа, вернуть чужой
   * ответ или ответить успехом на неудачу. Всё это выясняется либо
   * здесь, за одну проверку, либо в цепочке, где исправлять нечего.
   */
  if (!verifyEd25519(rebuilt.message, signed.signature, identity.publicKey)) {
    await store.finishAttempt(attemptId, 'FAILED', 'SIGNATURE_INVALID', signed.keyVersion);
    await store.markFailed(intent.id, 'SIGNATURE_INVALID');
    return { status: 'refused', code: 'SIGNATURE_INVALID' };
  }

  const signature = Buffer.from(signed.signature).toString('base64');
  const fingerprint = publicKeyFingerprint(identity.publicKey);

  await store.finishAttempt(attemptId, 'SUCCEEDED', null, signed.keyVersion);
  await store.markSigned(intent.id, signature, signed.keyVersion, fingerprint);

  /*
   * Конец. Дальше — ничего.
   *
   * Ни отправки, ни постановки в очередь, ни «подготовки к
   * отправке». Подписанные байты остаются в базе, и что с ними
   * делать, решает следующий этап, которого пока нет.
   */
  return { status: 'signed', signature, keyVersion: signed.keyVersion, fingerprint };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}
