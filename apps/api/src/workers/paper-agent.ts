/**
 * Автономный агент Phase 1 — строго бумажный контур.
 *
 * Единственный вход — уже сохранённый OkxSignal. Единственная цена для
 * сопровождения — Token.priceUsd, которую обновляет общий price-updater.
 * Здесь нет импорта execution, chain adapters, KMS, кошельков или RPC.
 */

import { Prisma as P } from '@prisma/client';
import {
  PAPER_AGENT_STRATEGIES,
  evaluatePaperSignal,
  markPaperPosition,
  openPaperPosition,
  paperAgentModeVerdict,
  paperDrawdownPct,
  type PaperAgentStrategy,
} from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import {
  enqueuePaperAgentOutbox,
  enqueuePaperAgentSystemEvent,
  paperAgentRunEventKey,
} from '../services/paper-agent-outbox.js';
import {
  allocatePaperAgentRun,
  processPaperAllocationPositions,
} from '../services/paper-agent-allocation.js';

const CONTROL_ID = 'primary';
const RECONCILE_INTERVAL_MS = 1_000;
const SIGNAL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 200;

export interface PaperAgentRuntimeStatus {
  running: boolean;
  executionMode: 'paper' | 'live';
  refusalReason: string | null;
  lastTickAt: string | null;
  lastErrorCode: string | null;
  lastActivityAt: string | null;
  queued: number;
  duplicatesSeen: number;
  processingErrors: number;
  /** Инвариант архитектуры, а не результат проверки кошелька. */
  liveExecutionReachable: false;
}

