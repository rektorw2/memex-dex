-- Phase 3 adds deterministic PAPER capital allocation and isolated ACTIVE/SHADOW ledgers.
-- Additive only: no live-execution, wallet, order, subscription or entitlement tables change.

ALTER TABLE "PaperAgentControl"
ADD COLUMN "activeAllocationMode" TEXT,
ADD COLUMN "activeAllocationPolicyKey" TEXT,
ADD COLUMN "activeAllocationPolicyVersion" INTEGER,
ADD COLUMN "learningModeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Phase 3 must never become active merely because a deploy applied its schema.
UPDATE "PaperAgentControl"
SET "isEnabled" = false,
    "activeAllocationMode" = NULL,
    "activeAllocationPolicyKey" = NULL,
    "activeAllocationPolicyVersion" = NULL,
    "learningModeEnabled" = false;

CREATE TABLE "PaperAgentAllocationPolicy" (
    "id" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "riskProfile" TEXT,
    "label" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "scorePolicyKey" TEXT NOT NULL,
    "scorePolicyVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SYSTEM',
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "hypothesisMetrics" JSONB,
    "sampleSize" INTEGER,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperAgentAllocationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperAgentAccountSession" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "policyKey" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "riskProfile" TEXT,
    "policySnapshot" JSONB NOT NULL,
    "scorePolicyKey" TEXT NOT NULL,
    "scorePolicyVersion" INTEGER NOT NULL,
    "reservePct" DECIMAL(8,4) NOT NULL,
    "maxExposurePct" DECIMAL(8,4) NOT NULL,
    "maxPositionPct" DECIMAL(8,4) NOT NULL,
    "maxOpenPositions" INTEGER NOT NULL,
    "minimumPositionUsd" DECIMAL(24,8) NOT NULL,
    "dailyEntryLimit" INTEGER NOT NULL,
    "drawdownStopPct" DECIMAL(8,4) NOT NULL,
    "allowPartialAllocation" BOOLEAN NOT NULL,
    "initialCapitalUsd" DECIMAL(24,8) NOT NULL,
    "freeBalanceUsd" DECIMAL(24,8) NOT NULL,
    "reservedBalanceUsd" DECIMAL(24,8) NOT NULL,
    "inPositionsUsd" DECIMAL(24,8) NOT NULL,
    "realizedPnlUsd" DECIMAL(24,8) NOT NULL,
    "unrealizedPnlUsd" DECIMAL(24,8) NOT NULL,
    "tradingFeesUsd" DECIMAL(24,8) NOT NULL,
    "slippageUsd" DECIMAL(24,8) NOT NULL,
    "networkCostsUsd" DECIMAL(24,8) NOT NULL,
    "equityUsd" DECIMAL(24,8) NOT NULL,
    "peakEquityUsd" DECIMAL(24,8) NOT NULL,
    "drawdownPct" DECIMAL(12,6) NOT NULL,
    "openPositions" INTEGER NOT NULL DEFAULT 0,
    "dailyEntries" INTEGER NOT NULL DEFAULT 0,
    "dailyEntriesDate" TIMESTAMP(3) NOT NULL,
    "ledgerVersion" INTEGER NOT NULL DEFAULT 0,
    "lastRecalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resetFromId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaperAgentAccountSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperAgentAllocation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "isShadow" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL,
    "decisionCode" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "riskProfile" TEXT,
    "policySnapshot" JSONB NOT NULL,
    "inputFacts" JSONB NOT NULL,
    "signalScore" INTEGER NOT NULL,
    "signalBand" TEXT NOT NULL,
    "allocationReason" TEXT NOT NULL,
    "allocatedUsd" DECIMAL(24,8),
    "capitalPct" DECIMAL(12,6),
    "freeAfterUsd" DECIMAL(24,8) NOT NULL,
    "reserveAfterUsd" DECIMAL(24,8) NOT NULL,
    "exposureAfterUsd" DECIMAL(24,8) NOT NULL,
    "entryAt" TIMESTAMP(3),
    "entrySourcePriceUsd" DECIMAL(38,18),
    "entryExecutionPriceUsd" DECIMAL(38,18),
    "entryQuantity" DECIMAL(38,18),
    "targetSourcePriceUsd" DECIMAL(38,18),
    "currentSourcePriceUsd" DECIMAL(38,18),
    "unrealizedPnlUsd" DECIMAL(24,8),
    "peakSourcePriceUsd" DECIMAL(38,18),
    "maxMultiple" DECIMAL(18,8),
    "maxDrawdownPct" DECIMAL(12,6),
    "lastMarkedAt" TIMESTAMP(3),
    "exitAt" TIMESTAMP(3),
    "exitReason" TEXT,
    "exitSourcePriceUsd" DECIMAL(38,18),
    "exitExecutionPriceUsd" DECIMAL(38,18),
    "grossExitUsd" DECIMAL(24,8),
    "netExitUsd" DECIMAL(24,8),
    "realizedPnlUsd" DECIMAL(24,8),
    "tradingFeesUsd" DECIMAL(24,8),
    "slippageUsd" DECIMAL(24,8),
    "networkCostsUsd" DECIMAL(24,8),
    "totalCostsUsd" DECIMAL(24,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaperAgentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperAgentCapitalLedger" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "allocationId" TEXT,
    "eventType" TEXT NOT NULL,
    "amountUsd" DECIMAL(24,8) NOT NULL,
    "freeBeforeUsd" DECIMAL(24,8) NOT NULL,
    "freeAfterUsd" DECIMAL(24,8) NOT NULL,
    "reservedBeforeUsd" DECIMAL(24,8) NOT NULL,
    "reservedAfterUsd" DECIMAL(24,8) NOT NULL,
    "inPositionsBeforeUsd" DECIMAL(24,8) NOT NULL,
    "inPositionsAfterUsd" DECIMAL(24,8) NOT NULL,
    "realizedPnlAfterUsd" DECIMAL(24,8) NOT NULL,
    "equityAfterUsd" DECIMAL(24,8) NOT NULL,
    "tradingFeesAfterUsd" DECIMAL(24,8) NOT NULL,
    "slippageAfterUsd" DECIMAL(24,8) NOT NULL,
    "networkCostsAfterUsd" DECIMAL(24,8) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperAgentCapitalLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaperAgentAllocationPolicy_policyKey_version_key"
ON "PaperAgentAllocationPolicy"("policyKey", "version");
CREATE INDEX "PaperAgentAllocationPolicy_mode_status_idx"
ON "PaperAgentAllocationPolicy"("mode", "status");
CREATE INDEX "PaperAgentAllocationPolicy_status_createdAt_idx"
ON "PaperAgentAllocationPolicy"("status", "createdAt");

CREATE INDEX "PaperAgentAccountSession_kind_status_idx"
ON "PaperAgentAccountSession"("kind", "status");
CREATE INDEX "PaperAgentAccountSession_mode_status_idx"
ON "PaperAgentAccountSession"("mode", "status");
CREATE INDEX "PaperAgentAccountSession_policyKey_policyVersion_idx"
ON "PaperAgentAccountSession"("policyKey", "policyVersion");
CREATE INDEX "PaperAgentAccountSession_resetFromId_idx"
ON "PaperAgentAccountSession"("resetFromId");

CREATE UNIQUE INDEX "PaperAgentAllocation_runId_sessionId_key"
ON "PaperAgentAllocation"("runId", "sessionId");
CREATE INDEX "PaperAgentAllocation_sessionId_state_idx"
ON "PaperAgentAllocation"("sessionId", "state");
CREATE INDEX "PaperAgentAllocation_state_updatedAt_idx"
ON "PaperAgentAllocation"("state", "updatedAt");
CREATE INDEX "PaperAgentAllocation_runId_idx"
ON "PaperAgentAllocation"("runId");

CREATE UNIQUE INDEX "PaperAgentCapitalLedger_eventKey_key"
ON "PaperAgentCapitalLedger"("eventKey");
CREATE INDEX "PaperAgentCapitalLedger_sessionId_createdAt_idx"
ON "PaperAgentCapitalLedger"("sessionId", "createdAt");
CREATE INDEX "PaperAgentCapitalLedger_allocationId_createdAt_idx"
ON "PaperAgentCapitalLedger"("allocationId", "createdAt");
CREATE INDEX "PaperAgentCapitalLedger_eventType_createdAt_idx"
ON "PaperAgentCapitalLedger"("eventType", "createdAt");

ALTER TABLE "PaperAgentAccountSession"
ADD CONSTRAINT "PaperAgentAccountSession_resetFromId_fkey"
FOREIGN KEY ("resetFromId") REFERENCES "PaperAgentAccountSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaperAgentAllocation"
ADD CONSTRAINT "PaperAgentAllocation_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "PaperAgentAccountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaperAgentAllocation"
ADD CONSTRAINT "PaperAgentAllocation_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "PaperAgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperAgentCapitalLedger"
ADD CONSTRAINT "PaperAgentCapitalLedger_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "PaperAgentAccountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaperAgentCapitalLedger"
ADD CONSTRAINT "PaperAgentCapitalLedger_allocationId_fkey"
FOREIGN KEY ("allocationId") REFERENCES "PaperAgentAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
