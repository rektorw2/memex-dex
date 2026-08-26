import { D, Decimal, type Numeric } from './money.js';

/** Phase 3 меняет только распределение PAPER-капитала. */
export type PaperAllocationMode = 'FIXED' | 'AUTOPILOT';
export type PaperRiskProfile = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
export type PaperSignalStrength = 'WEAK' | 'MEDIUM' | 'STRONG';

export const PAPER_ALLOCATION_SCORE_POLICY = {
  key: 'okx-signal-allocation-score',
  version: 1,
  freshnessMs: 60_000,
  bands: { medium: 40, strong: 70 },
} as const;

export interface PaperAllocationLimits {
  reservePct: number;
  maxExposurePct: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  minimumPositionUsd: string;
  dailyEntryLimit: number;
  drawdownStopPct: number;
  allowPartialAllocation: boolean;
}

export interface AllocationPolicySnapshot {
  mode: PaperAllocationMode;
  policyKey: string;
  policyVersion: number;
  riskProfile: PaperRiskProfile | null;
  limits: PaperAllocationLimits;
  scorePolicyKey: string;
  scorePolicyVersion: number;
}

export interface PaperSignalAllocationFacts {
  sourcePurchaseUsd: Numeric | null;
  walletTypes: readonly string[];
  tokenAgeMs: number | null;
  signalLatencyMs: number;
  liquidityUsd: Numeric | null;
  liquidityUpdatedAtMs: number | null;
  marketCapUsd: Numeric | null;
  marketCapUpdatedAtMs: number | null;
  /** Только статистика, рассчитанная до текущего сигнала. */
  historicalWalletWinRatePct: number | null;
  historicalWalletSampleSize: number | null;
  decidedAtMs: number;
}

export interface PaperSignalScore {
  score: number;
  band: PaperSignalStrength;
  sourceType: 'SMART_MONEY' | 'WHALE' | 'KOL' | 'UNKNOWN';
  reasons: string[];
  missingOrStale: string[];
  policyKey: string;
  policyVersion: number;
}

export interface AllocationContext {
  initialCapitalUsd: Numeric;
  freeBalanceUsd: Numeric;
  reservedBalanceUsd: Numeric;
  inPositionsUsd: Numeric;
  openPositions: number;
  entriesToday: number;
  currentDrawdownPct: number;
  policy: AllocationPolicySnapshot;
  signal: PaperSignalAllocationFacts;
}

export type AllocationDecisionCode =
  | 'ALLOCATED'
  | 'INVALID_CAPITAL_STATE'
  | 'RESERVE_VIOLATION'
  | 'DRAWDOWN_STOP'
  | 'MAX_POSITIONS_REACHED'
  | 'DAILY_ENTRY_LIMIT_REACHED'
  | 'EXPOSURE_LIMIT_REACHED'
  | 'INSUFFICIENT_FREE_BALANCE'
  | 'POSITION_BELOW_MINIMUM';

export interface AllocationDecision {
  allocated: boolean;
  code: AllocationDecisionCode;
  amountUsd: string | null;
  capitalPct: number | null;
  exposureAfterUsd: string;
  freeAfterUsd: string;
  reserveAfterUsd: string;
  score: PaperSignalScore;
  reason: string;
  policy: AllocationPolicySnapshot;
}

/** Контракт будущего adapter-а. В Phase 3 допустим только PAPER. */
export interface ExecutionRequest {
  execution: 'PAPER';
  network: 'SOLANA';
  runId: string;
  allocationSessionId: string;
  amountUsd: string;
  allocationMode: PaperAllocationMode;
  allocationPolicyKey: string;
  allocationPolicyVersion: number;
}