const runtime: PaperAgentRuntimeStatus = {
  running: false,
  executionMode: env.EXECUTION_MODE,
  refusalReason: null,
  lastTickAt: null,
  lastErrorCode: null,
  lastActivityAt: null,
  queued: 0,
  duplicatesSeen: 0,
  processingErrors: 0,
  liveExecutionReachable: false,
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let acceptingEntries = false;
const queuedSignalIds = new Set<string>();

export function paperAgentStartVerdict(mode: string): { ok: true } | { ok: false; reason: string } {
  return paperAgentModeVerdict(mode);
}

export function getPaperAgentRuntimeStatus(): PaperAgentRuntimeStatus {
  return { ...runtime, queued: queuedSignalIds.size };
}

/** Мгновенная доставка уже сохранённого события без второго OKX-клиента. */
export function queuePaperAgentSignal(signalId: string, duplicate = false): void {
  if (!signalId) return;
  // В live-режиме очередь тоже не накапливается: отказ — это отсутствие
  // работы, а не отложенный запуск после будущего переключения.
  if (!paperAgentModeVerdict(runtime.executionMode).ok || !acceptingEntries) return;
  if (duplicate) runtime.duplicatesSeen++;
  queuedSignalIds.add(signalId);
  runtime.queued = queuedSignalIds.size;
  if (runtime.running) queueMicrotask(() => void tick());
}

function decimal(value: number | null | undefined): P.Decimal | null {
  return value != null && Number.isFinite(value) ? new P.Decimal(value) : null;
}

function numberOf(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strategyConfig(raw: unknown): PaperAgentStrategy | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'BASELINE' || r.kind === 'SHADOW' ? r.kind : null;
  const required = [
    'version',
    'minAmountUsd',
    'maxTokenAgeMs',
    'maxDecisionLatencyMs',
    'entryDelayMs',
    'positionUsd',
    'targetMultiple',
  ] as const;
  if (
    typeof r.key !== 'string' ||
    typeof r.label !== 'string' ||
    !kind ||
    required.some((key) => typeof r[key] !== 'number' || !Number.isFinite(r[key]))
  ) {
    return null;
  }

  const tradeFeeBps = numberOf(r.tradeFeeBps ?? r.feeBps);
  const entrySlippageBps = numberOf(r.entrySlippageBps ?? r.slippageBps);
  const exitSlippageBps = numberOf(r.exitSlippageBps ?? r.slippageBps);
  const networkFeeUsdPerSide = numberOf(r.networkFeeUsdPerSide) ?? 0;
  if (tradeFeeBps == null || entrySlippageBps == null || exitSlippageBps == null) {
    return null;
  }

  // Открытые позиции Phase 1 обязаны продолжить сопровождение после обновления.
  // Их историческая модель не переписывается: недостающая сеть стоила $0.
  return {
    ...(r as unknown as PaperAgentStrategy),
    costModelKey:
      typeof r.costModelKey === 'string' ? r.costModelKey : `legacy-v${String(r.version)}`,
    tradeFeeBps,
    entrySlippageBps,
    exitSlippageBps,
    networkFeeUsdPerSide,
  };
}

/** Создаёт версии один раз; новая сборка не переписывает старый эксперимент. */
export async function ensurePaperAgentConfig(): Promise<void> {
  await prisma.paperAgentControl.upsert({
    where: { id: CONTROL_ID },
    create: {
      id: CONTROL_ID,
      isEnabled: false,
      baselineStrategyKey: PAPER_AGENT_STRATEGIES[0]!.key,
    },
    update: {},
  });

  // Старые v1-конфигурации остаются в истории, но новые решения считает v2.
  await prisma.paperAgentStrategy.updateMany({
    where: { key: { startsWith: 'okx-signal-v1-' } },
    data: { isEnabled: false },
  });

  for (const strategy of PAPER_AGENT_STRATEGIES) {
    await prisma.paperAgentStrategy.upsert({
      where: { key: strategy.key },
      create: {
        key: strategy.key,
        version: strategy.version,
        label: strategy.label,
        kind: strategy.kind,
        isEnabled: true,
        config: strategy as unknown as P.InputJsonValue,
      },
      // Конфигурация версии неизменяема: изменение создаёт новый key.
      update: {},
    });
  }
}

async function createRunIfMissing(
  signal: Awaited<ReturnType<typeof loadSignal>>,
  strategy: { id: string; config: unknown },
): Promise<string | null> {
  if (!signal) return null;
  try {
    const row = await prisma.paperAgentRun.create({
      data: {
        signalId: signal.id,
        strategyId: strategy.id,
        providerKey: signal.providerKey,
        tokenId: signal.tokenId,
        chain: signal.chain,
        address: signal.address,
        symbol: signal.symbol,
        source: signal.source,
        state: 'RECEIVED',
        signaledAt: signal.signaledAt,
        receivedAt: signal.receivedAt,
        poolCreatedAt: signal.token?.poolCreatedAt ?? null,
        walletTypes: signal.walletTypes,
        triggerWalletAddresses: signal.triggerWalletAddresses,
        signalAmountUsd: signal.amountUsd,
        signalPriceUsd: signal.priceUsd,
        signalMarketCapUsd: signal.marketCapUsd,
        warnings: {
          riskLevel: signal.token?.riskLevel ?? null,
          riskCodes: signal.token?.riskCodes ?? [],
          scamVerdict: signal.token?.scamVerdict ?? null,
          note: 'diagnostic_only',
        },
      },
      select: { id: true },
    });
    return row.id;
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error;
    runtime.duplicatesSeen++;
    const existing = await prisma.paperAgentRun.findUnique({
      where: { signalId_strategyId: { signalId: signal.id, strategyId: strategy.id } },
      select: { id: true },
    });
    return existing?.id ?? null;
  }
}

function loadSignal(id: string) {
  return prisma.okxSignal.findUnique({
    where: { id },
    include: {
      token: {
        select: {
          priceUsd: true,
          priceUpdatedAt: true,
          poolCreatedAt: true,
          liquidityUsd: true,
          riskLevel: true,
          riskCodes: true,
          scamVerdict: true,
        },
      },
    },
  });
}

async function decideRun(
  runId: string,
  signal: NonNullable<Awaited<ReturnType<typeof loadSignal>>>,
  strategy: PaperAgentStrategy,
  now = new Date(),
): Promise<void> {
  const sourcePrice = numberOf(signal.token?.priceUsd ?? signal.priceUsd);
  const decision = evaluatePaperSignal(
    strategy,
    {
      walletTypes: signal.walletTypes as never,
      amountUsd: numberOf(signal.amountUsd),
      signaledAtMs: signal.signaledAt.getTime(),
      poolCreatedAtMs: signal.token?.poolCreatedAt?.getTime() ?? null,
      priceUsd: sourcePrice,
      network: signal.chain,
    },
    now.getTime(),
  );

  const common = {
    state: decision.state,
    decisionCode: decision.code,
    decidedAt: now,
    latencyMs: Math.min(2_147_483_647, decision.latencyMs),
    tokenAgeMs:
      decision.tokenAgeMs == null ? null : Math.min(2_147_483_647, decision.tokenAgeMs),
    decisionPriceUsd: decimal(sourcePrice),
    priceSource: signal.token?.priceUsd != null ? 'shared_token_cache' : 'okx_signal',
  };

  if (decision.state !== 'ELIGIBLE') {
    await prisma.paperAgentRun.updateMany({
      where: { id: runId, state: { in: ['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY'] } },
      data: common,
    });
    return;
  }

  const allocationControl = await prisma.paperAgentControl.findUnique({
    where: { id: CONTROL_ID },
  });
  if (
    allocationControl?.activeAllocationMode &&
    strategy.key === allocationControl.baselineStrategyKey
  ) {
    const handled = await allocatePaperAgentRun({
      runId,
      signal,
      strategy,
      sourcePrice: sourcePrice!,
      commonRunData: common,
      now,
    });
    if (handled) {
      runtime.lastActivityAt = now.toISOString();
      return;
    }
    await prisma.paperAgentRun.updateMany({
      where: { id: runId, state: { in: ['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY'] } },
      data: {
        ...common,
        state: 'WAITING_ENTRY',
        decisionCode: 'ALLOCATION_SESSION_UNAVAILABLE',
      },
    });
    return;
  }

  const entry = sourcePrice == null ? null : openPaperPosition(strategy, sourcePrice);
  if (!entry) {
    await prisma.paperAgentRun.updateMany({
      where: { id: runId, state: 'ELIGIBLE' },
      data: { state: 'ERROR', errorCode: 'PAPER_ENTRY_CALCULATION_FAILED' },
    });
    runtime.processingErrors++;
    return;
  }

  const initialMark = markPaperPosition(strategy, entry, entry.sourcePriceUsd);
  if (!initialMark) {
    await prisma.paperAgentRun.updateMany({
      where: { id: runId, state: 'ELIGIBLE' },
      data: { state: 'ERROR', errorCode: 'PAPER_INITIAL_MARK_FAILED' },
    });
    runtime.processingErrors++;
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Проверка внутри той же транзакции закрывает гонку Stop против нового входа.
    const control = await tx.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
    if (!control?.isEnabled) return;

    const claimed = await tx.paperAgentRun.updateMany({
      where: { id: runId, state: { in: ['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY'] } },
      data: {
        ...common,
        state: 'PAPER_OPEN',
        entryAt: now,
        positionUsd: decimal(entry.positionUsd),
        costModelKey: strategy.costModelKey,
        tradeFeeBps: strategy.tradeFeeBps,
        entrySlippageBps: strategy.entrySlippageBps,
        exitSlippageBps: strategy.exitSlippageBps,
        networkFeeUsdPerSide: decimal(strategy.networkFeeUsdPerSide),
        // Legacy-поля остаются читаемыми для старого административного отчёта.
        feeBps: strategy.tradeFeeBps,
        slippageBps: strategy.entrySlippageBps,
        entrySourcePriceUsd: decimal(entry.sourcePriceUsd),
        entryExecutionPriceUsd: decimal(entry.executionPriceUsd),
        entryQuantity: decimal(entry.quantity),
        entryTradingFeeUsd: decimal(entry.entryTradingFeeUsd),
        entryNetworkFeeUsd: decimal(entry.entryNetworkFeeUsd),
        entrySlippageUsd: decimal(entry.entrySlippageUsd),
        entryFeeUsd: decimal(entry.entryFeeUsd),
        targetSourcePriceUsd: decimal(entry.targetSourcePriceUsd),
        currentSourcePriceUsd: decimal(entry.sourcePriceUsd),
        currentExecutionPriceUsd: decimal(initialMark.executionExitPriceUsd),
        unrealizedPnlUsd: decimal(initialMark.pnlUsd),
        peakSourcePriceUsd: decimal(entry.sourcePriceUsd),
        maxMultiple: decimal(1),
        maxDrawdownPct: decimal(0),
        totalCostsUsd: decimal(initialMark.totalCostsUsd),
        lastMarkedAt: now,
      },
    });
    if (claimed.count !== 1) return;

    const isBaseline = strategy.key === control.baselineStrategyKey;
    await enqueuePaperAgentOutbox(tx, {
      eventKey: paperAgentRunEventKey(runId, 'PAPER_BUY', strategy.version),
      runId,
      eventType: 'PAPER_BUY',
      strategyKey: strategy.key,
      strategyVersion: strategy.version,
      isBaselineEvent: isBaseline,
      telegramEligible:
        env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED &&
        (isBaseline || control.telegramShadowEnabled),
      payload: {
        paper: true,
        eventType: 'PAPER_BUY',
        runId,
        tokenId: signal.tokenId,
        network: 'Solana',
        strategyKey: strategy.key,
        strategyLabel: strategy.label,
        strategyVersion: strategy.version,
        symbol: signal.symbol,
        address: signal.address,
        signaledAt: signal.signaledAt.toISOString(),
        decidedAt: now.toISOString(),
        signalPriceUsd: numberOf(signal.priceUsd),
        decisionPriceUsd: sourcePrice,
        entryExecutionPriceUsd: entry.executionPriceUsd,
        positionUsd: entry.positionUsd,
        costModelKey: strategy.costModelKey,
        tradeFeeBps: strategy.tradeFeeBps,
        entrySlippageBps: strategy.entrySlippageBps,
        exitSlippageBps: strategy.exitSlippageBps,
        networkFeeUsdPerSide: strategy.networkFeeUsdPerSide,
        href: `/admin/agent?run=${encodeURIComponent(runId)}`,
      },
    });
    runtime.lastActivityAt = now.toISOString();
  });
}

