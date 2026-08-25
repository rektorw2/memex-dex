-- Происхождение и идентичность экономической сделки.
--
-- Только добавление. Ни одна существующая колонка не меняется,
-- не переименовывается и не удаляется; ни одна строка не удаляется.
-- Старые сделки остаются в базе — они лишь перестают считаться
-- дважды, когда backfill свернёт дубли в канонические записи.
--
-- Умолчания у `source`, `fillCount` и `reconciliation` нужны, чтобы
-- существующие строки не оказались с NULL там, где код ждёт значение.
-- У временных колонок умолчания нет намеренно: `now()` объявил бы
-- все прошлые сделки только что импортированными.

ALTER TABLE "WalletEconomicTrade" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'okx_dex_history';
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "sourceEventId" TEXT;
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "txHash" TEXT;
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "fillCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "firstFillAt" TIMESTAMP(3);
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "lastFillAt" TIMESTAMP(3);
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "reconciliation" TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE "WalletEconomicTrade" ADD COLUMN "supersededBy" TEXT;

CREATE INDEX "WalletEconomicTrade_walletAddress_chain_reconciliation_idx"
  ON "WalletEconomicTrade"("walletAddress", "chain", "reconciliation");

CREATE INDEX "WalletEconomicTrade_supersededBy_idx"
  ON "WalletEconomicTrade"("supersededBy");

-- Сильная идентичность живой сделки.
--
-- Частичный индекс, а не обычный unique: `txHash` есть только
-- у событий живой ленты, а история его не отдаёт вовсе. Обычный
-- unique пропустил бы неограниченное число строк с NULL —
-- в Postgres NULL не конфликтует с NULL, — то есть не защитил бы
-- ровно тот случай, ради которого заводится.
CREATE UNIQUE INDEX "WalletEconomicTrade_live_identity"
  ON "WalletEconomicTrade"("chain", "txHash", "side", "tokenAddress")
  WHERE "txHash" IS NOT NULL;