const PROFILE_LIMITS: Record<PaperRiskProfile, PaperAllocationLimits> = {
  CONSERVATIVE: {
    reservePct: 40,
    maxExposurePct: 60,
    maxPositionPct: 15,
    maxOpenPositions: 4,
    minimumPositionUsd: '5',
    dailyEntryLimit: 5,
    drawdownStopPct: 10,
    allowPartialAllocation: true,
  },
  BALANCED: {
    reservePct: 30,
    maxExposurePct: 70,
    maxPositionPct: 20,
    maxOpenPositions: 5,
    minimumPositionUsd: '5',
    dailyEntryLimit: 8,
    drawdownStopPct: 15,
    allowPartialAllocation: true,
  },
  AGGRESSIVE: {
    reservePct: 20,
    maxExposurePct: 80,
    maxPositionPct: 25,
    maxOpenPositions: 6,
    minimumPositionUsd: '5',
    dailyEntryLimit: 12,
    drawdownStopPct: 20,
    allowPartialAllocation: true,
  },
};

function finitePct(value: number, min = 0, max = 100): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export function validatePaperAllocationLimits(limits: PaperAllocationLimits): string | null {
  if (!finitePct(limits.reservePct, 0, 95)) return 'INVALID_RESERVE_PCT';
  if (!finitePct(limits.maxExposurePct, 1, 100)) return 'INVALID_MAX_EXPOSURE_PCT';
  if (!finitePct(limits.maxPositionPct, 0.01, 100)) return 'INVALID_MAX_POSITION_PCT';
  if (limits.reservePct + limits.maxExposurePct > 100) return 'RESERVE_AND_EXPOSURE_EXCEED_CAPITAL';
  if (limits.maxPositionPct > limits.maxExposurePct) return 'POSITION_EXCEEDS_EXPOSURE';
  if (!Number.isInteger(limits.maxOpenPositions) || limits.maxOpenPositions < 1 || limits.maxOpenPositions > 100) return 'INVALID_MAX_OPEN_POSITIONS';
  if (!Number.isInteger(limits.dailyEntryLimit) || limits.dailyEntryLimit < 1 || limits.dailyEntryLimit > 10_000) return 'INVALID_DAILY_ENTRY_LIMIT';
  if (!finitePct(limits.drawdownStopPct, 0.01, 100)) return 'INVALID_DRAWDOWN_STOP';
  try {
    if (!D(limits.minimumPositionUsd).isFinite() || D(limits.minimumPositionUsd).lte(0)) return 'INVALID_MINIMUM_POSITION';
  } catch {
    return 'INVALID_MINIMUM_POSITION';
  }
  return null;
}

export function fixedAllocationPolicy(input: {
  capitalUsd: Numeric;
  maxOpenPositions: number;
  reservePct?: number;
  minimumPositionUsd?: Numeric;
}): AllocationPolicySnapshot {
  const capital = D(input.capitalUsd);
  const reservePct = input.reservePct ?? 30;
  if (!capital.isFinite() || capital.lte(0)) throw new Error('INVALID_CAPITAL');
  if (!Number.isInteger(input.maxOpenPositions) || input.maxOpenPositions < 1 || input.maxOpenPositions > 100) throw new Error('INVALID_MAX_OPEN_POSITIONS');
  if (!finitePct(reservePct, 0, 95)) throw new Error('INVALID_RESERVE_PCT');
  const maxExposurePct = new Decimal(100).minus(reservePct).toNumber();
  const maxPositionPct = new Decimal(maxExposurePct)
    .div(input.maxOpenPositions)
    .toDecimalPlaces(8, Decimal.ROUND_DOWN)
    .toNumber();
  const limits: PaperAllocationLimits = {
    reservePct,
    maxExposurePct,
    maxPositionPct,
    maxOpenPositions: input.maxOpenPositions,
    minimumPositionUsd: D(input.minimumPositionUsd ?? 5).toFixed(),
    dailyEntryLimit: 10_000,
    drawdownStopPct: 100,
    allowPartialAllocation: false,
  };
  const invalid = validatePaperAllocationLimits(limits);
  if (invalid) throw new Error(invalid);
  return {
    mode: 'FIXED',
    policyKey: 'fixed-allocation',
    policyVersion: 1,
    riskProfile: null,
    limits,
    scorePolicyKey: PAPER_ALLOCATION_SCORE_POLICY.key,
    scorePolicyVersion: PAPER_ALLOCATION_SCORE_POLICY.version,
  };
}

