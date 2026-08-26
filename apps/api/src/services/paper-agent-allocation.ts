/**
 * Phase 3 PAPER-capital orchestration.
 *
 * The pure policy and ledger math live in @memex/core. This module owns the
 * database transaction boundary: one allocation, its account mutation, its
 * immutable ledger entry and its outbox event either commit together or not
 * at all. There is deliberately no execution, wallet, KMS, RPC or order import.
 */
import { createHash } from 'node:crypto';
import { Prisma as P } from '@prisma/client';
import {
  allocatePaperCapital,
  autopilotAllocationPolicy,
  closePaperCapitalLedger,
  fixedAllocationPolicy,
  initialPaperCapitalLedger,
  markPaperPosition,
  openPaperCapitalLedger,
  openPaperPosition,
  type AllocationPolicySnapshot,
  type PaperAgentStrategy,
  type PaperAllocationLimits,
  type PaperAllocationMode,
  type PaperCapitalLedgerSnapshot,
  type PaperRiskProfile,
  type PaperSignalAllocationFacts,
} from '@memex/core';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { fitDecimal } from '../lib/decimal.js';
import { enqueuePaperAgentOutbox } from './paper-agent-outbox.js';

const CONTROL_ID = 'primary';
const MONEY_MAX = new P.Decimal('1000000000');
const ALLOCATION_RETRIES = 3;

type AuditContext = { actorId: string; ip?: string | null };

export interface ConfigurePaperAllocationInput {
  mode: PaperAllocationMode;
  capitalUsd: string;
  fixed?: {
    maxOpenPositions: number;
    reservePct?: number;
    minimumPositionUsd?: string;
  };
  autopilot?: {
    riskProfile: PaperRiskProfile;
    overrides?: Partial<PaperAllocationLimits>;
  };
}

export interface AllocationSignalSnapshot {
  id: string;
  tokenId: string | null;
  chain: string;
  address: string;
  symbol: string;
  source: string;
  signaledAt: Date;
  receivedAt: Date;
  amountUsd: unknown;
  marketCapUsd: unknown;
  walletTypes: string[];
  token: {
    priceUsd: unknown;
    priceUpdatedAt: Date | null;
    poolCreatedAt: Date | null;
    liquidityUsd: unknown;
  } | null;
}

function numberOf(value: unknown): number | null {
  if (value == null) return null;
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : null;
}

const PAPER_DECIMAL_COLUMN = {
  money: { precision: 24, scale: 8 },
  price: { precision: 38, scale: 18 },
  percent: { precision: 12, scale: 6 },
  multiple: { precision: 18, scale: 8 },
} as const;

function decimal(
  value: string | number,
  column: { precision: number; scale: number } = PAPER_DECIMAL_COLUMN.money,
): P.Decimal {
  const fitted = fitDecimal(new P.Decimal(value), column);
  if (fitted == null) throw Object.assign(new Error('PAPER_DECIMAL_OUT_OF_RANGE'), {
    code: 'PAPER_DECIMAL_OUT_OF_RANGE',
  });
  return fitted;
}

const priceDecimal = (value: string | number) => decimal(value, PAPER_DECIMAL_COLUMN.price);
const percentDecimal = (value: string | number) => decimal(value, PAPER_DECIMAL_COLUMN.percent);
const multipleDecimal = (value: string | number) => decimal(value, PAPER_DECIMAL_COLUMN.multiple);

function json(value: unknown): P.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as P.InputJsonValue;
}

function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function policyWithStableIdentity(policy: AllocationPolicySnapshot): AllocationPolicySnapshot {
  const signature = createHash('sha256')
    .update(JSON.stringify({ mode: policy.mode, riskProfile: policy.riskProfile, limits: policy.limits }))
    .digest('hex')
    .slice(0, 12);
  return { ...policy, policyKey: `${policy.policyKey}-${signature}` };
}

function makeFixed(input: ConfigurePaperAllocationInput): AllocationPolicySnapshot {
  const fixed = input.fixed ?? { maxOpenPositions: 4 };
  return policyWithStableIdentity(
    fixedAllocationPolicy({
      capitalUsd: input.capitalUsd,
      maxOpenPositions: fixed.maxOpenPositions,
      reservePct: fixed.reservePct,
      minimumPositionUsd: fixed.minimumPositionUsd,
    }),
  );
}

function makeAutopilot(input: ConfigurePaperAllocationInput): AllocationPolicySnapshot {
  return policyWithStableIdentity(
    autopilotAllocationPolicy(
      input.autopilot?.riskProfile ?? 'BALANCED',
      input.autopilot?.overrides,
    ),
  );
}

function policyPair(input: ConfigurePaperAllocationInput): {
  active: AllocationPolicySnapshot;
  shadow: AllocationPolicySnapshot;
} {
  if (input.mode === 'FIXED') {
    return { active: makeFixed(input), shadow: makeAutopilot(input) };
  }
  const active = makeAutopilot(input);
  const shadowInput: ConfigurePaperAllocationInput = {
    ...input,
    mode: 'FIXED',
    fixed: {
      maxOpenPositions: active.limits.maxOpenPositions,
      reservePct: active.limits.reservePct,
      minimumPositionUsd: active.limits.minimumPositionUsd,
    },
  };
  return { active, shadow: makeFixed(shadowInput) };
}

function assertCapital(value: string): P.Decimal {
  let capital: P.Decimal;
  try {
    capital = decimal(value);
  } catch {
    throw Object.assign(new Error('Некорректный PAPER-капитал'), {
      statusCode: 400,
      code: 'INVALID_PAPER_CAPITAL',
    });
  }
  if (!capital.isFinite() || capital.lte(0) || capital.gt(MONEY_MAX) || capital.decimalPlaces() > 8) {
    throw Object.assign(new Error('PAPER-капитал должен быть больше нуля и помещаться в ledger'), {
      statusCode: 400,
      code: 'INVALID_PAPER_CAPITAL',
    });
  }
  return capital;
}

