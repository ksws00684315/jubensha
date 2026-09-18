-- Keep author design/review artifacts alongside, but independent from, runtime V2 content.
ALTER TABLE "scripts" ADD COLUMN "designPackage" JSONB;
ALTER TABLE "scripts" ADD COLUMN "designHash" TEXT;
ALTER TABLE "scripts" ADD COLUMN "designReview" JSONB;
