import type { OkxWalletCategory } from './okx-wallet-type.js';

/**
 * Чистая модель первого автономного агента.
 *
 * Здесь намеренно нет сети, базы, кошельков и исполнения ордеров. Модуль
 * отвечает только за решение по уже полученному OKX Signal и за честную
 * математику бумажной позиции. Поэтому один и тот же снимок всегда даёт
 * один и тот же результат, а тесты не могут случайно отправить транзакцию.
 */

export const PAPER_AGENT_ALLOWED_WALLET_TYPES = [
  'smart_money',
  'kol',
  'whale',
] as const satisfies readonly OkxWalletCategory[];

/** Жёсткий предохранитель: параметры стратегии не участвуют в этом решении. */
export function paperAgentModeVerdict(
  executionMode: string,
): { ok: true } | { ok: false; reason: 'PAPER_AGENT_REQUIRES_EXECUTION_MODE_PAPER' } {
  return executionMode === 'paper'
    ? { ok: true }
    : { ok: false, reason: 'PAPER_AGENT_REQUIRES_EXECUTION_MODE_PAPER' };
}

export type PaperAgentState =
  | 'RECEIVED'
  | 'WAITING_PRICE'
  | 'WAITING_ENTRY'
  | 'ELIGIBLE'
  | 'SKIPPED'
  | 'PAPER_OPEN'
  | 'PAPER_CLOSED'
  | 'ERROR';

export type PaperAgentDecisionCode =
  | 'ELIGIBLE'
  | 'WAITING_FOR_PRICE'
  | 'WAITING_FOR_ENTRY_DELAY'
  | 'UNSUPPORTED_SIGNAL_TYPE'
  | 'AMOUNT_BELOW_THRESHOLD'
  | 'TOKEN_AGE_UNKNOWN'
  | 'TOKEN_TOO_OLD'
  | 'NETWORK_NOT_SUPPORTED_PHASE_2'
  | 'DECISION_DEADLINE_EXCEEDED'
  | 'PRICE_UNAVAILABLE_BEFORE_DEADLINE';

/**
 * Phase 2 принимает только Solana, но источник может назвать её по-разному.
 * `501` — официальный chainIndex OKX. Неизвестное значение не угадывается.
 */
export function normalizePaperAgentNetwork(value: unknown): 'SOLANA' | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ['SOLANA', 'SOLANA_MAINNET', 'SOLANA_MAINNET_BETA', '501'].includes(normalized)
    ? 'SOLANA'
    : null;
}

export interface PaperAgentStrategy {
  key: string;
  version: number;
  label: string;
  kind: 'BASELINE' | 'SHADOW';
  minAmountUsd: number;
  maxTokenAgeMs: number;
  maxDecisionLatencyMs: number;
  entryDelayMs: number;
  positionUsd: number;
  targetMultiple: number;
  /** Версия явной модели расходов — часть неизменяемого снимка стратегии. */
  costModelKey: string;
  /** Консервативная симуляция комиссии DEX/маршрута на каждой стороне. */
  tradeFeeBps: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  /** Фиксированная оценка сетевой комиссии Solana для одной стороны. */
  networkFeeUsdPerSide: number;
}

const MINUTE = 60_000;

/**
 * Версионированный набор Phase 1.
 *
 * Ключ содержит смысл эксперимента: изменение настройки создаёт новую
 * стратегию, а не переписывает историю старой. Shadow-набор меняет ровно
 * одну переменную за раз, поэтому сравнение с baseline можно объяснить.
 */
