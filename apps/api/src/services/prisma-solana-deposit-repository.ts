import { Prisma as P } from '@prisma/client';
import { depositKey, type AssetRule } from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import * as balances from './balances.js';
import { readFundingSafetyState } from './prisma-solana-reconciliation-repository.js';
import type {
  SolanaDepositRepository,
  SolanaDepositSourceEvent,
  ResolvedSolanaDepositEvent,
  StoredDepositState,
} from './solana-deposit-pipeline.js';

/** Exact base-unit conversion without Number or floating point. */
export function rawAmountToDecimal(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new Error('raw amount must not be negative');
  const digits = raw.toString().padStart(decimals + 1, '0');
  if (decimals === 0) return digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * Persistent Phase 4 adapter. The RPC reader is wired separately, but the
 * worker remains inert while FUNDING_ENABLED=false.
 */
export class PrismaSolanaDepositRepository implements SolanaDepositRepository {
  async acquireCheckpointLease(consumer: string, workerId: string, now: Date, leaseMs: number) {
    const until = new Date(now.getTime() + leaseMs);
    return serializable(async (tx) => {
      await tx.solanaDepositCheckpoint.upsert({
        where: { id: consumer },
        create: { id: consumer, leaseOwner: null, leaseUntil: null },
        update: {},
      });
      const claimed = await tx.solanaDepositCheckpoint.updateMany({
        where: {
          id: consumer,
          OR: [
            { leaseOwner: workerId },
            { leaseOwner: null },
            { leaseUntil: null },
            { leaseUntil: { lt: now } },
          ],
        },
        data: { leaseOwner: workerId, leaseUntil: until, version: { increment: 1 } },
      });
      return claimed.count === 1;
    });
  }

  async checkpoint(consumer: string) {
    const row = await prisma.solanaDepositCheckpoint.findUnique({ where: { id: consumer } });
    return row?.lastProcessedSlot ?? 0n;
  }

  async pendingEventKeys() {
    const rows = await prisma.solanaDepositEvent.findMany({
      where: { state: { in: ['DETECTED', 'AWAITING_CONFIRMATIONS', 'CONFIRMED'] } },
      select: { eventKey: true },
      take: 500,
      orderBy: { slot: 'asc' },
    });
    return rows.map((row) => row.eventKey);
  }

  async resolveDestination(event: SolanaDepositSourceEvent, asset: AssetRule) {
    const wallet = await prisma.wallet.findFirst({
      where: {
        chain: 'SOLANA',
        kind: 'HOT_DEPOSIT',
        address: event.destination,
        isActive: true,
        userId: { not: null },
      },
      select: { id: true, userId: true, address: true },
    });
    if (!wallet?.userId) return null;

    const token = await prisma.token.findFirst({
      where: asset.mint
        ? { chain: 'SOLANA', address: asset.mint, decimals: asset.decimals, isQuote: true }
        : { chain: 'SOLANA', symbol: 'SOL', decimals: asset.decimals, isQuote: true },
      select: { id: true },
    });
    if (!token) return null;
    return {
      walletId: wallet.id,
      userId: wallet.userId,
      tokenId: token.id,
      expectedDestination: wallet.address,
    };
  }

  async observe(
    event: SolanaDepositSourceEvent | ResolvedSolanaDepositEvent,
    state: StoredDepositState,
    rejectCode?: string,
  ) {
    const key = depositKey(event.signature, event.instructionIndex);
    const identity = 'walletId' in event
      ? { walletId: event.walletId, userId: event.userId, tokenId: event.tokenId }
      : {};
    await prisma.solanaDepositEvent.upsert({
      where: { eventKey: key },
      create: {
        eventKey: key,
        signature: event.signature,
        instructionIndex: event.instructionIndex,
        slot: event.slot,
        blockhash: event.blockhash,
        state,
        mint: event.mint,
        destination: event.destination,
        rawAmount: event.rawAmount.toString(),
        confirmations: event.confirmations,
        ...identity,
        rejectCode: rejectCode ?? null,
        finalizedAt: state === 'FINALIZED' ? new Date() : null,
      },
      update: {
        ...(state === 'CREDITED' ? {} : { state }),
        slot: event.slot,
        blockhash: event.blockhash,
        confirmations: event.confirmations,
        ...identity,
        rejectCode: rejectCode ?? null,
        version: { increment: 1 },
      },
    });
  }

  async creditFinalizedAtomically(event: ResolvedSolanaDepositEvent, asset: AssetRule) {
    const key = depositKey(event.signature, event.instructionIndex);
    try {
      return await serializable(async (tx) => {
        const existing = await tx.solanaDepositEvent.findUnique({ where: { eventKey: key } });
        if (existing?.state === 'CREDITED') return 'duplicate' as const;

        const amount = rawAmountToDecimal(event.rawAmount, asset.decimals);
        const observed = existing ?? await tx.solanaDepositEvent.create({
          data: {
            eventKey: key,
            signature: event.signature,
            instructionIndex: event.instructionIndex,
            slot: event.slot,
            blockhash: event.blockhash,
            state: 'FINALIZED',
            mint: event.mint,
            destination: event.destination,
            rawAmount: event.rawAmount.toString(),
            decimals: asset.decimals,
            confirmations: event.confirmations,
            walletId: event.walletId,
            userId: event.userId,
            tokenId: event.tokenId,
            finalizedAt: new Date(),
          },
        });

        const deposit = await tx.deposit.create({
          data: {
            walletId: event.walletId,
            userId: event.userId,
            tokenId: event.tokenId,
            chain: 'SOLANA',
            amount: new P.Decimal(amount),
            // Legacy column is unique by signature. Phase 4 stores the event
            // key so two transfers in one transaction remain distinct.
            txSignature: key,
            confirmations: event.confirmations,
            isCredited: true,
            creditedAt: new Date(),
          },
        });

        await balances.credit(tx, {
          userId: event.userId,
          tokenId: event.tokenId,
          amount,
          type: 'DEPOSIT',
          refType: 'SolanaDepositEvent',
          refId: key,
          memo: `${asset.symbol} finalized deposit`,
        });

        const claimed = await tx.solanaDepositEvent.updateMany({
          where: { id: observed.id, state: { not: 'CREDITED' } },
          data: {
            state: 'CREDITED',
            depositId: deposit.id,
            decimals: asset.decimals,
            creditedAt: new Date(),
            finalizedAt: observed.finalizedAt ?? new Date(),
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) throw new Error('DEPOSIT_EVENT_ALREADY_CLAIMED');
        return 'credited' as const;
      });
    } catch (cause: any) {
      if (cause?.code === 'P2002') return 'duplicate' as const;
      throw cause;
    }
  }

  async markReorg(event: SolanaDepositSourceEvent) {
    const key = depositKey(event.signature, event.instructionIndex);
    return serializable(async (tx) => {
      const existing = await tx.solanaDepositEvent.findUnique({ where: { eventKey: key } });
      if (existing?.state === 'CREDITED') {
        await tx.solanaReconciliationIssue.upsert({
          where: { eventKey_kind: { eventKey: key, kind: 'REORG_AFTER_CREDIT' } },
          create: {
            eventKey: key,
            kind: 'REORG_AFTER_CREDIT',
            expected: { state: 'FINALIZED' },
            actual: { state: 'REORGED', slot: event.slot.toString() },
          },
          update: { actual: { state: 'REORGED', slot: event.slot.toString() }, status: 'OPEN' },
        });
        await tx.solanaDepositEvent.update({
          where: { eventKey: key },
          data: { state: 'REVIEW_REQUIRED', rejectCode: 'REORG_AFTER_CREDIT', reorgedAt: new Date() },
        });
        return 'review-required' as const;
      }

      await tx.solanaDepositEvent.upsert({
        where: { eventKey: key },
        create: {
          eventKey: key,
          signature: event.signature,
          instructionIndex: event.instructionIndex,
          slot: event.slot,
          blockhash: event.blockhash,
          state: 'REORGED',
          mint: event.mint,
          destination: event.destination,
          rawAmount: event.rawAmount.toString(),
          confirmations: event.confirmations,
          rejectCode: 'REORGED',
          reorgedAt: new Date(),
        },
        update: { state: 'REORGED', rejectCode: 'REORGED', reorgedAt: new Date() },
      });
      return 'reorged' as const;
    });
  }

  async advanceCheckpoint(consumer: string, workerId: string, slot: bigint) {
    const changed = await prisma.solanaDepositCheckpoint.updateMany({
      where: { id: consumer, leaseOwner: workerId, lastProcessedSlot: { lt: slot } },
      data: { lastProcessedSlot: slot, version: { increment: 1 } },
    });
    if (changed.count === 0) {
      const current = await prisma.solanaDepositCheckpoint.findUnique({ where: { id: consumer } });
      if (current?.leaseOwner !== workerId) throw new Error('CHECKPOINT_LEASE_LOST');
    }
  }

  async releaseCheckpointLease(consumer: string, workerId: string) {
    await prisma.solanaDepositCheckpoint.updateMany({
      where: { id: consumer, leaseOwner: workerId },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }

  async reconciliationIssues() {
    return prisma.solanaReconciliationIssue.findMany({
      where: { status: 'OPEN' },
      select: { eventKey: true, kind: true },
    });
  }

  /**
   * Состояние защёлки читается из базы на каждом цикле.
   *
   * Не из памяти процесса: защёлку поднимает другой воркер, возможно
   * в другом процессе, и кэш означал бы, что зачисления продолжаются
   * ещё столько времени, сколько живёт кэш.
   */
  async fundingSafetyState() {
    return readFundingSafetyState();
  }
}
