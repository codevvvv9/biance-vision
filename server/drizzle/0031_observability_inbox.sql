-- P2a-1 排障闭环存储（方案 §11.0/§11.1）：
-- 1) observability_inbox：已投影的服务端安全/错误/抽样日志 + 浏览器事件（P2a-3 起）。
--    source 由连接身份/生产者固定（server/browser），不能由客户端选择；
--    唯一 (source, purpose, subject_hash, event_id) 去重（客户端重试不重复计数）。
--    user-api 只 INSERT（+ON CONFLICT DO NOTHING），无 SELECT/UPDATE/DELETE。
-- 2) observability_error_groups：错误聚合（fingerprint+release 唯一）——
--    first/last_seen/count/样本；管理端查询专用（P2a-4）。
-- 保留：inbox 原始 14 天；error_groups 30 天无新事件清理（worker 周期任务）。
CREATE TABLE IF NOT EXISTS "observability_inbox" (
	"source" text NOT NULL,
	"purpose" text NOT NULL,
	"subject_hash" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"origin_request_id" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamptz NOT NULL DEFAULT now(),
	"processed_at" timestamptz,
	CONSTRAINT "observability_inbox_dedup_pk" PRIMARY KEY ("source", "purpose", "subject_hash", "event_id")
);
CREATE INDEX IF NOT EXISTS "observability_inbox_received_idx" ON "observability_inbox" ("received_at");
CREATE INDEX IF NOT EXISTS "observability_inbox_request_idx" ON "observability_inbox" ("request_id");

CREATE TABLE IF NOT EXISTS "observability_error_groups" (
	"fingerprint" text NOT NULL,
	"release" text NOT NULL DEFAULT 'unknown',
	"source" text NOT NULL DEFAULT 'server',
	"first_seen" timestamptz NOT NULL DEFAULT now(),
	"last_seen" timestamptz NOT NULL DEFAULT now(),
	"count" integer NOT NULL DEFAULT 1,
	"status" text NOT NULL DEFAULT 'open',
	"sample" jsonb,
	CONSTRAINT "observability_error_groups_pk" PRIMARY KEY ("fingerprint", "release")
);
CREATE INDEX IF NOT EXISTS "observability_error_groups_last_seen_idx" ON "observability_error_groups" ("last_seen");

-- 聚合 upsert（受控）：命中同指纹 last_seen/count 递增并刷新样本；否则新组。
-- biance_user 经此函数写 error_groups（无直接 DML）。
CREATE OR REPLACE FUNCTION observability_upsert_error_group(
	p_fingerprint text, p_release text, p_source text, p_sample jsonb
) RETURNS void
LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
	INSERT INTO observability_error_groups (fingerprint, release, source, sample)
	VALUES (p_fingerprint, p_release, p_source, p_sample)
	ON CONFLICT (fingerprint, release) DO UPDATE SET
		last_seen = now(), count = observability_error_groups.count + 1;
$$;
REVOKE ALL ON TABLE observability_inbox, observability_error_groups FROM PUBLIC;
REVOKE ALL ON FUNCTION observability_upsert_error_group(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION observability_upsert_error_group(text, text, text, jsonb) TO biance_user;