export const PAPER_AGENT_STRATEGIES: readonly PaperAgentStrategy[] = [
  {
    key: 'okx-signal-v2-baseline',
    version: 2,
    label: 'Baseline v2 · $5k · 15m · 2x',
    kind: 'BASELINE',
    minAmountUsd: 5_000,
    maxTokenAgeMs: 15 * MINUTE,
    maxDecisionLatencyMs: 30_000,
    entryDelayMs: 0,
    positionUsd: 100,
    targetMultiple: 2,
    costModelKey: 'solana-conservative-v1',
    tradeFeeBps: 30,
    entrySlippageBps: 100,
    exitSlippageBps: 100,
    networkFeeUsdPerSide: 0.02,
  },
  {
    key: 'okx-signal-v2-shadow-amount-10k',
    version: 2,
    label: 'Shadow v2 · $10k',
    kind: 'SHADOW',
    minAmountUsd: 10_000,
    maxTokenAgeMs: 15 * MINUTE,
    maxDecisionLatencyMs: 30_000,
    entryDelayMs: 0,
    positionUsd: 100,
    targetMultiple: 2,
    costModelKey: 'solana-conservative-v1',
    tradeFeeBps: 30,
    entrySlippageBps: 100,
    exitSlippageBps: 100,
    networkFeeUsdPerSide: 0.02,
  },
  {
    key: 'okx-signal-v2-shadow-age-20m',
    version: 2,
    label: 'Shadow v2 · возраст 20m',
    kind: 'SHADOW',
    minAmountUsd: 5_000,
    maxTokenAgeMs: 20 * MINUTE,
    maxDecisionLatencyMs: 30_000,
    entryDelayMs: 0,
    positionUsd: 100,
    targetMultiple: 2,
    costModelKey: 'solana-conservative-v1',
    tradeFeeBps: 30,
    entrySlippageBps: 100,
    exitSlippageBps: 100,
    networkFeeUsdPerSide: 0.02,
  },
  {
    key: 'okx-signal-v2-shadow-exit-3x',
    version: 2,
    label: 'Shadow v2 · выход 3x',
    kind: 'SHADOW',
    minAmountUsd: 5_000,
    maxTokenAgeMs: 15 * MINUTE,
    maxDecisionLatencyMs: 30_000,
    entryDelayMs: 0,
    positionUsd: 100,
    targetMultiple: 3,
    costModelKey: 'solana-conservative-v1',
    tradeFeeBps: 30,
    entrySlippageBps: 100,
    exitSlippageBps: 100,
    networkFeeUsdPerSide: 0.02,
  },
  {
    key: 'okx-signal-v2-shadow-delay-10s',
    version: 2,
    label: 'Shadow v2 · задержка 10s',
    kind: 'SHADOW',
    minAmountUsd: 5_000,
    maxTokenAgeMs: 15 * MINUTE,
    maxDecisionLatencyMs: 30_000,
    entryDelayMs: 10_000,
    positionUsd: 100,
    targetMultiple: 2,
    costModelKey: 'solana-conservative-v1',
    tradeFeeBps: 30,
    entrySlippageBps: 100,
    exitSlippageBps: 100,
    networkFeeUsdPerSide: 0.02,
  },
] as const;

export interface PaperSignalSnapshot {
  network: unknown;
  walletTypes: readonly OkxWalletCategory[];
  amountUsd: number | null;
  signaledAtMs: number;
  /** Только подтверждённое время создания пула. Время записи в БД не подходит. */
  poolCreatedAtMs: number | null;
  priceUsd: number | null;
}

export interface PaperSignalDecision {
  state: 'WAITING_PRICE' | 'WAITING_ENTRY' | 'ELIGIBLE' | 'SKIPPED';
  code: PaperAgentDecisionCode;
  decidedAtMs: number;
  latencyMs: number;
  tokenAgeMs: number | null;
}