export async function processPaperAgentSignal(signalId: string): Promise<void> {
  const signal = await loadSignal(signalId);
  if (!signal) return;

  const [control, strategies] = await Promise.all([
    prisma.paperAgentControl.findUnique({ where: { id: CONTROL_ID } }),
    prisma.paperAgentStrategy.findMany({ where: { isEnabled: true } }),
  ]);
  if (!control?.isEnabled) return;

  // Phase 3 не отменяет четыре threshold shadow-стратегии Phase 2.
  // Только baseline получает два капиталовых контура; остальные продолжают
  // eligibility/exit как прежде, поэтому произведения 5×2 не возникает.
  for (const row of strategies) {
    const config = strategyConfig(row.config);
    if (!config) {
      runtime.processingErrors++;
      runtime.lastErrorCode = 'INVALID_STRATEGY_CONFIG';
      continue;
    }
    const runId = await createRunIfMissing(signal, row);
    if (runId) await decideRun(runId, signal, config);
  }
}

export async function processOpenPaperPositions(now = new Date()): Promise<void> {
  const runs = await prisma.paperAgentRun.findMany({
    // Phase 3 positions are marked through their isolated capital ledgers.
    // This remains the backward-compatible Phase 1/2 path.
    where: { state: 'PAPER_OPEN', allocations: { none: {} } },
    include: { strategy: { select: { key: true, version: true, label: true, config: true } } },
    orderBy: { updatedAt: 'asc' },
    take: BATCH_SIZE,
  });
  const tokenIds = [...new Set(runs.map((run) => run.tokenId).filter(Boolean))] as string[];
  const tokens = await prisma.token.findMany({
    where: { id: { in: tokenIds } },
    select: { id: true, priceUsd: true },
  });
  const prices = new Map(tokens.map((token) => [token.id, numberOf(token.priceUsd)]));

  for (const run of runs) {
    const config = strategyConfig(run.strategy.config);
    const sourcePrice = run.tokenId ? prices.get(run.tokenId) ?? null : null;
    const entrySource = numberOf(run.entrySourcePriceUsd);
    const entryExecution = numberOf(run.entryExecutionPriceUsd);
    const quantity = numberOf(run.entryQuantity);
    const positionUsd = numberOf(run.positionUsd);
    const entryFee = numberOf(run.entryFeeUsd);
    const entryTradingFee = numberOf(run.entryTradingFeeUsd) ?? entryFee;
    const entryNetworkFee = numberOf(run.entryNetworkFeeUsd) ?? 0;
    const storedEntrySlippage = numberOf(run.entrySlippageUsd);
    const entrySlippage =
      storedEntrySlippage ??
      (entrySource != null && entryExecution != null && quantity != null
        ? Math.max(0, (entrySource - entryExecution) * quantity)
        : null);
    const target = numberOf(run.targetSourcePriceUsd);
    if (
      !config ||
      sourcePrice == null ||
      entrySource == null ||
      entryExecution == null ||
      quantity == null ||
      positionUsd == null ||
      entryFee == null ||
      entryTradingFee == null ||
      entrySlippage == null ||
      target == null
    ) {
      continue;
    }

    const entry = {
      positionUsd,
      sourcePriceUsd: entrySource,
      executionPriceUsd: entryExecution,
      quantity,
      entryTradingFeeUsd: entryTradingFee,
      entryNetworkFeeUsd: entryNetworkFee,
      entrySlippageUsd: entrySlippage,
      entryFeeUsd: entryFee,
      targetSourcePriceUsd: target,
    };
    const mark = markPaperPosition(config, entry, sourcePrice);
    if (!mark) continue;

    const previousPeak = numberOf(run.peakSourcePriceUsd) ?? entrySource;
    const peak = Math.max(previousPeak, sourcePrice);
    const currentDrawdown = paperDrawdownPct(peak, sourcePrice) ?? 0;
    const maxDrawdown = Math.max(numberOf(run.maxDrawdownPct) ?? 0, currentDrawdown);
    const maxMultiple = Math.max(numberOf(run.maxMultiple) ?? 1, mark.multiple);

    const marked = {
      currentSourcePriceUsd: decimal(mark.sourcePriceUsd),
      currentExecutionPriceUsd: decimal(mark.executionExitPriceUsd),
      unrealizedPnlUsd: decimal(mark.pnlUsd),
      totalCostsUsd: decimal(mark.totalCostsUsd),
      peakSourcePriceUsd: decimal(peak),
      maxMultiple: decimal(maxMultiple),
      maxDrawdownPct: decimal(maxDrawdown),
      lastMarkedAt: now,
    };

    if (!mark.shouldClose) {
      await prisma.paperAgentRun.updateMany({
        where: { id: run.id, state: 'PAPER_OPEN' },
        data: marked,
      });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const control = await tx.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
      const closed = await tx.paperAgentRun.updateMany({
        where: { id: run.id, state: 'PAPER_OPEN' },
        data: {
          ...marked,
          state: 'PAPER_CLOSED',
          exitAt: now,
          exitReason: 'TARGET_REACHED',
          exitSourcePriceUsd: decimal(mark.sourcePriceUsd),
          exitExecutionPriceUsd: decimal(mark.executionExitPriceUsd),
          exitTradingFeeUsd: decimal(mark.exitTradingFeeUsd),
          exitNetworkFeeUsd: decimal(mark.exitNetworkFeeUsd),
          exitSlippageUsd: decimal(mark.exitSlippageUsd),
          exitFeeUsd: decimal(mark.exitFeeUsd),
          grossExitUsd: decimal(mark.grossExitUsd),
          netExitUsd: decimal(mark.netExitUsd),
          realizedPnlUsd: decimal(mark.pnlUsd),
        },
      });
      if (closed.count !== 1) return;

      const isBaseline = run.strategy.key === control?.baselineStrategyKey;
      const telegramEligible =
        env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED &&
        (isBaseline || control?.telegramShadowEnabled === true);
      const durationMs = run.entryAt ? Math.max(0, now.getTime() - run.entryAt.getTime()) : null;
      const pnlPct = positionUsd > 0 ? (mark.pnlUsd / positionUsd) * 100 : null;
      const payload = {
        paper: true,
        runId: run.id,
        tokenId: run.tokenId,
        network: 'Solana',
        strategyKey: run.strategy.key,
        strategyLabel: run.strategy.label,
        strategyVersion: run.strategy.version,
        symbol: run.symbol,
        address: run.address,
        exitAt: now.toISOString(),
        exitExecutionPriceUsd: mark.executionExitPriceUsd,
        exitReason: 'TARGET_REACHED',
        pnlUsd: mark.pnlUsd,
        pnlPct,
        multiple: mark.multiple,
        tradingFeesUsd: entry.entryTradingFeeUsd + mark.exitTradingFeeUsd,
        slippageUsd: entry.entrySlippageUsd + mark.exitSlippageUsd,
        networkFeesUsd: entry.entryNetworkFeeUsd + mark.exitNetworkFeeUsd,
        totalCostsUsd: mark.totalCostsUsd,
        durationMs,
        maxMultiple,
        maxDrawdownPct: maxDrawdown,
        href: `/admin/agent?run=${encodeURIComponent(run.id)}`,
      };
      await enqueuePaperAgentOutbox(tx, {
        eventKey: paperAgentRunEventKey(run.id, 'PAPER_SELL', run.strategy.version),
        runId: run.id,
        eventType: 'PAPER_SELL',
        strategyKey: run.strategy.key,
        strategyVersion: run.strategy.version,
        isBaselineEvent: isBaseline,
        telegramEligible,
        payload: { ...payload, eventType: 'PAPER_SELL' },
      });
      await enqueuePaperAgentOutbox(tx, {
        eventKey: paperAgentRunEventKey(run.id, 'TRADE_RESULT', run.strategy.version),
        runId: run.id,
        eventType: 'TRADE_RESULT',
        strategyKey: run.strategy.key,
        strategyVersion: run.strategy.version,
        isBaselineEvent: isBaseline,
        telegramEligible,
        payload: { ...payload, eventType: 'TRADE_RESULT' },
      });
      runtime.lastActivityAt = now.toISOString();
    });
  }
}

