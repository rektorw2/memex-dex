-- Доказательство проверки узла сети. Только добавление.
--
-- Появилась, потому что готовность сети выводилась из наличия
-- переменной с адресом узла. Переменная не доказывает ни
-- доступности, ни того, что это devnet.
--
-- Адреса узла в таблице нет намеренно: путь и query могут содержать
-- API-ключ, а строка подключения в базе — это утечка, отложенная до
-- первого дампа. Endpoint представлен односторонним отпечатком:
-- по нему видно, что настройку сменили, но не видно, на какую.
--
-- Ни DROP, ни ALTER существующих объектов: миграция добавляет одну
-- таблицу и один индекс и ничего не переписывает.

CREATE TABLE IF NOT EXISTS "SolanaNetworkProof" (
  "id" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "network" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "genesisHash" TEXT,
  "endpointFingerprint" TEXT NOT NULL,
  "methods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failureCode" TEXT,
  "failureKind" TEXT,
  "maxLatencyMs" INTEGER,
  "commitmentLagSlots" INTEGER,
  "verifiedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "checkedBy" TEXT,
  "leaseHolder" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SolanaNetworkProof_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SolanaNetworkProof_network_outcome_idx"
  ON "SolanaNetworkProof" ("network", "outcome");
