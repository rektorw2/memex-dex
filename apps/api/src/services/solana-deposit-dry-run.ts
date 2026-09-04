import { assetByMint } from '@memex/core';
import {
  SolanaRpcDepositEventSource,
  SolanaRpcRequestError,
  scanAddressesForOwner,
  type SolanaDepositAddressBook,
  type SolanaRpcClient,
  type SolanaWatchedDestination,
} from './solana-rpc-deposit-source.js';
import type { SolanaDepositSourceEvent } from './solana-deposit-pipeline.js';

/**
 * Холостой прогон чтения цепочки.
 *
 * Существует ради одного вопроса: понимает ли наш разбор то, что
 * на самом деле отдаёт devnet. Ответить на него по мокам нельзя —
 * моки написаны по нашему же представлению о формате, и если оно
 * неверно, они это представление подтвердят.
 *
 * Чего здесь нет и не должно появиться: записи в `Deposit`,
 * `LedgerEntry`, `Balance` и в checkpoint. Prisma сюда не
 * импортируется вовсе — не «мы не вызываем запись», а «записать
 * нечем». Проверка, которая может изменить баланс, однажды его
 * изменит.
 *
 * Адрес приходит снаружи и остаётся просто строкой. Никакого
 * `userId` источник не назначает: право собственности определяет
 * база, и только в боевом пути.
 */

export interface DryRunOptions {
  /** Публичный адрес для наблюдения. Ключа к нему у нас нет и не нужно. */
  address: string;
  /** С какого слота смотреть. */
  fromSlot: bigint;
  pageSize?: number;
  maxPages?: number;
  maxTransactions?: number;
}

export interface DryRunSummary {
  network: string;
  /** Просмотренный диапазон. Границы, а не содержимое. */
  fromSlot: string;
  scannedThroughSlot: string;
  signatures: number;
  transactions: number;
  solTransfers: number;
  splTransfers: number;
  /** Переводы в токенах вне списка разрешённых. */
  unsupportedMint: number;
  /** Инструкции, которые разбор не счёл переводом. */
  skippedInstructions: number;
  /** Самая большая сумма в минимальных единицах. Строкой: u64 не влезает в number. */
  largestRawAmount: string | null;
  /** Диапазон позиционных индексов: доказывает, что они не сбрасываются. */
  instructionIndexes: number[];
  /** Код ошибки, если проход не завершился. */
  failureCode: string | null;
}

/**
 * Адресная книга одного адреса.
 *
 * Курсор всегда `0n`: холостой прогон ничего не запоминает, и
 * следующий его запуск обязан посмотреть тот же диапазон заново.
 */
class SingleAddressBook implements SolanaDepositAddressBook {
  constructor(private readonly address: string) {}

  async listActiveDestinations(): Promise<readonly SolanaWatchedDestination[]> {
    return [{
      ownerAddress: this.address,
      scanAddresses: scanAddressesForOwner(this.address),
      scannedThroughSlot: 0n,
    }];
  }

  async recordScannedThrough(): Promise<void> {
    // Намеренно пусто: курсор — это состояние боевого прохода.
    // Записать его отсюда значит объявить диапазон просмотренным
    // тем циклом, который никого не зачислял.
  }
}

export async function runSolanaDepositDryRun(
  rpc: SolanaRpcClient,
  network: string,
  options: DryRunOptions,
): Promise<DryRunSummary> {
  const source = new SolanaRpcDepositEventSource(rpc, new SingleAddressBook(options.address), {
    signaturePageSize: options.pageSize ?? 50,
    maxPagesPerAddress: options.maxPages ?? 2,
    maxTransactionsPerCycle: options.maxTransactions ?? 100,
    // Курсора нет, поэтому окно нового адреса и есть окно прогона.
    newAddressLookbackSlots: 216_000,
  });

  const summary: DryRunSummary = {
    network,
    fromSlot: options.fromSlot.toString(),
    scannedThroughSlot: options.fromSlot.toString(),
    signatures: 0,
    transactions: 0,
    solTransfers: 0,
    splTransfers: 0,
    unsupportedMint: 0,
    skippedInstructions: 0,
    largestRawAmount: null,
    instructionIndexes: [],
    failureCode: null,
  };

  try {
    const batch = await source.readAfterSlot(options.fromSlot);
    summary.scannedThroughSlot = batch.scannedThroughSlot.toString();
    summarize(batch.events, summary);
  } catch (error: unknown) {
    /*
     * Ошибка не скрывается и не превращается в ноль.
     *
     * «Ноль переводов» и «прочитать не удалось» — разные ответы,
     * и второй из них означает, что проверять надо конфигурацию,
     * а не разбор.
     */
    summary.failureCode = error instanceof SolanaRpcRequestError
      ? error.code
      : 'SOLANA_DRY_RUN_FAILED';
  }

  return summary;
}

/** Сводка по событиям. Сырые транзакции наружу не выходят. */
export function summarize(
  events: readonly SolanaDepositSourceEvent[],
  summary: DryRunSummary,
): DryRunSummary {
  const signatures = new Set<string>();
  let largest: bigint | null = null;

  for (const event of events) {
    signatures.add(event.signature);
    if (event.mint == null) summary.solTransfers += 1;
    else summary.splTransfers += 1;
    if (assetByMint(event.mint) == null) summary.unsupportedMint += 1;
    if (largest == null || event.rawAmount > largest) largest = event.rawAmount;
    summary.instructionIndexes.push(event.instructionIndex);
  }

  summary.signatures = signatures.size;
  summary.transactions = signatures.size;
  // Строкой: u64 не помещается в число с плавающей точкой, и
  // округление суммы в отчёте о деньгах — плохое начало.
  summary.largestRawAmount = largest?.toString() ?? null;
  summary.instructionIndexes = [...new Set(summary.instructionIndexes)].sort((a, b) => a - b);
  return summary;
}
