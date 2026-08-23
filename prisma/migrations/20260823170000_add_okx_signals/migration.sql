-- Official OKX Signal events. Additive only: existing token and radar data stay untouched.
CREATE TABLE "OkxSignal" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "tokenId" TEXT,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "signaledAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceUsd" DECIMAL(38,18),
    "marketCapUsd" DECIMAL(24,8),
    "holders" INTEGER,
    "top10HolderPct" DECIMAL(8,4),
    "walletTypes" TEXT[],
    "triggerWalletCount" INTEGER,
    "amountUsd" DECIMAL(24,8),
    "soldRatioPct" DECIMAL(8,4),
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OkxSignal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OkxSignal_providerKey_key" ON "OkxSignal"("providerKey");
CREATE INDEX "OkxSignal_signaledAt_idx" ON "OkxSignal"("signaledAt");
CREATE INDEX "OkxSignal_chain_signaledAt_idx" ON "OkxSignal"("chain", "signaledAt");
CREATE INDEX "OkxSignal_tokenId_signaledAt_idx" ON "OkxSignal"("tokenId", "signaledAt");
CREATE INDEX "OkxSignal_chain_address_signaledAt_idx" ON "OkxSignal"("chain", "address", "signaledAt");

ALTER TABLE "OkxSignal"
ADD CONSTRAINT "OkxSignal_tokenId_fkey"
FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE SET NULL ON UPDATE CASCADE;