async function tick(): Promise<void> {
  if (!runtime.running || ticking) return;
  ticking = true;
  runtime.lastTickAt = new Date().toISOString();
  try {
    const control = await prisma.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
    acceptingEntries = control?.isEnabled === true;

    // Stop запрещает новые входы, но открытая paper-позиция продолжает
    // получать цену и может закрыться: статистика не исчезает из-за кнопки.
    await processPaperAllocationPositions();
    await processOpenPaperPositions();

    if (!acceptingEntries) {
      queuedSignalIds.clear();
      runtime.queued = 0;
      return;
    }

    const queued = [...queuedSignalIds].splice(0, BATCH_SIZE);
    queued.forEach((id) => queuedSignalIds.delete(id));
    runtime.queued = queuedSignalIds.size;

    /*
     * Ищем пропуск отдельно для каждой версии стратегии.
     *
     * Проверка `paperAgentRuns: none {}` была бы неверной после падения
     * посередине сигнала: baseline уже создан, третий shadow ещё нет — у
     * сигнала есть run, поэтому рестарт объявил бы его законченным. Условие
     * ниже спрашивает ровно то, что нужно: отсутствует ли run этой версии.
     */
    const enabledStrategies = await prisma.paperAgentStrategy.findMany({
      where: { isEnabled: true },
      select: { id: true },
    });
    const missingByStrategy = await Promise.all(
      enabledStrategies.map((strategy) =>
        prisma.okxSignal.findMany({
          where: {
            signaledAt: { gte: new Date(Date.now() - SIGNAL_LOOKBACK_MS) },
            paperAgentRuns: { none: { strategyId: strategy.id } },
          },
          select: { id: true },
          orderBy: { signaledAt: 'asc' },
          take: BATCH_SIZE,
        }),
      ),
    );
    const waiting = await prisma.paperAgentRun.findMany({
      where: { state: { in: ['WAITING_PRICE', 'WAITING_ENTRY'] } },
      select: { signalId: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
    });

    const ids = new Set([
      ...queued,
      ...missingByStrategy.flat().map((row) => row.id),
      ...waiting.map((row) => row.signalId),
    ]);
    for (const id of ids) await processPaperAgentSignal(id);
    runtime.lastErrorCode = null;
  } catch (error: any) {
    runtime.processingErrors++;
    runtime.lastErrorCode = error?.code ?? error?.name ?? 'PAPER_AGENT_TICK_FAILED';
    logger.warn({ code: runtime.lastErrorCode }, 'paper-agent: проход завершился ошибкой');
    await enqueuePaperAgentSystemEvent({
      eventKey: `paper-agent:critical:${runtime.lastErrorCode}:${Math.floor(Date.now() / 60_000)}`,
      eventType: 'CRITICAL_ERROR',
      isBaselineEvent: true,
      telegramEligible: env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED,
      payload: {
        paper: true,
        eventType: 'CRITICAL_ERROR',
        errorCode: runtime.lastErrorCode,
        observedAt: new Date().toISOString(),
      },
    }).catch(() => undefined);
  } finally {
    ticking = false;
  }
}

export async function startPaperAgent(): Promise<boolean> {
  if (runtime.running) return true;
  const verdict = paperAgentStartVerdict(env.EXECUTION_MODE);
  if (!verdict.ok) {
    runtime.refusalReason = verdict.reason;
    logger.error({ reason: verdict.reason }, 'paper-agent отказался запускаться');
    return false;
  }

  await ensurePaperAgentConfig();
  const control = await prisma.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
  acceptingEntries = control?.isEnabled === true;
  runtime.running = true;
  runtime.refusalReason = null;
  timer = setInterval(() => void tick(), RECONCILE_INTERVAL_MS);
  timer.unref?.();
  void tick();
  logger.info({ restoredEnabledState: acceptingEntries },
    'paper-agent: восстановил выбранное администратором PAPER-состояние');
  return true;
}

export function stopPaperAgent(): void {
  runtime.running = false;
  if (timer) clearInterval(timer);
  timer = null;
  queuedSignalIds.clear();
  acceptingEntries = false;
  runtime.queued = 0;
}

/** Ускоряет реакцию, когда API и worker живут в одном процессе. */
export function setPaperAgentEnabledCache(enabled: boolean): void {
  acceptingEntries = enabled;
  if (!enabled) queuedSignalIds.clear();
}
