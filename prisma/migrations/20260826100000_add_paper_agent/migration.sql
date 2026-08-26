-- Phase 1 autonomous agent. Additive and paper-only: no wallet, order or key tables change.
ALTER TABLE "OkxSignal"
ADD COLUMN "triggerWalletAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "PaperAgentControl" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baselineStrategyKey" TEXT NOT NULL DEFAULT 'okx-signal-v2-baseline',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaperAgentControl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperAgentStrategy" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaperAgentStrategy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperAgentRun" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "tokenId" TEXT,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "decisionCode" TEXT,
    "errorCode" TEXT,
    "signaledAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "poolCreatedAt" TIMESTAMP(3),
    "tokenAgeMs" INTEGER,
    "walletTypes" TEXT[],
    "triggerWalletAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "signalAmountUsd" DECIMAL(24,8),
    "signalPriceUsd" DECIMAL(38,18),
    "signalMarketCapUsd" DECIMAL(24,8),
    "decisionPriceUsd" DECIMAL(38,18),
    "priceSource" TEXT,
    "warnings" JSONB,
    "positionUsd" DECIMAL(24,8),
    "feeBps" INTEGER,
    "slippageBps" INTEGER,
    "entryAt" TIMESTAMP(3),
    "entrySourcePriceUsd" DECIMAL(38,18),
    "entryExecutionPriceUsd" DECIMAL(38,18),
    "entryQuantity" DECIMAL(38,18),
    "entryFeeUsd" DECIMAL(24,8),
    "targetSourcePriceUsd" DECIMAL(38,18),
    "currentSourcePriceUsd" DECIMAL(38,18),
    "currentExecutionPriceUsd" DECIMAL(38,18),
    "unrealizedPnlUsd" DECIMAL(24,8),
    "peakSourcePriceUsd" DECIMAL(38,18),
    "maxMultiple" DECIMAL(18,8),
    "maxDrawdownPct" DECIMAL(12,6),
    "lastMarkedAt" TIMESTAMP(3),
    "exitAt" TIMESTAMP(3),
    "exitReason" TEXT,
    "exitSourcePriceUsd" DECIMAL(38,18),
    "exitExecutionPriceUsd" DECIMAL(38,18),
    "exitFeeUsd" DECIMAL(24,8),
    "grossExitUsd" DECIMAL(24,8),
    "netExitUsd" DECIMAL(24,8),
    "realizedPnlUsd" DECIMAL(24,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaperAgentRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaperAgentStrategy_key_key" ON "PaperAgentStrategy"("key");
CREATE INDEX "PaperAgentStrategy_kind_isEnabled_idx" ON "PaperAgentStrategy"("kind", "isEnabled");
CREATE UNIQUE INDEX "PaperAgentRun_signalId_strategyId_key" ON "PaperAgentRun"("signalId", "strategyId");
CREATE INDEX "PaperAgentRun_state_updatedAt_idx" ON "PaperAgentRun"("state", "updatedAt");
CREATE INDEX "PaperAgentRun_strategyId_createdAt_idx" ON "PaperAgentRun"("strategyId", "createdAt");
CREATE INDEX "PaperAgentRun_tokenId_state_idx" ON "PaperAgentRun"("tokenId", "state");
CREATE INDEX "PaperAgentRun_providerKey_idx" ON "PaperAgentRun"("providerKey");

ALTER TABLE "PaperAgentRun"
ADD CONSTRAINT "PaperAgentRun_signalId_fkey"
FOREIGN KEY ("signalId") REFERENCES "OkxSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperAgentRun"
ADD CONSTRAINT "PaperAgentRun_strategyId_fkey"
FOREIGN KEY ("strategyId") REFERENCES "PaperAgentStrategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
