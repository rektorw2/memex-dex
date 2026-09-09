import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  isLivePaperSignalOrigin,
  paperAgentHealthState,
  paperAgentMarkerTime,
  percentile,
  summarizePaperAgentLatencies,
  summarizePaperDecisionDimensions,
  liveReadiness,
  liveReadinessStage,
  liveReadinessWithDiagnostics,
  phase4SectionsVerdict,
  SOLANA_DEPOSIT_ASSETS,
  depositNetworkStatus,
  PAPER_EXIT_MODE_LABELS,
  PAPER_EXIT_PRESETS,
  allowedExitModes,
  exitPlanAllowed,
  AGENT_NETWORK_INFO,
  isExitModeAllowed,
  describePaperExitPlan,
  paperExitPlan,
  type PaperExitPlan,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { getOkxSignalIngestStatus } from '../workers/okx-signal-ingest.js';
import { agentNetworksReadiness, readyAgentNetworks } from '../services/agent-networks.js';
import { readFundingSafetyState } from '../services/prisma-solana-reconciliation-repository.js';
import { readSigningState } from '../services/signing-state.js';
import { readSchemaReadiness } from '../services/schema-readiness.js';
import {
  ensurePaperAgentConfig,
  getPaperAgentRuntimeStatus,
  paperAgentStartVerdict,
  setPaperAgentEnabledCache,
} from '../workers/paper-agent.js';
import {
  getPaperAgentNotificationRuntime,
} from '../workers/paper-agent-notifications.js';
import {
  closeAllPaperPositions,
  configurePaperAllocationAccounts,
  resetPaperAllocationAccount,
} from '../services/paper-agent-allocation.js';
import {
  createPaperTestSignal,
  createPaperTestToken,
  setPaperTestPrice,
} from '../services/paper-test-source.js';

const CONTROL_ID = 'primary';
const SAMPLE_LIMIT = 5_000;
const MIN_CLOSED_FOR_COMPARISON = 30;

/** Результат чтения дополнительного раздела. */
type SectionResult<T> = { ok: true; value: T } | { ok: false };

/** Куда пишется настоящая причина отказа раздела. */
type SectionLogger = { error: (details: Record<string, unknown>, message: string) => void };

/**
 * Чтение дополнительного раздела, сбой которого не роняет ответ.
 *
 * Два разных адресата, и путать их нельзя. В журнал уходит настоящая
 * причина вместе с `reqId`: без неё дежурный видит «раздел недоступен»
 * и не может ничего сделать. Человеку не уходит ничего — ни текста
 * ошибки, ни имени таблицы, ни кода драйвера.
 *
 * Ловится любая ошибка. Разбирать её здесь на «ожидаемые» и
 * «неожиданные» значило бы завести список, который однажды разойдётся
 * с реальностью, и вернуть тот же пустой экран для случая, забытого
 * в списке.
 */
async function optionalSection<T>(
  read: () => Promise<T>,
  /*
   * Имя раздела перечислением, а не строкой.
   *
   * Оно попадает в журнал и в `unavailable`, который видит человек.
   * Свободная строка означала бы, что опечатка в имени раздела
   * доедет до экрана и там будет выглядеть новым видом сбоя.
   */
  section: 'funding' | 'signing' | 'schema',
  log: SectionLogger,
): Promise<SectionResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    log.error(
      { section, err: error },
      'диагностический раздел /agent недоступен, ответ отдан без него',
    );
    return { ok: false };
  }
}

function numberOf(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeRuns(rows: Array<{
  signalId: string;
  state: string;
  signalOrigin: string | null;
  agentDecisionLatencyMs: number | null;
  realizedPnlUsd: unknown;
  unrealizedPnlUsd: unknown;
  maxMultiple: unknown;
  maxDrawdownPct: unknown;
  totalCostsUsd: unknown;
  entryAt: Date | null;
  exitAt: Date | null;
}>) {
  const closedPnl = rows
    .filter((row) => row.state === 'PAPER_CLOSED')
    .map((row) => numberOf(row.realizedPnlUsd))
    .filter((value): value is number => value != null);
  const openPnl = rows
    .filter((row) => row.state === 'PAPER_OPEN')
    .map((row) => numberOf(row.unrealizedPnlUsd))
    .filter((value): value is number => value != null);
  const multiples = rows
    .map((row) => numberOf(row.maxMultiple))
    .filter((value): value is number => value != null);
  const drawdowns = rows
    .map((row) => numberOf(row.maxDrawdownPct))
    .filter((value): value is number => value != null);
  const costs = rows
    .map((row) => numberOf(row.totalCostsUsd))
    .filter((value): value is number => value != null);
  const latencies = rows
    .filter((row) => isLivePaperSignalOrigin(row.signalOrigin))
    .map((row) => row.agentDecisionLatencyMs)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  const durations = rows
    .filter((row) => row.entryAt && row.exitAt)
    .map((row) => row.exitAt!.getTime() - row.entryAt!.getTime())
    .filter((value) => value >= 0 && Number.isFinite(value));
  const closed = closedPnl.length;
  const skipped = rows.filter((row) => row.state === 'SKIPPED').length;
  const entries = rows.filter((row) => ['PAPER_OPEN', 'PAPER_CLOSED'].includes(row.state)).length;
  const positive = closedPnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(
    closedPnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );

  return {
    signals: new Set(rows.map((row) => row.signalId)).size,
    runs: rows.length,
    entries,
    skipped,
    skipRatePct: rows.length === 0 ? null : (skipped / rows.length) * 100,
    open: rows.filter((row) => row.state === 'PAPER_OPEN').length,
    closed,
    averagePnlUsd: average(closedPnl),
    medianPnlUsd: percentile(closedPnl, 0.5),
    totalNetPnlUsd:
      closedPnl.length === 0 ? null : closedPnl.reduce((sum, value) => sum + value, 0),
    realizedPnlUsd:
      closedPnl.length === 0 ? null : closedPnl.reduce((sum, value) => sum + value, 0),
    unrealizedPnlUsd:
      openPnl.length === 0 ? null : openPnl.reduce((sum, value) => sum + value, 0),
    winRatePct:
      closedPnl.length === 0
        ? null
        : (closedPnl.filter((value) => value > 0).length / closedPnl.length) * 100,
    averageMaxMultiple: average(multiples),
    medianMaxMultiple: percentile(multiples, 0.5),
    worstDrawdownPct: drawdowns.length === 0 ? null : Math.max(...drawdowns),
    profitFactor: negative === 0 ? (positive > 0 ? null : null) : positive / negative,
    averageDurationMs: average(durations),
    decisionLatencyP50Ms: percentile(latencies, 0.5),
    decisionLatencyP95Ms: percentile(latencies, 0.95),
    decisionLatencySampleSize: latencies.length,
    totalCostsUsd: costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0),
    sampleSize: closed,
    minimumSampleSize: MIN_CLOSED_FOR_COMPARISON,
    enoughData: closed >= MIN_CLOSED_FOR_COMPARISON,
  };
}

function serializeRun(run: any) {
  const activeAllocation = run.allocations?.find((row: any) => !row.isShadow) ?? null;
  return {
    id: run.id,
    tokenId: run.tokenId,
    state: run.state,
    decisionCode: run.decisionCode,
    errorCode: run.errorCode,
    strategyKey: run.strategy.key,
    strategyLabel: run.strategy.label,
    providerKey: run.providerKey,
    chain: run.chain,
    address: run.address,
    symbol: run.symbol,
    token: run.token
      ? {
          id: run.token.id,
          symbol: run.token.symbol,
          name: run.token.name,
          logoUrl: run.token.logoUrl,
        }
      : null,
    walletTypes: run.walletTypes,
    triggerWalletAddresses: run.triggerWalletAddresses,
    signalAmountUsd: numberOf(run.signalAmountUsd),
    signaledAt: run.signaledAt.toISOString(),
    decidedAt: run.decidedAt?.toISOString() ?? null,
    latencyMs: run.latencyMs,
    signalOrigin: run.signalOrigin,
    providerDeliveryLatencyMs: run.providerDeliveryLatencyMs,
    agentDecisionLatencyMs: run.agentDecisionLatencyMs,
    endToEndLatencyMs: run.endToEndLatencyMs,
    tokenAgeMs: run.tokenAgeMs,
    decisionPriceUsd: numberOf(run.decisionPriceUsd),
    entryAt: run.entryAt?.toISOString() ?? null,
    entryPriceUsd: numberOf(run.entryExecutionPriceUsd),
    targetPriceUsd: numberOf(run.targetSourcePriceUsd),
    currentPriceUsd: numberOf(run.currentSourcePriceUsd),
    unrealizedPnlUsd: numberOf(run.unrealizedPnlUsd),
    realizedPnlUsd: numberOf(run.realizedPnlUsd),
    maxMultiple: numberOf(run.maxMultiple),
    maxDrawdownPct: numberOf(run.maxDrawdownPct),
    exitAt: run.exitAt?.toISOString() ?? null,
    exitReason: run.exitReason,
    positionUsd: numberOf(run.positionUsd),
    costModelKey: run.costModelKey,
    tradeFeeBps: run.tradeFeeBps,
    entrySlippageBps: run.entrySlippageBps,
    exitSlippageBps: run.exitSlippageBps,
    networkFeeUsdPerSide: numberOf(run.networkFeeUsdPerSide),
    totalCostsUsd: numberOf(run.totalCostsUsd),
    durationMs:
      run.entryAt && run.exitAt ? Math.max(0, run.exitAt.getTime() - run.entryAt.getTime()) : null,
    warnings: run.warnings,
    allocation: activeAllocation
      ? {
          id: activeAllocation.id,
          mode: activeAllocation.mode,
          policyKey: activeAllocation.policyKey,
          policyVersion: activeAllocation.policyVersion,
          riskProfile: activeAllocation.riskProfile,
          allocatedUsd: numberOf(activeAllocation.allocatedUsd),
          capitalPct: numberOf(activeAllocation.capitalPct),
          signalScore: activeAllocation.signalScore,
          signalBand: activeAllocation.signalBand,
          reason: activeAllocation.allocationReason,
          state: activeAllocation.state,
          exit: allocationExitView(activeAllocation),
        }
      : { legacy: true, label: 'Legacy Phase 1/2' },
  };
}

