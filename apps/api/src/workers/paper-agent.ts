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
  actionablePaperOrigins,
  PAPER_TEST_ORIGIN,
  evaluatePaperSignal,
  signalSourceVerdict,
  type SignalSourceFacts,
  isActionablePaperOrigin,
  markPaperPosition,
  openPaperPosition,
  paperAgentModeVerdict,
  paperDrawdownPct,
  normalizeAgentNetwork,
  strategyForNetwork,
  strategyWithStoredCosts,
  AGENT_NETWORK_INFO,
  type PaperAgentStrategy,
} from '@memex/core';
import { env } from '../lib/env.js';
import { isAgentNetworkReady, readyAgentNetworks } from '../services/agent-networks.js';
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
import { registerMemoryActivityProbe } from './memory-monitor.js';
import { requestPaperTokenMetadata } from '../services/paper-token-metadata.js';

const CONTROL_ID = 'primary';
const RECONCILE_INTERVAL_MS = 1_000;
/** Как часто воркер пишет пульс в базу; проход — каждую секунду, строка — раз в десять. */
const HEARTBEAT_INTERVAL_MS = 10_000;
export const PAPER_AGENT_WORKER_NAME = 'paper-agent';
const SIGNAL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 200;
export const TOKEN_METADATA_WAIT_MS = 30_000;

export interface PaperAgentRuntimeStatus {
  running: boolean;
  executionMode: 'paper' | 'live';
  refusalReason: string | null;
  /** Начало последнего прохода — то же, что `lastTickStartedAt`; оставлено для совместимости. */
  lastTickAt: string | null;
  /** Когда последний проход *начался*. Обновляется и у падающего воркера. */
  lastTickStartedAt: string | null;
  /**
   * Когда последний проход *завершился без ошибки*. Только это поле
   * доказывает, что агент работает: проход, начавшийся и упавший,
   * его не двигает.
   */
  lastTickCompletedAt: string | null;
  /** Сколько проходов подряд закончились ошибкой; успех обнуляет. */
  consecutiveTickFailures: number;
  /** Ошибки записи пульса в базу — считаются, но проход не ломают. */
  heartbeatWriteErrors: number;
  lastErrorCode: string | null;
  lastActivityAt: string | null;
  queued: number;
  duplicatesSeen: number;
  processingErrors: number;
  /** Инвариант архитектуры, а не результат проверки кошелька. */
  liveExecutionReachable: false;
  /**
   * Почему новые входы приостановлены источником сигналов. `null` —
   * источник доступен. Отдельно от `isEnabled`: кнопка Stop — решение
   * человека, а это — состояние поставщика.
   */
  entriesPausedBySource: { code: string; message: string; transport: string } | null;
}

const runtime: PaperAgentRuntimeStatus = {
  running: false,
  executionMode: env.EXECUTION_MODE,
  refusalReason: null,
  lastTickAt: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  consecutiveTickFailures: 0,
  heartbeatWriteErrors: 0,
  lastErrorCode: null,
  lastActivityAt: null,
  queued: 0,
  duplicatesSeen: 0,
  processingErrors: 0,
  liveExecutionReachable: false,
  entriesPausedBySource: null,
};

/**
 * Откуда брать факты об источнике сигналов.
 *
 * Регистрируется воркером приёма, а не импортируется отсюда: модули
 * ссылаются друг на друга, и импорт в обе стороны сделал бы порядок
 * загрузки частью поведения.
 */
let signalSourceProbe: (() => SignalSourceFacts) | null = null;
export function setPaperSignalSourceProbe(probe: (() => SignalSourceFacts) | null): void {
  signalSourceProbe = probe;
}