async function upsertPolicy(tx: P.TransactionClient, policy: AllocationPolicySnapshot): Promise<void> {
  await tx.paperAgentAllocationPolicy.upsert({
    where: { policyKey_version: { policyKey: policy.policyKey, version: policy.policyVersion } },
    create: {
      policyKey: policy.policyKey,
      version: policy.policyVersion,
      mode: policy.mode,
      riskProfile: policy.riskProfile,
      label:
        policy.mode === 'FIXED'
          ? `Fixed · ${policy.limits.maxOpenPositions} позиций`
          : `Autopilot · ${policy.riskProfile}`,
      limits: json(policy.limits),
      scorePolicyKey: policy.scorePolicyKey,
      scorePolicyVersion: policy.scorePolicyVersion,
      status: 'SYSTEM',
      source: 'SYSTEM',
    },
    // Policy versions are immutable. A changed snapshot gets another stable key/version.
    update: {},
  });
}

async function createSession(
  tx: P.TransactionClient,
  kind: 'ACTIVE' | 'SHADOW',
  policy: AllocationPolicySnapshot,
  capital: P.Decimal,
  resetFromId: string | null = null,
) {
  const initial = initialPaperCapitalLedger(capital.toString(), policy.limits.reservePct);
  const session = await tx.paperAgentAccountSession.create({
    data: {
      kind,
      mode: policy.mode,
      policyKey: policy.policyKey,
      policyVersion: policy.policyVersion,
      riskProfile: policy.riskProfile,
      policySnapshot: json(policy),
      scorePolicyKey: policy.scorePolicyKey,
      scorePolicyVersion: policy.scorePolicyVersion,
      reservePct: percentDecimal(policy.limits.reservePct),
      maxExposurePct: percentDecimal(policy.limits.maxExposurePct),
      maxPositionPct: percentDecimal(policy.limits.maxPositionPct),
      maxOpenPositions: policy.limits.maxOpenPositions,
      minimumPositionUsd: decimal(policy.limits.minimumPositionUsd),
      dailyEntryLimit: policy.limits.dailyEntryLimit,
      drawdownStopPct: percentDecimal(policy.limits.drawdownStopPct),
      allowPartialAllocation: policy.limits.allowPartialAllocation,
      initialCapitalUsd: decimal(initial.initialCapitalUsd),
      freeBalanceUsd: decimal(initial.freeBalanceUsd),
      reservedBalanceUsd: decimal(initial.reservedBalanceUsd),
      inPositionsUsd: decimal(initial.inPositionsUsd),
      realizedPnlUsd: decimal(initial.realizedPnlUsd),
      unrealizedPnlUsd: decimal(initial.unrealizedPnlUsd),
      tradingFeesUsd: decimal(initial.tradingFeesUsd),
      slippageUsd: decimal(initial.slippageUsd),
      networkCostsUsd: decimal(initial.networkCostsUsd),
      equityUsd: decimal(initial.equityUsd),
      peakEquityUsd: decimal(initial.peakEquityUsd),
      drawdownPct: decimal(initial.drawdownPct),
      openPositions: 0,
      dailyEntries: 0,
      dailyEntriesDate: utcDay(new Date()),
      resetFromId,
    },
  });
  await tx.paperAgentCapitalLedger.create({
    data: {
      eventKey: `${session.id}:INITIALIZE`,
      sessionId: session.id,
      eventType: 'INITIALIZE',
      amountUsd: capital,
      freeBeforeUsd: 0,
      freeAfterUsd: decimal(initial.freeBalanceUsd),
      reservedBeforeUsd: 0,
      reservedAfterUsd: decimal(initial.reservedBalanceUsd),
      inPositionsBeforeUsd: 0,
      inPositionsAfterUsd: 0,
      realizedPnlAfterUsd: 0,
      equityAfterUsd: capital,
      tradingFeesAfterUsd: 0,
      slippageAfterUsd: 0,
      networkCostsAfterUsd: 0,
      metadata: json({ paper: true, kind, policyKey: policy.policyKey, policyVersion: policy.policyVersion }),
    },
  });
  return session;
}

export async function configurePaperAllocationAccounts(
  input: ConfigurePaperAllocationInput,
  audit?: AuditContext,
) {
  if (env.EXECUTION_MODE !== 'paper') {
    throw Object.assign(new Error('Распределение капитала доступно только в PAPER'), {
      statusCode: 409,
      code: 'PAPER_AGENT_REQUIRES_EXECUTION_MODE_PAPER',
    });
  }
  const capital = assertCapital(input.capitalUsd);
  const pair = policyPair(input);

  return prisma.$transaction(async (tx) => {
    await upsertPolicy(tx, pair.active);
    await upsertPolicy(tx, pair.shadow);
    const previous = await tx.paperAgentAccountSession.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, openPositions: true },
    });
    for (const row of previous) {
      await tx.paperAgentAccountSession.update({
        where: { id: row.id },
        data: {
          status: row.openPositions > 0 ? 'DRAINING' : 'CLOSED',
          closedAt: row.openPositions > 0 ? null : new Date(),
        },
      });
    }

    const active = await createSession(tx, 'ACTIVE', pair.active, capital);
    const shadow = await createSession(tx, 'SHADOW', pair.shadow, capital);
    const before = await tx.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
    await tx.paperAgentControl.update({
      where: { id: CONTROL_ID },
      data: {
        activeAllocationMode: pair.active.mode,
        activeAllocationPolicyKey: pair.active.policyKey,
        activeAllocationPolicyVersion: pair.active.policyVersion,
      },
    });
    if (audit) {
      await tx.auditLog.create({
        data: {
          actorId: audit.actorId,
          action: 'paper_agent.allocation_configure',
          entity: 'PaperAgentControl',
          entityId: CONTROL_ID,
          before: before
            ? json({
                mode: before.activeAllocationMode,
                policyKey: before.activeAllocationPolicyKey,
                policyVersion: before.activeAllocationPolicyVersion,
              })
            : undefined,
          after: json({
            paper: true,
            activeSessionId: active.id,
            shadowSessionId: shadow.id,
            mode: pair.active.mode,
            policyKey: pair.active.policyKey,
            policyVersion: pair.active.policyVersion,
          }),
          ip: audit.ip ?? undefined,
        },
      });
    }
    return { active, shadow };
  });
}