/**
 * Правило выхода — словами, для интерфейса.
 *
 * У счетов, созданных до появления режимов, плана в снимке нет:
 * это TARGET, и он назван явно, а не показан пустым полем.
 */
function exitPlanView(plan: PaperExitPlan | undefined | null) {
  const effective = plan ?? PAPER_EXIT_PRESETS.TARGET;
  return {
    mode: effective.mode,
    label: PAPER_EXIT_MODE_LABELS[effective.mode]?.label ?? effective.mode,
    description: describePaperExitPlan(effective),
    plan: effective,
  };
}

/** Ход исполнения плана на одной позиции: остаток, ступени, действующий стоп. */
function allocationExitView(allocation: any) {
  const plan = allocationExitPlanOf(allocation);
  const state = (allocation.exitState ?? null) as {
    remainingPct?: number; legsFilled?: number; legsTotal?: number;
    stopSourcePriceUsd?: number | null; stopReason?: string | null; nextTargetSourcePriceUsd?: number | null;
  } | null;
  return {
    mode: plan.mode,
    label: PAPER_EXIT_MODE_LABELS[plan.mode]?.label ?? plan.mode,
    description: describePaperExitPlan(plan),
    remainingPct: state?.remainingPct ?? 100,
    legsFilled: state?.legsFilled ?? 0,
    legsTotal: state?.legsTotal ?? plan.legs.length,
    stopPriceUsd: state?.stopSourcePriceUsd ?? null,
    stopReason: state?.stopReason ?? null,
    nextTargetPriceUsd: state?.nextTargetSourcePriceUsd ?? numberOf(allocation.targetSourcePriceUsd),
    exitReason: allocation.exitReason ?? null,
  };
}

function allocationExitPlanOf(allocation: any): PaperExitPlan {
  const stored = allocation.exitPlan as PaperExitPlan | null | undefined;
  if (stored && typeof stored === 'object' && typeof stored.mode === 'string') return stored;
  const fromPolicy = (allocation.policySnapshot as { exitPlan?: PaperExitPlan } | null)?.exitPlan;
  return fromPolicy ?? PAPER_EXIT_PRESETS.TARGET;
}

function serializeAccount(row: any) {
  const currentEquity = numberOf(row.equityUsd);
  const dayCutoff = Date.now() - 24 * 60 * 60 * 1_000;
  const dailyLedger = (row.ledger ?? []).filter(
    (entry: any) => entry.createdAt.getTime() >= dayCutoff,
  );
  const dayStartEquity = dailyLedger.length
    ? numberOf(dailyLedger[dailyLedger.length - 1]?.equityAfterUsd)
    : null;
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    policyKey: row.policyKey,
    policyVersion: row.policyVersion,
    riskProfile: row.riskProfile,
    policySnapshot: row.policySnapshot,
    exitPlan: exitPlanView((row.policySnapshot as { exitPlan?: PaperExitPlan } | null)?.exitPlan),
    capital: {
      initialUsd: numberOf(row.initialCapitalUsd),
      freeUsd: numberOf(row.freeBalanceUsd),
      reservedUsd: numberOf(row.reservedBalanceUsd),
      inPositionsUsd: numberOf(row.inPositionsUsd),
      equityUsd: numberOf(row.equityUsd),
      realizedPnlUsd: numberOf(row.realizedPnlUsd),
      unrealizedPnlUsd: numberOf(row.unrealizedPnlUsd),
      tradingFeesUsd: numberOf(row.tradingFeesUsd),
      slippageUsd: numberOf(row.slippageUsd),
      networkCostsUsd: numberOf(row.networkCostsUsd),
      peakEquityUsd: numberOf(row.peakEquityUsd),
      drawdownPct: numberOf(row.drawdownPct),
      dailyChangeUsd:
        currentEquity != null && dayStartEquity != null ? currentEquity - dayStartEquity : null,
    },
    limits: {
      reservePct: numberOf(row.reservePct),
      maxExposurePct: numberOf(row.maxExposurePct),
      maxPositionPct: numberOf(row.maxPositionPct),
      maxOpenPositions: row.maxOpenPositions,
      minimumPositionUsd: numberOf(row.minimumPositionUsd),
      dailyEntryLimit: row.dailyEntryLimit,
      drawdownStopPct: numberOf(row.drawdownStopPct),
      allowPartialAllocation: row.allowPartialAllocation,
    },
    openPositions: row.openPositions,
    dailyEntries: row.dailyEntries,
    dailyEntriesDate: row.dailyEntriesDate.toISOString(),
    resetFromId: row.resetFromId,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    ledger: (row.ledger ?? []).map((entry: any) => ({
      id: entry.id,
      eventType: entry.eventType,
      amountUsd: numberOf(entry.amountUsd),
      freeAfterUsd: numberOf(entry.freeAfterUsd),
      reservedAfterUsd: numberOf(entry.reservedAfterUsd),
      inPositionsAfterUsd: numberOf(entry.inPositionsAfterUsd),
      realizedPnlAfterUsd: numberOf(entry.realizedPnlAfterUsd),
      equityAfterUsd: numberOf(entry.equityAfterUsd),
      tradingFeesAfterUsd: numberOf(entry.tradingFeesAfterUsd),
      slippageAfterUsd: numberOf(entry.slippageAfterUsd),
      networkCostsAfterUsd: numberOf(entry.networkCostsAfterUsd),
      createdAt: entry.createdAt.toISOString(),
      allocation: entry.allocation
        ? {
            decisionCode: entry.allocation.decisionCode,
            reason: entry.allocation.allocationReason,
            signalScore: entry.allocation.signalScore,
            tokenId: entry.allocation.run.tokenId,
            symbol: entry.allocation.run.symbol,
            address: entry.allocation.run.address,
            chain: entry.allocation.run.chain,
            signalOrigin: entry.allocation.run.signalOrigin,
            token: entry.allocation.run.token,
          }
        : null,
    })),
  };
}

/**
 * DTO продуктового экрана.
 *
 * Обычному пользователю не нужны provider keys, адреса кошельков-источников,
 * внутренние error codes и полная история policy. Они остаются только в
 * административном endpoint. Здесь — состояние PAPER-счёта и объяснимые
 * события, достаточные для проверки работы агента.
 */
