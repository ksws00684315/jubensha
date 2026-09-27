-- S4.1 单写者租约：两列都可空，历史行与新版本代码互不影响（null 即「无人主持」，可被任一实例接管）。
ALTER TABLE "games" ADD COLUMN "ownerId" TEXT,
ADD COLUMN "leaseUntil" TIMESTAMP(3);
