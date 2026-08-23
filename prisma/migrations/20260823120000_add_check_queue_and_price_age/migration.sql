-- Очередь проверки и возраст цены.
--
-- Только добавление. Ни одна существующая колонка не меняется,
-- не переименовывается и не удаляется; значений по умолчанию,
-- которые переписали бы историю, здесь нет.
--
-- Умолчания у счётчика и флага нужны, чтобы полторы тысячи
-- существующих строк не оказались с NULL там, где код ждёт число.
-- У временных колонок умолчания нет намеренно: `now()` объявил бы
-- все цены свежими в момент миграции, то есть выдал бы вчерашние
-- котировки за сегодняшние.

ALTER TABLE "Token" ADD COLUMN "scamCheckAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Token" ADD COLUMN "scamCheckNextAt" TIMESTAMP(3);
ALTER TABLE "Token" ADD COLUMN "scamProviderError" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Token" ADD COLUMN "priceUpdatedAt" TIMESTAMP(3);

CREATE INDEX "Token_scamCheckNextAt_idx" ON "Token"("scamCheckNextAt");
CREATE INDEX "Token_isHidden_priceUpdatedAt_idx" ON "Token"("isHidden", "priceUpdatedAt");