/**
 * Доступность источника — по происхождению сигнала, а не для всех разом.
 *
 * Настоящий поток (WEBSOCKET_LIVE, REST_RECONCILIATION) идёт из OKX,
 * и при отказе OKX по нему нельзя входить: сигнал есть, а источника,
 * который подтвердил бы, что он свежий и настоящий, нет. Управляемый
 * тестовый источник (TEST_HARNESS) в OKX не нуждается — его
 * доступность и есть сам стенд, а допущен он только при
 * `PAPER_TEST_SOURCE_ENABLED` и уже проверенных на старте ограничениях
 * (PAPER, не mainnet, без исполнения и выводов). Включённый стенд не
 * открывает настоящие сигналы при отказавшем OKX: решение принимается
 * по происхождению каждого сигнала отдельно.
 */
export function paperSignalSourceState(): { code: string; message: string; transport: string } | null {
  const source = signalSourceProbe ? signalSourceVerdict(signalSourceProbe()) : null;
  return source && !source.available ? { code: source.code, message: source.message, transport: source.transport } : null;
}

export function originAllowedNow(origin: string | null, sourceUnavailable: boolean): boolean {
  if (!isActionablePaperOrigin(origin, env.PAPER_TEST_SOURCE_ENABLED)) return false;
  if (origin === PAPER_TEST_ORIGIN) return env.PAPER_TEST_SOURCE_ENABLED;
  return !sourceUnavailable;
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let acceptingEntries = false;
const queuedSignalIds = new Set<string>();

registerMemoryActivityProbe('paperAgent', () => ({
  running: runtime.running,
  queued: queuedSignalIds.size,
  lastTickCompletedAt: runtime.lastTickCompletedAt,
  consecutiveTickFailures: runtime.consecutiveTickFailures,
}));

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

function databaseInt(value: number | null): number | null {
  return value != null && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : null;
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
  await prisma.$transaction(async (tx) => {
    await tx.paperAgentControl.upsert({
      where: { id: CONTROL_ID },
      create: {
        id: CONTROL_ID,
        isEnabled: false,
        baselineStrategyKey: PAPER_AGENT_STRATEGIES[0]!.key,
      },
      update: {},
    });

    // Старые v1-конфигурации остаются в истории, но новые решения считает текущий набор.
    await tx.paperAgentStrategy.updateMany({
      where: { key: { startsWith: 'okx-signal-v1-' } },
      data: { isEnabled: false },
    });

    for (const strategy of PAPER_AGENT_STRATEGIES) {
      await tx.paperAgentStrategy.upsert({
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

    // Снижение порога — новая версия, прежние config и run неизменны.
    // Условное обновление сохраняет выбор администратора, если он продвинул shadow.
    const changed = await tx.paperAgentControl.updateMany({
      where: { id: CONTROL_ID, baselineStrategyKey: 'okx-signal-v2-baseline' },
      data: { baselineStrategyKey: PAPER_AGENT_STRATEGIES[0]!.key },
    });
    await tx.paperAgentStrategy.updateMany({
      where: { key: 'okx-signal-v2-baseline', isEnabled: true },
      data: { isEnabled: false },
    });
    if (changed.count === 1) {
      await tx.auditLog.create({
        data: {
          action: 'paper_agent.baseline_upgrade',
          entity: 'PaperAgentControl',
          entityId: CONTROL_ID,
          before: { baselineStrategyKey: 'okx-signal-v2-baseline', minAmountUsd: 5_000 },
          after: { baselineStrategyKey: PAPER_AGENT_STRATEGIES[0]!.key, minAmountUsd: 600 },
        },
      });
    }
  });
}

async function createRunIfMissing(
  signal: Awaited<ReturnType<typeof loadSignal>>,
  strategy: { id: string; config: unknown },
): Promise<string | null> {
  if (!signal) return null;

  const key = { signalId: signal.id, strategyId: strategy.id };

  /*
   * Быстрый путь: run этой пары уже существует.
   *
   * Сигнал приходит к воркеру не один раз — его кладут в очередь,
   * его же находит догон пропущенных, его же перечитывает проход по
   * ожидающим. Раньше каждый такой заход доходил до вставки и получал
   * `P2002`, и журнал заполнялся пойманными конфликтами на совершенно
   * штатной работе. В таком журнале настоящую аварию не разглядеть.
   */
  const known = await prisma.paperAgentRun.findUnique({
    where: { signalId_strategyId: key },
    select: { id: true },
  });
  if (known) return known.id;

  /*
   * Вставка через `ON CONFLICT DO NOTHING`.
   *
   * `createMany` со `skipDuplicates` компилируется Prisma именно в
   * него: конфликт разрешает сама база одним оператором, исключение
   * не возникает вовсе. Ограничение уникальности при этом никуда не
   * делось и по-прежнему остаётся единственным арбитром гонки —
   * поменялось только то, что проигравший узнаёт об этом из
   * количества вставленных строк, а не из брошенной ошибки.
   *
   * Проверка выше гонку не решает и не претендует: между ней и
   * вставкой другой процесс успевает вставить свою строку. Именно
   * поэтому арбитром остаётся база, а не приложение.
   */
  const inserted = await prisma.paperAgentRun.createMany({
    skipDuplicates: true,
    data: [
      {
        signalId: signal.id,
        strategyId: strategy.id,
        providerKey: signal.providerKey,
        tokenId: signal.tokenId,
        chain: signal.chain,
        address: signal.address,
        symbol: signal.symbol,
        source: signal.source,
        signalOrigin: signal.ingestOrigin,
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
    ],
  });

  /*
   * Ноль вставленных строк означает, что гонку выиграл другой
   * процесс. Это по-прежнему наблюдаемое событие — просто теперь
   * оно приходит числом, а не исключением, и потому его видно в
   * метрике, а не в куче пойманных ошибок.
   */
  if (inserted.count === 0) runtime.duplicatesSeen++;

  /*
   * Идентификатор читается после вставки, потому что `createMany`
   * его не возвращает. Строка к этому моменту есть в базе — своя
   * или чужая, и это одно и то же: пара `(signalId, strategyId)`
   * определяет её однозначно.
   *
   * `null` возможен в одном случае: победитель гонки откатился.
   * Тогда сигнал остаётся необработанным и его подберёт следующий
   * проход — тот самый догон пропущенных, ради которого он и есть.
   */
  const row = await prisma.paperAgentRun.findUnique({
    where: { signalId_strategyId: key },
    select: { id: true },
  });
  return row?.id ?? null;
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

/** Подпись сети для уведомлений: ключ базы → название для человека. */
function networkLabel(chain: string): string {
  const network = normalizeAgentNetwork(chain);
  return network ? AGENT_NETWORK_INFO[network].label : chain;
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
      receivedAtMs: signal.receivedAt.getTime(),
      origin: signal.ingestOrigin as never,
      poolCreatedAtMs: signal.token?.poolCreatedAt?.getTime() ?? null,
      priceUsd: sourcePrice,
      network: signal.chain,
    },
    now.getTime(),
  );

  // The deadline is anchored to persisted timestamps, so neither a restart
  // nor duplicate delivery grants a new waiting window. Final runs are immutable.
  if (decision.code === 'TOKEN_AGE_UNKNOWN') {
    if ((decision.endToEndLatencyMs ?? Infinity) > strategy.maxDecisionLatencyMs) {
      decision.code = sourcePrice != null && sourcePrice > 0
        ? 'DECISION_DEADLINE_EXCEEDED' : 'PRICE_UNAVAILABLE_BEFORE_DEADLINE';
    } else if ((decision.agentDecisionLatencyMs ?? Infinity) < TOKEN_METADATA_WAIT_MS) {
      // Mark waiting, not an attempted fetch. Admission is token-wide and durable
      // in the service; a final run cannot request metadata on redelivery.
      const waiting = await prisma.paperAgentRun.updateMany({
        where: { id: runId, state: 'RECEIVED' },
        data: { decisionCode: 'WAITING_FOR_TOKEN_METADATA' },
      });
      if (waiting.count > 0 && signal.tokenId && signal.ingestOrigin !== PAPER_TEST_ORIGIN) {
        const admission = await requestPaperTokenMetadata(signal.tokenId, signal.chain, signal.address,
          Math.min(signal.signaledAt.getTime() + strategy.maxDecisionLatencyMs, signal.receivedAt.getTime() + TOKEN_METADATA_WAIT_MS));
        logger.debug({ runId, tokenId: signal.tokenId, admission }, 'PAPER: ожидание метаданных');
      }
      return;
    }
  }

  const common = {
    state: decision.state,
    decisionCode: decision.code,
    decidedAt: now,
    poolCreatedAt: signal.token?.poolCreatedAt ?? null,
    latencyMs: databaseInt(decision.endToEndLatencyMs),
    providerDeliveryLatencyMs: databaseInt(decision.providerDeliveryLatencyMs),
    agentDecisionLatencyMs: databaseInt(decision.agentDecisionLatencyMs),
    endToEndLatencyMs: databaseInt(decision.endToEndLatencyMs),
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
        network: networkLabel(signal.chain),
        strategyKey: strategy.key,
        strategyLabel: strategy.label,
        strategyVersion: strategy.version,
        symbol: signal.symbol,
        address: signal.address,
        signaledAt: signal.signaledAt.toISOString(),
        decidedAt: now.toISOString(),
        signalOrigin: signal.ingestOrigin,
        providerDeliveryLatencyMs: decision.providerDeliveryLatencyMs,
        agentDecisionLatencyMs: decision.agentDecisionLatencyMs,
        endToEndLatencyMs: decision.endToEndLatencyMs,
        signalPriceUsd: numberOf(signal.priceUsd),
        decisionPriceUsd: sourcePrice,
        entryExecutionPriceUsd: entry.executionPriceUsd,
        positionUsd: entry.positionUsd,
        costModelKey: strategy.costModelKey,
        tradeFeeBps: strategy.tradeFeeBps,
        entrySlippageBps: strategy.entrySlippageBps,
        exitSlippageBps: strategy.exitSlippageBps,
        networkFeeUsdPerSide: strategy.networkFeeUsdPerSide,
        href: `/agent?run=${encodeURIComponent(runId)}`,
      },
    });
    runtime.lastActivityAt = now.toISOString();
  });
}

