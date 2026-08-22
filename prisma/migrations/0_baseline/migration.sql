-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'TRADER', 'ADMIN');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE');

-- CreateEnum
CREATE TYPE "WalletKind" AS ENUM ('HOT_DEPOSIT', 'HOT_TRADING', 'COLD', 'FEE_COLLECTOR');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE_IN', 'TRADE_OUT', 'FEE_PERFORMANCE', 'FEE_SWAP', 'FEE_NETWORK', 'LOCK', 'UNLOCK', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('MANUAL', 'COPY_TRADE', 'CALL', 'API');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "RadarChannel" AS ENUM ('IN_APP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'HIT_TARGET', 'STOPPED_OUT', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CallRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'DEGEN');

-- CreateEnum
CREATE TYPE "CopyStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CopyPendingMode" AS ENUM ('ON_FILL', 'MIRROR');

-- CreateEnum
CREATE TYPE "CopySizing" AS ENUM ('FIXED_USD', 'PCT_EQUITY', 'PROPORTIONAL');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PERFORMANCE', 'SWAP', 'WITHDRAWAL', 'NETWORK');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('ACCRUED', 'SETTLED', 'WAIVED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'AWAITING_2FA', 'MANUAL_REVIEW', 'APPROVED', 'BROADCAST', 'CONFIRMED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "telegramChatId" TEXT,
    "telegramLinkCode" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NONE',
    "kycRef" TEXT,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "logoUrl" TEXT,
    "isQuote" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "poolAddress" TEXT,
    "source" TEXT DEFAULT 'manual',
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "liquidityUsd" DECIMAL(24,8),
    "volume24hUsd" DECIMAL(24,8),
    "priceUsd" DECIMAL(38,18),
    "priceChange24h" DECIMAL(12,4),
    "fdvUsd" DECIMAL(24,8),
    "holders" INTEGER,
    "isHoneypot" BOOLEAN NOT NULL DEFAULT false,
    "lpBurnedPct" DECIMAL(8,4),
    "topHolderPct" DECIMAL(8,4),
    "riskScore" INTEGER,
    "scamVerdict" TEXT,
    "scamReasons" JSONB,
    "riskLevel" TEXT,
    "riskCodes" TEXT[],
    "isRegistered" BOOLEAN NOT NULL DEFAULT false,
    "scamCheckedAt" TIMESTAMP(3),
    "scamRulesVersion" INTEGER NOT NULL DEFAULT 0,
    "buys24h" INTEGER,
    "sells24h" INTEGER,
    "socials" JSONB,
    "metricsUpdated" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volumeUsd" DECIMAL(24,8) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "chain" "Chain" NOT NULL,
    "kind" "WalletKind" NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedKey" BYTEA,
    "keyNonce" BYTEA,
    "keyAuthTag" BYTEA,
    "wrappedDek" BYTEA,
    "kmsKeyId" TEXT,
    "derivationPath" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Balance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "available" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "locked" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "tokenInId" TEXT NOT NULL,
    "tokenOutId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "source" "OrderSource" NOT NULL DEFAULT 'MANUAL',
    "amountIn" DECIMAL(38,18) NOT NULL,
    "filledIn" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "filledOut" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "limitPrice" DECIMAL(38,18),
    "triggerPrice" DECIMAL(38,18),
    "trailingBps" INTEGER,
    "slippageBps" INTEGER NOT NULL DEFAULT 100,
    "expiresAt" TIMESTAMP(3),
    "parentOrderId" TEXT,
    "callId" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "amountIn" DECIMAL(38,18) NOT NULL,
    "amountOut" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "valueUsd" DECIMAL(24,8) NOT NULL,
    "route" JSONB,
    "aggregator" TEXT,
    "txSignature" TEXT,
    "blockNumber" BIGINT,
    "networkFeeUsd" DECIMAL(24,8),
    "slippageBps" INTEGER,
    "priceImpactBps" INTEGER,
    "swapFeeUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "performanceFeeUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "realizedPnlUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "status" "TradeStatus" NOT NULL DEFAULT 'SUBMITTED',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "avgCostUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "costBasisUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "realizedPnlUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "feesPaidUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "copiedQuantity" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenResearch" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "securityFlags" JSONB,
    "socials" JSONB,
    "holderStats" JSONB,
    "factSources" JSONB,
    "aiSummary" TEXT,
    "aiRiskScore" INTEGER,
    "aiRiskFactors" JSONB,
    "aiSentiment" TEXT,
    "aiSources" JSONB,
    "aiModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenResearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadarEvent" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "poolAddress" TEXT,
    "priceUsd" DECIMAL(38,18),
    "liquidityUsd" DECIMAL(24,8),
    "volume24hUsd" DECIMAL(24,8),
    "fdvUsd" DECIMAL(24,8),
    "poolAgeHours" DECIMAL(12,4),
    "source" TEXT NOT NULL,
    "riskScore" INTEGER,
    "riskFlags" JSONB,
    "riskLevel" TEXT,
    "riskCodes" TEXT[],
    "riskRulesVersion" INTEGER NOT NULL DEFAULT 0,
    "mcapAtSignalUsd" DECIMAL(24,8),
    "currentMcapUsd" DECIMAL(24,8),
    "peakMcapUsd" DECIMAL(24,8),
    "currentPriceUsd" DECIMAL(38,18),
    "currentMultiple" DECIMAL(12,4),
    "peakMultiple" DECIMAL(12,4),
    "peakAt" TIMESTAMP(3),
    "currentHolders" INTEGER,
    "holdersAtSignal" INTEGER,
    "currentTop10Pct" DECIMAL(8,4),
    "pricePoints" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "walletsCheckedAt" TIMESTAMP(3),
    "smartBuyers" INTEGER NOT NULL DEFAULT 0,
    "smartBuyVolumeUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "whaleBuyers" INTEGER NOT NULL DEFAULT 0,
    "walletSignalScore" INTEGER NOT NULL DEFAULT 0,
    "isTracking" BOOLEAN NOT NULL DEFAULT true,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "listedTokenId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RadarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderWallet" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "knownAs" TEXT,
    "tokensBought" INTEGER NOT NULL DEFAULT 0,
    "wins2x" INTEGER NOT NULL DEFAULT 0,
    "wins5x" INTEGER NOT NULL DEFAULT 0,
    "rugs" INTEGER NOT NULL DEFAULT 0,
    "volumeUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "avgPeakMultiple" DECIMAL(12,4),
    "medianEntryHours" DECIMAL(12,4),
    "score" INTEGER,
    "label" TEXT NOT NULL DEFAULT 'none',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraderWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTrade" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "radarEventId" TEXT,
    "side" TEXT NOT NULL,
    "amountUsd" DECIMAL(24,8) NOT NULL,
    "priceUsd" DECIMAL(38,18),
    "mcapAtTradeUsd" DECIMAL(24,8),
    "poolAgeHours" DECIMAL(12,4),
    "txHash" TEXT,
    "tradedAt" TIMESTAMP(3) NOT NULL,
    "outcomeMultiple" DECIMAL(12,4),
    "outcomeAt" TIMESTAMP(3),

    CONSTRAINT "WalletTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxPerHour" INTEGER NOT NULL DEFAULT 60,
    "maxOrderUsd" DECIMAL(24,8),
    "lastUsedAt" TIMESTAMP(3),
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Основное правило',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isDryRun" BOOLEAN NOT NULL DEFAULT true,
    "chains" "Chain"[],
    "minSmartBuyers" INTEGER NOT NULL DEFAULT 2,
    "minSignalStrength" INTEGER NOT NULL DEFAULT 40,
    "minSmartVolumeUsd" DECIMAL(24,8) NOT NULL DEFAULT 3000,
    "minLiquidityUsd" DECIMAL(24,8) NOT NULL DEFAULT 30000,
    "minVolume24hUsd" DECIMAL(24,8) NOT NULL DEFAULT 20000,
    "maxRiskScore" INTEGER NOT NULL DEFAULT 60,
    "maxPoolAgeHours" INTEGER NOT NULL DEFAULT 72,
    "maxCallsPerDay" INTEGER NOT NULL DEFAULT 5,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "targetPcts" JSONB NOT NULL DEFAULT '[50, 100, 200]',
    "stopLossPct" INTEGER NOT NULL DEFAULT 35,
    "suggestedPct" DECIMAL(8,4) NOT NULL DEFAULT 2,
    "timeHorizon" TEXT NOT NULL DEFAULT '1-3 дня',
    "isCopyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoRuleFire" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "radarEventId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoRuleFire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadarSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "RadarChannel" NOT NULL DEFAULT 'IN_APP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "chains" "Chain"[],
    "minLiquidityUsd" DECIMAL(24,8),
    "minVolume24hUsd" DECIMAL(24,8),
    "maxRiskScore" INTEGER,
    "maxPoolAgeHours" INTEGER,
    "maxAlertsPerHour" INTEGER NOT NULL DEFAULT 20,
    "sentLastHour" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadarSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "title" TEXT NOT NULL,
    "thesis" TEXT NOT NULL,
    "risk" "CallRisk" NOT NULL DEFAULT 'HIGH',
    "status" "CallStatus" NOT NULL DEFAULT 'DRAFT',
    "entryPriceUsd" DECIMAL(38,18) NOT NULL,
    "targets" JSONB NOT NULL,
    "stopLossUsd" DECIMAL(38,18),
    "suggestedPct" DECIMAL(8,4),
    "timeHorizon" TEXT,
    "links" JSONB,
    "peakPriceUsd" DECIMAL(38,18),
    "peakMultiple" DECIMAL(12,4),
    "closedPriceUsd" DECIMAL(38,18),
    "resultPct" DECIMAL(12,4),
    "isCopyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopySubscription" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "status" "CopyStatus" NOT NULL DEFAULT 'ACTIVE',
    "sizing" "CopySizing" NOT NULL DEFAULT 'PCT_EQUITY',
    "pendingMode" "CopyPendingMode" NOT NULL DEFAULT 'ON_FILL',
    "maxLockedShare" DECIMAL(5,4) DEFAULT 0.5,
    "fixedUsd" DECIMAL(24,8),
    "pctEquity" DECIMAL(8,4),
    "maxPerTradeUsd" DECIMAL(24,8),
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 10,
    "dailyLossLimitUsd" DECIMAL(24,8),
    "allowedChains" "Chain"[],
    "minLiquidityUsd" DECIMAL(24,8),
    "maxRiskScore" INTEGER,
    "performanceFeeBps" INTEGER NOT NULL DEFAULT 1000,
    "highWaterMarkUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "copiedTrades" INTEGER NOT NULL DEFAULT 0,
    "grossPnlUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "feesPaidUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "acceptedTermsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradeId" TEXT,
    "subscriptionId" TEXT,
    "leaderId" TEXT,
    "type" "FeeType" NOT NULL,
    "status" "FeeStatus" NOT NULL DEFAULT 'ACCRUED',
    "basisPnlUsd" DECIMAL(24,8) NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "amountUsd" DECIMAL(24,8) NOT NULL,
    "amountToken" DECIMAL(38,18) NOT NULL,
    "feeTokenId" TEXT,
    "leaderShareUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "platformShareUsd" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "calcSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "FeeLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "txSignature" TEXT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "isCredited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "feeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "toAddress" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "txSignature" TEXT,
    "reviewedBy" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WalletActivity" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "side" TEXT NOT NULL,
    "quoteSymbol" TEXT,
    "quoteAmount" DECIMAL(38,18),
    "priceUsd" DECIMAL(38,18),
    "marketCapUsd" DECIMAL(24,8),
    "realizedPnlUsd" DECIMAL(24,8),
    "txHash" TEXT,
    "trackerType" INTEGER,
    "source" TEXT NOT NULL,
    "parsingConfidence" DECIMAL(4,3) NOT NULL DEFAULT 1,
    "appliedToLedger" BOOLEAN NOT NULL DEFAULT false,
    "ledgerState" TEXT NOT NULL DEFAULT 'pending',
    "ledgerAppliedAt" TIMESTAMP(3),
    "ledgerErrorCode" TEXT,
    "ledgerAttempts" INTEGER NOT NULL DEFAULT 0,
    "tradedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobState" (
    "name" TEXT NOT NULL,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "itemCount" INTEGER,
    "errorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobState_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "WalletEconomicTrade" (
    "key" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "side" TEXT NOT NULL,
    "amount" DECIMAL(40,18) NOT NULL,
    "valueUsd" DECIMAL(30,10) NOT NULL,
    "price" DECIMAL(40,20) NOT NULL,
    "marketCapUsd" DECIMAL(30,10),
    "providerPnlUsd" DECIMAL(30,10),
    "provider" TEXT NOT NULL DEFAULT 'okx_dex_history',
    "tradedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletEconomicTrade_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WalletSyncQueue" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 1,
    "lockedBy" TEXT,
    "leaseToken" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletSyncQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramLinkCode_key" ON "User"("telegramLinkCode");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "WalletFavorite_userId_createdAt_idx" ON "WalletFavorite"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFavorite_userId_chain_walletAddress_key" ON "WalletFavorite"("userId", "chain", "walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Token_chain_isVerified_idx" ON "Token"("chain", "isVerified");

-- CreateIndex
CREATE INDEX "Token_volume24hUsd_idx" ON "Token"("volume24hUsd");

-- CreateIndex
CREATE INDEX "Token_scamVerdict_volume24hUsd_idx" ON "Token"("scamVerdict", "volume24hUsd");

-- CreateIndex
CREATE INDEX "Token_scamCheckedAt_idx" ON "Token"("scamCheckedAt");

-- CreateIndex
CREATE INDEX "Token_scamRulesVersion_idx" ON "Token"("scamRulesVersion");

-- CreateIndex
CREATE INDEX "Token_riskLevel_volume24hUsd_idx" ON "Token"("riskLevel", "volume24hUsd");

-- CreateIndex
CREATE UNIQUE INDEX "Token_chain_address_key" ON "Token"("chain", "address");

-- CreateIndex
CREATE INDEX "Candle_tokenId_interval_openTime_idx" ON "Candle"("tokenId", "interval", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_tokenId_interval_openTime_key" ON "Candle"("tokenId", "interval", "openTime");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_chain_address_key" ON "Wallet"("chain", "address");

-- CreateIndex
CREATE INDEX "Balance_userId_idx" ON "Balance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Balance_userId_tokenId_key" ON "Balance"("userId", "tokenId");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_tokenId_createdAt_idx" ON "LedgerEntry"("userId", "tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_refType_refId_idx" ON "LedgerEntry"("refType", "refId");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Order_status_type_idx" ON "Order"("status", "type");

-- CreateIndex
CREATE INDEX "Order_parentOrderId_idx" ON "Order"("parentOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_txSignature_key" ON "Trade"("txSignature");

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- CreateIndex
CREATE INDEX "Position_userId_idx" ON "Position"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_userId_tokenId_key" ON "Position"("userId", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenResearch_tokenId_key" ON "TokenResearch"("tokenId");

-- CreateIndex
CREATE INDEX "TokenResearch_updatedAt_idx" ON "TokenResearch"("updatedAt");

-- CreateIndex
CREATE INDEX "RadarEvent_firstSeenAt_idx" ON "RadarEvent"("firstSeenAt");

-- CreateIndex
CREATE INDEX "RadarEvent_notified_riskScore_idx" ON "RadarEvent"("notified", "riskScore");

-- CreateIndex
CREATE INDEX "RadarEvent_isTracking_lastCheckedAt_idx" ON "RadarEvent"("isTracking", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "RadarEvent_isTracking_walletsCheckedAt_idx" ON "RadarEvent"("isTracking", "walletsCheckedAt");

-- CreateIndex
CREATE INDEX "RadarEvent_peakMultiple_idx" ON "RadarEvent"("peakMultiple");

-- CreateIndex
CREATE INDEX "RadarEvent_riskLevel_firstSeenAt_idx" ON "RadarEvent"("riskLevel", "firstSeenAt");

-- CreateIndex
CREATE INDEX "RadarEvent_riskLevel_currentMultiple_idx" ON "RadarEvent"("riskLevel", "currentMultiple");

-- CreateIndex
CREATE INDEX "RadarEvent_riskLevel_liquidityUsd_idx" ON "RadarEvent"("riskLevel", "liquidityUsd");

-- CreateIndex
CREATE INDEX "RadarEvent_riskLevel_riskScore_idx" ON "RadarEvent"("riskLevel", "riskScore");

-- CreateIndex
CREATE INDEX "RadarEvent_riskRulesVersion_idx" ON "RadarEvent"("riskRulesVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RadarEvent_chain_address_key" ON "RadarEvent"("chain", "address");

-- CreateIndex
CREATE INDEX "TraderWallet_label_score_idx" ON "TraderWallet"("label", "score");

-- CreateIndex
CREATE INDEX "TraderWallet_lastActiveAt_idx" ON "TraderWallet"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "TraderWallet_chain_address_key" ON "TraderWallet"("chain", "address");

-- CreateIndex
CREATE INDEX "WalletTrade_chain_tokenAddress_tradedAt_idx" ON "WalletTrade"("chain", "tokenAddress", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletTrade_radarEventId_idx" ON "WalletTrade"("radarEventId");

-- CreateIndex
CREATE INDEX "WalletTrade_outcomeMultiple_idx" ON "WalletTrade"("outcomeMultiple");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTrade_walletId_txHash_side_key" ON "WalletTrade"("walletId", "txHash", "side");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_tokenHash_key" ON "ApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiKey_isActive_idx" ON "ApiKey"("isActive");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "AutoRuleFire_ruleId_createdAt_idx" ON "AutoRuleFire"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "AutoRuleFire_outcome_createdAt_idx" ON "AutoRuleFire"("outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutoRuleFire_ruleId_radarEventId_key" ON "AutoRuleFire"("ruleId", "radarEventId");

-- CreateIndex
CREATE INDEX "RadarSubscription_isActive_idx" ON "RadarSubscription"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RadarSubscription_userId_channel_key" ON "RadarSubscription"("userId", "channel");

-- CreateIndex
CREATE INDEX "Call_status_publishedAt_idx" ON "Call"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Call_chain_status_idx" ON "Call"("chain", "status");

-- CreateIndex
CREATE INDEX "CopySubscription_leaderId_status_idx" ON "CopySubscription"("leaderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CopySubscription_followerId_leaderId_key" ON "CopySubscription"("followerId", "leaderId");

-- CreateIndex
CREATE INDEX "FeeLedger_userId_createdAt_idx" ON "FeeLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FeeLedger_leaderId_status_idx" ON "FeeLedger"("leaderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_txSignature_key" ON "Deposit"("txSignature");

-- CreateIndex
CREATE INDEX "Deposit_userId_idx" ON "Deposit"("userId");

-- CreateIndex
CREATE INDEX "Withdrawal_userId_status_idx" ON "Withdrawal"("userId", "status");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE INDEX "WalletActivity_tradedAt_idx" ON "WalletActivity"("tradedAt");

-- CreateIndex
CREATE INDEX "WalletActivity_chain_tradedAt_idx" ON "WalletActivity"("chain", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletActivity_walletAddress_tradedAt_idx" ON "WalletActivity"("walletAddress", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletActivity_tokenAddress_tradedAt_idx" ON "WalletActivity"("tokenAddress", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletActivity_side_tradedAt_idx" ON "WalletActivity"("side", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletActivity_source_tradedAt_idx" ON "WalletActivity"("source", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletActivity_appliedToLedger_idx" ON "WalletActivity"("appliedToLedger");

-- CreateIndex
CREATE INDEX "WalletEconomicTrade_walletAddress_chain_tradedAt_idx" ON "WalletEconomicTrade"("walletAddress", "chain", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletEconomicTrade_walletAddress_chain_tokenAddress_traded_idx" ON "WalletEconomicTrade"("walletAddress", "chain", "tokenAddress", "tradedAt");

-- CreateIndex
CREATE INDEX "WalletSyncQueue_dueAt_lockedUntil_idx" ON "WalletSyncQueue"("dueAt", "lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "WalletSyncQueue_chain_walletAddress_key" ON "WalletSyncQueue"("chain", "walletAddress");

-- AddForeignKey
ALTER TABLE "WalletFavorite" ADD CONSTRAINT "WalletFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Balance" ADD CONSTRAINT "Balance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Balance" ADD CONSTRAINT "Balance_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tokenInId_fkey" FOREIGN KEY ("tokenInId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tokenOutId_fkey" FOREIGN KEY ("tokenOutId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenResearch" ADD CONSTRAINT "TokenResearch_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTrade" ADD CONSTRAINT "WalletTrade_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "TraderWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRuleFire" ADD CONSTRAINT "AutoRuleFire_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutoRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRuleFire" ADD CONSTRAINT "AutoRuleFire_radarEventId_fkey" FOREIGN KEY ("radarEventId") REFERENCES "RadarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadarSubscription" ADD CONSTRAINT "RadarSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopySubscription" ADD CONSTRAINT "CopySubscription_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopySubscription" ADD CONSTRAINT "CopySubscription_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeLedger" ADD CONSTRAINT "FeeLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeLedger" ADD CONSTRAINT "FeeLedger_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

