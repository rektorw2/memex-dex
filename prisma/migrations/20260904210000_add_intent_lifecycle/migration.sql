-- Жизненный цикл намерения: происхождение, связь с предложением и
-- отпечаток показанного человеку. Только добавление.
--
-- Отправки по-прежнему нет: состояний SUBMITTED, CONFIRMED и
-- FINALIZED в модели не появляется.

ALTER TABLE "TransactionIntent"
  ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'AGENT_PROPOSAL',
  ADD COLUMN IF NOT EXISTS "proposalId" TEXT,
  ADD COLUMN IF NOT EXISTS "shownFingerprint" TEXT;

CREATE INDEX IF NOT EXISTS "TransactionIntent_proposalId_idx"
  ON "TransactionIntent" ("proposalId");

-- Одно предложение — не больше одного живого намерения.
--
-- Частичный уникальный индекс, а не проверка в коде: два
-- параллельных подтверждения иначе создали бы два намерения
-- на одну и ту же сумму, и оба выглядели бы законными.
--
-- Закрытые состояния из индекса исключены: после отказа или
-- истечения человек вправе получить новое предложение по тому же
-- поводу, и запрещать это незачем.
CREATE UNIQUE INDEX IF NOT EXISTS "TransactionIntent_one_live_per_proposal"
  ON "TransactionIntent" ("proposalId")
  WHERE "proposalId" IS NOT NULL
    AND "state" IN ('DRAFT', 'VALIDATED', 'APPROVED', 'SIGNING', 'SIGNED');
