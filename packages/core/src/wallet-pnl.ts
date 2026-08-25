/**
 * Точный локальный PnL кошелька.
 *
 * Провайдер может прислать готовое число прибыли, но его правила и
 * себестоимость нам неизвестны. Поэтому публичный результат считается
 * только из канонических BUY/SELL: средневзвешенная себестоимость,
 * точные десятичные строки и отдельный результат каждой продажи.
 *
 * `number` здесь запрещён намеренно. Количество токена содержит до
 * восемнадцати знаков после запятой; преобразование в double до конца
 * расчёта незаметно меняет себестоимость частичных продаж.
 */

import Decimal from 'decimal.js';
import type { CanonicalTrade } from './okx-dex-history.js';
import { normalizeAddress, type ChainKey } from './token-registry.js';

export const WALLET_PNL_VERSION = 1;
export const WALLET_PNL_METHOD = 'weighted_average' as const;
export const WALLET_PNL_PRICE_STALE_AFTER_MS = 5 * 60_000;

export type WalletPnlState =
  | 'available'
  | 'pending'
  | 'incomplete_history'
  | 'ambiguous'
  | 'stale'
  | 'empty';

export type TradePnlState =
  | 'available'
  | 'open_position'
  | 'incomplete_history'
  | 'ambiguous';

export interface ExactTradePnl {
  canonicalTradeKey: string;
  side: 'BUY' | 'SELL';
  state: TradePnlState;
  /** Выручка минус средневзвешенная себестоимость этой продажи. */
  realizedUsd: string | null;
  /** Средневзвешенная себестоимость проданного количества. */
  costBasisUsd: string | null;
}

export interface ExactWalletPosition {
  chain: string;
  wallet: string;
  tokenAddress: string;
  boughtAmount: string;
  soldAmount: string;
  remainingAmount: string;
  remainingCostUsd: string;
  realizedUsd: string;
  firstBuyAt: number | null;
  lastTradeAt: number;
  isClosed: boolean;
}

export interface WalletLedgerCalculation {
  positions: ExactWalletPosition[];
  tradePnl: ExactTradePnl[];
  realizedUsd: string | null;
  closedPositions: number;
  openPositions: number;
  incompleteTokens: number;
  ambiguousTokens: number;
  latestTradeAt: number | null;
}

export interface WalletPriceMark {
  chain: string;
  tokenAddress: string;
  priceUsd: string;
  observedAt: number;
}

export interface WalletPnlSnapshot {
  state: WalletPnlState;
  /** Текущая рыночная стоимость всех известных открытых позиций. */
  assetsUsd: string | null;
  realizedUsd: string | null;
  unrealizedUsd: string | null;
  totalUsd: string | null;
  closedPositions: number;
  openPositions: number;
  incompleteTokens: number;
  ambiguousTokens: number;
  unpricedPositions: number;
  isStale: boolean;
  computedAt: number | null;
  priceAsOf: number | null;
  method: typeof WALLET_PNL_METHOD;
  version: typeof WALLET_PNL_VERSION;
}

type TokenGroup = {
  trades: CanonicalTrade[];
  state: 'complete' | 'incomplete_history' | 'ambiguous';
};

const ZERO = new Decimal(0);

