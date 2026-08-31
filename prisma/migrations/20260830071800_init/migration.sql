-- CreateTable
CREATE TABLE "scripts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "minPlayers" INTEGER NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "difficulty" TEXT NOT NULL,
    "tags" TEXT[],
    "intro" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'openai_compatible',
    "baseUrl" TEXT NOT NULL,
    "apiKeyCipher" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_bindings" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION,
    "fallbackSlot" TEXT,

    CONSTRAINT "model_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'lobby',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "playerName" TEXT,
    "characterId" TEXT,
    "token" TEXT,
    "ready" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "phase" TEXT NOT NULL DEFAULT 'LOBBY',
    "round" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_events" (
    "seq" BIGSERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 0,
    "fromSeat" INTEGER,
    "toSeat" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "seat_states" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "seat_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "targetIndex" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_messages" (
    "seq" BIGSERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "fromSeat" INTEGER NOT NULL,
    "toSeat" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "private_messages_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "providerName" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "gameId" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tts_cache" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tts_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_bindings_slot_key" ON "model_bindings"("slot");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE UNIQUE INDEX "seats_roomId_index_key" ON "seats"("roomId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "games_roomId_key" ON "games"("roomId");

-- CreateIndex
CREATE INDEX "game_events_gameId_seq_idx" ON "game_events"("gameId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "seat_states_gameId_seatIndex_key" ON "seat_states"("gameId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "votes_gameId_seatIndex_key" ON "votes"("gameId", "seatIndex");

-- CreateIndex
CREATE INDEX "private_messages_gameId_seq_idx" ON "private_messages"("gameId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tts_cache_hash_key" ON "tts_cache"("hash");

-- AddForeignKey
ALTER TABLE "model_bindings" ADD CONSTRAINT "model_bindings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "scripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_states" ADD CONSTRAINT "seat_states_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_messages" ADD CONSTRAINT "private_messages_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
