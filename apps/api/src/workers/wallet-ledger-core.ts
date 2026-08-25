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
  calculateWalletLedger,
  normalizeAddress,
  WALLET_PNL_VERSION,
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

  // Публичный PnL считается отдельно, без преобразования Decimal
  // в number. Старый position-ledger пока остаётся только для Smart
  // Score, а точный ledger даёт результат каждой частичной SELL.
  const exactLedger = calculateWalletLedger(all);

  const activityUpdates = await matchActivities(
    chain,
    wallet,
    all,
    exactLedger.tradePnl,
    deps.repo,
  );
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
 * ─── Что здесь было сломано ─────────────────────────────────────────
 *
 * Стоял `trades.find(...)`, и из него следовали сразу две беды.
 *
 * Первая: одна сделка истории могла достаться нескольким событиям
 * ленты. `find` ничего не помечает занятым, поэтому две похожие
 * продажи одного токена подтверждались одной и той же строкой —
 * то есть транзакция применялась к учёту дважды.
 *
 * Вторая: при двух подходящих кандидатах выбирался первый по порядку
 * массива. Это не выбор, а совпадение: порядок страниц истории
 * решал, какое событие считать подтверждённым.
 *
 * ─── Как теперь ─────────────────────────────────────────────────────
 *
 * Сделка, отданная событию, помечается занятой и больше не кандидат.
 * Два подходящих кандидата означают неоднозначность, и событие
 * остаётся неразрешённым — придумывать ему сделку нельзя, оценка
 * кошелька не должна зависеть от нашей догадки.
 *
 * События разбираются от самых ранних: иначе позднее событие
 * забирало бы сделку у более раннего просто потому, что оказалось
 * первым в выборке.
 */
async function matchActivities(
  chain: ChainKey,
  wallet: string,
  trades: CanonicalTrade[],
  exactTradePnl: ReturnType<typeof calculateWalletLedger>['tradePnl'],
  repo: WalletLedgerRepository,
): Promise<ActivityStateUpdate[]> {
  const pending = await repo.pendingActivities(chain, wallet, 500);
  if (pending.length === 0) return [];

  /** Сделки, уже отданные другому событию в прошлом проходе. */
  const taken = await repo.assignedCanonicalTradeKeys(
    chain,
    wallet,
    pending.map((activity) => activity.id),
  );
  const pnlByTrade = new Map(exactTradePnl.map((result) => [result.canonicalTradeKey, result]));
  const computedAt = Date.now();

  const ordered = [...pending].sort((a, b) => a.tradedAt - b.tradedAt);

  return ordered.map((a): ActivityStateUpdate => {
    // При смене версии уже сопоставленная строка не выбирает сделку
    // заново: её прежняя сильная связь важнее близости по времени.
    const existing = a.canonicalTradeKey == null
      ? null
      : trades.find((trade) => trade.key === a.canonicalTradeKey) ?? null;

    if (existing && !taken.has(existing.key)) {
      const local = pnlByTrade.get(existing.key);
      taken.add(existing.key);
      return {
        id: a.id,
        state: 'applied',
        applied: true,
        canonicalTradeKey: existing.key,
        localPnlState: local?.state ?? (existing.side === 'BUY' ? 'open_position' : 'ambiguous'),
        localRealizedPnlUsd: local?.realizedUsd ?? null,
        localCostBasisUsd: local?.costBasisUsd ?? null,
        pnlVersion: WALLET_PNL_VERSION,
        pnlComputedAt: computedAt,
      };
    }

    const fits = trades.filter(
      (t) =>
        !taken.has(t.key) &&
        // Неоднозначная группа подтверждением быть не может:
        // мы сами не уверены, что сложили её верно.
        t.ambiguous !== true &&
        normalizeAddress(chain, t.tokenAddress) === normalizeAddress(chain, a.tokenAddress) &&
        t.side === a.side &&
        Math.abs(t.tradedAt - a.tradedAt) <= MATCH_WINDOW_MS,
    );

    if (fits.length === 1) {
      const matched = fits[0]!;
      const local = pnlByTrade.get(matched.key);
      taken.add(matched.key);
      return {
        id: a.id,
        state: 'applied',
        applied: true,
        canonicalTradeKey: matched.key,
        localPnlState: local?.state ?? (matched.side === 'BUY' ? 'open_position' : 'ambiguous'),
        localRealizedPnlUsd: local?.realizedUsd ?? null,
        localCostBasisUsd: local?.costBasisUsd ?? null,
        pnlVersion: WALLET_PNL_VERSION,
        pnlComputedAt: computedAt,
      };
    }

    if (fits.length > 1) {
      /*
       * Выбрать нельзя. Прежний код брал первый попавшийся
       * и объявлял событие подтверждённым — а вместе с ним
       * подтверждал число, которое могло относиться к другой сделке.
       */
      return {
        id: a.id,
        state: 'ambiguous',
        applied: false,
        localPnlState: 'ambiguous',
        pnlVersion: WALLET_PNL_VERSION,
        pnlComputedAt: computedAt,
      };
    }

    // История обновляется позже сокета. Это не ошибка и не повод
    // ни удалять событие из ленты, ни выдумывать ему количество.
    return {
      id: a.id,
      state: 'deferred',
      applied: false,
      localPnlState: 'pending',
      pnlVersion: WALLET_PNL_VERSION,
      pnlComputedAt: computedAt,
    };
  });
}

export { assessCoverage };
