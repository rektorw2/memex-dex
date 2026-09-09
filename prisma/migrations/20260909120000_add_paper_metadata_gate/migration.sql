-- Additive, bounded coordination state. Existing trading records are untouched.
CREATE TABLE "PaperMetadataGate" (
  "id" INTEGER NOT NULL,
  "state" JSONB NOT NULL,
  CONSTRAINT "PaperMetadataGate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaperMetadataGate_singleton" CHECK ("id" = 1)
);