export async function resetPaperAllocationAccount(
  sessionId: string,
  capitalUsd: string | null,
  audit: AuditContext,
) {
  if (env.EXECUTION_MODE !== 'paper') {
    throw Object.assign(new Error('Сброс доступен только в PAPER'), {
      statusCode: 409,
      code: 'PAPER_AGENT_REQUIRES_EXECUTION_MODE_PAPER',
    });
  }
  return prisma.$transaction(async (tx) => {
    const previous = await tx.paperAgentAccountSession.findUnique({ where: { id: sessionId } });
    if (!previous) {
      throw Object.assign(new Error('Капиталовый контур не найден'), {
        statusCode: 404,
        code: 'PAPER_ACCOUNT_NOT_FOUND',
      });
    }
    if (previous.openPositions !== 0) {
      throw Object.assign(new Error('Нельзя сбросить контур с открытыми PAPER-позициями'), {
        statusCode: 409,
        code: 'PAPER_ACCOUNT_HAS_OPEN_POSITIONS',
      });
    }
    const policy = previous.policySnapshot as unknown as AllocationPolicySnapshot;
    const capital = capitalUsd == null ? previous.initialCapitalUsd : assertCapital(capitalUsd);
    await tx.paperAgentAccountSession.update({
      where: { id: previous.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const replacement = await createSession(
      tx,
      previous.kind as 'ACTIVE' | 'SHADOW',
      policy,
      capital,
      previous.id,
    );
    await tx.auditLog.create({
      data: {
        actorId: audit.actorId,
        action: 'paper_agent.account_reset',
        entity: 'PaperAgentAccountSession',
        entityId: previous.id,
        before: json({ sessionId: previous.id, equityUsd: previous.equityUsd.toString() }),
        after: json({ replacementSessionId: replacement.id, capitalUsd: capital.toString() }),
        ip: audit.ip ?? undefined,
      },
    });
    return replacement;
  });
}

function ledgerSnapshot(session: {
  initialCapitalUsd: P.Decimal;
  freeBalanceUsd: P.Decimal;
  reservedBalanceUsd: P.Decimal;
  inPositionsUsd: P.Decimal;
  realizedPnlUsd: P.Decimal;
  unrealizedPnlUsd: P.Decimal;
  tradingFeesUsd: P.Decimal;
  slippageUsd: P.Decimal;
  networkCostsUsd: P.Decimal;
  equityUsd: P.Decimal;
  peakEquityUsd: P.Decimal;
  drawdownPct: P.Decimal;
  openPositions: number;
}): PaperCapitalLedgerSnapshot {
  return {
    initialCapitalUsd: session.initialCapitalUsd.toString(),
    freeBalanceUsd: session.freeBalanceUsd.toString(),
    reservedBalanceUsd: session.reservedBalanceUsd.toString(),
    inPositionsUsd: session.inPositionsUsd.toString(),
    realizedPnlUsd: session.realizedPnlUsd.toString(),
    unrealizedPnlUsd: session.unrealizedPnlUsd.toString(),
    tradingFeesUsd: session.tradingFeesUsd.toString(),
    slippageUsd: session.slippageUsd.toString(),
    networkCostsUsd: session.networkCostsUsd.toString(),
    equityUsd: session.equityUsd.toString(),
    peakEquityUsd: session.peakEquityUsd.toString(),
    drawdownPct: session.drawdownPct.toString(),
    openPositions: session.openPositions,
  };
}

function allocationFacts(signal: AllocationSignalSnapshot, now: Date): PaperSignalAllocationFacts {
  return {
    sourcePurchaseUsd: signal.amountUsd == null ? null : String(signal.amountUsd),
    walletTypes: signal.walletTypes,
    tokenAgeMs:
      signal.token?.poolCreatedAt == null
        ? null
        : Math.max(0, now.getTime() - signal.token.poolCreatedAt.getTime()),
    signalLatencyMs: Math.max(0, now.getTime() - signal.signaledAt.getTime()),
    liquidityUsd: signal.token?.liquidityUsd == null ? null : String(signal.token.liquidityUsd),
    liquidityUpdatedAtMs: signal.token?.priceUpdatedAt?.getTime() ?? null,
    marketCapUsd: signal.marketCapUsd == null ? null : String(signal.marketCapUsd),
    marketCapUpdatedAtMs: signal.receivedAt.getTime(),
    // Phase 3 never derives this from the current signal or future outcome.
    historicalWalletWinRatePct: null,
    historicalWalletSampleSize: null,
    decidedAtMs: now.getTime(),
  };
}

function policyOf(value: unknown): AllocationPolicySnapshot {
  return value as AllocationPolicySnapshot;
}

class AllocationConflict extends Error {}

async function allocateForSession(input: {
  sessionId: string;
  runId: string;
  signal: AllocationSignalSnapshot;
  strategy: PaperAgentStrategy;
  sourcePrice: number;
  commonRunData: Record<string, unknown>;
  now: Date;
}) {
  for (let attempt = 0; attempt < ALLOCATION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const session = await tx.paperAgentAccountSession.findUnique({ where: { id: input.sessionId } });
        if (!session || !['ACTIVE', 'DRAINING'].includes(session.status)) return null;
        const prior = await tx.paperAgentAllocation.findUnique({
          where: { runId_sessionId: { runId: input.runId, sessionId: session.id } },
        });
        if (prior) return prior;

        const today = utcDay(input.now);
        const entriesToday = session.dailyEntriesDate.getTime() === today.getTime()
          ? session.dailyEntries
          : 0;
        const policy = policyOf(session.policySnapshot);
        const facts = allocationFacts(input.signal, input.now);
        const decision = allocatePaperCapital({
          initialCapitalUsd: session.initialCapitalUsd.toString(),
          freeBalanceUsd: session.freeBalanceUsd.toString(),
          reservedBalanceUsd: session.reservedBalanceUsd.toString(),
          inPositionsUsd: session.inPositionsUsd.toString(),
          openPositions: session.openPositions,
          entriesToday,
          currentDrawdownPct: numberOf(session.drawdownPct) ?? 0,
          policy,
          signal: facts,
        });

        if (!decision.allocated || decision.amountUsd == null) {
          const skipped = await tx.paperAgentAllocation.create({
            data: {
              sessionId: session.id,
              runId: input.runId,
              isShadow: session.kind === 'SHADOW',
              state: 'SKIPPED',
              decisionCode: decision.code,
              mode: policy.mode,
              policyKey: policy.policyKey,
              policyVersion: policy.policyVersion,
              riskProfile: policy.riskProfile,
              policySnapshot: json(policy),
              inputFacts: json(facts),
              signalScore: decision.score.score,
              signalBand: decision.score.band,
              allocationReason: decision.reason,
              freeAfterUsd: decimal(decision.freeAfterUsd),
              reserveAfterUsd: decimal(decision.reserveAfterUsd),
              exposureAfterUsd: decimal(decision.exposureAfterUsd),
            },
          });
          if (session.kind === 'ACTIVE') {
            await tx.paperAgentRun.updateMany({
              where: {
                id: input.runId,
                state: { in: ['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY', 'ELIGIBLE'] },
              },
              data: {
                ...input.commonRunData,
                state: 'SKIPPED',
                decisionCode: `CAPITAL_${decision.code}`,
              },
            });
          }
          return skipped;
        }

        const entry = openPaperPosition(
          { ...input.strategy, positionUsd: Number(decision.amountUsd) },
          input.sourcePrice,
        );
        if (!entry) throw new Error('PAPER_ALLOCATION_ENTRY_CALCULATION_FAILED');
        const mark = markPaperPosition(
          { ...input.strategy, positionUsd: Number(decision.amountUsd) },
          entry,
          entry.sourcePriceUsd,
        );
        if (!mark) throw new Error('PAPER_ALLOCATION_INITIAL_MARK_FAILED');

        const before = ledgerSnapshot(session);
        const after = openPaperCapitalLedger(before, decision.amountUsd);
        const claimed = await tx.paperAgentAccountSession.updateMany({
          where: {
            id: session.id,
            ledgerVersion: session.ledgerVersion,
            status: session.status,
          },
          data: {
            freeBalanceUsd: decimal(after.freeBalanceUsd),
            inPositionsUsd: decimal(after.inPositionsUsd),
            openPositions: after.openPositions,
            dailyEntries: entriesToday + 1,
            dailyEntriesDate: today,
            ledgerVersion: { increment: 1 },
            lastRecalculatedAt: input.now,
          },
        });
        if (claimed.count !== 1) throw new AllocationConflict('ALLOCATION_LEDGER_CONFLICT');

        const allocation = await tx.paperAgentAllocation.create({
          data: {
            sessionId: session.id,
            runId: input.runId,
            isShadow: session.kind === 'SHADOW',
            state: 'OPEN',
            decisionCode: decision.code,
            mode: policy.mode,
            policyKey: policy.policyKey,
            policyVersion: policy.policyVersion,
            riskProfile: policy.riskProfile,
            policySnapshot: json(policy),
            inputFacts: json(facts),
            signalScore: decision.score.score,
            signalBand: decision.score.band,
            allocationReason: decision.reason,
            allocatedUsd: decimal(decision.amountUsd),
            capitalPct: percentDecimal(decision.capitalPct ?? 0),
            freeAfterUsd: decimal(decision.freeAfterUsd),
            reserveAfterUsd: decimal(decision.reserveAfterUsd),
            exposureAfterUsd: decimal(decision.exposureAfterUsd),
            entryAt: input.now,
            entrySourcePriceUsd: priceDecimal(entry.sourcePriceUsd),
            entryExecutionPriceUsd: priceDecimal(entry.executionPriceUsd),
            entryQuantity: priceDecimal(entry.quantity),
            targetSourcePriceUsd: priceDecimal(entry.targetSourcePriceUsd),
            currentSourcePriceUsd: priceDecimal(entry.sourcePriceUsd),
            unrealizedPnlUsd: decimal(mark.pnlUsd),
            peakSourcePriceUsd: priceDecimal(entry.sourcePriceUsd),
            maxMultiple: multipleDecimal(1),
            maxDrawdownPct: percentDecimal(0),
            lastMarkedAt: input.now,
          },
        });
        await tx.paperAgentCapitalLedger.create({
          data: {
            eventKey: `${allocation.id}:OPEN`,
            sessionId: session.id,
            allocationId: allocation.id,
            eventType: 'OPEN',
            amountUsd: decimal(decision.amountUsd),
            freeBeforeUsd: session.freeBalanceUsd,
            freeAfterUsd: decimal(after.freeBalanceUsd),
            reservedBeforeUsd: session.reservedBalanceUsd,
            reservedAfterUsd: session.reservedBalanceUsd,
            inPositionsBeforeUsd: session.inPositionsUsd,
            inPositionsAfterUsd: decimal(after.inPositionsUsd),
            realizedPnlAfterUsd: session.realizedPnlUsd,
            equityAfterUsd: session.equityUsd,
            tradingFeesAfterUsd: session.tradingFeesUsd,
            slippageAfterUsd: session.slippageUsd,
            networkCostsAfterUsd: session.networkCostsUsd,
            metadata: json({
              paper: true,
              mode: policy.mode,
              policyKey: policy.policyKey,
              policyVersion: policy.policyVersion,
              signalScore: decision.score.score,
              signalBand: decision.score.band,
            }),
          },
        });

        if (session.kind === 'ACTIVE') {
          await tx.paperAgentRun.updateMany({
            where: {
              id: input.runId,
              state: { in: ['RECEIVED', 'WAITING_PRICE', 'WAITING_ENTRY', 'ELIGIBLE'] },
            },
            data: {
              ...input.commonRunData,
              state: 'PAPER_OPEN',
              entryAt: input.now,
              positionUsd: decimal(entry.positionUsd),
              costModelKey: input.strategy.costModelKey,
              tradeFeeBps: input.strategy.tradeFeeBps,
              entrySlippageBps: input.strategy.entrySlippageBps,
              exitSlippageBps: input.strategy.exitSlippageBps,
              networkFeeUsdPerSide: decimal(input.strategy.networkFeeUsdPerSide),
              feeBps: input.strategy.tradeFeeBps,
              slippageBps: input.strategy.entrySlippageBps,
              entrySourcePriceUsd: priceDecimal(entry.sourcePriceUsd),
              entryExecutionPriceUsd: priceDecimal(entry.executionPriceUsd),
              entryQuantity: priceDecimal(entry.quantity),
              entryTradingFeeUsd: decimal(entry.entryTradingFeeUsd),
              entryNetworkFeeUsd: decimal(entry.entryNetworkFeeUsd),
              entrySlippageUsd: decimal(entry.entrySlippageUsd),
              entryFeeUsd: decimal(entry.entryFeeUsd),
              targetSourcePriceUsd: priceDecimal(entry.targetSourcePriceUsd),
              currentSourcePriceUsd: priceDecimal(entry.sourcePriceUsd),
              currentExecutionPriceUsd: priceDecimal(mark.executionExitPriceUsd),
              unrealizedPnlUsd: decimal(mark.pnlUsd),
              peakSourcePriceUsd: priceDecimal(entry.sourcePriceUsd),
              maxMultiple: multipleDecimal(1),
              maxDrawdownPct: percentDecimal(0),
              totalCostsUsd: decimal(mark.totalCostsUsd),
              lastMarkedAt: input.now,
            },
          });
        }

        await enqueuePaperAgentOutbox(tx, {
          eventKey: `${input.runId}:${session.id}:PAPER_BUY:v${policy.policyVersion}`,
          runId: input.runId,
          eventType: 'PAPER_BUY',
          strategyKey: input.strategy.key,
          strategyVersion: input.strategy.version,
          isBaselineEvent: session.kind === 'ACTIVE',
          telegramEligible:
            session.kind === 'ACTIVE' && env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED,
          payload: json({
            paper: true,
            eventType: 'PAPER_BUY',
            runId: input.runId,
            allocationId: allocation.id,
            allocationSessionId: session.id,
            shadow: session.kind === 'SHADOW',
            network: 'Solana',
            symbol: input.signal.symbol,
            address: input.signal.address,
            strategyKey: input.strategy.key,
            strategyLabel: input.strategy.label,
            allocationMode: policy.mode,
            allocationPolicyKey: policy.policyKey,
            allocationPolicyVersion: policy.policyVersion,
            riskProfile: policy.riskProfile,
            allocationReason: decision.reason,
            signalScore: decision.score.score,
            signalBand: decision.score.band,
            allocatedUsd: decision.amountUsd,
            capitalPct: decision.capitalPct,
            freeAfterUsd: decision.freeAfterUsd,
            reserveAfterUsd: decision.reserveAfterUsd,
            exposureAfterUsd: decision.exposureAfterUsd,
            entryExecutionPriceUsd: entry.executionPriceUsd,
            href: `/admin/agent?run=${encodeURIComponent(input.runId)}`,
          }),
        });
        return allocation;
      });
    } catch (error) {
      if (error instanceof AllocationConflict && attempt + 1 < ALLOCATION_RETRIES) continue;
      if ((error as { code?: string })?.code === 'P2002') {
        return prisma.paperAgentAllocation.findUnique({
          where: { runId_sessionId: { runId: input.runId, sessionId: input.sessionId } },
        });
      }
      throw error;
    }
  }
  return null;
}

