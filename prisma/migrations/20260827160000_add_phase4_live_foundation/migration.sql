-- Phase 4 foundation is additive only. Nothing here enables network workers.

CREATE TYPE "SolanaDepositEventState" AS ENUM ('DETECTED', 'AWAITING_CONFIRMATIONS', 'CONFIRMED', 'FINALIZED', 'CREDITED', 'REJECTED', 'REVIEW_REQUIRED', 'REORGED');
CREATE TYPE "SolanaTransactionState" AS ENUM ('CREATED', 'QUOTED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'AMBIGUOUS', 'EXPIRED');
CREATE TYPE "LiveAgentProposalState" AS ENUM ('CREATED', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'EXPIRED');
CREATE TYPE "WithdrawalLifecycleState" AS ENUM ('REQUESTED', 'LOCKED', 'APPROVED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'AMBIGUOUS', 'CANCELLED');
CREATE TYPE "ComplianceState" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED');

CREATE TABLE "SolanaDepositCheckpoint" (
  "id" TEXT NOT NULL,
  "lastProcessedSlot" BIGINT NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SolanaDepositCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SolanaDepositEvent" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "instructionIndex" INTEGER NOT NULL,
  "slot" BIGINT NOT NULL,
  "blockhash" TEXT,
  "state" "SolanaDepositEventState" NOT NULL DEFAULT 'DETECTED',
  "mint" TEXT,
  "destination" TEXT NOT NULL,
  "rawAmount" TEXT NOT NULL,
  "decimals" INTEGER,
  "confirmations" INTEGER NOT NULL DEFAULT 0,
  "walletId" TEXT,
  "userId" TEXT,
  "tokenId" TEXT,
  "depositId" TEXT,
  "rejectCode" TEXT,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finalizedAt" TIMESTAMP(3),
  "creditedAt" TIMESTAMP(3),
  "reorgedAt" TIMESTAMP(3),
  CONSTRAINT "SolanaDepositEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveAgentProposal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenId" TEXT,
  "network" "Chain" NOT NULL DEFAULT 'SOLANA',
  "assetAddress" TEXT NOT NULL,
  "assetSymbol" TEXT NOT NULL,
  "amountUsd" DECIMAL(24,8) NOT NULL,
  "estimatedNetworkFeeUsd" DECIMAL(24,8),
  "estimatedPlatformFeeUsd" DECIMAL(24,8),
  "priceImpactBps" INTEGER,
  "riskSnapshot" JSONB NOT NULL,
  "status" "LiveAgentProposalState" NOT NULL DEFAULT 'CREATED',
  "idempotencyKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveAgentProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SolanaTransaction" (
  "id" TEXT NOT NULL,
  "proposalId" TEXT,
  "withdrawalOperationId" TEXT,
  "state" "SolanaTransactionState" NOT NULL DEFAULT 'CREATED',
  "idempotencyKey" TEXT NOT NULL,
  "signature" TEXT,
  "recentBlockhash" TEXT,
  "lastValidBlockHeight" BIGINT,
  "broadcastAttempts" INTEGER NOT NULL DEFAULT 0,
  "quotedInputRaw" TEXT,
  "quotedOutputRaw" TEXT,
  "actualInputRaw" TEXT,
  "actualOutputRaw" TEXT,
  "actualFeeLamports" BIGINT,
  "lastRpcErrorCode" TEXT,
  "submittedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SolanaTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WithdrawalOperation" (
  "id" TEXT NOT NULL,
  "withdrawalId" TEXT NOT NULL,
  "state" "WithdrawalLifecycleState" NOT NULL DEFAULT 'REQUESTED',
  "idempotencyKey" TEXT NOT NULL,
  "lockedAmount" DECIMAL(38,18) NOT NULL,
  "unfinalizedDepositAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "limitsSnapshot" JSONB NOT NULL,
  "complianceReviewId" TEXT,
  "transactionId" TEXT,
  "failureCode" TEXT,
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "WithdrawalOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplianceReview" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "kyc" "ComplianceState" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "aml" "ComplianceState" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "sanctions" "ComplianceState" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "sourceOfFunds" "ComplianceState" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "overall" "ComplianceState" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "providerRef" TEXT,
  "reason" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ComplianceReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SolanaReconciliationIssue" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "expected" JSONB,
  "actual" JSONB,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "resolvedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "SolanaReconciliationIssue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KmsAuditEvent" (
  "id" TEXT NOT NULL,
  "walletId" TEXT,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "keyVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KmsAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SolanaDepositEvent_eventKey_key" ON "SolanaDepositEvent"("eventKey");
CREATE UNIQUE INDEX "SolanaDepositEvent_signature_instructionIndex_key" ON "SolanaDepositEvent"("signature", "instructionIndex");
CREATE UNIQUE INDEX "SolanaDepositEvent_depositId_key" ON "SolanaDepositEvent"("depositId");
CREATE INDEX "SolanaDepositEvent_state_slot_idx" ON "SolanaDepositEvent"("state", "slot");
CREATE INDEX "SolanaDepositEvent_destination_state_idx" ON "SolanaDepositEvent"("destination", "state");
CREATE UNIQUE INDEX "LiveAgentProposal_idempotencyKey_key" ON "LiveAgentProposal"("idempotencyKey");
CREATE INDEX "LiveAgentProposal_userId_status_createdAt_idx" ON "LiveAgentProposal"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "SolanaTransaction_proposalId_key" ON "SolanaTransaction"("proposalId");
CREATE UNIQUE INDEX "SolanaTransaction_withdrawalOperationId_key" ON "SolanaTransaction"("withdrawalOperationId");
CREATE UNIQUE INDEX "SolanaTransaction_idempotencyKey_key" ON "SolanaTransaction"("idempotencyKey");
CREATE UNIQUE INDEX "SolanaTransaction_signature_key" ON "SolanaTransaction"("signature");
CREATE INDEX "SolanaTransaction_state_updatedAt_idx" ON "SolanaTransaction"("state", "updatedAt");
CREATE UNIQUE INDEX "WithdrawalOperation_withdrawalId_key" ON "WithdrawalOperation"("withdrawalId");
CREATE UNIQUE INDEX "WithdrawalOperation_idempotencyKey_key" ON "WithdrawalOperation"("idempotencyKey");
CREATE UNIQUE INDEX "WithdrawalOperation_transactionId_key" ON "WithdrawalOperation"("transactionId");
CREATE INDEX "WithdrawalOperation_state_createdAt_idx" ON "WithdrawalOperation"("state", "createdAt");
CREATE UNIQUE INDEX "ComplianceReview_operationType_operationId_key" ON "ComplianceReview"("operationType", "operationId");
CREATE INDEX "ComplianceReview_userId_overall_createdAt_idx" ON "ComplianceReview"("userId", "overall", "createdAt");
CREATE UNIQUE INDEX "SolanaReconciliationIssue_eventKey_kind_key" ON "SolanaReconciliationIssue"("eventKey", "kind");
CREATE INDEX "SolanaReconciliationIssue_status_createdAt_idx" ON "SolanaReconciliationIssue"("status", "createdAt");
CREATE INDEX "KmsAuditEvent_walletId_createdAt_idx" ON "KmsAuditEvent"("walletId", "createdAt");
CREATE INDEX "KmsAuditEvent_action_status_createdAt_idx" ON "KmsAuditEvent"("action", "status", "createdAt");