function decimal(value: string): Decimal | null {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function text(value: Decimal): string {
  // Никогда не отдаём экспоненциальную запись: Prisma Decimal и
  // JSON-клиенты одинаково понимают обычную десятичную строку.
  return value.toFixed();
}

function tokenKey(chain: string, address: string): string {
  return `${chain}:${normalizeAddress(chain as ChainKey, address)}`;
}

/**
 * Классифицировать историю до расчёта.
 *
 * Если позже обнаружилась продажа без известной покупки, нельзя
 * оставить ранние продажи «достоверными»: пропущенная старая покупка
 * меняет среднюю себестоимость и у них тоже. Поэтому плохим становится
 * весь токен, а не только последняя строка.
 */
function classifyToken(trades: CanonicalTrade[]): TokenGroup['state'] {
  const byTimestamp = new Map<number, Set<'BUY' | 'SELL'>>();

  for (const trade of trades) {
    const sides = byTimestamp.get(trade.tradedAt) ?? new Set<'BUY' | 'SELL'>();
    sides.add(trade.side);
    byTimestamp.set(trade.tradedAt, sides);

    if (trade.ambiguous === true) return 'ambiguous';
  }

  // История OKX не даёт logIndex. BUY и SELL одного токена с одной
  // отметкой времени нельзя упорядочить честно: сортировка по ключу
  // была бы детерминированной, но экономически случайной.
  if ([...byTimestamp.values()].some((sides) => sides.size > 1)) return 'ambiguous';

  let remaining = ZERO;

  for (const trade of trades) {
    const amount = decimal(trade.amount);
    const value = decimal(trade.valueUsd);
    if (!amount || !value || amount.lte(0) || value.lt(0)) return 'ambiguous';

    if (trade.side === 'BUY') {
      remaining = remaining.plus(amount);
      continue;
    }

    if (amount.gt(remaining)) return 'incomplete_history';
    remaining = remaining.minus(amount);
  }

  return 'complete';
}

/** Рассчитать позиции и результат каждой SELL без базы и сети. */
export function calculateWalletLedger(trades: CanonicalTrade[]): WalletLedgerCalculation {
  const grouped = new Map<string, CanonicalTrade[]>();

  for (const trade of trades) {
    const key = tokenKey(trade.chain, trade.tokenAddress);
    const list = grouped.get(key) ?? [];
    list.push(trade);
    grouped.set(key, list);
  }

  const groups: TokenGroup[] = [...grouped.values()].map((list) => {
    const ordered = [...list].sort((a, b) => {
      if (a.tradedAt !== b.tradedAt) return a.tradedAt - b.tradedAt;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return { trades: ordered, state: classifyToken(ordered) };
  });

  const positions: ExactWalletPosition[] = [];
  const tradePnl: ExactTradePnl[] = [];
  let realized = ZERO;
  let incompleteTokens = 0;
  let ambiguousTokens = 0;
  let latestTradeAt: number | null = null;

  for (const group of groups) {
    const first = group.trades[0]!;
    latestTradeAt = Math.max(latestTradeAt ?? first.tradedAt, ...group.trades.map((t) => t.tradedAt));

    if (group.state !== 'complete') {
      if (group.state === 'ambiguous') ambiguousTokens++;
      else incompleteTokens++;

      for (const trade of group.trades) {
        tradePnl.push({
          canonicalTradeKey: trade.key,
          side: trade.side,
          state: group.state,
          realizedUsd: null,
          costBasisUsd: null,
        });
      }
      continue;
    }

    let bought = ZERO;
    let sold = ZERO;
    let remaining = ZERO;
    let remainingCost = ZERO;
    let tokenRealized = ZERO;
    let firstBuyAt: number | null = null;

    for (const trade of group.trades) {
      const amount = decimal(trade.amount)!;
      const value = decimal(trade.valueUsd)!;

      if (trade.side === 'BUY') {
        bought = bought.plus(amount);
        remaining = remaining.plus(amount);
        remainingCost = remainingCost.plus(value);
        firstBuyAt ??= trade.tradedAt;
        tradePnl.push({
          canonicalTradeKey: trade.key,
          side: 'BUY',
          state: 'open_position',
          realizedUsd: null,
          costBasisUsd: null,
        });
        continue;
      }

      const unitCost = remainingCost.div(remaining);
      const costBasis = unitCost.mul(amount);
      const salePnl = value.minus(costBasis);

      sold = sold.plus(amount);
      remaining = remaining.minus(amount);
      remainingCost = remainingCost.minus(costBasis);
      tokenRealized = tokenRealized.plus(salePnl);

      tradePnl.push({
        canonicalTradeKey: trade.key,
        side: 'SELL',
        state: 'available',
        realizedUsd: text(salePnl),
        costBasisUsd: text(costBasis),
      });
    }

    // Позиция закрыта только после продажи всего известного количества.
    // Старый агрегат считал остаток до 1% «пылью» и обнулял его. Для
    // точного PnL это недопустимо: у остатка есть себестоимость и live-
    // стоимость, поэтому частичная продажа 99% всё ещё оставляет
    // открытую позицию. Decimal не создаёт хвостов double-арифметики.
    const isClosed = bought.gt(0) && remaining.eq(0);

    realized = realized.plus(tokenRealized);
    positions.push({
      chain: first.chain,
      wallet: first.wallet,
      tokenAddress: first.tokenAddress,
      boughtAmount: text(bought),
      soldAmount: text(sold),
      remainingAmount: text(remaining),
      remainingCostUsd: text(remainingCost),
      realizedUsd: text(tokenRealized),
      firstBuyAt,
      lastTradeAt: group.trades.at(-1)!.tradedAt,
      isClosed,
    });
  }

  const closedPositions = positions.filter((p) => p.isClosed).length;
  const openPositions = positions.length - closedPositions;

  return {
    positions,
    tradePnl,
    realizedUsd: incompleteTokens > 0 || ambiguousTokens > 0 ? null : text(realized),
    closedPositions,
    openPositions,
    incompleteTokens,
    ambiguousTokens,
    latestTradeAt,
  };
}

/**
 * Добавить к локальной себестоимости сохранённые рыночные цены.
 *
 * Ни одного запроса к провайдеру здесь нет. Отсутствующая или старая
 * цена оставляет нереализованный результат неизвестным, но не
 * подменяет его нулём.
 */
export function walletPnlSnapshot(
  ledger: WalletLedgerCalculation,
  marks: WalletPriceMark[],
  opts: { computedAt: number; staleAfterMs?: number },
): WalletPnlSnapshot {
  const base = {
    closedPositions: ledger.closedPositions,
    openPositions: ledger.openPositions,
    incompleteTokens: ledger.incompleteTokens,
    ambiguousTokens: ledger.ambiguousTokens,
    method: WALLET_PNL_METHOD,
    version: WALLET_PNL_VERSION,
  } as const;

  if (ledger.latestTradeAt == null) {
    return {
      ...base,
      state: 'empty',
      assetsUsd: null,
      realizedUsd: null,
      unrealizedUsd: null,
      totalUsd: null,
      unpricedPositions: 0,
      isStale: false,
      computedAt: null,
      priceAsOf: null,
    };
  }

  if (ledger.incompleteTokens > 0 || ledger.ambiguousTokens > 0) {
    return {
      ...base,
      state: ledger.incompleteTokens > 0 ? 'incomplete_history' : 'ambiguous',
      assetsUsd: null,
      realizedUsd: null,
      unrealizedUsd: null,
      totalUsd: null,
      unpricedPositions: ledger.openPositions,
      isStale: false,
      computedAt: opts.computedAt,
      priceAsOf: null,
    };
  }

  const byToken = new Map(marks.map((m) => [tokenKey(m.chain, m.tokenAddress), m]));
  const open = ledger.positions.filter((p) => !p.isClosed);
  let unrealized = ZERO;
  let assets = ZERO;
  let unpriced = 0;
  let stale = false;
  let priceAsOf: number | null = null;
  const staleAfter = opts.staleAfterMs ?? WALLET_PNL_PRICE_STALE_AFTER_MS;

  for (const position of open) {
    const mark = byToken.get(tokenKey(position.chain, position.tokenAddress));
    const price = mark ? decimal(mark.priceUsd) : null;

    if (!mark || !price || price.lt(0)) {
      unpriced++;
      continue;
    }

    if (opts.computedAt - mark.observedAt > staleAfter) {
      stale = true;
      unpriced++;
      continue;
    }

    priceAsOf = priceAsOf == null ? mark.observedAt : Math.min(priceAsOf, mark.observedAt);
    const marketValue = new Decimal(position.remainingAmount).mul(price);
    assets = assets.plus(marketValue);
    unrealized = unrealized.plus(marketValue.minus(position.remainingCostUsd));
  }

  const realized = new Decimal(ledger.realizedUsd ?? 0);

  if (unpriced > 0) {
    return {
      ...base,
      state: stale ? 'stale' : 'pending',
      // Частичную стоимость не выдаём за весь портфель: если хотя бы
      // одна открытая позиция без цены, итог неизвестен.
      assetsUsd: null,
      realizedUsd: text(realized),
      unrealizedUsd: null,
      totalUsd: null,
      unpricedPositions: unpriced,
      isStale: stale,
      computedAt: opts.computedAt,
      priceAsOf,
    };
  }

  return {
    ...base,
    state: 'available',
    assetsUsd: text(assets),
    realizedUsd: text(realized),
    unrealizedUsd: text(unrealized),
    totalUsd: text(realized.plus(unrealized)),
    unpricedPositions: 0,
    isStale: false,
    computedAt: opts.computedAt,
    priceAsOf,
  };
}
