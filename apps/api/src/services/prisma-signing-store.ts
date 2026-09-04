import { prisma } from '../lib/prisma.js';
import type { SigningStore } from './transaction-intent-signing.js';

/**
 * Хранилище намерений на Postgres.
 *
 * Единственная по-настоящему сложная часть — захват. Всё остальное
 * здесь бухгалтерия, а захват решает, окажется ли под одним
 * намерением одна подпись или две.
 *
 * Приватных ключей тут нет и быть не может: в базу попадают подпись
 * (публичное значение), отпечаток публичного ключа и версия. Сам
 * ключ живёт в KMS и оттуда не выходит.
 */
export class PrismaSigningStore implements SigningStore {
  /**
   * Захват намерения одним оператором.
   *
   * `UPDATE ... WHERE state = 'APPROVED'` — состояние входит в
   * условие, а не проверяется отдельным запросом. Между `SELECT`
   * и `UPDATE` в двух запросах помещается второй процесс, и оба
   * уходят подписывать.
   *
   * Возвращается число изменённых строк: единица досталась одному.
   */
  async claim(intentId: string, claimedBy: string, now: Date): Promise<boolean> {
    const claimed = await prisma.transactionIntent.updateMany({
      where: { id: intentId, state: 'APPROVED' },
      data: { state: 'SIGNING', signingClaimedBy: claimedBy, signingClaimedAt: now },
    });
    return claimed.count === 1;
  }

  async recordAttemptStart(intentId: string, claimedBy: string): Promise<string> {
    const attempt = await prisma.signingAttempt.create({
      data: { intentId, outcome: 'CLAIMED', claimedBy },
      select: { id: true },
    });
    return attempt.id;
  }

  async finishAttempt(
    attemptId: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'AMBIGUOUS',
    code: string | null,
    keyVersion: string | null,
  ): Promise<void> {
    await prisma.signingAttempt.update({
      where: { id: attemptId },
      // `code` — безопасный машинный код. Ни ответа провайдера,
      // ни сообщения, ни имени ресурса ключа.
      data: { outcome, code, keyVersion, endedAt: new Date() },
    });
  }

  async markSigned(
    intentId: string,
    signature: string,
    keyVersion: string,
    fingerprint: string,
  ): Promise<void> {
    /*
     * Переход только из `SIGNING`.
     *
     * Состояние снова в условии: намерение, у которого захват
     * потерян или отозван, не должно получить подпись задним числом.
     */
    const updated = await prisma.transactionIntent.updateMany({
      where: { id: intentId, state: 'SIGNING' },
      data: {
        state: 'SIGNED',
        signature,
        keyVersion,
        keyFingerprint: fingerprint,
        signedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new Error('INTENT_CLAIM_LOST');

    await prisma.auditLog.create({
      data: {
        action: 'TRANSACTION_INTENT_SIGNED',
        entity: 'TransactionIntent',
        entityId: intentId,
        /*
         * В журнал идут отпечаток и версия, а не подпись и не
         * сообщение. Подпись публична, но полная транзакция в
         * журнале — это содержимое чужого перевода там, где его
         * читают все.
         */
        after: { keyFingerprint: fingerprint, keyVersion, submitted: false } as never,
      },
    });
  }

  async markFailed(intentId: string, code: string): Promise<void> {
    /*
     * Провалить можно только незакрытое намерение.
     *
     * Подписанное намерение не превращается в проваленное поздним
     * ответом: подпись уже существует, и её отрицание в базе
     * означало бы, что мы про неё забыли.
     */
    await prisma.transactionIntent.updateMany({
      where: { id: intentId, state: { in: ['DRAFT', 'VALIDATED', 'APPROVED', 'SIGNING'] } },
      data: { state: 'FAILED', failureCode: code },
    });

    await prisma.auditLog.create({
      data: {
        action: 'TRANSACTION_INTENT_FAILED',
        entity: 'TransactionIntent',
        entityId: intentId,
        after: { failureCode: code } as never,
      },
    });
  }

  async existingSignature(
    intentId: string,
  ): Promise<{ signature: string; keyVersion: string } | null> {
    const intent = await prisma.transactionIntent.findUnique({
      where: { id: intentId },
      select: { state: true, signature: true, keyVersion: true },
    });
    if (intent?.state !== 'SIGNED' || !intent.signature || !intent.keyVersion) return null;
    return { signature: intent.signature, keyVersion: intent.keyVersion };
  }
}
