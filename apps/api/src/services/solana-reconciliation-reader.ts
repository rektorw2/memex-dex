import { depositKey } from '@memex/core';
import {
  SolanaRpcRequestError,
  type SolanaRpcDepositEventSource,
} from './solana-rpc-deposit-source.js';
import type {
  ChainLookup,
  ReconcilableEvent,
  ReconciliationChainReader,
} from './solana-reconciliation-pipeline.js';

/**
 * Чтение цепочки для сверки.
 *
 * Использует тот же источник, что и приём депозитов: сверка,
 * читающая другим кодом, сверяла бы две реализации друг с другом,
 * а не запись с цепочкой.
 *
 * Единственное, что этот слой добавляет, — различение трёх исходов,
 * которые источник сваливает в один. «Не нашлось» и «узел не
 * ответил» выглядят одинаково в try/catch, но означают
 * противоположное: первое может быть реорганизацией, второе — нет.
 */
export class SourceBackedReconciliationReader implements ReconciliationChainReader {
  constructor(private readonly source: Pick<SolanaRpcDepositEventSource, 'readByEventKeys'>) {}

  async lookup(events: readonly ReconcilableEvent[]): Promise<Map<string, ChainLookup>> {
    const result = new Map<string, ChainLookup>();
    if (events.length === 0) return result;

    const keys = events.map((event) => event.eventKey);
    try {
      const found = await this.source.readByEventKeys(keys);
      const byKey = new Map(
        found.map((event) => [depositKey(event.signature, event.instructionIndex), event]),
      );
      for (const key of keys) {
        const event = byKey.get(key);
        result.set(key, event ? { kind: 'found', event } : { kind: 'absent' });
      }
      return result;
    } catch (error: unknown) {
      /*
       * Ошибка накрывает весь пакет.
       *
       * Помечать часть пакета как «не нашлось», а часть как
       * «недоступно» здесь нельзя: источник бросает до того, как
       * стало известно, какие именно ключи он успел проверить.
       * Считать непроверенное отсутствующим — прямой путь к ложной
       * реорганизации.
       */
      const lookup: ChainLookup = classifyRpcError(error);
      for (const key of keys) result.set(key, lookup);
      return result;
    }
  }
}

function classifyRpcError(error: unknown): ChainLookup {
  if (error instanceof SolanaRpcRequestError) {
    // Неповторяемая ошибка — это испорченный или неожиданный ответ,
    // а не недоступность: узел ответил, но ответу нельзя верить.
    return error.retryable
      ? { kind: 'unreachable', code: error.code }
      : { kind: 'invalid', code: error.code };
  }
  return { kind: 'unreachable', code: 'SOLANA_RECONCILIATION_LOOKUP_FAILED' };
}