/**
 * Returns false when Phase 3 is not configured, preserving all Phase 1/2 rows.
 * Once configured, only the baseline run uses the capital engine; the existing
 * threshold shadow strategies remain experiments and do not multiply accounts.
 */
export async function allocatePaperAgentRun(input: {
  runId: string;
  signal: AllocationSignalSnapshot;
  strategy: PaperAgentStrategy;
  sourcePrice: number;
  commonRunData: Record<string, unknown>;
  now: Date;
}): Promise<boolean> {
  if (env.EXECUTION_MODE !== 'paper') return false;
  const control = await prisma.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
  if (
    !control?.isEnabled ||
    !control.activeAllocationMode ||
    input.strategy.key !== control.baselineStrategyKey
  ) {
    return false;
  }
  const sessions = await prisma.paperAgentAccountSession.findMany({
    where: { status: 'ACTIVE', kind: { in: ['ACTIVE', 'SHADOW'] } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
  });
  const active = sessions.find((row) => row.kind === 'ACTIVE');
  const shadow = sessions.find((row) => row.kind === 'SHADOW');
  if (!active) return false;
  await allocateForSession({ ...input, sessionId: active.id });
  if (shadow) await allocateForSession({ ...input, sessionId: shadow.id });
  return true;
}

/**
 * Learning is advisory only. It writes a versioned PROPOSED policy after a
 * complete historical sample; neither control nor an account is mutated.
 */
export async function proposePaperAllocationHypothesisIfReady(
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  const control = await prisma.paperAgentControl.findUnique({ where: { id: CONTROL_ID } });
  if (!control?.learningModeEnabled) return false;
  const session = await prisma.paperAgentAccountSession.findUnique({ where: { id: sessionId } });
  if (!session) return false;
  const closed = await prisma.paperAgentAllocation.findMany({
    where: { sessionId, state: 'CLOSED' },
    select: {
      realizedPnlUsd: true,
      allocatedUsd: true,
      capitalPct: true,
      maxDrawdownPct: true,
      totalCostsUsd: true,
      entryAt: true,
      exitAt: true,
      createdAt: true,
    },
    orderBy: { exitAt: 'asc' },
    take: 5_000,
  });
  if (closed.length < 30) return false;
  const completedWindow = Math.floor(closed.length / 30) * 30;
  const sample = closed.slice(0, completedWindow);
  const proposalKey = `${session.policyKey}-learning-${completedWindow}`;
  const exists = await prisma.paperAgentAllocationPolicy.findUnique({
    where: { policyKey_version: { policyKey: proposalKey, version: 1 } },
  });
  if (exists) return false;
  const base = policyOf(session.policySnapshot);
  const pnl = sample.reduce((sum, row) => sum + (numberOf(row.realizedPnlUsd) ?? 0), 0);
  const wins = sample.filter((row) => (numberOf(row.realizedPnlUsd) ?? 0) > 0).length;
  const positivePnl = sample
    .map((row) => numberOf(row.realizedPnlUsd) ?? 0)
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const negativePnl = Math.abs(sample
    .map((row) => numberOf(row.realizedPnlUsd) ?? 0)
    .filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  const worstDrawdownPct = sample.reduce(
    (worst, row) => Math.max(worst, numberOf(row.maxDrawdownPct) ?? 0),
    0,
  );
  const totalCostsUsd = sample.reduce(
    (sum, row) => sum + (numberOf(row.totalCostsUsd) ?? 0),
    0,
  );
  const capitalPcts = sample
    .map((row) => numberOf(row.capitalPct))
    .filter((value): value is number => value != null);
  const allocations = sample
    .map((row) => numberOf(row.allocatedUsd))
    .filter((value): value is number => value != null);
  const holdingTimes = sample
    .filter((row) => row.entryAt && row.exitAt)
    .map((row) => row.exitAt!.getTime() - row.entryAt!.getTime())
    .filter((value) => value >= 0 && Number.isFinite(value));
  const winRate = wins / sample.length;
  const winRateMarginPct95 = 1.96 * Math.sqrt(winRate * (1 - winRate) / sample.length) * 100;
  const defensive = pnl < 0 || worstDrawdownPct >= base.limits.drawdownStopPct * 0.8;
  const proposedPositionPct = defensive
    ? Math.max(0.01, base.limits.maxPositionPct * 0.9)
    // Learning никогда не увеличивает hard limits. Даже положительная
    // выборка рождает лишь более осторожную shadow-гипотезу.
    : Math.max(0.01, base.limits.maxPositionPct * 0.98);
  const proposedLimits = {
    ...base.limits,
    maxPositionPct: Number(proposedPositionPct.toFixed(8)),
  };
  await prisma.paperAgentAllocationPolicy.create({
    data: {
      policyKey: proposalKey,
      version: 1,
      mode: base.mode,
      riskProfile: base.riskProfile,
      label: `Learning hypothesis · ${completedWindow} outcomes`,
      limits: json(proposedLimits),
      scorePolicyKey: base.scorePolicyKey,
      scorePolicyVersion: base.scorePolicyVersion,
      status: 'PROPOSED',
      source: 'LEARNING',
      hypothesisMetrics: json({
        paper: true,
        parentPolicyKey: base.policyKey,
        parentPolicyVersion: base.policyVersion,
        realizedPnlUsd: pnl,
        netPnlUsd: pnl,
        winRatePct: winRate * 100,
        worstDrawdownPct,
        profitFactor: negativePnl > 0 ? positivePnl / negativePnl : null,
        capitalUtilizationPct: capitalPcts.length
          ? capitalPcts.reduce((sum, value) => sum + value, 0) / capitalPcts.length
          : null,
        averageAllocationUsd: allocations.length
          ? allocations.reduce((sum, value) => sum + value, 0) / allocations.length
          : null,
        averageHoldingMs: holdingTimes.length
          ? holdingTimes.reduce((sum, value) => sum + value, 0) / holdingTimes.length
          : null,
        totalCostsUsd,
        statisticalUncertainty: {
          method: 'WILSON_NORMAL_APPROX_95',
          winRateMarginPct95,
          sampleSize: sample.length,
          sufficient: sample.length >= 30,
        },
        comparisonToActive: {
          maxPositionPctDelta: proposedPositionPct - base.limits.maxPositionPct,
          estimatedMaxPositionUsdBefore:
            (numberOf(session.initialCapitalUsd) ?? 0) * base.limits.maxPositionPct / 100,
          estimatedMaxPositionUsdAfter:
            (numberOf(session.initialCapitalUsd) ?? 0) * proposedPositionPct / 100,
          increasesAnyHardLimit: false,
        },
        proposedChange: {
          maxPositionPct: {
            before: base.limits.maxPositionPct,
            after: proposedLimits.maxPositionPct,
          },
        },
        autoPromotion: false,
      }),
      sampleSize: sample.length,
      periodStart: sample[0]?.createdAt ?? null,
      periodEnd: sample.at(-1)?.exitAt ?? now,
    },
  });
  return true;
}

/** Marks and closes Phase 3 allocations without creating a second price system. */
export async function processPaperAllocationPositions(now = new Date()): Promise<void> {
  const allocations = await prisma.paperAgentAllocation.findMany({
    where: { state: 'OPEN' },
    include: {
      session: true,
      run: {
        include: { strategy: { select: { key: true, version: true, label: true, config: true } } },
      },
    },
    orderBy: { updatedAt: 'asc' },
    take: 200,
  });
  const tokenIds = [...new Set(allocations.map((row) => row.run.tokenId).filter(Boolean))] as string[];
  const tokens = await prisma.token.findMany({
    where: { id: { in: tokenIds } },
    select: { id: true, priceUsd: true },
  });
  const prices = new Map(tokens.map((token) => [token.id, numberOf(token.priceUsd)]));

  for (const allocation of allocations) {
    const sourcePrice = allocation.run.tokenId ? prices.get(allocation.run.tokenId) ?? null : null;
    const allocatedUsd = numberOf(allocation.allocatedUsd);
    const entrySource = numberOf(allocation.entrySourcePriceUsd);
    const entryExecution = numberOf(allocation.entryExecutionPriceUsd);
    const quantity = numberOf(allocation.entryQuantity);
    const target = numberOf(allocation.targetSourcePriceUsd);
    const rawStrategy = allocation.run.strategy.config as unknown as PaperAgentStrategy;
    if (
      sourcePrice == null ||
      allocatedUsd == null ||
      entrySource == null ||
      entryExecution == null ||
      quantity == null ||
      target == null
    ) continue;
    const strategy: PaperAgentStrategy = { ...rawStrategy, positionUsd: allocatedUsd };
    const entryTradingFeeUsd = allocatedUsd * Math.max(0, strategy.tradeFeeBps) / 10_000;
    const entryNetworkFeeUsd = Math.max(0, strategy.networkFeeUsdPerSide);
    const entry = {
      positionUsd: allocatedUsd,
      sourcePriceUsd: entrySource,
      executionPriceUsd: entryExecution,
      quantity,
      entryTradingFeeUsd,
      entryNetworkFeeUsd,
      entrySlippageUsd: Math.max(0, (entryExecution - entrySource) * quantity),
      entryFeeUsd: entryTradingFeeUsd + entryNetworkFeeUsd,
      targetSourcePriceUsd: target,
    };
    const mark = markPaperPosition(strategy, entry, sourcePrice);
    if (!mark) continue;
    const peak = Math.max(numberOf(allocation.peakSourcePriceUsd) ?? entrySource, sourcePrice);
    const currentDrawdown = peak <= 0 ? 0 : Math.max(0, ((peak - sourcePrice) / peak) * 100);
    const maxDrawdown = Math.max(numberOf(allocation.maxDrawdownPct) ?? 0, currentDrawdown);
    const maxMultiple = Math.max(numberOf(allocation.maxMultiple) ?? 1, mark.multiple);

    let didClose = false;
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.paperAgentAllocation.findUnique({ where: { id: allocation.id } });
      const session = await tx.paperAgentAccountSession.findUnique({ where: { id: allocation.sessionId } });
      if (!fresh || fresh.state !== 'OPEN' || !session) return;
      const otherOpen = await tx.paperAgentAllocation.findMany({
        where: { sessionId: session.id, state: 'OPEN', id: { not: fresh.id } },
        select: { unrealizedPnlUsd: true },
      });
      const otherUnrealized = otherOpen.reduce(
        (sum, row) => sum.plus(row.unrealizedPnlUsd ?? 0),
        new P.Decimal(0),
      );
      const markedUnrealized = otherUnrealized.plus(mark.pnlUsd);

      if (!mark.shouldClose) {
        const equity = session.freeBalanceUsd
          .plus(session.reservedBalanceUsd)
          .plus(session.inPositionsUsd)
          .plus(markedUnrealized);
        const peakEquity = P.Decimal.max(session.peakEquityUsd, equity);
        const drawdownPct = peakEquity.lte(0)
          ? new P.Decimal(0)
          : peakEquity.minus(equity).div(peakEquity).mul(100);
        const claimed = await tx.paperAgentAccountSession.updateMany({
          where: { id: session.id, ledgerVersion: session.ledgerVersion },
          data: {
            unrealizedPnlUsd: markedUnrealized,
            equityUsd: equity,
            peakEquityUsd: peakEquity,
            drawdownPct,
            ledgerVersion: { increment: 1 },
            lastRecalculatedAt: now,
          },
        });
        if (claimed.count !== 1) return;
        await tx.paperAgentAllocation.update({
          where: { id: fresh.id },
          data: {
            currentSourcePriceUsd: priceDecimal(mark.sourcePriceUsd),
            unrealizedPnlUsd: decimal(mark.pnlUsd),
            peakSourcePriceUsd: priceDecimal(peak),
            maxMultiple: multipleDecimal(maxMultiple),
            maxDrawdownPct: percentDecimal(maxDrawdown),
            lastMarkedAt: now,
          },
        });
        if (!fresh.isShadow) {
          await tx.paperAgentRun.updateMany({
            where: { id: fresh.runId, state: 'PAPER_OPEN' },
            data: {
              currentSourcePriceUsd: priceDecimal(mark.sourcePriceUsd),
              currentExecutionPriceUsd: priceDecimal(mark.executionExitPriceUsd),
              unrealizedPnlUsd: decimal(mark.pnlUsd),
              totalCostsUsd: decimal(mark.totalCostsUsd),
              peakSourcePriceUsd: priceDecimal(peak),
              maxMultiple: multipleDecimal(maxMultiple),
              maxDrawdownPct: percentDecimal(maxDrawdown),
              lastMarkedAt: now,
            },
          });
        }
        return;
      }

      const before = ledgerSnapshot(session);
      const after = closePaperCapitalLedger(
        { ...before, unrealizedPnlUsd: otherUnrealized.toString() },
        {
          allocatedUsd: allocatedUsd.toString(),
          netExitUsd: mark.netExitUsd.toString(),
          tradingFeesUsd: (entry.entryTradingFeeUsd + mark.exitTradingFeeUsd).toString(),
          slippageUsd: (entry.entrySlippageUsd + mark.exitSlippageUsd).toString(),
          networkCostsUsd: (entry.entryNetworkFeeUsd + mark.exitNetworkFeeUsd).toString(),
        },
      );
      const status = session.status === 'DRAINING' && after.openPositions === 0 ? 'CLOSED' : session.status;
      const claimed = await tx.paperAgentAccountSession.updateMany({
        where: { id: session.id, ledgerVersion: session.ledgerVersion },
        data: {
          freeBalanceUsd: decimal(after.freeBalanceUsd),
          inPositionsUsd: decimal(after.inPositionsUsd),
          realizedPnlUsd: decimal(after.realizedPnlUsd),
          unrealizedPnlUsd: decimal(after.unrealizedPnlUsd),
          tradingFeesUsd: decimal(after.tradingFeesUsd),
          slippageUsd: decimal(after.slippageUsd),
          networkCostsUsd: decimal(after.networkCostsUsd),
          equityUsd: decimal(after.equityUsd),
          peakEquityUsd: decimal(after.peakEquityUsd),
          drawdownPct: decimal(after.drawdownPct),
          openPositions: after.openPositions,
          status,
          closedAt: status === 'CLOSED' ? now : session.closedAt,
          ledgerVersion: { increment: 1 },
          lastRecalculatedAt: now,
        },
      });
      if (claimed.count !== 1) return;
      const costs = {
        trading: entry.entryTradingFeeUsd + mark.exitTradingFeeUsd,
        slippage: entry.entrySlippageUsd + mark.exitSlippageUsd,
        network: entry.entryNetworkFeeUsd + mark.exitNetworkFeeUsd,
      };
      await tx.paperAgentAllocation.update({
        where: { id: fresh.id },
        data: {
          state: 'CLOSED',
          currentSourcePriceUsd: priceDecimal(mark.sourcePriceUsd),
          unrealizedPnlUsd: decimal(0),
          peakSourcePriceUsd: priceDecimal(peak),
          maxMultiple: multipleDecimal(maxMultiple),
          maxDrawdownPct: percentDecimal(maxDrawdown),
          lastMarkedAt: now,
          exitAt: now,
          exitReason: 'TARGET_REACHED',
          exitSourcePriceUsd: priceDecimal(mark.sourcePriceUsd),
          exitExecutionPriceUsd: priceDecimal(mark.executionExitPriceUsd),
          grossExitUsd: decimal(mark.grossExitUsd),
          netExitUsd: decimal(mark.netExitUsd),
          realizedPnlUsd: decimal(mark.pnlUsd),
          tradingFeesUsd: decimal(costs.trading),
          slippageUsd: decimal(costs.slippage),
          networkCostsUsd: decimal(costs.network),
          totalCostsUsd: decimal(mark.totalCostsUsd),
        },
      });
      await tx.paperAgentCapitalLedger.create({
        data: {
          eventKey: `${fresh.id}:CLOSE`,
          sessionId: session.id,
          allocationId: fresh.id,
          eventType: 'CLOSE',
          amountUsd: decimal(mark.netExitUsd),
          freeBeforeUsd: session.freeBalanceUsd,
          freeAfterUsd: decimal(after.freeBalanceUsd),
          reservedBeforeUsd: session.reservedBalanceUsd,
          reservedAfterUsd: session.reservedBalanceUsd,
          inPositionsBeforeUsd: session.inPositionsUsd,
          inPositionsAfterUsd: decimal(after.inPositionsUsd),
          realizedPnlAfterUsd: decimal(after.realizedPnlUsd),
          equityAfterUsd: decimal(after.equityUsd),
          tradingFeesAfterUsd: decimal(after.tradingFeesUsd),
          slippageAfterUsd: decimal(after.slippageUsd),
          networkCostsAfterUsd: decimal(after.networkCostsUsd),
          metadata: json({ paper: true, exitReason: 'TARGET_REACHED' }),
        },
      });
      if (!fresh.isShadow) {
        await tx.paperAgentRun.updateMany({
          where: { id: fresh.runId, state: 'PAPER_OPEN' },
          data: {
            state: 'PAPER_CLOSED',
            currentSourcePriceUsd: priceDecimal(mark.sourcePriceUsd),
            currentExecutionPriceUsd: priceDecimal(mark.executionExitPriceUsd),
            unrealizedPnlUsd: decimal(0),
            exitAt: now,
            exitReason: 'TARGET_REACHED',
            exitSourcePriceUsd: priceDecimal(mark.sourcePriceUsd),
            exitExecutionPriceUsd: priceDecimal(mark.executionExitPriceUsd),
            exitTradingFeeUsd: decimal(mark.exitTradingFeeUsd),
            exitNetworkFeeUsd: decimal(mark.exitNetworkFeeUsd),
            exitSlippageUsd: decimal(mark.exitSlippageUsd),
            exitFeeUsd: decimal(mark.exitFeeUsd),
            grossExitUsd: decimal(mark.grossExitUsd),
            netExitUsd: decimal(mark.netExitUsd),
            realizedPnlUsd: decimal(mark.pnlUsd),
            totalCostsUsd: decimal(mark.totalCostsUsd),
            maxMultiple: multipleDecimal(maxMultiple),
            maxDrawdownPct: percentDecimal(maxDrawdown),
            lastMarkedAt: now,
          },
        });
      }
      const payload = json({
        paper: true,
        eventType: 'TRADE_RESULT',
        runId: fresh.runId,
        allocationId: fresh.id,
        allocationSessionId: session.id,
        shadow: fresh.isShadow,
        network: 'Solana',
        symbol: allocation.run.symbol,
        address: allocation.run.address,
        strategyKey: allocation.run.strategy.key,
        strategyLabel: allocation.run.strategy.label,
        allocationMode: fresh.mode,
        allocationPolicyKey: fresh.policyKey,
        allocationPolicyVersion: fresh.policyVersion,
        riskProfile: fresh.riskProfile,
        allocationReason: fresh.allocationReason,
        allocatedUsd,
        capitalPct: numberOf(fresh.capitalPct),
        freeAfterUsd: numberOf(after.freeBalanceUsd),
        reserveAfterUsd: numberOf(after.reservedBalanceUsd),
        exposureAfterUsd: numberOf(after.inPositionsUsd),
        exitExecutionPriceUsd: mark.executionExitPriceUsd,
        pnlUsd: mark.pnlUsd,
        pnlPct: allocatedUsd > 0 ? mark.pnlUsd / allocatedUsd * 100 : null,
        totalCostsUsd: mark.totalCostsUsd,
        maxMultiple,
        maxDrawdownPct: maxDrawdown,
        href: `/admin/agent?run=${encodeURIComponent(fresh.runId)}`,
      });
      for (const eventType of ['PAPER_SELL', 'TRADE_RESULT'] as const) {
        await enqueuePaperAgentOutbox(tx, {
          eventKey: `${fresh.runId}:${session.id}:${eventType}:v${fresh.policyVersion}`,
          runId: fresh.runId,
          eventType,
          strategyKey: allocation.run.strategy.key,
          strategyVersion: allocation.run.strategy.version,
          isBaselineEvent: !fresh.isShadow,
          telegramEligible: !fresh.isShadow && env.TELEGRAM_AGENT_NOTIFICATIONS_ENABLED,
          payload: json({ ...(payload as Record<string, unknown>), eventType }),
        });
      }
      didClose = true;
    });
    if (didClose) {
      await proposePaperAllocationHypothesisIfReady(allocation.sessionId, now).catch(() => false);
    }
  }
}
