-- Additive observability for OKX Signal ingest and paper-agent latency.
-- Historical rows remain NULL and are intentionally excluded from new live percentiles.
ALTER TABLE "OkxSignal"
  ADD COLUMN "ingestOrigin" TEXT,
  ADD COLUMN "paperAgentIngestCode" TEXT;

ALTER TABLE "PaperAgentRun"
  ADD COLUMN "signalOrigin" TEXT,
  ADD COLUMN "providerDeliveryLatencyMs" INTEGER,
  ADD COLUMN "agentDecisionLatencyMs" INTEGER,
  ADD COLUMN "endToEndLatencyMs" INTEGER;

CREATE INDEX "OkxSignal_ingestOrigin_receivedAt_idx"
  ON "OkxSignal"("ingestOrigin", "receivedAt");
CREATE INDEX "OkxSignal_paperAgentIngestCode_receivedAt_idx"
  ON "OkxSignal"("paperAgentIngestCode", "receivedAt");
CREATE INDEX "PaperAgentRun_signalOrigin_createdAt_idx"
  ON "PaperAgentRun"("signalOrigin", "createdAt");
