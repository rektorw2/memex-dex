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
  | 'INVALID_SIGNAL_TIMESTAMPS'
  | 'DECISION_DEADLINE_EXCEEDED'
  | 'PRICE_UNAVAILABLE_BEFORE_DEADLINE';

export const PAPER_SIGNAL_ORIGINS = [
  'WEBSOCKET_LIVE',
  'REST_RECONCILIATION',
  'REST_BACKFILL',
] as const;

export type PaperSignalOrigin = (typeof PAPER_SIGNAL_ORIGINS)[number];

export function isPaperSignalOrigin(value: unknown): value is PaperSignalOrigin {
  return (PAPER_SIGNAL_ORIGINS as readonly unknown[]).includes(value);
}

export function isLivePaperSignalOrigin(value: unknown): value is Exclude<PaperSignalOrigin, 'REST_BACKFILL'> {
  return value === 'WEBSOCKET_LIVE' || value === 'REST_RECONCILIATION';
}

export interface PaperSignalLatencies {
  /** Время доставки от отметки провайдера до сохранения нами. */
  providerDeliveryLatencyMs: number | null;
  /** Только скорость решения агента после получения сигнала. */
  agentDecisionLatencyMs: number | null;
  /** Полный путь; не является скоростью агента. */
  endToEndLatencyMs: number | null;
}

function orderedDifference(later: number, earlier: number): number | null {
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  const difference = later - earlier;
  return Number.isFinite(difference) && difference >= 0 ? difference : null;
}

export function paperSignalLatencies(input: {
  signaledAtMs: number;
  receivedAtMs: number;
  decidedAtMs: number;
}): PaperSignalLatencies {
  return {
    providerDeliveryLatencyMs: orderedDifference(input.receivedAtMs, input.signaledAtMs),
    agentDecisionLatencyMs: orderedDifference(input.decidedAtMs, input.receivedAtMs),
    endToEndLatencyMs: orderedDifference(input.decidedAtMs, input.signaledAtMs),
  };
}

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
  receivedAtMs: number;
  origin: PaperSignalOrigin;
  /** Только подтверждённое время создания пула. Время записи в БД не подходит. */
  poolCreatedAtMs: number | null;
  priceUsd: number | null;
}

export interface PaperSignalDecision {
  state: 'WAITING_PRICE' | 'WAITING_ENTRY' | 'ELIGIBLE' | 'SKIPPED';
  code: PaperAgentDecisionCode;
  decidedAtMs: number;
  /** Legacy alias for end-to-end latency; new reports must use named metrics. */
  latencyMs: number | null;
  providerDeliveryLatencyMs: number | null;
  agentDecisionLatencyMs: number | null;
  endToEndLatencyMs: number | null;
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
  const latencies = paperSignalLatencies({
    signaledAtMs: signal.signaledAtMs,
    receivedAtMs: signal.receivedAtMs,
    decidedAtMs,
  });
  const latencyMs = latencies.endToEndLatencyMs;
  const tokenAgeMs =
    signal.poolCreatedAtMs == null || !Number.isFinite(signal.poolCreatedAtMs)
      ? null
      : Math.max(0, decidedAtMs - signal.poolCreatedAtMs);
  const result = (
    state: PaperSignalDecision['state'],
    code: PaperAgentDecisionCode,
  ): PaperSignalDecision => ({
    state,
    code,
    decidedAtMs,
    latencyMs,
    ...latencies,
    tokenAgeMs,
  });

