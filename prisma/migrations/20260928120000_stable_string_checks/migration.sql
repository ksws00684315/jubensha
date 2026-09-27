-- 上线前请在目标库逐项执行下列检查，确保没有非法历史值，再运行 migrate deploy：
-- SELECT status, count(*) FROM rooms GROUP BY status;
-- SELECT kind, count(*) FROM seats GROUP BY kind;
-- SELECT status, count(*) FROM games GROUP BY status;
-- SELECT phase, count(*) FROM games GROUP BY phase;
-- SELECT protocol, count(*) FROM ai_providers GROUP BY protocol;
-- SELECT source, count(*) FROM scripts GROUP BY source;
-- SELECT difficulty, count(*) FROM scripts GROUP BY difficulty;
-- 合法值依次为：rooms.status lobby/playing/ended/aborted；seats.kind human/ai/empty；
-- games.status running/ended/aborted；games.phase LOBBY/READING/SELF_INTRO/SEARCH/DISCUSSION/VOTE/REVEAL/ENDED；
-- ai_providers.protocol openai_compatible/anthropic；scripts.source manual/ai/import；
-- scripts.difficulty 新手/进阶/硬核。

ALTER TABLE "rooms" ADD CONSTRAINT "rooms_status_stable_check"
  CHECK ("status" IN ('lobby', 'playing', 'ended', 'aborted'));

ALTER TABLE "seats" ADD CONSTRAINT "seats_kind_stable_check"
  CHECK ("kind" IN ('human', 'ai', 'empty'));

ALTER TABLE "games" ADD CONSTRAINT "games_status_stable_check"
  CHECK ("status" IN ('running', 'ended', 'aborted'));

ALTER TABLE "games" ADD CONSTRAINT "games_phase_stable_check"
  CHECK ("phase" IN ('LOBBY', 'READING', 'SELF_INTRO', 'SEARCH', 'DISCUSSION', 'VOTE', 'REVEAL', 'ENDED'));

ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_protocol_stable_check"
  CHECK ("protocol" IN ('openai_compatible', 'anthropic'));

ALTER TABLE "scripts" ADD CONSTRAINT "scripts_source_stable_check"
  CHECK ("source" IN ('manual', 'ai', 'import'));

ALTER TABLE "scripts" ADD CONSTRAINT "scripts_difficulty_stable_check"
  CHECK ("difficulty" IN ('新手', '进阶', '硬核'));
