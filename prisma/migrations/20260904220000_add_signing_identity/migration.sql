-- Связь ключа KMS с адресом Solana. Только добавление.
--
-- Идентификатор ресурса KMS в таблице отсутствует намеренно: по
-- отпечатку и адресу нельзя восстановить ни аккаунт, ни регион,
-- а по имени ресурса — можно.

CREATE TABLE IF NOT EXISTS "SigningIdentity" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'UNREGISTERED',
  "fingerprint" TEXT NOT NULL,
  "solanaAddress" TEXT NOT NULL,
  "keyVersion" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "registeredBy" TEXT,
  "registeredAt" TIMESTAMP(3),
  "pausedReason" TEXT,
  "pausedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SigningIdentity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SigningIdentity_state_idx" ON "SigningIdentity" ("state");
