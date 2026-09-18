-- 批次 G：用量日志按时间排序与按对局聚合此前全表扫描
CREATE INDEX IF NOT EXISTS "UsageLog_createdAt_idx" ON "usage_logs"("createdAt");
CREATE INDEX IF NOT EXISTS "UsageLog_gameId_idx" ON "usage_logs"("gameId");
