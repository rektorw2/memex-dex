/**
 * Чистая часть пересчёта позиций.
 *
 * Вынесена отдельно от планировщика, потому что проверять надо
 * именно её: что происходит при осиротевшей продаже, обрезанной
 * истории, повторной сделке и событии, пришедшем задним числом.
 * Планировщик вокруг — это таймер и захват задачи, там ошибаться
 * почти негде.
 *
 * Здесь нет ни базы, ни сети: обе приходят снаружи интерфейсами,
 * и подделать их в тесте можно целиком.
 */

import {
  sortForLedger,
  dedupeCanonical,
  buildPositions,
  summarizePnl,
  checkCompleteness,
  scorableTokens,
  coveragePercent,
  assessCoverage,
  type CanonicalTrade,
  type ChainKey,
  type EconomicTrade,
  type HistoryCoverage,
} from '@memex/core';
import type {
  WalletLedgerRepository,
  ActivityStateUpdate,
} from './wallet-ledger-repo.js';

/** Откуда берётся история. Подделывается в тестах целиком. */
export interface HistorySource {
  fetch(
    chain: ChainKey,
    wallet: string,
    opts: { since: number | null },
  ): Promise<{ trades: CanonicalTrade[]; coverage: HistoryCoverage }>;
}

export interface RebuildResult {
  chain: string;
  wallet: string;
  /** Всего канонических сделок после дозагрузки. */
  totalTrades: number;
  newTrades: number;
  /** Закрытых позиций, годных для оценки. */
  scorableClosed: number;
  /** Закрытых позиций всего, включая непригодные. */
  closedTotal: number;
  /** Токены с неизвестной себестоимостью. */
  incompleteTokens: number;
  coveragePercent: number | null;
  historyStatus: HistoryCoverage['status'];
  appliedActivities: number;
  deferredActivities: number;
}

/**
 * Расхождение времени между лентой и историей.
 *
 * Лента берёт момент попадания в блок, история — момент
 * подтверждения; на загруженной сети разница доходит до минуты.
 */
export const MATCH_WINDOW_MS = 120_000;

/**
 * Пересчёт одного кошелька.
 *
 * Позиция не изменяется приращением, а собирается заново из всех
 * известных сделок. Причина в том, что события приходят повторно,
 * не по порядку, после переподключения и задним числом: приращение
 * при любом из этих случаев даёт неверный остаток, а заметить это
 * нечем — расхождение накапливается тихо.
 */
export async function rebuildWallet(
  chain: ChainKey,
  wallet: string,
  deps: { repo: WalletLedgerRepository; history: HistorySource },
): Promise<RebuildResult> {
  const since = await deps.repo.lastTradeTime(chain, wallet);
  const fetched = await deps.history.fetch(chain, wallet, { since });

  const persisted = await deps.repo.persistCanonicalTrades(
    dedupeCanonical(fetched.trades),
  );

  // Пересчёт идёт по всем сделкам, а не только по свежим: поздняя
  // историческая покупка меняет среднюю себестоимость всех
  // последующих продаж.
  const all = sortForLedger(await deps.repo.loadCanonicalTrades(chain, wallet));

  const completeness = checkCompleteness(all);
  const scorable = scorableTokens(completeness);

  // В оценку идут только токены с известной себестоимостью.
  // Осиротевшая продажа без покупки выглядит чистой прибылью,
  // и кошелёк с обрезанной историей становится тем «успешнее»,
  // чем больше у него истории потеряно.
  const forScoring = all.filter((t) => scorable.has(t.tokenAddress));

  const positions = buildPositions(toEconomic(all));
  const scorablePositions = buildPositions(toEconomic(forScoring));

  const pnl = summarizePnl(scorablePositions);

  const activityUpdates = await matchActivities(chain, wallet, all, deps.repo);
  await deps.repo.applyActivityStates(activityUpdates);

  return {
    chain,
    wallet,
    totalTrades: all.length,
    newTrades: persisted.created,
    scorableClosed: pnl.closedCount,
    closedTotal: positions.filter((p) => p.isClosed).length,
    incompleteTokens: completeness.filter((c) => c.incompleteCostBasis).length,
    coveragePercent: coveragePercent(completeness),
    historyStatus: fetched.coverage.status,
    appliedActivities: activityUpdates.filter((u) => u.applied).length,
    deferredActivities: activityUpdates.filter((u) => !u.applied).length,
  };
}

/**
 * Перевод канонических сделок в формат существующего ядра.
 *
 * Приведение к числу происходит здесь и только здесь — осознанно
 * и в одном месте, чтобы было видно, где теряется точность строки.
 */
function toEconomic(trades: CanonicalTrade[]): EconomicTrade[] {
  return trades.map((t) => ({
    chain: t.chain,
    wallet: t.wallet,
    tokenAddress: t.tokenAddress,
    side: t.side,
    tokenAmount: Number(t.amount),
    amountUsd: Number(t.valueUsd),
    priceUsd: Number(t.price),
    timestamp: t.tradedAt,
    txHash: t.key,
    legs: 1,
    parsingConfidence: 1,
    source: 'okx_dex_history',
  }));
}

/**
 * Сопоставление событий ленты с точными сделками.
 *
 * Несопоставленное событие остаётся несопоставленным и получает
 * состояние «отложено». Придумывать ему количество нельзя: оценка
 * кошелька не должна зависеть от того, что мы что-то предположили.
 */
async function matchActivities(
  chain: ChainKey,
  wallet: string,
  trades: CanonicalTrade[],
  repo: WalletLedgerRepository,
): Promise<ActivityStateUpdate[]> {
  const pending = await repo.pendingActivities(chain, wallet, 500);
  if (pending.length === 0) return [];

  return pending.map((a): ActivityStateUpdate => {
    const match = trades.find(
      (t) =>
        t.tokenAddress === a.tokenAddress &&
        t.side === a.side &&
        Math.abs(t.tradedAt - a.tradedAt) <= MATCH_WINDOW_MS,
    );

    return match
      ? { id: a.id, state: 'applied', applied: true }
      : // История обновляется позже сокета. Это не ошибка и не повод
        // ни удалять событие из ленты, ни выдумывать ему количество.
        { id: a.id, state: 'deferred', applied: false };
  });
}

export { assessCoverage };