export function publicSnapshotOf(snapshot: any, isAdmin: boolean) {
  const activeAccount = snapshot.allocation.accounts.find(
    (account: any) => account.kind === 'ACTIVE' && account.status !== 'CLOSED',
  ) ?? null;
  const publicRun = (run: any) => ({
    id: run.id,
    tokenId: run.tokenId,
    token: run.token,
    state: run.state,
    decisionCode: run.decisionCode,
    strategyLabel: run.strategyLabel,
    chain: run.chain,
    address: run.address,
    symbol: run.symbol,
    signaledAt: run.signaledAt,
    decidedAt: run.decidedAt,
    signalOrigin: run.signalOrigin,
    entryAt: run.entryAt,
    exitAt: run.exitAt,
    entryPriceUsd: run.entryPriceUsd,
    currentPriceUsd: run.currentPriceUsd,
    realizedPnlUsd: run.realizedPnlUsd,
    unrealizedPnlUsd: run.unrealizedPnlUsd,
    maxMultiple: run.maxMultiple,
    durationMs: run.durationMs,
    positionUsd: run.positionUsd,
    totalCostsUsd: run.totalCostsUsd,
    allocation: run.allocation,
  });
  const activeRuns = snapshot.positions.open.filter(
    (run: any) => run.allocation && run.allocation.legacy !== true,
  );
  const lastDecision = snapshot.decisions.find((run: any) => run.decidedAt != null) ?? null;

  return {
    paper: true,
    /* Сети — в phase4.networks с готовностью; здесь — готовые списком, для старых клиентов строка. */
    network: readyAgentNetworks().map((chain) => AGENT_NETWORK_INFO[chain].label).join(', ') || 'нет готовых сетей',
    networks: readyAgentNetworks(),
    viewer: { isAdmin },
    health: snapshot.health,
    control: {
      isEnabled: snapshot.control.isEnabled,
      activeAllocationMode: snapshot.control.activeAllocationMode,
      learningModeEnabled: snapshot.control.learningModeEnabled,
    },
    runtime: {
      running: snapshot.runtime.running,
      lastActivityAt: snapshot.runtime.lastActivityAt,
      queued: snapshot.runtime.queued,
      // Причина паузы входов от источника сигналов; `null` — источник доступен.
      entriesPausedBySource: snapshot.runtime.entriesPausedBySource ?? null,
    },
    source: {
      transportMode: snapshot.okxSignal.transportMode,
      socketState: snapshot.okxSignal.socket?.state ?? null,
      lastSignalAt: snapshot.okxSignal.lastSignalAt,
      lastRestSuccessAt: snapshot.okxSignal.lastRestSuccessAt,
      nextRestReconciliationAt: snapshot.okxSignal.nextRestReconciliationAt,
      fallbackActive: snapshot.okxSignal.transportMode === 'REST_ONLY' || (snapshot.okxSignal.socket?.state !== 'connected' && snapshot.okxSignal.lastRestSuccessAt != null),
      loginVerified: snapshot.okxSignal.socket?.loginVerified ?? false,
      subscriptionsVerified: snapshot.okxSignal.socket?.subscriptionsVerified ?? false,
      lastSubscriptionAt: snapshot.okxSignal.socket?.lastSubscriptionAt ?? null,
      lastWsEventAt: snapshot.okxSignal.socket?.lastChannelEventAt ?? null,
      nextAccessCheckAt: snapshot.okxSignal.socket?.nextAccessCheckAt ?? null,
      accessMessage: snapshot.okxSignal.accessMessage ?? null,
      lastRestErrorCode: snapshot.okxSignal.lastRestErrorCode ?? null,
      providerDeliveryLatencyMs: lastDecision?.providerDeliveryLatencyMs ?? null,
      agentDecisionLatencyMs: lastDecision?.agentDecisionLatencyMs ?? null,
    },
    lastDecisionAt: lastDecision?.decidedAt ?? null,
    notifications: {
      unread: snapshot.notifications.unread,
      telegramEnabled: snapshot.notifications.telegramEnabled,
    },
    metrics24h: {
      uniqueSignals: snapshot.metrics24h.uniqueSignals,
      runs: snapshot.metrics24h.runs,
      openPositions: snapshot.metrics24h.openPositions,
      closedPositions: snapshot.metrics24h.states.PAPER_CLOSED ?? 0,
      capitalUtilizationPct:
        activeAccount?.capital.initialUsd > 0
          ? (activeAccount.capital.inPositionsUsd / activeAccount.capital.initialUsd) * 100
          : 0,
    },
    wallet: activeAccount,
    positions: activeRuns.map(publicRun),
    recentDecisions: snapshot.decisions.slice(0, 60).map(publicRun),
    analytics: {
      strategyCount: snapshot.comparison.length,
      decisionLatencyP50Ms: snapshot.metrics24h.decisionLatencyP50Ms,
      decisionLatencyP95Ms: snapshot.metrics24h.decisionLatencyP95Ms,
      validLatencySampleSize: snapshot.metrics24h.decisionLatencySampleSize,
    },
    phase4: snapshot.phase4,
  };
}

function summarizeAllocations(rows: any[]) {
  const closed = rows.filter((row) => row.state === 'CLOSED');
  const open = rows.filter((row) => row.state === 'OPEN');
  const entries = rows.filter((row) => ['OPEN', 'CLOSED'].includes(row.state));
  const realized = closed
    .map((row) => numberOf(row.realizedPnlUsd))
    .filter((value): value is number => value != null);
  const costs = closed
    .map((row) => numberOf(row.totalCostsUsd))
    .filter((value): value is number => value != null);
  const unrealized = open
    .map((row) => numberOf(row.unrealizedPnlUsd))
    .filter((value): value is number => value != null);
  const allocations = entries
    .map((row) => numberOf(row.allocatedUsd))
    .filter((value): value is number => value != null);
  const reserves = rows
    .map((row) => numberOf(row.reserveAfterUsd))
    .filter((value): value is number => value != null);
  const exposures = rows
    .map((row) => numberOf(row.exposureAfterUsd))
    .filter((value): value is number => value != null);
  const drawdowns = entries
    .map((row) => numberOf(row.maxDrawdownPct))
    .filter((value): value is number => value != null);
  const multiples = entries
    .map((row) => numberOf(row.maxMultiple))
    .filter((value): value is number => value != null);
  const latencies = rows
    .filter((row) => isLivePaperSignalOrigin(row.run?.signalOrigin))
    .map((row) => row.run?.agentDecisionLatencyMs)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  const durations = closed
    .filter((row) => row.entryAt && row.exitAt)
    .map((row) => row.exitAt.getTime() - row.entryAt.getTime())
    .filter((value) => value >= 0 && Number.isFinite(value));
  const tradingFees = closed
    .map((row) => numberOf(row.tradingFeesUsd))
    .filter((value): value is number => value != null);
  const slippage = closed
    .map((row) => numberOf(row.slippageUsd))
    .filter((value): value is number => value != null);
  const networkCosts = closed
    .map((row) => numberOf(row.networkCostsUsd))
    .filter((value): value is number => value != null);
  const positive = realized.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(
    realized.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );
  const pnlBySourceType: Record<string, { count: number; netPnlUsd: number }> = {};
  const pnlByScoreBand: Record<string, { count: number; netPnlUsd: number }> = {};
  for (const row of entries) {
    const facts = row.inputFacts && typeof row.inputFacts === 'object'
      ? row.inputFacts as Record<string, unknown>
      : {};
    const wallets = Array.isArray(facts.walletTypes)
      ? facts.walletTypes.map((value) => String(value).toLowerCase())
      : [];
    const sourceType = wallets.includes('smart_money')
      ? 'SMART_MONEY'
      : wallets.includes('whale') ? 'WHALE' : wallets.includes('kol') ? 'KOL' : 'UNKNOWN';
    const pnl = numberOf(row.realizedPnlUsd) ?? numberOf(row.unrealizedPnlUsd) ?? 0;
    const sourceBucket = pnlBySourceType[sourceType] ?? { count: 0, netPnlUsd: 0 };
    sourceBucket.count += 1;
    sourceBucket.netPnlUsd += pnl;
    pnlBySourceType[sourceType] = sourceBucket;
    const scoreBand = typeof row.signalBand === 'string' ? row.signalBand : 'UNKNOWN';
    const scoreBucket = pnlByScoreBand[scoreBand] ?? { count: 0, netPnlUsd: 0 };
    scoreBucket.count += 1;
    scoreBucket.netPnlUsd += pnl;
    pnlByScoreBand[scoreBand] = scoreBucket;
  }
  const realizedTotal = realized.length ? realized.reduce((sum, value) => sum + value, 0) : null;
  const unrealizedTotal = unrealized.length ? unrealized.reduce((sum, value) => sum + value, 0) : null;
  return {
    decisions: rows.length,
    signals: rows.length,
    entries: entries.length,
    skipped: rows.filter((row) => row.state === 'SKIPPED').length,
    missedInsufficientBalance: rows.filter((row) => ['INSUFFICIENT_FREE_BALANCE', 'POSITION_BELOW_MINIMUM'].includes(row.decisionCode)).length,
    missedExposureLimit: rows.filter((row) => row.decisionCode === 'EXPOSURE_LIMIT_REACHED').length,
    missedMaxPositions: rows.filter((row) => row.decisionCode === 'MAX_POSITIONS_REACHED').length,
    open: open.length,
    closed: closed.length,
    averageAllocationUsd: average(allocations),
    medianAllocationUsd: percentile(allocations, 0.5),
    turnoverUsd: allocations.length ? allocations.reduce((sum, value) => sum + value, 0) : null,
    averageReserveUsd: average(reserves),
    averageExposureUsd: average(exposures),
    realizedPnlUsd: realizedTotal,
    unrealizedPnlUsd: unrealizedTotal,
    netPnlUsd: realizedTotal == null && unrealizedTotal == null ? null : (realizedTotal ?? 0) + (unrealizedTotal ?? 0),
    averagePnlUsd: average(realized),
    medianPnlUsd: percentile(realized, 0.5),
    winRatePct:
      realized.length === 0
        ? null
        : (realized.filter((value) => value > 0).length / realized.length) * 100,
    profitFactor: negative > 0 ? positive / negative : null,
    totalCostsUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    tradingFeesUsd: tradingFees.length ? tradingFees.reduce((sum, value) => sum + value, 0) : null,
    slippageUsd: slippage.length ? slippage.reduce((sum, value) => sum + value, 0) : null,
    networkCostsUsd: networkCosts.length ? networkCosts.reduce((sum, value) => sum + value, 0) : null,
    maxDrawdownPct: drawdowns.length ? Math.max(...drawdowns) : null,
    averageHoldingMs: average(durations),
    averageMaxMultiple: average(multiples),
    maxMultiple: multiples.length ? Math.max(...multiples) : null,
    decisionLatencyP50Ms: percentile(latencies, 0.5),
    decisionLatencyP95Ms: percentile(latencies, 0.95),
    pnlBySourceType,
    pnlByScoreBand,
    lastDecision: rows[0]
      ? { code: rows[0].decisionCode, reason: rows[0].allocationReason }
      : null,
    sampleSize: closed.length,
    minimumSampleSize: MIN_CLOSED_FOR_COMPARISON,
    enoughData: closed.length >= MIN_CLOSED_FOR_COMPARISON,
  };
}

