-- 向量检索记忆层：公开发言的 embedding 缓存（仅当设置页绑定 embedding 模型后写入）
CREATE TABLE "event_vectors" (
    "gameId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "vector" JSONB NOT NULL,

    CONSTRAINT "event_vectors_pkey" PRIMARY KEY ("gameId","seq")
);
