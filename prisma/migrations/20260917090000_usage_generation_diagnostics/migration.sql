-- Preserve enough information to explain model budgets, retries and stale generations.
ALTER TABLE "usage_logs" ADD COLUMN "requestId" TEXT;
ALTER TABLE "usage_logs" ADD COLUMN "generationId" TEXT;
ALTER TABLE "usage_logs" ADD COLUMN "taskType" TEXT;
ALTER TABLE "usage_logs" ADD COLUMN "inputTokensEstimate" INTEGER;
ALTER TABLE "usage_logs" ADD COLUMN "budgetTokens" INTEGER;
ALTER TABLE "usage_logs" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage_logs" ADD COLUMN "cancelled" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "usage_logs_requestId_idx" ON "usage_logs"("requestId");
CREATE INDEX "usage_logs_generationId_idx" ON "usage_logs"("generationId");
