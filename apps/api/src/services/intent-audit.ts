import { Prisma as P } from '@prisma/client';
import { AUDIT_FORBIDDEN_KEYS, type AuditEntry } from '@memex/core';
import { prisma } from '../lib/prisma.js';

/**
 * Журнал жизненного цикла.
 *
 * Пишется той же транзакцией, что и переход состояния. Не рядом,
 * а внутри: состояние, изменённое без записи в журнал, означает, что
 * однажды никто не сможет сказать, кто и на каком основании его
 * изменил, — а именно этот вопрос и задают после инцидента.
 *
 * Набор полей закрытый. В журнал попадают идентификаторы, переход,
 * версии и безопасный код причины. Всё остальное — суммы, адреса,
 * сообщение, подпись, заголовки, учётные данные — не попадает
 * никогда: журнал живёт дольше инцидента и читается шире, чем база.
 */

/** Ключи, присутствие которых в записи считается ошибкой. */
const FORBIDDEN = new Set<string>(AUDIT_FORBIDDEN_KEYS);

export class AuditContractError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`AUDIT_FORBIDDEN_KEYS:${keys.join(',')}`);
    this.name = 'AuditContractError';
  }
}

/**
 * Запись события.
 *
 * Проверка на запрещённые ключи выполняется здесь, а не на код-ревью:
 * поле `headers`, добавленное однажды для отладки, переживёт и
 * отладку, и того, кто его добавил.
 */
export async function recordAudit(
  tx: P.TransactionClient | typeof prisma,
  entry: AuditEntry,
): Promise<void> {
  const payload = safePayload(entry);

  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.intentId ? 'TransactionIntent' : 'LiveAgentProposal',
      entityId: entry.intentId ?? entry.proposalId,
      after: payload as never,
    },
  });
}

/**
 * Полезная нагрузка записи.
 *
 * Собирается поимённо из известных полей, а не копированием входа.
 * Копирование пропустило бы любое новое поле, включая то, которое
 * добавят «на минутку» вместе с сырым ответом провайдера.
 */
export function safePayload(entry: AuditEntry): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    userId: entry.userId,
    proposalId: entry.proposalId,
    intentId: entry.intentId,
    network: entry.network,
    purpose: entry.purpose,
    fromState: entry.fromState,
    toState: entry.toState,
    policyVersion: entry.policyVersion,
    keyFingerprint: entry.keyFingerprint,
    keyVersion: entry.keyVersion,
    reasonCode: entry.reasonCode,
  };

  const leaked = Object.keys(payload).filter((key) => FORBIDDEN.has(key));
  if (leaked.length > 0) throw new AuditContractError(leaked);
  return payload;
}