export async function processPaperAgentSignal(signalId: string): Promise<void> {
  const signal = await loadSignal(signalId);
  if (!signal) return;

  // GEMS хранит все сети, но агент ведёт только свои — и только те из
  // них, у которых подтверждена инфраструктура (сигналы OKX по сети,
  // цена, узел). Чужая сеть и своя-но-не-готовая записываются разными
  // кодами: в истории это разные ответы на вопрос «почему пропущено».
  const network = normalizeAgentNetwork(signal.chain);
  if (network == null || !isAgentNetworkReady(network)) {
    await prisma.okxSignal.updateMany({
      where: { id: signal.id },
      data: { paperAgentIngestCode: network == null ? 'FILTERED_UNSUPPORTED_NETWORK' : 'NETWORK_NOT_READY' },
    });
    return;
  }
  /*
   * По каким сигналам агент вправе действовать.
   *
   * Список считается один раз в ядре и зависит от того, включён ли
   * управляемый источник. При выключенном флаге он ровно тот же, что
   * был раньше, — production ничего не замечает.
   *
   * Раньше здесь стояло `isLivePaperSignalOrigin`, и это соединяло два
   * разных вопроса: «можно ли действовать» и «считать ли живым».
   * Из-за этого управляемый источник, сделанный ради проверки
   * PAPER-режима, не мог довести до воркера ни одного сигнала.
   */
  if (!isActionablePaperOrigin(signal.ingestOrigin, env.PAPER_TEST_SOURCE_ENABLED)) {
    await prisma.okxSignal.updateMany({
      where: { id: signal.id },
      data: { paperAgentIngestCode: 'BACKFILL_DIAGNOSTIC_ONLY' },
    });
    return;
  }
  /*
   * Настоящий сигнал при отказавшем OKX не обрабатывается, а ждёт:
   * запись остаётся, решение примется, когда источник вернётся (или
   * сигнал устареет по `maxDecisionLatencyMs`). Прямой вызов обязан
   * держать то же правило, что и проход по таймеру.
   */
  if (!originAllowedNow(signal.ingestOrigin, paperSignalSourceState() != null)) return;

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
    // Модель расходов — по сети сигнала: сетевой сбор Solana и BNB Chain
    // разный, и снимок стратегии в run должен это помнить.
    if (runId) await decideRun(runId, signal, strategyForNetwork(config, network));
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
    // Расходы — из снимка входа в самой позиции; общая стратегия — только запасной вариант для старых записей.
    const stored = strategyConfig(run.strategy.config);
    const config = stored ? strategyWithStoredCosts(stored, { ...run, networkFeeUsdPerSide: run.networkFeeUsdPerSide?.toString() ?? null }) : null;
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
        network: networkLabel(run.chain),
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
        href: `/agent?run=${encodeURIComponent(run.id)}`,
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

/**
 * Один проход воркера.
 *
 * Экспортируется, чтобы сквозной стенд мог прогнать очередь без
 * таймера. Это не тестовый дубль и не копия: `tick` ниже вызывает
 * ровно эту функцию, добавляя к ней только защиту от повторного
 * входа и проверку «воркер запущен». Разделение сделано так, а не
 * копированием тела, потому что вторая реализация того же прохода
 * однажды разошлась бы с первой — и стенд начал бы проверять то,
 * чего в production нет.
 *
 * Проверку `runtime.running` сюда намеренно не переносили: стенд
 * управляет проходами сам и таймер не запускает.
 */
export async function runPaperAgentTickOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  runtime.lastTickAt = startedAt;
  runtime.lastTickStartedAt = startedAt;
  try {
    await runTickBody();
    runtime.lastErrorCode = null;
    runtime.lastTickCompletedAt = new Date().toISOString();
    runtime.consecutiveTickFailures = 0;
  } catch (error: any) {
    runtime.processingErrors++;
    runtime.consecutiveTickFailures++;
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
    await recordHeartbeat();
  }
}

