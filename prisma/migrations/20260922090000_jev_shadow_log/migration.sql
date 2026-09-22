-- 实机影子：Jev 在真实对局里的并行决策记账。纯新增表，旧版本与历史数据不受影响。
CREATE TABLE "jev_shadow_logs" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "jevKey" TEXT,
    "jevProbability" DOUBLE PRECISION,
    "jevConfidence" DOUBLE PRECISION,
    "actualKey" TEXT,
    "agreed" BOOLEAN,
    "legal" BOOLEAN NOT NULL DEFAULT false,
    "usedForAction" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "stateChars" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jev_shadow_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "jev_shadow_logs_gameId_slot_idx" ON "jev_shadow_logs"("gameId", "slot");

CREATE INDEX "jev_shadow_logs_createdAt_idx" ON "jev_shadow_logs"("createdAt");
