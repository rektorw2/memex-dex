-- Phase 2 remains paper-only. This migration adds cost snapshots and a reliable outbox.
-- Existing runs are preserved: all new accounting columns are nullable.

ALTER TABLE "PaperAgentControl"
ALTER COLUMN "isEnabled" SET DEFAULT false,
ALTER COLUMN "baselineStrategyKey" SET DEFAULT 'okx-signal-v2-baseline';

-- Safe transition for an environment that applied the uncommitted Phase 1 migration.
-- An administrator must explicitly restore the chosen enabled state after deployment.
UPDATE "PaperAgentControl"
SET "isEnabled" = false,
    "baselineStrategyKey" = 'okx-signal-v2-baseline';

ALTER TABLE "PaperAgentControl"
ADD COLUMN "telegramShadowEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PaperAgentRun"
ADD COLUMN "costModelKey" TEXT,
ADD COLUMN "tradeFeeBps" INTEGER,
ADD COLUMN "entrySlippageBps" INTEGER,
ADD COLUMN "exitSlippageBps" INTEGER,
ADD COLUMN "networkFeeUsdPerSide" DECIMAL(24,8),
ADD COLUMN "entryTradingFeeUsd" DECIMAL(24,8),
ADD COLUMN "entryNetworkFeeUsd" DECIMAL(24,8),
ADD COLUMN "entrySlippageUsd" DECIMAL(24,8),
ADD COLUMN "exitTradingFeeUsd" DECIMAL(24,8),
ADD COLUMN "exitNetworkFeeUsd" DECIMAL(24,8),
ADD COLUMN "exitSlippageUsd" DECIMAL(24,8),
ADD COLUMN "totalCostsUsd" DECIMAL(24,8);

CREATE TABLE "PaperAgentNotification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "runId" TEXT,
    "eventType" TEXT NOT NULL,
    "strategyKey" TEXT,
    "strategyVersion" INTEGER,
    "isBaselineEvent" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "inAppStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "inAppDeliveredAt" TIMESTAMP(3),
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "telegramEligible" BOOLEAN NOT NULL DEFAULT false,
    "telegramStatus" TEXT NOT NULL DEFAULT 'DISABLED',
    "telegramAttempts" INTEGER NOT NULL DEFAULT 0,
    "telegramNextAttemptAt" TIMESTAMP(3),
    "telegramLastAttemptAt" TIMESTAMP(3),
    "telegramDeliveredAt" TIMESTAMP(3),
    "telegramErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaperAgentNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaperAgentNotification_eventKey_key"
ON "PaperAgentNotification"("eventKey");
CREATE INDEX "PaperAgentNotification_inAppStatus_createdAt_idx"
ON "PaperAgentNotification"("inAppStatus", "createdAt");
CREATE INDEX "PaperAgentNotification_isRead_createdAt_idx"
ON "PaperAgentNotification"("isRead", "createdAt");
CREATE INDEX "PaperAgentNotification_telegramStatus_telegramNextAttemptAt_idx"
ON "PaperAgentNotification"("telegramStatus", "telegramNextAttemptAt");
CREATE INDEX "PaperAgentNotification_strategyKey_eventType_createdAt_idx"
ON "PaperAgentNotification"("strategyKey", "eventType", "createdAt");
CREATE INDEX "PaperAgentNotification_runId_createdAt_idx"
ON "PaperAgentNotification"("runId", "createdAt");

ALTER TABLE "PaperAgentNotification"
ADD CONSTRAINT "PaperAgentNotification_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "PaperAgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