function positive(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function evaluatePaperSignal(
  strategy: PaperAgentStrategy,
  signal: PaperSignalSnapshot,
  decidedAtMs: number,
): PaperSignalDecision {
  const latencyMs = Math.max(0, decidedAtMs - signal.signaledAtMs);
  const tokenAgeMs =
    signal.poolCreatedAtMs == null || !Number.isFinite(signal.poolCreatedAtMs)
      ? null
      : Math.max(0, decidedAtMs - signal.poolCreatedAtMs);
  const result = (
    state: PaperSignalDecision['state'],
    code: PaperAgentDecisionCode,
  ): PaperSignalDecision => ({ state, code, decidedAtMs, latencyMs, tokenAgeMs });

  if (normalizePaperAgentNetwork(signal.network) !== 'SOLANA') {
    return result('SKIPPED', 'NETWORK_NOT_SUPPORTED_PHASE_2');
  }

  if (
    !signal.walletTypes.some((type) =>
      (PAPER_AGENT_ALLOWED_WALLET_TYPES as readonly string[]).includes(type),
    )
  ) {
    return result('SKIPPED', 'UNSUPPORTED_SIGNAL_TYPE');
  }

  if (!positive(signal.amountUsd) || signal.amountUsd < strategy.minAmountUsd) {
    return result('SKIPPED', 'AMOUNT_BELOW_THRESHOLD');
  }

  if (tokenAgeMs == null) return result('SKIPPED', 'TOKEN_AGE_UNKNOWN');
  if (tokenAgeMs > strategy.maxTokenAgeMs) return result('SKIPPED', 'TOKEN_TOO_OLD');

  if (latencyMs > strategy.maxDecisionLatencyMs) {
    return result(
      'SKIPPED',
      positive(signal.priceUsd)
        ? 'DECISION_DEADLINE_EXCEEDED'
        : 'PRICE_UNAVAILABLE_BEFORE_DEADLINE',
    );
  }

  if (!positive(signal.priceUsd)) return result('WAITING_PRICE', 'WAITING_FOR_PRICE');
  if (latencyMs < strategy.entryDelayMs) {
    return result('WAITING_ENTRY', 'WAITING_FOR_ENTRY_DELAY');
  }

  return result('ELIGIBLE', 'ELIGIBLE');
}

export interface PaperEntry {
  positionUsd: number;
  sourcePriceUsd: number;
  executionPriceUsd: number;
  quantity: number;
  entryTradingFeeUsd: number;
  entryNetworkFeeUsd: number;
  entrySlippageUsd: number;
  entryFeeUsd: number;
  targetSourcePriceUsd: number;
}

export function openPaperPosition(
  strategy: PaperAgentStrategy,
  sourcePriceUsd: number,
): PaperEntry | null {
  if (!positive(sourcePriceUsd) || !positive(strategy.positionUsd)) return null;
  const feeRate = Math.max(0, strategy.tradeFeeBps) / 10_000;
  const slippageRate = Math.max(0, strategy.entrySlippageBps) / 10_000;
  const networkFeeUsd = Math.max(0, strategy.networkFeeUsdPerSide);
  if (feeRate >= 1 || slippageRate >= 1 || strategy.targetMultiple <= 0) return null;

  const entryTradingFeeUsd = strategy.positionUsd * feeRate;
  const entryNetworkFeeUsd = networkFeeUsd;
  const entryFeeUsd = entryTradingFeeUsd + entryNetworkFeeUsd;
  const executionPriceUsd = sourcePriceUsd * (1 + slippageRate);
  const spendableUsd = strategy.positionUsd - entryFeeUsd;
  if (spendableUsd <= 0) return null;
  const quantity = spendableUsd / executionPriceUsd;
  const entrySlippageUsd = quantity * (executionPriceUsd - sourcePriceUsd);

  return {
    positionUsd: strategy.positionUsd,
    sourcePriceUsd,
    executionPriceUsd,
    quantity,
    entryTradingFeeUsd,
    entryNetworkFeeUsd,
    entrySlippageUsd,
    entryFeeUsd,
    targetSourcePriceUsd: sourcePriceUsd * strategy.targetMultiple,
  };
}

export interface PaperMark {
  sourcePriceUsd: number;
  executionExitPriceUsd: number;
  grossExitUsd: number;
  exitTradingFeeUsd: number;
  exitNetworkFeeUsd: number;
  exitSlippageUsd: number;
  exitFeeUsd: number;
  totalCostsUsd: number;
  netExitUsd: number;
  pnlUsd: number;
  multiple: number;
  shouldClose: boolean;
}

export function markPaperPosition(
  strategy: PaperAgentStrategy,
  entry: PaperEntry,
  sourcePriceUsd: number,
): PaperMark | null {
  if (!positive(sourcePriceUsd) || !positive(entry.quantity)) return null;
  const feeRate = Math.max(0, strategy.tradeFeeBps) / 10_000;
  const slippageRate = Math.max(0, strategy.exitSlippageBps) / 10_000;
  if (feeRate >= 1 || slippageRate >= 1) return null;

  const executionExitPriceUsd = sourcePriceUsd * (1 - slippageRate);
  const grossExitUsd = entry.quantity * executionExitPriceUsd;
  const exitTradingFeeUsd = grossExitUsd * feeRate;
  const exitNetworkFeeUsd = Math.max(0, strategy.networkFeeUsdPerSide);
  const exitSlippageUsd = entry.quantity * (sourcePriceUsd - executionExitPriceUsd);
  const exitFeeUsd = exitTradingFeeUsd + exitNetworkFeeUsd;
  const netExitUsd = grossExitUsd - exitFeeUsd;
  const pnlUsd = netExitUsd - entry.positionUsd;
  const totalCostsUsd =
    entry.entryTradingFeeUsd +
    entry.entryNetworkFeeUsd +
    entry.entrySlippageUsd +
    exitTradingFeeUsd +
    exitNetworkFeeUsd +
    exitSlippageUsd;

  return {
    sourcePriceUsd,
    executionExitPriceUsd,
    grossExitUsd,
    exitTradingFeeUsd,
    exitNetworkFeeUsd,
    exitSlippageUsd,
    exitFeeUsd,
    totalCostsUsd,
    netExitUsd,
    pnlUsd,
    multiple: sourcePriceUsd / entry.sourcePriceUsd,
    shouldClose: sourcePriceUsd >= entry.targetSourcePriceUsd,
  };
}

export type PaperAgentHealthState = 'OFF' | 'STANDBY' | 'ACTIVE' | 'DEGRADED' | 'REFUSED';

export function paperAgentHealthState(input: {
  executionMode: string;
  enabled: boolean;
  socketHealthy: boolean;
  waitingForPrice: number;
  queued: number;
  lastActivityAtMs: number | null;
  nowMs: number;
}): PaperAgentHealthState {
  if (!paperAgentModeVerdict(input.executionMode).ok) return 'REFUSED';
  if (!input.enabled) return 'OFF';
  if (!input.socketHealthy || input.waitingForPrice > 0) return 'DEGRADED';
  if (
    input.queued > 0 ||
    (input.lastActivityAtMs != null && input.nowMs - input.lastActivityAtMs <= 15_000)
  ) {
    return 'ACTIVE';
  }
  return 'STANDBY';
}

const INTERVAL_SECONDS: Record<string, number> = {
  '1s': 1,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

/** Привязка persisted-события к началу свечи без зависимости от графика. */
export function paperAgentMarkerTime(eventTimeMs: number, interval: string): number | null {
  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds || !Number.isFinite(eventTimeMs)) return null;
  const timestamp = Math.floor(eventTimeMs / 1_000);
  return Math.floor(timestamp / seconds) * seconds;
}

/** Просадка от лучшей цены после входа, в процентах. */
export function paperDrawdownPct(peakPriceUsd: number, currentPriceUsd: number): number | null {
  if (!positive(peakPriceUsd) || currentPriceUsd < 0 || !Number.isFinite(currentPriceUsd)) {
    return null;
  }
  return ((peakPriceUsd - currentPriceUsd) / peakPriceUsd) * 100;
}

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(0, Math.min(1, p)) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}