/** Тело прохода; любой `return` здесь — успешное завершение, любой throw — ошибка прохода. */
async function runTickBody(): Promise<void> {
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

  /*
   * Источник сигналов недоступен — новые входы стоят, открытые
   * позиции уже сопровождены выше. Очередь не очищается: сигналы в
   * ней уже получены от документированного источника и станут
   * решениями, как только он вернётся (а не устареют — это решит
   * `maxDecisionLatencyMs` стратегии).
   */
  const paused = paperSignalSourceState();
  if (paused) {
    if (runtime.entriesPausedBySource?.code !== paused.code) {
      logger.warn({ code: paused.code }, 'PAPER-агент: входы по сигналам OKX приостановлены — источник недоступен');
    }
    runtime.entriesPausedBySource = paused;
  } else {
    if (runtime.entriesPausedBySource) logger.info('PAPER-агент: источник сигналов восстановлен, входы возобновлены');
    runtime.entriesPausedBySource = null;
  }

  /*
   * Что можно обрабатывать в этом проходе: при недоступном OKX —
   * только сигналы управляемого источника (если он включён), при
   * доступном — весь список. Очередь разбирается всегда: настоящий
   * сигнал при паузе `processPaperAgentSignal` придержит без run, а
   * после восстановления его найдёт запрос «сигнал без run этой
   * стратегии» ниже — очередь в памяти и так не переживает рестарт,
   * источник истины здесь база.
   */
  const actionable = actionablePaperOrigins(env.PAPER_TEST_SOURCE_ENABLED)
    .filter((origin) => originAllowedNow(origin, paused != null));
  if (actionable.length === 0) return;

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
  // Один список на оба запроса ниже: два списка однажды разошлись бы.
  const readyChains = readyAgentNetworks();
  const enabledStrategies = await prisma.paperAgentStrategy.findMany({
    where: { isEnabled: true },
    select: { id: true },
  });
  const missingByStrategy = await Promise.all(
    enabledStrategies.map((strategy) =>
      prisma.okxSignal.findMany({
        where: {
          signaledAt: { gte: new Date(Date.now() - SIGNAL_LOOKBACK_MS) },
          chain: { in: readyChains },
          ingestOrigin: { in: actionable },
          paperAgentRuns: { none: { strategyId: strategy.id } },
        },
        select: { id: true },
        orderBy: { signaledAt: 'asc' },
        take: BATCH_SIZE,
      }),
    ),
  );
  const waiting = await prisma.paperAgentRun.findMany({
    where: {
      state: { in: ['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY'] },
      chain: { in: readyChains },
      signalOrigin: { in: actionable },
    },
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
}

/**
 * Пульс в базу — раз в `HEARTBEAT_INTERVAL_MS`, а не каждый проход.
 *
 * Строка одна на воркер; API в другом процессе читает её в
 * `/health/agent`. Ошибка записи проход не ломает: считается и
 * логируется, но агент из-за недоступной таблицы пульса не
 * останавливается — он и без неё работал.
 */
let lastHeartbeatWriteAt = 0;
let heartbeatStartedAt: string | null = null;
async function recordHeartbeat(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastHeartbeatWriteAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatWriteAt = now;
  const data = {
    processId: String(process.pid),
    hostname: typeof process.env.HOSTNAME === 'string' && process.env.HOSTNAME !== '' ? process.env.HOSTNAME : null,
    startedAt: new Date(heartbeatStartedAt ?? new Date(now).toISOString()),
    lastTickStartedAt: runtime.lastTickStartedAt ? new Date(runtime.lastTickStartedAt) : null,
    lastTickCompletedAt: runtime.lastTickCompletedAt ? new Date(runtime.lastTickCompletedAt) : null,
    lastErrorCode: runtime.lastErrorCode,
    consecutiveFailures: runtime.consecutiveTickFailures,
  };
  try {
    await prisma.workerHeartbeat.upsert({
      where: { name: PAPER_AGENT_WORKER_NAME },
      create: { name: PAPER_AGENT_WORKER_NAME, ...data },
      update: data,
    });
  } catch (error: any) {
    runtime.heartbeatWriteErrors++;
    if (runtime.heartbeatWriteErrors === 1 || runtime.heartbeatWriteErrors % 100 === 0) {
      logger.warn({ code: error?.code ?? error?.name, count: runtime.heartbeatWriteErrors }, 'paper-agent: пульс в базу не записан');
    }
  }
}

/**
 * Проход по таймеру.
 *
 * Добавляет к общему проходу ровно две вещи: не запускается, пока
 * воркер не стартовал, и не входит второй раз, пока идёт первый.
 * Больше здесь ничего нет — вся работа в `runPaperAgentTickOnce`.
 */
async function tick(): Promise<void> {
  if (!runtime.running || ticking) return;
  ticking = true;
  try {
    await runPaperAgentTickOnce();
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
  // Новый старт — новое наблюдение: проходы прошлого запуска здоровья
  // не доказывают, иначе перезапущенный и сразу падающий воркер минуту
  // выглядел бы здоровым по старой отметке.
  runtime.lastTickStartedAt = null;
  runtime.lastTickCompletedAt = null;
  runtime.lastTickAt = null;
  runtime.consecutiveTickFailures = 0;
  heartbeatStartedAt = new Date().toISOString();
  lastHeartbeatWriteAt = 0;
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
