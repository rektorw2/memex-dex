import type { Prisma, LedgerType } from '@prisma/client';
import { Prisma as P } from '@prisma/client';
import { serializable } from '../lib/prisma.js';

/**
 * Все движения средств проходят только через эти функции.
 * Правило: Balance — это кэш, LedgerEntry — источник истины.
 * Расхождение между ними ловится ночной сверкой (reconcile).
 */

export async function credit(
  tx: Prisma.TransactionClient,
  params: { userId: string; tokenId: string; amount: P.Decimal | string; type: LedgerType; refType?: string; refId?: string; memo?: string },
) {
  const amount = new P.Decimal(params.amount);
  if (amount.lte(0)) throw new Error('credit: сумма должна быть > 0');

  await tx.balance.upsert({
    where: { userId_tokenId: { userId: params.userId, tokenId: params.tokenId } },
    create: { userId: params.userId, tokenId: params.tokenId, available: amount },
    update: { available: { increment: amount }, version: { increment: 1 } },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: params.userId,
      tokenId: params.tokenId,
      type: params.type,
      amount,
      refType: params.refType ?? null,
      refId: params.refId ?? null,
      memo: params.memo ?? null,
    },
  });
}

export async function debit(
  tx: Prisma.TransactionClient,
  params: { userId: string; tokenId: string; amount: P.Decimal | string; type: LedgerType; fromLocked?: boolean; refType?: string; refId?: string; memo?: string },
) {
  const amount = new P.Decimal(params.amount);
  if (amount.lte(0)) throw new Error('debit: сумма должна быть > 0');

  const bal = await tx.balance.findUnique({
    where: { userId_tokenId: { userId: params.userId, tokenId: params.tokenId } },
  });
  if (!bal) throw new Error('Баланс не найден');

  const source = params.fromLocked ? bal.locked : bal.available;
  if (source.lt(amount)) {
    throw new Error(
      `Недостаточно средств: доступно ${source.toString()}, требуется ${amount.toString()}`,
    );
  }

  await tx.balance.update({
    where: { userId_tokenId: { userId: params.userId, tokenId: params.tokenId } },
    data: params.fromLocked
      ? { locked: { decrement: amount }, version: { increment: 1 } }
      : { available: { decrement: amount }, version: { increment: 1 } },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: params.userId,
      tokenId: params.tokenId,
      type: params.type,
      amount: amount.negated(),
      refType: params.refType ?? null,
      refId: params.refId ?? null,
      memo: params.memo ?? null,
    },
  });
}

/** Резерв под лимитный ордер: available -> locked. */
export async function lock(
  tx: Prisma.TransactionClient,
  params: { userId: string; tokenId: string; amount: P.Decimal | string; refId: string },
) {
  const amount = new P.Decimal(params.amount);
  const bal = await tx.balance.findUnique({
    where: { userId_tokenId: { userId: params.userId, tokenId: params.tokenId } },
  });
  if (!bal || bal.available.lt(amount)) {
    throw new Error('Недостаточно свободных средств для резерва под ордер');
  }

  await tx.balance.update({
    where: { userId_tokenId: { userId: params.userId, tokenId: params.tokenId } },
    data: {
      available: { decrement: amount },
      locked: { increment: amount },
      version: { increment: 1 },
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: params.userId,
      tokenId: params.tokenId,
      type: 'LOCK',
      amount: new P.Decimal(0),
      refType: 'Order',
      refId: params.refId,
      memo: `Резерв ${amount.toString()} под ордер`,
    },
  });
}

/** Снятие резерва при отмене/истечении ордера. */
export async function unlock(
  tx: Prisma.TransactionClient,
  params: { userId: string; tokenId: string; amount: P.Decimal | string; refId: string },
) {
  const amount = new P.Decimal(params.amount);
  if (amount.lte(0)) return;

  await tx.balance.update({
    where: { userId_tokenId: { userId: params.userId, tokenId: params.tokenId } },
    data: {
      available: { increment: amount },
      locked: { decrement: amount },
      version: { increment: 1 },
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: params.userId,
      tokenId: params.tokenId,
      type: 'UNLOCK',
      amount: new P.Decimal(0),
      refType: 'Order',
      refId: params.refId,
      memo: `Снят резерв ${amount.toString()}`,
    },
  });
}

/** Сверка: сумма ledger должна совпадать с балансом. Запускать по расписанию. */
export async function reconcileUser(userId: string) {
  return serializable(async (tx) => {
    const balances = await tx.balance.findMany({ where: { userId } });
    const discrepancies: Array<{ tokenId: string; balance: string; ledger: string }> = [];

    for (const b of balances) {
      const agg = await tx.ledgerEntry.aggregate({
        where: { userId, tokenId: b.tokenId },
        _sum: { amount: true },
      });
      const ledgerSum = agg._sum.amount ?? new P.Decimal(0);
      const total = b.available.plus(b.locked);
      if (!total.equals(ledgerSum)) {
        discrepancies.push({
          tokenId: b.tokenId,
          balance: total.toString(),
          ledger: ledgerSum.toString(),
        });
      }
    }
    return discrepancies;
  });
}
