-- Keep each game bound to the normalized script that was used at start.
ALTER TABLE "games" ADD COLUMN "scriptSnapshot" JSONB;
ALTER TABLE "games" ADD COLUMN "scriptHash" TEXT;
ALTER TABLE "games" ADD COLUMN "scriptSnapshotSource" TEXT;

-- Model binding capabilities and input context budget.
ALTER TABLE "model_bindings" ADD COLUMN "contextWindow" INTEGER;
ALTER TABLE "model_bindings" ADD COLUMN "supportsSystem" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "model_bindings" ADD COLUMN "supportsJson" BOOLEAN NOT NULL DEFAULT false;

-- Vector rows from before this migration remain readable as legacy space.
ALTER TABLE "event_vectors" ADD COLUMN "spaceId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "event_vectors" ADD COLUMN "dimension" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "event_vectors" ADD COLUMN "sourceHash" TEXT;
CREATE INDEX "event_vectors_gameId_spaceId_idx" ON "event_vectors"("gameId", "spaceId");
