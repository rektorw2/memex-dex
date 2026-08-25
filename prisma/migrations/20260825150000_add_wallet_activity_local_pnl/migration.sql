-- Локальный PnL событий кошелька.
--
-- Только добавление. Старое `realizedPnlUsd` не меняется и остаётся
-- диагностическим числом провайдера. Новые колонки NULL-able без
-- умолчаний: NULL отличает строку, которую ещё не пересчитали новыми
-- правилами, от честно посчитанного нуля.

ALTER TABLE "WalletActivity" ADD COLUMN "canonicalTradeKey" TEXT;
ALTER TABLE "WalletActivity" ADD COLUMN "localRealizedPnlUsd" DECIMAL(30,10);
ALTER TABLE "WalletActivity" ADD COLUMN "localCostBasisUsd" DECIMAL(30,10);
ALTER TABLE "WalletActivity" ADD COLUMN "localPnlState" TEXT;
ALTER TABLE "WalletActivity" ADD COLUMN "pnlVersion" INTEGER;
ALTER TABLE "WalletActivity" ADD COLUMN "pnlComputedAt" TIMESTAMP(3);

-- Одна каноническая сделка может объяснять только одно событие
-- ленты. NULL остаётся разрешённым для ещё не сопоставленных строк.
CREATE UNIQUE INDEX "WalletActivity_canonicalTradeKey_key"
  ON "WalletActivity"("canonicalTradeKey");

CREATE INDEX "WalletActivity_localPnlState_tradedAt_idx"
  ON "WalletActivity"("localPnlState", "tradedAt");

-- Найти прежние события, которые ещё не прошли новые правила.
CREATE INDEX "WalletActivity_pnlVersion_idx"
  ON "WalletActivity"("pnlVersion");