/** Административная наблюдаемость и только ручное управление. */
export const paperAgentRoutes: FastifyPluginAsync = async (app) => {
  /*
   * Журнал берётся у запроса: только там есть `reqId`, по которому
   * дежурный связывает жалобу человека с записью о причине.
   */
  const readSnapshot = async (req?: { log?: SectionLogger }) => {
    const log = req?.log ?? app.log;
    await ensurePaperAgentConfig();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const [
      control,
      strategies,
      stateGroups,
      sampled,
      recent,
      lastSignal,
      receivedSignals,
      signalOriginGroups,
      ingestCodeGroups,
      decisionDimensions,
      unreadNotifications,
      pendingNotifications,
    ] =
      await Promise.all([
        prisma.paperAgentControl.findUniqueOrThrow({ where: { id: CONTROL_ID } }),
        prisma.paperAgentStrategy.findMany({ orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] }),
        prisma.paperAgentRun.groupBy({
          by: ['state'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.paperAgentRun.findMany({
          select: {
            signalId: true,
            strategyId: true,
            state: true,
            signalOrigin: true,
            providerDeliveryLatencyMs: true,
            agentDecisionLatencyMs: true,
            endToEndLatencyMs: true,
            realizedPnlUsd: true,
            unrealizedPnlUsd: true,
            maxMultiple: true,
            maxDrawdownPct: true,
            totalCostsUsd: true,
            entryAt: true,
            exitAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: SAMPLE_LIMIT,
        }),
        prisma.paperAgentRun.findMany({
          include: {
            strategy: { select: { key: true, label: true } },
            allocations: {
              select: {
                id: true,
                isShadow: true,
                mode: true,
                policyKey: true,
                policyVersion: true,
                riskProfile: true,
                allocatedUsd: true,
                capitalPct: true,
                signalScore: true,
                signalBand: true,
                allocationReason: true,
                state: true,
                exitPlan: true,
                exitState: true,
                exitReason: true,
                targetSourcePriceUsd: true,
                policySnapshot: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.okxSignal.findFirst({
          select: { signaledAt: true, receivedAt: true, providerKey: true },
          orderBy: { signaledAt: 'desc' },
        }),
        prisma.okxSignal.count({ where: { receivedAt: { gte: since } } }),
        prisma.okxSignal.groupBy({
          by: ['ingestOrigin'],
          where: { receivedAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.okxSignal.groupBy({
          by: ['paperAgentIngestCode'],
          where: { receivedAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.paperAgentRun.findMany({
          where: { createdAt: { gte: since } },
          select: {
            signalId: true,
            state: true,
            decisionCode: true,
            signalOrigin: true,
            strategy: { select: { key: true, version: true, kind: true } },
            allocations: {
              select: {
                isShadow: true,
                policyKey: true,
                policyVersion: true,
              },
            },
          },
        }),
        prisma.paperAgentNotification.count({ where: { isRead: false } }),
        prisma.paperAgentNotification.count({
          where: {
            OR: [
              { inAppStatus: 'PENDING' },
              { telegramStatus: { in: ['PENDING', 'FAILED', 'AMBIGUOUS'] } },
            ],
          },
        }),
      ]);

    const [allocationAccounts, allocationPolicies, allocationRows] = await Promise.all([
      prisma.paperAgentAccountSession.findMany({
        where: { status: { in: ['ACTIVE', 'DRAINING', 'CLOSED'] } },
        include: {
          ledger: {
            orderBy: { createdAt: 'desc' },
            take: 80,
            select: {
              id: true,
              eventType: true,
              amountUsd: true,
              freeAfterUsd: true,
              reservedAfterUsd: true,
              inPositionsAfterUsd: true,
              realizedPnlAfterUsd: true,
              equityAfterUsd: true,
              tradingFeesAfterUsd: true,
              slippageAfterUsd: true,
              networkCostsAfterUsd: true,
              createdAt: true,
              allocation: {
                select: {
                  decisionCode: true,
                  allocationReason: true,
                  signalScore: true,
                  run: {
                    select: {
                      tokenId: true,
                      symbol: true,
                      address: true,
                      chain: true,
                      signalOrigin: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.paperAgentAllocationPolicy.findMany({
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 100,
      }),
      prisma.paperAgentAllocation.findMany({
        select: {
          sessionId: true,
          state: true,
          decisionCode: true,
          allocationReason: true,
          inputFacts: true,
          signalBand: true,
          allocatedUsd: true,
          reserveAfterUsd: true,
          exposureAfterUsd: true,
          realizedPnlUsd: true,
          unrealizedPnlUsd: true,
          tradingFeesUsd: true,
          slippageUsd: true,
          networkCostsUsd: true,
          totalCostsUsd: true,
          maxMultiple: true,
          maxDrawdownPct: true,
          entryAt: true,
          exitAt: true,
          run: { select: { agentDecisionLatencyMs: true, signalOrigin: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: SAMPLE_LIMIT,
      }),
    ]);

    const latencySummary = summarizePaperAgentLatencies(sampled);
    const runCount24h = stateGroups.reduce((sum, row) => sum + row._count._all, 0);
    const countBy = <T,>(rows: T[], keyOf: (row: T) => string) =>
      Object.fromEntries(
        [...rows.reduce((map, row) => {
          const key = keyOf(row);
          map.set(key, (map.get(key) ?? 0) + 1);
          return map;
        }, new Map<string, number>())],
      );
    const decisionBreakdown = summarizePaperDecisionDimensions(decisionDimensions);
    const allocationDimensions = decisionDimensions.flatMap((row) =>
      row.allocations.map((allocation) => ({ ...allocation, signalId: row.signalId })),
    );
    const comparison = strategies.map((strategy) => ({
      key: strategy.key,
      label: strategy.label,
      kind: strategy.kind,
      isEnabled: strategy.isEnabled,
      isBaseline: strategy.key === control.baselineStrategyKey,
      config: strategy.config,
      ...summarizeRuns(sampled.filter((row) => row.strategyId === strategy.id)),
    }));
    const runtime = getPaperAgentRuntimeStatus();
    const okxSignalStatus = getOkxSignalIngestStatus();
    const waitingForPrice =
      (stateGroups.find((row) => row.state === 'WAITING_PRICE')?._count._all ?? 0) +
      (stateGroups.find((row) => row.state === 'WAITING_ENTRY')?._count._all ?? 0);
    const health = paperAgentHealthState({
      executionMode: env.EXECUTION_MODE,
      enabled: control.isEnabled,
      socketHealthy:
        (okxSignalStatus.socket?.state === 'connected' || okxSignalStatus.transportMode === 'REST_ONLY')
        && runtime.entriesPausedBySource == null,
      waitingForPrice,
      queued: runtime.queued,
      lastActivityAtMs: runtime.lastActivityAt == null ? null : Date.parse(runtime.lastActivityAt),
      nowMs: Date.now(),
    });
    /*
     * Дополнительная диагностика. Дальше этой точки ни один сбой
     * не имеет права унести данные PAPER: всё, что читается ниже,
     * относится к контурам, которых бумажная торговля не касается.
     *
     * Состояние защёлки читается из базы: её поднимает воркер сверки,
     * возможно в другом процессе. Реестр ключа — оттуда же; наружу
     * пойдёт только производное состояние, без отпечатка и адреса.
     */
    const [fundingSafety, signing, schema] = await Promise.all([
      optionalSection(() => readFundingSafetyState(), 'funding', log),
      optionalSection(() => readSigningState(), 'signing', log),
      /*
       * Применена ли схема — по живой базе, а не по флагу.
       *
       * `LIVE_MIGRATIONS_READY` отвечал на вопрос «считает ли
       * оператор схему готовой», а лестница помечала этот вход
       * наблюдаемым фактом. Поставить флаг можно одной строкой в
       * панели развёртывания, в том числе на базе, где нужных
       * таблиц нет.
       */
      optionalSection(() => readSchemaReadiness(), 'schema', log),
    ]);
    /*
     * Молчащая проверка схемы не считается пройденной.
     *
     * Раздел необязательный: его сбой не имеет права унести данные
     * PAPER. Но и подставлять вместо него `true` нельзя — «не
     * прочиталось» это не «применено».
     */
    const migrationsReady = schema.ok && schema.value.ready;
    const sections = phase4SectionsVerdict({
      funding: fundingSafety.ok ? 'AVAILABLE' : 'UNAVAILABLE',
      signing: signing.ok ? 'AVAILABLE' : 'UNAVAILABLE',
    });
    const live = liveReadiness({
      executionMode: env.EXECUTION_MODE,
      liveAgentEnabled: env.LIVE_AGENT_ENABLED,
      liveExecutionEnabled: env.LIVE_EXECUTION_ENABLED,
      withdrawalsEnabled: env.WITHDRAWALS_ENABLED,
      // Два разных контура, два разных источника. Раньше второй
      // читал устаревший флаг, и интерфейс расходился с воркером.
      custodyProvider: env.KMS_PROVIDER,
      transactionSigningEnabled: env.SOLANA_SIGNING_ENABLED,
      rpcReady: env.LIVE_RPC_READY,
      reconciliationReady: env.LIVE_RECONCILIATION_ENABLED,
      migrationsReady,
      semiAutoReady: env.LIVE_AGENT_CONTROL_MODE === 'semi-auto',
      networkAdaptersReady: false,
      autoRequested: env.LIVE_AGENT_CONTROL_MODE === 'auto',
    });
    const guardedLive = liveReadinessWithDiagnostics(live, sections);
    /*
     * Ступень готовности к LIVE на devnet.
     *
     * Не заменяет `blockers`, а отвечает на другой вопрос: не «чего
     * не хватает», а «на чём мы стоим». Считается только когда обе
     * диагностики ответили: молчащая проверка не может подтвердить
     * ступень, и подставлять здесь оптимистичные значения нельзя.
     */
    const stage =
      signing.ok && fundingSafety.ok
        ? liveReadinessStage({
            paperAgentConfigured: control.activeAllocationMode != null,
            allocationConfigured: allocationAccounts.length > 0,
            signingEnabled: signing.value.facts.signingEnabled,
            signerProviderSupported: signing.value.facts.providerSupported,
            signerKeyConfigured: signing.value.facts.keyConfigured,
            signerKeyFingerprintObserved: signing.value.facts.keyFingerprint != null,
            identityRegistered: signing.value.facts.identityState === 'OK',
            expectedKeyMatches: signing.value.facts.expectedKeyMatches === true,
            networkVerified: signing.value.facts.networkVerified,
            reconciliationEnabled: env.LIVE_RECONCILIATION_ENABLED,
            safetyLatchHealthy: fundingSafety.value === 'HEALTHY',
            migrationsReady,
            signatureValidated: signing.value.facts.signatureValidated,
            hasAmbiguousAttempt: signing.value.facts.hasAmbiguousAttempt,
            network: signing.value.facts.network,
          })
        : null;

    return {
      paper: true,
      network: 'Solana',
      phase4: {
        /*
         * Доступность блока — первое поле, потому что от неё зависит
         * смысл всех остальных. `UNAVAILABLE` означает «не знаем», и
         * это честнее любого значения по умолчанию.
         */
        status: sections.status,
        unavailable: sections.unavailable,
        mode: 'SEMI_AUTO',
        network: 'SOLANA',
        /*
         * Режим управления и доступные ему правила выхода. Одно правило
         * с сервером: интерфейс прячет лишние карточки, а PUT allocation
         * отклоняет режим не из этого списка.
         */
        controlMode: env.LIVE_AGENT_CONTROL_MODE,
        allowedExitModes: allowedExitModes(env.LIVE_AGENT_CONTROL_MODE),
        /*
         * Сети агента с готовностью и причинами. Готовность — по живому
         * списку OKX Signal API, источнику цены и узлу; сама по себе
         * связь с RPC сеть не открывает. Один список для карточек сетей,
         * выбора кошелька и приёма сигналов.
         */
        networks: agentNetworksReadiness(),
        live: {
          enabled: env.LIVE_AGENT_ENABLED,
          executionEnabled: env.LIVE_EXECUTION_ENABLED,
          // Молчащая диагностика не считается пройденной проверкой.
          ready: guardedLive.ready,
          blockers: guardedLive.blockers,
          /*
           * Ступень лестницы devnet. `null` — диагностика молчит,
           * и место на лестнице неизвестно; выдумывать его нельзя.
           */
          stage: stage?.stage ?? null,
          stageBlockers: stage?.blockers ?? [],
          mainnetRequested: stage?.mainnetRequested ?? false,
          /*
           * Состояние узла сети — очищенное и без адреса.
           *
           * Раньше готовность сети выводилась из наличия переменной
           * `SOLANA_PREFLIGHT_RPC_URL`, и экран показывал «проверено»
           * там, где не проверяли ничего. Теперь это состояние
           * доказательства: когда проверяли, до каких пор годится и
           * почему не годится сейчас.
           *
           * Ни URL, ни query, ни отпечатка настройки: отпечаток
           * односторонний, но по нему видна история смен endpoint, а
           * этого экрану знать незачем. `null` — диагностика подписи
           * молчит, и о сети ничего не известно.
           */
          rpc: signing.ok && signing.value.devnetProof
            ? {
                state: signing.value.devnetProof.state,
                verifiedAt: signing.value.devnetProof.verifiedAt,
                expiresAt: signing.value.devnetProof.expiresAt,
                stale: signing.value.devnetProof.stale,
              }
            : null,
        },
        funding: {
          enabled: env.FUNDING_ENABLED,
          source: env.FUNDING_ENABLED ? 'NOT_CONFIGURED' : 'DISABLED',
          assets: SOLANA_DEPOSIT_ASSETS.map((asset) => ({
            symbol: asset.symbol,
            mint: asset.mint,
            minAmount: asset.minAmount,
            decimals: asset.decimals,
            minConfirmations: asset.minConfirmations,
          })),
        },
        /*
         * Состояние приёма депозитов для человека.
         *
         * Один код и ничего больше: ни адреса узла, ни номера слота,
         * ни кода ошибки RPC. Внутренние подробности здесь создают
         * ощущение поломки там, где идёт обычная проверка, и при этом
         * рассказывают постороннему, как устроен контур.
         */
        depositNetwork: fundingSafety.ok
          ? {
              status: depositNetworkStatus({
                fundingEnabled: env.FUNDING_ENABLED,
                safety: fundingSafety.value,
              }),
            }
          : null,
        /*
         * Контур подписи для человека.
         *
         * Ни имени ресурса ключа, ни адреса узла, ни кода ошибки.
         * `broadcastAvailable: false` — не настройка, которую можно
         * включить, а факт: транспорта отправки в контуре нет.
         */
        signing: signing.ok
          ? {
              /*
               * Наружу идёт вычисленное состояние, а не сырые флаги.
               *
               * Флаг отвечает на вопрос «что попросили», состояние — на
               * вопрос «что получилось». Раньше здесь стоял флаг, и
               * человек видел «готово» там, где ключ не подтверждён.
               */
              state: signing.value.state,
              status: signing.value.publicView,
              network: signing.value.facts.network,
              signingEnabled: signing.value.facts.signingEnabled,
              signingConfigured: !signing.value.blockers.includes('KEY_NOT_CONFIGURED')
                && !signing.value.blockers.includes('PROVIDER_NOT_SELECTED'),
              identityVerified: !signing.value.blockers.includes('IDENTITY_NOT_REGISTERED')
                && !signing.value.blockers.includes('IDENTITY_MISMATCH'),
              networkVerified: signing.value.facts.networkVerified,
              signatureValidated: signing.value.facts.signatureValidated,
              /*
               * Состояние защёлки берётся из своего раздела и только
               * если тот ответил. Раньше здесь стояло значение,
               * прочитанное выше без всякой оговорки, — и при молчащей
               * сверке экран показывал бы `HEALTHY`.
               */
              safetyState: fundingSafety.ok ? fundingSafety.value : null,
              /*
               * Не настройка, которую можно включить, а факт: транспорта
               * отправки в контуре нет. `SIGNED` не равно `SUBMITTED`.
               */
              broadcastAvailable: signing.value.facts.broadcastAvailable,
              // Старое поле сохранено: фронт и API выкатываются раздельно.
              ready: signing.value.allowsKmsCall,
            }
          : null,
        withdrawals: { enabled: env.WITHDRAWALS_ENABLED },
        compliance: { state: 'NOT_CONFIGURED' },
        proposal: null,
      },
      health,
      control: {
        isEnabled: control.isEnabled,
        baselineStrategyKey: control.baselineStrategyKey,
        telegramShadowEnabled: control.telegramShadowEnabled,
        activeAllocationMode: control.activeAllocationMode,
        activeAllocationPolicyKey: control.activeAllocationPolicyKey,
        activeAllocationPolicyVersion: control.activeAllocationPolicyVersion,
        learningModeEnabled: control.learningModeEnabled,
        updatedAt: control.updatedAt.toISOString(),
      },
      runtime,
      okxSignal: {
        ...okxSignalStatus,
        lastPersistedSignal: lastSignal
          ? {
              providerKey: lastSignal.providerKey,
              signaledAt: lastSignal.signaledAt.toISOString(),
              receivedAt: lastSignal.receivedAt.toISOString(),
            }
          : null,
      },
      notifications: {
        unread: unreadNotifications,
        pending: pendingNotifications,
        ...getPaperAgentNotificationRuntime(),
      },
      metrics24h: {
        receivedSignals,
        uniqueSignals: receivedSignals,
        runs: runCount24h,
        averageRunsPerSignal: receivedSignals === 0 ? null : runCount24h / receivedSignals,
        processedRuns: stateGroups
          .filter((row) => !['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY'].includes(row.state))
          .reduce((sum, row) => sum + row._count._all, 0),
        errorRuns: stateGroups.find((row) => row.state === 'ERROR')?._count._all ?? 0,
        openPositions: stateGroups.find((row) => row.state === 'PAPER_OPEN')?._count._all ?? 0,
        states: Object.fromEntries(stateGroups.map((row) => [row.state, row._count._all])),
        skipReasons: decisionBreakdown.skipReasons,
        skipReasonsUniqueSignals: decisionBreakdown.skipReasonsUniqueSignals,
        skipReasonsByStrategy: decisionBreakdown.skipReasonsByStrategy,
        skipReasonsByContour: decisionBreakdown.skipReasonsByContour,
        signalOrigins: Object.fromEntries(
          signalOriginGroups.map((row) => [row.ingestOrigin ?? 'LEGACY_UNKNOWN', row._count._all]),
        ),
        ingestCodes: Object.fromEntries(
          ingestCodeGroups.map((row) => [row.paperAgentIngestCode ?? 'LEGACY_UNKNOWN', row._count._all]),
        ),
        runsByOrigin: decisionBreakdown.runsByOrigin,
        runsByStrategyKind: decisionBreakdown.runsByStrategyKind,
        runsByStrategyVersion: decisionBreakdown.runsByStrategyVersion,
        capitalContours: countBy(
          allocationDimensions,
          (row) => row.isShadow ? 'SHADOW' : 'ACTIVE',
        ),
        allocationPolicyVersions: countBy(
          allocationDimensions,
          (row) => `${row.policyKey}@v${row.policyVersion}`,
        ),
        ...latencySummary,
        sampleLimited: sampled.length === SAMPLE_LIMIT,
      },
      comparison,
      allocation: {
        configured: control.activeAllocationMode != null,
        execution: 'PAPER',
        network: readyAgentNetworks().map((chain) => AGENT_NETWORK_INFO[chain].label).join(', '),
        networks: readyAgentNetworks(),
        accounts: allocationAccounts.map(serializeAccount),
        policies: allocationPolicies.map((policy) => ({
          id: policy.id,
          policyKey: policy.policyKey,
          version: policy.version,
          mode: policy.mode,
          riskProfile: policy.riskProfile,
          label: policy.label,
          limits: policy.limits,
          scorePolicyKey: policy.scorePolicyKey,
          scorePolicyVersion: policy.scorePolicyVersion,
          status: policy.status,
          source: policy.source,
          hypothesisMetrics: policy.hypothesisMetrics,
          sampleSize: policy.sampleSize,
          periodStart: policy.periodStart?.toISOString() ?? null,
          periodEnd: policy.periodEnd?.toISOString() ?? null,
          createdAt: policy.createdAt.toISOString(),
        })),
        comparison: allocationAccounts
          .filter((account) => ['ACTIVE', 'DRAINING'].includes(account.status))
          .map((account) => {
            const initial = numberOf(account.initialCapitalUsd);
            const inPositions = numberOf(account.inPositionsUsd);
            return {
              accountId: account.id,
              kind: account.kind,
              mode: account.mode,
              policyKey: account.policyKey,
              policyVersion: account.policyVersion,
              riskProfile: account.riskProfile,
              capital: serializeAccount(account).capital,
              capitalUtilizationPct:
                initial != null && initial > 0 && inPositions != null
                  ? (inPositions / initial) * 100
                  : null,
              currentExposureUsd: inPositions,
              currentReserveUsd: numberOf(account.reservedBalanceUsd),
              ...summarizeAllocations(
                allocationRows.filter((allocation) => allocation.sessionId === account.id),
              ),
            };
          }),
        hypotheses: allocationPolicies
          .filter((policy) => policy.status === 'PROPOSED')
          .map((policy) => ({
            id: policy.id,
            policyKey: policy.policyKey,
            version: policy.version,
            label: policy.label,
            limits: policy.limits,
            metrics: policy.hypothesisMetrics,
            sampleSize: policy.sampleSize,
            periodStart: policy.periodStart?.toISOString() ?? null,
            periodEnd: policy.periodEnd?.toISOString() ?? null,
          })),
      },
      positions: {
        open: recent.filter((row) => row.state === 'PAPER_OPEN').map(serializeRun),
        closed: recent.filter((row) => row.state === 'PAPER_CLOSED').map(serializeRun),
      },
      decisions: recent.map(serializeRun),
    };
  };

  app.get('/paper-agent', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { role: true },
    });
    if (!actor) return reply.code(401).send({ error: 'Требуется авторизация' });

    try {
      return publicSnapshotOf(await readSnapshot(req), actor.role === 'ADMIN');
    } catch (error) {
      /*
       * Сюда попадает только отказ обязательной части: счёт, позиции,
       * решения. Дополнительная диагностика до этого места не доходит
       * — её сбой уже разобран внутри снимка.
       *
       * 503, а не 500: состояние временное, повтор осмыслен, и
       * интерфейсу нужно отличать «сервер не может ответить сейчас»
       * от «нет доступа» и от «нет такого экрана».
       *
       * Наружу — только машинный код. Настоящая причина уходит в
       * журнал вместе с `reqId`, по которому дежурный находит запись.
       */
      req.log.error({ err: error }, 'обязательные данные /agent недоступны');
      return reply.code(503).send({ code: 'PAPER_SNAPSHOT_UNAVAILABLE' });
    }
  });

  app.get('/admin/paper-agent', { preHandler: [app.requireAdmin] }, (req) => readSnapshot(req));

  app.put('/admin/paper-agent/allocation', { preHandler: [app.requireAdmin] }, async (req) => {
    const exitOverrides = z
      .object({
        targetMultiple: z.number().gt(1).max(1000).nullable().optional(),
        stopLossPct: z.number().gt(0).lt(100).nullable().optional(),
        trailingPct: z.number().gt(0).lt(100).nullable().optional(),
        timeStopMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
        timeStopMinMultiple: z.number().min(1).max(1000).nullable().optional(),
        maxHoldHours: z.number().gt(0).max(720).nullable().optional(),
        legs: z
          .array(z.object({ multiple: z.number().gt(1).max(1000), sellPct: z.number().gt(0).max(100) }).strict())
          .max(8)
          .optional(),
      })
      .strict();
    const limitOverrides = z
      .object({
        reservePct: z.number().min(0).max(95).optional(),
        maxExposurePct: z.number().positive().max(100).optional(),
        maxPositionPct: z.number().positive().max(100).optional(),
        maxOpenPositions: z.number().int().min(1).max(100).optional(),
        minimumPositionUsd: z.string().min(1).max(64).optional(),
        dailyEntryLimit: z.number().int().min(1).max(10_000).optional(),
        drawdownStopPct: z.number().positive().max(100).optional(),
        allowPartialAllocation: z.boolean().optional(),
      })
      .strict();
    const body = z
      .object({
        mode: z.enum(['FIXED', 'AUTOPILOT']),
        capitalUsd: z.string().min(1).max(64),
        maxOpenPositions: z.number().int().min(1).max(100).optional(),
        reservePct: z.number().min(0).max(95).optional(),
        minimumPositionUsd: z.string().min(1).max(64).optional(),
        riskProfile: z.enum(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE']).optional(),
        overrides: limitOverrides.optional(),
        exitMode: z.enum(['TARGET', 'PROTECTED', 'LADDER', 'TRAILING', 'TRAILING_PURE']).optional(),
        exitOverrides: exitOverrides.optional(),
        confirm: z.literal(true),
      })
      .strict()
      .parse(req.body);
    await ensurePaperAgentConfig();
    /*
     * План проверяется ядром до того, как что-то запишется: план,
     * который никогда не закрывается или продаёт больше позиции,
     * отклоняется как 400, а не живёт в базе до первой сделки.
     */
    /*
     * Semi-auto допускает только «Цель 2×». Проверка здесь, а не
     * только в интерфейсе: прямой запрос к API обязан получить тот же
     * отказ, что и спрятанная карточка.
     */
    const requestedMode = body.exitMode ?? 'TARGET';
    if (!isExitModeAllowed(env.LIVE_AGENT_CONTROL_MODE, requestedMode)) {
      throw Object.assign(new Error(`Режим выхода ${requestedMode} недоступен в ${env.LIVE_AGENT_CONTROL_MODE}`), {
        statusCode: 400,
        code: 'EXIT_MODE_NOT_ALLOWED',
        allowed: allowedExitModes(env.LIVE_AGENT_CONTROL_MODE),
      });
    }
    let exitPlan: PaperExitPlan;
    try {
      exitPlan = paperExitPlan(requestedMode, body.exitOverrides ?? {});
    } catch (cause) {
      throw Object.assign(new Error('Некорректный план выхода'), {
        statusCode: 400,
        code: cause instanceof Error ? cause.message : 'INVALID_EXIT_PLAN',
      });
    }
    /*
     * Проверяется итоговый план, а не имя режима: «Цель 2×» с
     * переопределённой целью или трейлингом в полуавтомате — обход,
     * и прямой запрос к API получает тот же отказ.
     */
    const planVerdict = exitPlanAllowed(env.LIVE_AGENT_CONTROL_MODE, exitPlan);
    if (!planVerdict.ok) {
      throw Object.assign(new Error(planVerdict.message), {
        statusCode: 400,
        code: planVerdict.code,
        allowed: allowedExitModes(env.LIVE_AGENT_CONTROL_MODE),
      });
    }
    if (body.mode === 'FIXED' && body.maxOpenPositions == null) {
      throw Object.assign(new Error('Для Fixed укажите число одновременных позиций'), {
        statusCode: 400,
        code: 'MAX_OPEN_POSITIONS_REQUIRED',
      });
    }
    const configured = await configurePaperAllocationAccounts(
      {
        mode: body.mode,
        capitalUsd: body.capitalUsd,
        fixed:
          body.mode === 'FIXED'
            ? {
                maxOpenPositions: body.maxOpenPositions!,
                reservePct: body.reservePct,
                minimumPositionUsd: body.minimumPositionUsd,
              }
            : undefined,
        autopilot:
          body.mode === 'AUTOPILOT'
            ? { riskProfile: body.riskProfile ?? 'BALANCED', overrides: body.overrides }
            : undefined,
        exitPlan,
      },
      { actorId: req.user.sub, ip: req.ip },
    );
    return {
      paper: true,
      active: serializeAccount(configured.active),
      shadow: serializeAccount(configured.shadow),
    };
  });

  app.post('/admin/paper-agent/allocation/:id/reset', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(req.params);
    const body = z
      .object({ capitalUsd: z.string().min(1).max(64).nullable().optional(), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const replacement = await resetPaperAllocationAccount(
      id,
      body.capitalUsd ?? null,
      { actorId: req.user.sub, ip: req.ip },
    );
    return { paper: true, account: serializeAccount(replacement) };
  });

  /*
   * Panic — закрыть всё сейчас. Отдельно от Stop намеренно: Stop
   * запрещает новые входы и не трогает открытое, Panic — наоборот.
   * Новые входы после Panic не запрещаются: кто хочет и того, и
   * другого, нажимает обе кнопки, и каждая делает ровно одно.
   */
  app.post('/admin/paper-agent/panic', { preHandler: [app.requireAdmin] }, async (req) => {
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    const result = await closeAllPaperPositions('MANUAL_PANIC', { actorId: req.user.sub, ip: req.ip });
    return { paper: true, ...result };
  });

  app.put('/admin/paper-agent/learning', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await ensurePaperAgentConfig();
    return prisma.$transaction(async (tx) => {
      const before = await tx.paperAgentControl.findUniqueOrThrow({ where: { id: CONTROL_ID } });
      const changed = await tx.paperAgentControl.updateMany({
        where: { id: CONTROL_ID, learningModeEnabled: !body.enabled },
        data: { learningModeEnabled: body.enabled },
      });
      if (changed.count === 1) {
        await tx.auditLog.create({
          data: {
            actorId: req.user.sub,
            action: 'paper_agent.learning_toggle',
            entity: 'PaperAgentControl',
            entityId: CONTROL_ID,
            before: { learningModeEnabled: before.learningModeEnabled },
            after: { learningModeEnabled: body.enabled },
            ip: req.ip,
          },
        });
      }
      return { enabled: body.enabled, changed: changed.count === 1, autoPromotion: false };
    });
  });

  app.post('/admin/paper-agent/allocation-policies/:id/review', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(req.params);
    const body = z
      .object({ decision: z.enum(['PROMOTE', 'REJECT']), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const status = body.decision === 'PROMOTE' ? 'PROMOTED' : 'REJECTED';
    return prisma.$transaction(async (tx) => {
      const candidate = await tx.paperAgentAllocationPolicy.findUnique({ where: { id } });
      if (!candidate || candidate.status !== 'PROPOSED') {
        throw Object.assign(new Error('Гипотеза не найдена или уже рассмотрена'), {
          statusCode: 404,
          code: 'PAPER_ALLOCATION_HYPOTHESIS_NOT_FOUND',
        });
      }
      await tx.paperAgentAllocationPolicy.update({
        where: { id },
        data: {
          status,
          reviewedAt: new Date(),
          reviewedBy: req.user.sub,
          promotedAt: status === 'PROMOTED' ? new Date() : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: `paper_agent.allocation_policy_${status.toLowerCase()}`,
          entity: 'PaperAgentAllocationPolicy',
          entityId: id,
          before: { status: candidate.status },
          after: { status, autoActivated: false },
          ip: req.ip,
        },
      });
      // Review never mutates the working account. Activation still requires
      // the explicit allocation configuration action above.
      return { id, status, activated: false };
    });
  });

  app.put('/admin/paper-agent', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z.object({ isEnabled: z.boolean() }).parse(req.body);
    await ensurePaperAgentConfig();
    if (body.isEnabled) {
      const verdict = paperAgentStartVerdict(env.EXECUTION_MODE);
      if (!verdict.ok) {
        const error = new Error('Paper-агент можно включить только при EXECUTION_MODE=paper') as Error & {
          statusCode: number;
          code: string;
        };
        error.statusCode = 409;
        error.code = verdict.reason;
        throw error;
      }
      const allocationControl = await prisma.paperAgentControl.findUnique({
        where: { id: CONTROL_ID },
      });
      if (!allocationControl?.activeAllocationMode) {
        throw Object.assign(new Error('Сначала выберите Fixed или Autopilot и создайте PAPER-счёт'), {
          statusCode: 409,
          code: 'PAPER_ALLOCATION_MODE_REQUIRED',
        });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.paperAgentControl.updateMany({
        where: { id: CONTROL_ID, isEnabled: !body.isEnabled },
        data: { isEnabled: body.isEnabled },
      });
      if (changed.count === 1) {
        await tx.auditLog.create({
          data: {
            actorId: req.user.sub,
            action: 'paper_agent.toggle',
            entity: 'PaperAgentControl',
            entityId: CONTROL_ID,
            before: { isEnabled: !body.isEnabled },
            after: { isEnabled: body.isEnabled },
            ip: req.ip,
          },
        });
      }
      const control = await tx.paperAgentControl.findUniqueOrThrow({ where: { id: CONTROL_ID } });
      return { control, changed: changed.count === 1 };
    });
    setPaperAgentEnabledCache(result.control.isEnabled);
    return { isEnabled: result.control.isEnabled, changed: result.changed };
  });

  app.post('/admin/paper-agent/promote', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z
      .object({ strategyKey: z.string().min(1).max(120), confirm: z.literal(true) })
      .parse(req.body);
    await ensurePaperAgentConfig();
    const candidate = await prisma.paperAgentStrategy.findUnique({ where: { key: body.strategyKey } });
    if (!candidate?.isEnabled || candidate.kind !== 'SHADOW') {
      const error = new Error('Активная shadow-стратегия не найдена') as Error & {
        statusCode: number;
        code: string;
      };
      error.statusCode = 404;
      error.code = 'PAPER_STRATEGY_NOT_FOUND';
      throw error;
    }

    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.paperAgentControl.findUniqueOrThrow({ where: { id: CONTROL_ID } });
      if (before.baselineStrategyKey === candidate.key) {
        return { baselineStrategyKey: before.baselineStrategyKey, changed: false };
      }
      const changed = await tx.paperAgentControl.updateMany({
        where: { id: CONTROL_ID, baselineStrategyKey: before.baselineStrategyKey },
        data: { baselineStrategyKey: candidate.key },
      });
      if (changed.count !== 1) {
        const current = await tx.paperAgentControl.findUniqueOrThrow({ where: { id: CONTROL_ID } });
        return { baselineStrategyKey: current.baselineStrategyKey, changed: false };
      }
      await tx.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: 'paper_agent.promote',
          entity: 'PaperAgentStrategy',
          entityId: candidate.id,
          before: { baselineStrategyKey: before.baselineStrategyKey },
          after: { baselineStrategyKey: candidate.key },
          ip: req.ip,
        },
      });
      return { baselineStrategyKey: candidate.key, changed: true };
    });
    return result;
  });

  app.put('/admin/paper-agent/telegram-shadow', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    await ensurePaperAgentConfig();
    return prisma.$transaction(async (tx) => {
      const changed = await tx.paperAgentControl.updateMany({
        where: { id: CONTROL_ID, telegramShadowEnabled: !body.enabled },
        data: { telegramShadowEnabled: body.enabled },
      });
      if (changed.count === 1) {
        await tx.auditLog.create({
          data: {
            actorId: req.user.sub,
            action: 'paper_agent.telegram_shadow',
            entity: 'PaperAgentControl',
            entityId: CONTROL_ID,
            before: { telegramShadowEnabled: !body.enabled },
            after: { telegramShadowEnabled: body.enabled },
            ip: req.ip,
          },
        });
      }
      const control = await tx.paperAgentControl.findUniqueOrThrow({ where: { id: CONTROL_ID } });
      return { enabled: control.telegramShadowEnabled, changed: changed.count === 1 };
    });
  });

  app.get('/admin/paper-agent/notifications', { preHandler: [app.requireAdmin] }, async (req) => {
    const query = z
      .object({
        strategyKey: z.string().min(1).max(120).optional(),
        eventType: z.string().min(1).max(64).optional(),
        unread: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    const rows = await prisma.paperAgentNotification.findMany({
      where: {
        ...(query.strategyKey ? { strategyKey: query.strategyKey } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.unread ? { isRead: query.unread === 'true' ? false : true } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return {
      unread: await prisma.paperAgentNotification.count({ where: { isRead: false } }),
      items: rows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        runId: row.runId,
        eventType: row.eventType,
        strategyKey: row.strategyKey,
        strategyVersion: row.strategyVersion,
        isBaselineEvent: row.isBaselineEvent,
        payload: row.payload,
        isRead: row.isRead,
        inAppStatus: row.inAppStatus,
        telegramStatus: row.telegramStatus,
        telegramAttempts: row.telegramAttempts,
        telegramLastAttemptAt: row.telegramLastAttemptAt?.toISOString() ?? null,
        telegramDeliveredAt: row.telegramDeliveredAt?.toISOString() ?? null,
        telegramErrorCode: row.telegramErrorCode,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.patch('/admin/paper-agent/notifications/:id/read', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(req.params);
    const { isRead } = z.object({ isRead: z.boolean() }).parse(req.body);
    const result = await prisma.paperAgentNotification.updateMany({
      where: { id },
      data: { isRead, readAt: isRead ? new Date() : null },
    });
    return { updated: result.count === 1 };
  });

  app.post('/admin/paper-agent/notifications/:id/retry', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(req.params);
    const retried = await prisma.$transaction(async (tx) => {
      const result = await tx.paperAgentNotification.updateMany({
        where: { id, telegramStatus: { in: ['FAILED', 'AMBIGUOUS'] } },
        data: {
          telegramStatus: 'PENDING',
          telegramNextAttemptAt: new Date(),
          telegramErrorCode: null,
        },
      });
      if (result.count !== 1) return false;
      await tx.auditLog.create({
        data: {
          actorId: req.user.sub,
          action: 'paper_agent.notification_retry',
          entity: 'PaperAgentNotification',
          entityId: id,
          after: { telegramStatus: 'PENDING' },
          ip: req.ip,
        },
      });
      return true;
    });
    return { retried };
  });

  app.get('/admin/paper-agent/markers', { preHandler: [app.requireAdmin] }, async (req) => {
    const query = z
      .object({
        tokenId: z.string().min(1).max(120),
        interval: z.enum(['1s', '5m', '15m', '1h', '4h', '1d']),
      })
      .parse(req.query);
    const rows = await prisma.paperAgentRun.findMany({
      where: { tokenId: query.tokenId, state: { in: ['PAPER_OPEN', 'PAPER_CLOSED'] } },
      include: {
        strategy: { select: { key: true, label: true, version: true } },
        allocations: {
          where: { state: { in: ['OPEN', 'CLOSED'] } },
          orderBy: { isShadow: 'asc' },
        },
      },
      orderBy: { entryAt: 'asc' },
      take: 500,
    });
    return rows.flatMap((run) => {
      const positions = run.allocations.length > 0
        ? run.allocations.map((allocation) => ({
            id: allocation.id,
            isShadow: allocation.isShadow,
            entryAt: allocation.entryAt,
            exitAt: allocation.exitAt,
            entryPrice: allocation.entryExecutionPriceUsd,
            exitPrice: allocation.exitExecutionPriceUsd,
            pnl: allocation.realizedPnlUsd,
            mode: allocation.mode,
            allocatedUsd: allocation.allocatedUsd,
            capitalPct: allocation.capitalPct,
            freeAfterUsd: allocation.freeAfterUsd,
            reserveAfterUsd: allocation.reserveAfterUsd,
            exposureAfterUsd: allocation.exposureAfterUsd,
            riskProfile: allocation.riskProfile,
            reason: allocation.allocationReason,
            policyKey: allocation.policyKey,
            policyVersion: allocation.policyVersion,
          }))
        : [{
            id: run.id,
            // Legacy Phase 1/2 rows do not carry the control snapshot. Calling
            // them shadow here would invent history from the current config.
            isShadow: false,
            entryAt: run.entryAt,
            exitAt: run.exitAt,
            entryPrice: run.entryExecutionPriceUsd,
            exitPrice: run.exitExecutionPriceUsd,
            pnl: run.realizedPnlUsd,
            mode: 'LEGACY',
            allocatedUsd: run.positionUsd,
            capitalPct: null,
            freeAfterUsd: null,
            reserveAfterUsd: null,
            exposureAfterUsd: null,
            riskProfile: null,
            reason: 'Legacy Phase 1/2',
            policyKey: run.strategy.key,
            policyVersion: run.strategy.version,
          }];
      return positions.flatMap((position) => {
        const buyTime = position.entryAt
          ? paperAgentMarkerTime(position.entryAt.getTime(), query.interval)
          : null;
        const sellTime = position.exitAt
          ? paperAgentMarkerTime(position.exitAt.getTime(), query.interval)
          : null;
        const common = {
          runId: run.id,
          allocationId: position.id,
          shadow: position.isShadow,
          strategyKey: run.strategy.key,
          strategyLabel: run.strategy.label,
          strategyVersion: run.strategy.version,
          allocationMode: position.mode,
          allocationPolicyKey: position.policyKey,
          allocationPolicyVersion: position.policyVersion,
          allocatedUsd: numberOf(position.allocatedUsd),
          capitalPct: numberOf(position.capitalPct),
          freeAfterUsd: numberOf(position.freeAfterUsd),
          reserveAfterUsd: numberOf(position.reserveAfterUsd),
          exposureAfterUsd: numberOf(position.exposureAfterUsd),
          riskProfile: position.riskProfile,
          allocationReason: position.reason,
          signalOrigin: run.signalOrigin,
          providerDeliveryLatencyMs: run.providerDeliveryLatencyMs,
          agentDecisionLatencyMs: run.agentDecisionLatencyMs,
          endToEndLatencyMs: run.endToEndLatencyMs,
        };
        return [
          ...(buyTime == null
            ? []
            : [{
                ...common,
                id: `${position.id}:buy`, side: 'BUY', time: buyTime,
                occurredAt: position.entryAt!.toISOString(),
                priceUsd: numberOf(position.entryPrice), pnlUsd: null,
              }]),
          ...(sellTime == null
            ? []
            : [{
                ...common,
                id: `${position.id}:sell`, side: 'SELL', time: sellTime,
                occurredAt: position.exitAt!.toISOString(),
                priceUsd: numberOf(position.exitPrice), pnlUsd: numberOf(position.pnl),
              }]),
        ];
      });
    });
  });

  /*
   * Управляемый источник сигналов и цен.
   *
   * Три маршрута под `requireAdmin`, и этого мало: сама служба
   * ещё раз спрашивает допуск по конфигурации. Роль отвечает
   * на вопрос «кто», настройка — на вопрос «здесь ли вообще
   * можно», и подменять одно другим нельзя.
   *
   * 403 с машинным кодом на любой отказ: перечислять человеку,
   * какое именно условие не выполнено, здесь незачем — причина
   * уходит в код ответа, а не в текст.
   */
  const testSourceRefusal = (reason: string, reply: FastifyReply) =>
    reply.code(403).send({ code: `PAPER_TEST_SOURCE_${reason}` });

  app.post('/admin/paper-agent/test-source/token', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const body = z
      .object({
        symbol: z.string().min(1).max(32),
        name: z.string().min(1).max(64),
        priceUsd: z.number().positive().nullable().default(null),
        poolCreatedAt: z.string().datetime().nullable().default(null),
      })
      .parse(req.body);

    const created = await createPaperTestToken(req.user.role, {
      symbol: body.symbol,
      name: body.name,
      priceUsd: body.priceUsd,
      poolCreatedAt: body.poolCreatedAt == null ? null : new Date(body.poolCreatedAt),
    });
    if (!created.ok) return testSourceRefusal(created.reason, reply);

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'paper_agent.test_token',
        entity: 'Token',
        entityId: created.value.id,
        after: { address: created.value.address },
      },
    });
    return created.value;
  });

  app.put('/admin/paper-agent/test-source/price', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const body = z
      .object({ tokenId: z.string().min(1), priceUsd: z.number().positive().nullable() })
      .parse(req.body);

    const updated = await setPaperTestPrice(req.user.role, body.tokenId, body.priceUsd);
    if (!updated.ok) return testSourceRefusal(updated.reason, reply);

    return { ok: true };
  });

  app.post('/admin/paper-agent/test-source/signal', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const body = z
      .object({
        tokenId: z.string().min(1),
        walletTypes: z.array(z.string().min(1)).min(1),
        amountUsd: z.number().positive(),
        signaledAt: z.string().datetime(),
        receivedAt: z.string().datetime(),
        priceUsd: z.number().positive().nullable().default(null),
      })
      .parse(req.body);

    const created = await createPaperTestSignal(req.user.role, {
      tokenId: body.tokenId,
      walletTypes: body.walletTypes,
      amountUsd: body.amountUsd,
      signaledAt: new Date(body.signaledAt),
      receivedAt: new Date(body.receivedAt),
      priceUsd: body.priceUsd,
    });
    if (!created.ok) return testSourceRefusal(created.reason, reply);

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'paper_agent.test_signal',
        entity: 'OkxSignal',
        entityId: created.value.id,
        after: { tokenId: body.tokenId },
      },
    });
    return created.value;
  });
};
