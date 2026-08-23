-- Peak since each OKX Signal event. Additive only; existing events remain valid.
ALTER TABLE "OkxSignal"
ADD COLUMN "peakPriceUsd" DECIMAL(38,18),
ADD COLUMN "peakObservedAt" TIMESTAMP(3);

-- The signal quote is the first known point of the peak series.
-- Unknown signal prices deliberately remain NULL rather than becoming zero.
UPDATE "OkxSignal"
SET "peakPriceUsd" = "priceUsd",
    "peakObservedAt" = "signaledAt"
WHERE "priceUsd" IS NOT NULL;