  if (latencyMs == null || latencies.agentDecisionLatencyMs == null) {
    return result('SKIPPED', 'INVALID_SIGNAL_TIMESTAMPS');
  }

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

export interface PaperAgentLatencyObservation {
  signalOrigin: unknown;
  providerDeliveryLatencyMs: number | null;
  agentDecisionLatencyMs: number | null;
  endToEndLatencyMs: number | null;
}

export interface PaperAgentLatencySummary {
  decisionLatencyP50Ms: number | null;
  decisionLatencyP95Ms: number | null;
  decisionLatencySampleSize: number;
  providerDeliveryLatencyP50Ms: number | null;
  providerDeliveryLatencyP95Ms: number | null;
  providerDeliveryLatencySampleSize: number;
  endToEndLatencyP50Ms: number | null;
  endToEndLatencyP95Ms: number | null;
  endToEndLatencySampleSize: number;
}

function validPersistedLatency(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/**
 * Агрегаты скорости считаются только по live/reconciliation-сигналам.
 * Исторический backfill, legacy-строки и невозможные отрицательные
 * интервалы не должны улучшать или ухудшать оперативные p50/p95.
 */
export function summarizePaperAgentLatencies(
  rows: readonly PaperAgentLatencyObservation[],
): PaperAgentLatencySummary {
  const live = rows.filter((row) => isLivePaperSignalOrigin(row.signalOrigin));
  const agent = live
    .map((row) => row.agentDecisionLatencyMs)
    .filter(validPersistedLatency);
  const provider = live
    .map((row) => row.providerDeliveryLatencyMs)
    .filter(validPersistedLatency);
  const endToEnd = live
    .map((row) => row.endToEndLatencyMs)
    .filter(validPersistedLatency);

  return {
    decisionLatencyP50Ms: percentile(agent, 0.5),
    decisionLatencyP95Ms: percentile(agent, 0.95),
    decisionLatencySampleSize: agent.length,
    providerDeliveryLatencyP50Ms: percentile(provider, 0.5),
    providerDeliveryLatencyP95Ms: percentile(provider, 0.95),
    providerDeliveryLatencySampleSize: provider.length,
    endToEndLatencyP50Ms: percentile(endToEnd, 0.5),
    endToEndLatencyP95Ms: percentile(endToEnd, 0.95),
    endToEndLatencySampleSize: endToEnd.length,
  };
}

export interface PaperDecisionDimension {
  signalId: string;
  state: string;
  decisionCode: string | null;
  signalOrigin: unknown;
  strategy: {
    key: string;
    version: number;
    kind: 'BASELINE' | 'SHADOW' | string;
  };
}

export interface PaperDecisionBreakdown {
  runs: number;
  uniqueRunSignals: number;
  averageRunsPerRunSignal: number | null;
  skipReasons: Record<string, number>;
  skipReasonsUniqueSignals: Record<string, number>;
  skipReasonsByStrategy: Record<string, Record<string, number>>;
  skipReasonsByContour: Record<string, Record<string, number>>;
  runsByOrigin: Record<string, number>;
  runsByStrategyKind: Record<string, number>;
  runsByStrategyVersion: Record<string, number>;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function incrementNested(
  target: Record<string, Record<string, number>>,
  group: string,
  key: string,
): void {
  target[group] ??= {};
  increment(target[group]!, key);
}

/** Объяснимая статистика runs без смешивания strategy versions. */
export function summarizePaperDecisionDimensions(
  rows: readonly PaperDecisionDimension[],
): PaperDecisionBreakdown {
  const uniqueSignals = new Set<string>();
  const uniqueSkipSignals = new Map<string, Set<string>>();
  const result: PaperDecisionBreakdown = {
    runs: rows.length,
    uniqueRunSignals: 0,
    averageRunsPerRunSignal: null,
    skipReasons: {},
    skipReasonsUniqueSignals: {},
    skipReasonsByStrategy: {},
    skipReasonsByContour: {},
    runsByOrigin: {},
    runsByStrategyKind: {},
    runsByStrategyVersion: {},
  };

  for (const row of rows) {
    uniqueSignals.add(row.signalId);
    const strategyVersion = `${row.strategy.key}@v${row.strategy.version}`;
    const origin = isPaperSignalOrigin(row.signalOrigin) ? row.signalOrigin : 'LEGACY_UNKNOWN';
    increment(result.runsByOrigin, origin);
    increment(result.runsByStrategyKind, row.strategy.kind);
    increment(result.runsByStrategyVersion, strategyVersion);

    if (row.state !== 'SKIPPED') continue;
    const reason = row.decisionCode ?? 'UNKNOWN';
    const contour = row.strategy.kind === 'SHADOW' ? 'SHADOW' : 'ACTIVE';
    increment(result.skipReasons, reason);
    incrementNested(result.skipReasonsByStrategy, strategyVersion, reason);
    incrementNested(result.skipReasonsByContour, contour, reason);
    const ids = uniqueSkipSignals.get(reason) ?? new Set<string>();
    ids.add(row.signalId);
    uniqueSkipSignals.set(reason, ids);
  }

  result.uniqueRunSignals = uniqueSignals.size;
  result.averageRunsPerRunSignal =
    uniqueSignals.size === 0 ? null : rows.length / uniqueSignals.size;
  result.skipReasonsUniqueSignals = Object.fromEntries(
    [...uniqueSkipSignals].map(([reason, ids]) => [reason, ids.size]),
  );
  return result;
}
