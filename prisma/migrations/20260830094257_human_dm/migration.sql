-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "dmName" TEXT,
ADD COLUMN     "dmToken" TEXT,
ADD COLUMN     "humanDm" BOOLEAN NOT NULL DEFAULT false;
