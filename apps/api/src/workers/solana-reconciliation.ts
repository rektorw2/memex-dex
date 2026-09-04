import { randomUUID } from 'node:crypto';
import type { FundingSafetyState } from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { PrismaSolanaDepositAddressBook } from '../services/prisma-solana-deposit-address-book.js';
import {
  PrismaSolanaReconciliationRepository,
  readFundingSafetyState,
} from '../services/prisma-solana-reconciliation-repository.js';
import {
  FetchSolanaRpcClient,
  SolanaRpcDepositEventSource,
  SolanaRpcRequestError,
} from '../services/solana-rpc-deposit-source.js';
import { SourceBackedReconciliationReader } from '../services/solana-reconciliation-reader.js';
import { runSolanaReconciliationCycle } from '../services/solana-reconciliation-pipeline.js';

/**
 * Воркер сверки.
 *
 * Отдельный от приёма депозитов: у них разный темп и разная цена
 * задержки. Приём не должен ждать, пока перепроверятся тысячи старых
 * строк; сверка не должна торопиться и брать больше, чем успеет
 * обработать до истечения аренды.
 *
 * Ни одной операции с деньгами здесь нет.
 */

export interface SolanaReconciliationRuntimeStatus {
  running: boolean;
  lastCycleAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  safetyState: FundingSafetyState;
  claimed: number;
  matched: number;
  mismatched: number;
  missing: number;
  unreachable: number;
  issuesRaised: number;
}

const runtime: SolanaReconciliationRuntimeStatus = {
  running: false,
  lastCycleAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  safetyState: 'HEALTHY',
  claimed: 0,
  matched: 0,
  mismatched: 0,
  missing: 0,
  unreachable: 0,
  issuesRaised: 0,
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const workerId = `solana-reconcile:${process.pid}:${randomUUID()}`;

export function getSolanaReconciliationRuntimeStatus(): SolanaReconciliationRuntimeStatus {
  return { ...runtime };
}

export async function runSolanaReconciliationTick(): Promise<void> {
  // Второй тик поверх первого удвоил бы счётчики исчезновений
  // и поднял бы тревогу втрое быстрее порога.
  if (!runtime.running || ticking) return;
  ticking = true;
  runtime.lastCycleAt = new Date().toISOString();
  try {
    const rpc = new FetchSolanaRpcClient(env.SOLANA_RPC_URL, env.SOLANA_DEPOSIT_RPC_TIMEOUT_MS);
    const source = new SolanaRpcDepositEventSource(rpc, new PrismaSolanaDepositAddressBook(), {
      signaturePageSize: env.SOLANA_DEPOSIT_SIGNATURE_PAGE_SIZE,
      maxPagesPerAddress: env.SOLANA_DEPOSIT_MAX_PAGES,
      maxTransactionsPerCycle: env.SOLANA_DEPOSIT_MAX_TRANSACTIONS,
    });
    const result = await runSolanaReconciliationCycle({
      repository: new PrismaSolanaReconciliationRepository(),
      reader: new SourceBackedReconciliationReader(source),
      workerId,
      leaseMs: Math.max(env.SOLANA_RECONCILE_INTERVAL_MS * 2, 60_000),
      batchSize: env.SOLANA_RECONCILE_BATCH_SIZE,
    });
    runtime.lastSuccessAt = new Date().toISOString();
    runtime.lastErrorCode = null;
    runtime.claimed = result.claimed;
    runtime.matched = result.matched;
    runtime.mismatched = result.mismatched;
    runtime.missing = result.missing;
    runtime.unreachable = result.unreachable;
    runtime.issuesRaised += result.issuesRaised;
    // Состояние читается из базы, а не берётся из результата цикла:
    // защёлку мог поднять другой процесс.
    runtime.safetyState = await readFundingSafetyState();
    if (result.issuesRaised > 0) {
      // Ни адресов, ни сумм, ни ответа провайдера: только счётчики.
      logger.warn(
        { issues: result.issuesRaised, safety: runtime.safetyState },
        'Solana reconciliation raised issues',
      );
    }
  } catch (error: unknown) {
    runtime.lastErrorCode = safeErrorCode(error);
    logger.warn({ code: runtime.lastErrorCode }, 'Solana reconciliation cycle failed');
  } finally {
    ticking = false;
  }
}

export function startSolanaReconciliationWorker(): boolean {
  if (runtime.running) return true;
  // Тот же выключатель, что и у приёма: сверять нечего, пока никто
  // ничего не зачисляет.
  if (!env.FUNDING_ENABLED || env.SOLANA_DEPOSIT_SOURCE === 'disabled') return false;
  runtime.running = true;
  timer = setInterval(() => void runSolanaReconciliationTick(), env.SOLANA_RECONCILE_INTERVAL_MS);
  timer.unref?.();
  void runSolanaReconciliationTick();
  logger.info({ intervalMs: env.SOLANA_RECONCILE_INTERVAL_MS }, 'Solana reconciliation worker started');
  return true;
}

export function stopSolanaReconciliationWorker(): void {
  runtime.running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SolanaRpcRequestError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'SOLANA_RECONCILIATION_CYCLE_FAILED';
}