export function autopilotAllocationPolicy(
  riskProfile: PaperRiskProfile,
  overrides: Partial<PaperAllocationLimits> = {},
): AllocationPolicySnapshot {
  const limits = { ...PROFILE_LIMITS[riskProfile], ...overrides };
  const invalid = validatePaperAllocationLimits(limits);
  if (invalid) throw new Error(invalid);
  return {
    mode: 'AUTOPILOT',
    policyKey: `autopilot-${riskProfile.toLowerCase()}`,
    policyVersion: 1,
    riskProfile,
    limits,
    scorePolicyKey: PAPER_ALLOCATION_SCORE_POLICY.key,
    scorePolicyVersion: PAPER_ALLOCATION_SCORE_POLICY.version,
  };
}

function numeric(value: Numeric | null): Decimal | null {
  if (value == null) return null;
  try {
    const parsed = D(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function fresh(value: Numeric | null, updatedAtMs: number | null, decidedAtMs: number): Decimal | null {
  const parsed = numeric(value);
  if (parsed == null || updatedAtMs == null || !Number.isFinite(updatedAtMs)) return null;
  if (updatedAtMs > decidedAtMs || decidedAtMs - updatedAtMs > PAPER_ALLOCATION_SCORE_POLICY.freshnessMs) return null;
  return parsed;
}

export function scorePaperAllocationSignal(facts: PaperSignalAllocationFacts): PaperSignalScore {
  let score = 0;
  const reasons: string[] = [];
  const missingOrStale: string[] = [];
  const wallet = facts.walletTypes.map((value) => value.trim().toLowerCase());
  const sourceType = wallet.includes('smart_money')
    ? 'SMART_MONEY'
    : wallet.includes('whale')
      ? 'WHALE'
      : wallet.includes('kol')
        ? 'KOL'
        : 'UNKNOWN';
  const sourcePoints = { SMART_MONEY: 30, WHALE: 22, KOL: 16, UNKNOWN: 0 }[sourceType];
  score += sourcePoints;
  reasons.push(`SOURCE_${sourceType}:${sourcePoints}`);

  const purchase = numeric(facts.sourcePurchaseUsd);
  const purchasePoints = purchase == null ? 0 : purchase.gte(10_000) ? 20 : purchase.gte(5_000) ? 12 : purchase.gte(1_000) ? 5 : 0;
  score += purchasePoints;
  reasons.push(`SOURCE_PURCHASE:${purchasePoints}`);
  if (purchase == null) missingOrStale.push('SOURCE_PURCHASE_UNKNOWN');

  const agePoints = facts.tokenAgeMs == null || !Number.isFinite(facts.tokenAgeMs)
    ? 0
    : facts.tokenAgeMs <= 5 * 60_000 ? 15 : facts.tokenAgeMs <= 15 * 60_000 ? 10 : facts.tokenAgeMs <= 30 * 60_000 ? 4 : 0;
  score += agePoints;
  reasons.push(`TOKEN_AGE:${agePoints}`);
  if (facts.tokenAgeMs == null) missingOrStale.push('TOKEN_AGE_UNKNOWN');

  const latencyPoints = !Number.isFinite(facts.signalLatencyMs) || facts.signalLatencyMs < 0
    ? 0
    : facts.signalLatencyMs <= 5_000 ? 12 : facts.signalLatencyMs <= 15_000 ? 8 : facts.signalLatencyMs <= 30_000 ? 3 : 0;
  score += latencyPoints;
  reasons.push(`SIGNAL_LATENCY:${latencyPoints}`);

  const liquidity = fresh(facts.liquidityUsd, facts.liquidityUpdatedAtMs, facts.decidedAtMs);
  const liquidityPoints = liquidity == null ? 0 : liquidity.gte(100_000) ? 10 : liquidity.gte(30_000) ? 7 : liquidity.gte(10_000) ? 3 : 0;
  score += liquidityPoints;
  reasons.push(`FRESH_LIQUIDITY:${liquidityPoints}`);
  if (liquidity == null) missingOrStale.push('LIQUIDITY_MISSING_OR_STALE');

  const marketCap = fresh(facts.marketCapUsd, facts.marketCapUpdatedAtMs, facts.decidedAtMs);
  const marketCapPoints = marketCap == null || marketCap.lte(0) ? 0 : marketCap.gte(10_000) && marketCap.lte(300_000) ? 8 : marketCap.lte(1_000_000) ? 4 : 1;
  score += marketCapPoints;
  reasons.push(`FRESH_MARKET_CAP:${marketCapPoints}`);
  if (marketCap == null) missingOrStale.push('MARKET_CAP_MISSING_OR_STALE');

  const historicalPoints = facts.historicalWalletSampleSize != null && Number.isInteger(facts.historicalWalletSampleSize) && facts.historicalWalletSampleSize >= 30 && facts.historicalWalletWinRatePct != null && finitePct(facts.historicalWalletWinRatePct)
    ? facts.historicalWalletWinRatePct >= 60 ? 5 : facts.historicalWalletWinRatePct >= 50 ? 3 : 0
    : 0;
  score += historicalPoints;
  reasons.push(`PRE_SIGNAL_WALLET_HISTORY:${historicalPoints}`);
  if (historicalPoints === 0 && (facts.historicalWalletSampleSize ?? 0) < 30) missingOrStale.push('WALLET_HISTORY_INSUFFICIENT');

  const bounded = Math.max(0, Math.min(100, score));
  const band: PaperSignalStrength = bounded >= PAPER_ALLOCATION_SCORE_POLICY.bands.strong
    ? 'STRONG'
    : bounded >= PAPER_ALLOCATION_SCORE_POLICY.bands.medium ? 'MEDIUM' : 'WEAK';
  return { score: bounded, band, sourceType, reasons, missingOrStale, policyKey: PAPER_ALLOCATION_SCORE_POLICY.key, policyVersion: PAPER_ALLOCATION_SCORE_POLICY.version };
}

function decimalText(value: Decimal): string {
  return value.toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed();
}

export function allocatePaperCapital(context: AllocationContext): AllocationDecision {
  const score = scorePaperAllocationSignal(context.signal);
  const policy = context.policy;
  const limits = policy.limits;
  const invalidLimits = validatePaperAllocationLimits(limits);
  const initial = numeric(context.initialCapitalUsd);
  const free = numeric(context.freeBalanceUsd);
  const reserved = numeric(context.reservedBalanceUsd);
  const inPositions = numeric(context.inPositionsUsd);
  const fallback = (code: AllocationDecisionCode, reason: string): AllocationDecision => ({
    allocated: false,
    code,
    amountUsd: null,
    capitalPct: null,
    exposureAfterUsd: decimalText(inPositions ?? new Decimal(0)),
    freeAfterUsd: decimalText(free ?? new Decimal(0)),
    reserveAfterUsd: decimalText(reserved ?? new Decimal(0)),
    score,
    reason,
    policy,
  });
  if (
    invalidLimits || !initial || !free || !reserved || !inPositions ||
    initial.lte(0) || free.lt(0) || reserved.lt(0) || inPositions.lt(0) ||
    !Number.isInteger(context.openPositions) || context.openPositions < 0 ||
    !Number.isInteger(context.entriesToday) || context.entriesToday < 0 ||
    !Number.isFinite(context.currentDrawdownPct) || context.currentDrawdownPct < 0
  ) return fallback('INVALID_CAPITAL_STATE', invalidLimits ?? 'INVALID_CAPITAL_STATE');
  const minimumReserve = initial.mul(limits.reservePct).div(100);
  if (reserved.lt(minimumReserve)) return fallback('RESERVE_VIOLATION', 'MINIMUM_RESERVE_NOT_AVAILABLE');
  if (!Number.isFinite(context.currentDrawdownPct) || context.currentDrawdownPct >= limits.drawdownStopPct) return fallback('DRAWDOWN_STOP', 'DRAWDOWN_LIMIT_REACHED');
  if (!Number.isInteger(context.openPositions) || context.openPositions >= limits.maxOpenPositions) return fallback('MAX_POSITIONS_REACHED', 'MAX_OPEN_POSITIONS_REACHED');
  if (!Number.isInteger(context.entriesToday) || context.entriesToday >= limits.dailyEntryLimit) return fallback('DAILY_ENTRY_LIMIT_REACHED', 'DAILY_ENTRY_LIMIT_REACHED');

  const maxExposure = initial.mul(limits.maxExposurePct).div(100);
  const exposureCapacity = Decimal.max(0, maxExposure.minus(inPositions));
  if (exposureCapacity.lte(0)) return fallback('EXPOSURE_LIMIT_REACHED', 'MAX_EXPOSURE_REACHED');
  if (free.lte(0)) return fallback('INSUFFICIENT_FREE_BALANCE', 'NO_FREE_BALANCE');

  const maxPosition = initial.mul(limits.maxPositionPct).div(100);
  const strengthMultiplier = policy.mode === 'FIXED' ? new Decimal(1) : score.band === 'STRONG' ? new Decimal(1) : score.band === 'MEDIUM' ? new Decimal('0.75') : new Decimal('0.5');
  const requested = maxPosition.mul(strengthMultiplier).toDecimalPlaces(8, Decimal.ROUND_DOWN);
  const capacity = Decimal.min(free, exposureCapacity);
  if (requested.gt(capacity) && !limits.allowPartialAllocation) {
    return fallback(free.lt(requested) ? 'INSUFFICIENT_FREE_BALANCE' : 'EXPOSURE_LIMIT_REACHED', 'FULL_ALLOCATION_NOT_AVAILABLE');
  }
  const amount = limits.allowPartialAllocation ? Decimal.min(requested, capacity) : requested;
  if (amount.lt(D(limits.minimumPositionUsd))) return fallback('POSITION_BELOW_MINIMUM', 'ALLOCATION_BELOW_MINIMUM');
  const freeAfter = free.minus(amount);
  const exposureAfter = inPositions.plus(amount);
  if (freeAfter.lt(0) || exposureAfter.gt(maxExposure)) return fallback('INVALID_CAPITAL_STATE', 'ALLOCATION_INVARIANT_FAILED');
  return {
    allocated: true,
    code: 'ALLOCATED',
    amountUsd: decimalText(amount),
    capitalPct: amount.div(initial).mul(100).toDecimalPlaces(6).toNumber(),
    exposureAfterUsd: decimalText(exposureAfter),
    freeAfterUsd: decimalText(freeAfter),
    reserveAfterUsd: decimalText(reserved),
    score,
    reason: `${policy.mode}_${score.band}_POSITION`,
    policy,
  };
}

export interface PaperCapitalLedgerSnapshot {
  initialCapitalUsd: string;
  freeBalanceUsd: string;
  reservedBalanceUsd: string;
  inPositionsUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string;
  tradingFeesUsd: string;
  slippageUsd: string;
  networkCostsUsd: string;
  equityUsd: string;
  peakEquityUsd: string;
  drawdownPct: string;
  openPositions: number;
}

export function initialPaperCapitalLedger(capitalUsd: Numeric, reservePct: number): PaperCapitalLedgerSnapshot {
  const capital = D(capitalUsd);
  if (!capital.isFinite() || capital.lte(0) || !finitePct(reservePct, 0, 95)) throw new Error('INVALID_CAPITAL');
  const reserved = capital.mul(reservePct).div(100).toDecimalPlaces(8, Decimal.ROUND_UP);
  return {
    initialCapitalUsd: decimalText(capital), freeBalanceUsd: decimalText(capital.minus(reserved)), reservedBalanceUsd: decimalText(reserved), inPositionsUsd: '0', realizedPnlUsd: '0', unrealizedPnlUsd: '0', tradingFeesUsd: '0', slippageUsd: '0', networkCostsUsd: '0', equityUsd: decimalText(capital), peakEquityUsd: decimalText(capital), drawdownPct: '0', openPositions: 0,
  };
}

export function openPaperCapitalLedger(snapshot: PaperCapitalLedgerSnapshot, amountUsd: Numeric): PaperCapitalLedgerSnapshot {
  const amount = D(amountUsd);
  const free = D(snapshot.freeBalanceUsd);
  if (!amount.isFinite() || amount.lte(0) || free.lt(amount)) throw new Error('INSUFFICIENT_FREE_BALANCE');
  return { ...snapshot, freeBalanceUsd: decimalText(free.minus(amount)), inPositionsUsd: decimalText(D(snapshot.inPositionsUsd).plus(amount)), openPositions: snapshot.openPositions + 1 };
}

export function closePaperCapitalLedger(snapshot: PaperCapitalLedgerSnapshot, input: {
  allocatedUsd: Numeric; netExitUsd: Numeric; tradingFeesUsd: Numeric; slippageUsd: Numeric; networkCostsUsd: Numeric;
}): PaperCapitalLedgerSnapshot {
  const allocated = D(input.allocatedUsd);
  const netExit = D(input.netExitUsd);
  const tradingFees = D(input.tradingFeesUsd);
  const slippage = D(input.slippageUsd);
  const networkCosts = D(input.networkCostsUsd);
  const inPositions = D(snapshot.inPositionsUsd);
  if (
    !allocated.isFinite() || !netExit.isFinite() || !tradingFees.isFinite() ||
    !slippage.isFinite() || !networkCosts.isFinite() || allocated.lte(0) ||
    netExit.lt(0) || tradingFees.lt(0) || slippage.lt(0) || networkCosts.lt(0) ||
    inPositions.lt(allocated) || snapshot.openPositions < 1
  ) throw new Error('INVALID_CLOSE');
  const realized = netExit.minus(allocated);
  const freeAfter = D(snapshot.freeBalanceUsd).plus(netExit);
  const inPositionsAfter = inPositions.minus(allocated);
  const realizedAfter = D(snapshot.realizedPnlUsd).plus(realized);
  const equity = freeAfter.plus(snapshot.reservedBalanceUsd).plus(inPositionsAfter).plus(snapshot.unrealizedPnlUsd);
  const peak = Decimal.max(D(snapshot.peakEquityUsd), equity);
  const drawdown = peak.lte(0) ? new Decimal(0) : peak.minus(equity).div(peak).mul(100);
  return {
    ...snapshot,
    freeBalanceUsd: decimalText(freeAfter), inPositionsUsd: decimalText(inPositionsAfter), realizedPnlUsd: decimalText(realizedAfter),
    tradingFeesUsd: decimalText(D(snapshot.tradingFeesUsd).plus(tradingFees)), slippageUsd: decimalText(D(snapshot.slippageUsd).plus(slippage)), networkCostsUsd: decimalText(D(snapshot.networkCostsUsd).plus(networkCosts)),
    equityUsd: decimalText(equity), peakEquityUsd: decimalText(peak), drawdownPct: decimalText(drawdown), openPositions: snapshot.openPositions - 1,
  };
}
