-- Additive and nullable: old application versions and historical rows remain valid.
ALTER TABLE "model_bindings" ADD COLUMN "detectedSystemSupport" BOOLEAN,
ADD COLUMN "capabilityDetectedAt" TIMESTAMP(3);
ALTER TABLE "usage_logs" ADD COLUMN "fallbackReason" TEXT;
