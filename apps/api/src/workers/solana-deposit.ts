import { randomUUID } from 'node:crypto';
import type { FundingSafetyState } from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { PrismaSolanaDepositAddressBook } from '../services/prisma-solana-deposit-address-book.js';
import { PrismaSolanaDepositRepository } from '../services/prisma-solana-deposit-repository.js';
import {
  FetchSolanaRpcClient,
  SolanaRpcDepositEventSource,
  SolanaRpcRequestError,
} from '../services/solana-rpc-deposit-source.js';
import { processSolanaDepositCycle } from '../services/solana-deposit-pipeline.js';

export interface SolanaDepositRuntimeStatus {
  running: boolean;
  source: 'disabled' | 'rpc';
  lastCycleAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  checkpoint: string | null;
  credited: number;
  pending: number;
  rejected: number;
  /** Финализировано и опознано, но не зачислено: защёлка поднята. */
  heldBack: number;
  safetyState: FundingSafetyState;
}

const runtime: SolanaDepositRuntimeStatus = {
  running: false,
  source: env.SOLANA_DEPOSIT_SOURCE,
  lastCycleAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  checkpoint: null,
  credited: 0,
  pending: 0,
  rejected: 0,
  heldBack: 0,
  safetyState: 'HEALTHY',
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const workerId = `solana-deposit:${process.pid}:${randomUUID()}`;

export function getSolanaDepositRuntimeStatus(): SolanaDepositRuntimeStatus {
  return { ...runtime };
}

export async function runSolanaDepositCycle(): Promise<void> {
  if (!runtime.running || ticking) return;
  ticking = true;
  runtime.lastCycleAt = new Date().toISOString();
  try {
    const rpc = new FetchSolanaRpcClient(
      env.SOLANA_RPC_URL,
      env.SOLANA_DEPOSIT_RPC_TIMEOUT_MS,
    );
    const source = new SolanaRpcDepositEventSource(
      rpc,
      new PrismaSolanaDepositAddressBook(),
      {
        signaturePageSize: env.SOLANA_DEPOSIT_SIGNATURE_PAGE_SIZE,
        maxPagesPerAddress: env.SOLANA_DEPOSIT_MAX_PAGES,
        maxTransactionsPerCycle: env.SOLANA_DEPOSIT_MAX_TRANSACTIONS,
        newAddressLookbackSlots: env.SOLANA_DEPOSIT_NEW_ADDRESS_LOOKBACK_SLOTS,
      },
    );
    const result = await processSolanaDepositCycle({
      source,
      repository: new PrismaSolanaDepositRepository(),
      workerId,
      initialStartSlot: BigInt(env.SOLANA_DEPOSIT_BOOTSTRAP_SLOT!),
      overlapSlots: BigInt(env.SOLANA_DEPOSIT_OVERLAP_SLOTS),
      leaseMs: Math.max(env.SOLANA_DEPOSIT_POLL_INTERVAL_MS * 2, 30_000),
    });
    runtime.lastSuccessAt = new Date().toISOString();
    runtime.lastErrorCode = null;
    runtime.checkpoint = result.checkpoint.toString();
    runtime.credited += result.credited;
    runtime.pending = result.pending;
    runtime.rejected += result.rejected;
    runtime.heldBack = result.heldBack;
    runtime.safetyState = result.safetyState;
    if (result.heldBack > 0) {
      // Деньги не потеряны: событие сохранено финализированным.
      // Зачисление ждёт решения человека.
      logger.warn(
        { heldBack: result.heldBack, safety: result.safetyState },
        'Solana deposits held back by funding safety latch',
      );
    }
    if (result.credited > 0 || result.reviewRequired > 0) {
      logger.info({
        credited: result.credited,
        reviewRequired: result.reviewRequired,
        checkpoint: runtime.checkpoint,
      }, 'Solana deposit cycle completed');
    }
  } catch (error: unknown) {
    runtime.lastErrorCode = safeErrorCode(error);
    logger.warn({ code: runtime.lastErrorCode }, 'Solana deposit cycle failed');
  } finally {
    ticking = false;
  }
}

export function startSolanaDepositWorker(): boolean {
  if (runtime.running) return true;
  if (!env.FUNDING_ENABLED || env.SOLANA_DEPOSIT_SOURCE === 'disabled') {
    runtime.source = 'disabled';
    return false;
  }
  if (!env.SOLANA_DEPOSIT_BOOTSTRAP_SLOT) {
    runtime.lastErrorCode = 'SOLANA_DEPOSIT_BOOTSTRAP_SLOT_REQUIRED';
    return false;
  }
  runtime.running = true;
  runtime.source = 'rpc';
  timer = setInterval(() => void runSolanaDepositCycle(), env.SOLANA_DEPOSIT_POLL_INTERVAL_MS);
  timer.unref?.();
  void runSolanaDepositCycle();
  logger.info({ intervalMs: env.SOLANA_DEPOSIT_POLL_INTERVAL_MS }, 'Solana deposit worker started');
  return true;
}

export function stopSolanaDepositWorker(): void {
  runtime.running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SolanaRpcRequestError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'SOLANA_DEPOSIT_CYCLE_FAILED';
}
