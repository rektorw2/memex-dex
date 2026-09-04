-- Сверка зачислений Phase 4. Только добавление: ни одна существующая
-- колонка не меняет тип, не переименовывается и не удаляется, ни одна
-- строка не переписывается.
--
-- Новые колонки допускают NULL без значения по умолчанию намеренно.
-- NULL здесь читается как «ни разу не сверялось» и отличается от
-- проверенного совпадения. Значение по умолчанию объявило бы все
-- существующие строки сверенными, не сверив ни одной.

ALTER TABLE "SolanaDepositEvent"
  ADD COLUMN IF NOT EXISTS "lastChainSeenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "missingSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "consecutiveMissingChecks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reconciliationState" TEXT,
  ADD COLUMN IF NOT EXISTS "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reconcileNotBefore" TIMESTAMP(3);

-- Очередь сверки читается по состоянию и времени следующей попытки.
CREATE INDEX IF NOT EXISTS "SolanaDepositEvent_state_reconcileNotBefore_idx"
  ON "SolanaDepositEvent" ("state", "reconcileNotBefore");

-- Докуда просмотрен отдельный адрес пополнения. Общий checkpoint не
-- отвечает за кошелёк, заведённый после того, как он сдвинулся.
CREATE TABLE IF NOT EXISTS "SolanaDepositAddressCursor" (
  "address" TEXT NOT NULL,
  "scannedThroughSlot" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SolanaDepositAddressCursor_pkey" PRIMARY KEY ("address")
);

-- Защёлка контура пополнений: поднимает сервер, снимает человек.
CREATE TABLE IF NOT EXISTS "FundingSafetyLatch" (
  "id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'HEALTHY',
  "reasonKind" TEXT,
  "eventKey" TEXT,
  "raisedAt" TIMESTAMP(3),
  "clearedAt" TIMESTAMP(3),
  "clearedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FundingSafetyLatch_pkey" PRIMARY KEY ("id")
);
