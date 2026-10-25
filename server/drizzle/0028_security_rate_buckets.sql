-- P1-2 共享限流原语（方案 §4.1/§11.1/§11.2.1）：
-- 1) security_rate_buckets：固定窗口计数桶（scope+subject_hash 唯一）。
--    user-api 不给表 DML——限流计数只经受控函数 security_consume_rate_limit
--    （SECURITY DEFINER，原子 UPSERT+条件 UPDATE），PUBLIC 撤销 EXECUTE。
-- 2) shadow 与 enforce 的 scope 天然分离（调用方以 'shadow:' 前缀注册独立桶），
--    模拟桶不消费正式额度（方案 §13.2）。
CREATE TABLE IF NOT EXISTS "security_rate_buckets" (
	"scope" text NOT NULL,
	"subject_hash" text NOT NULL,
	"counter" integer NOT NULL DEFAULT 0,
	"window_start" bigint NOT NULL DEFAULT 0,
	"window_ms" bigint NOT NULL,
	"expires_at" timestamptz NOT NULL,
	CONSTRAINT "security_rate_buckets_scope_subject_pk" PRIMARY KEY ("scope", "subject_hash")
);
CREATE INDEX IF NOT EXISTS "security_rate_buckets_expires_at_idx" ON "security_rate_buckets" ("expires_at");

-- 受控消费函数：窗口重置/递增/限值判定在单条 SQL 内原子完成；
-- 达到限值后计数封顶（超限不无限递增，不更新成允许）。返回
-- { allowed, counter, limit, retry_after_seconds }——allowed 由调用方按
-- enforce/shadow 解释（shadow 命中仍放行业务，仅记录 should_block）。
CREATE OR REPLACE FUNCTION security_consume_rate_limit(
	p_scope text, p_subject text, p_limit integer, p_window_ms bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
	v_now bigint := (extract(epoch FROM now()) * 1000)::bigint;
	v_counter integer;
	v_window_start bigint;
BEGIN
	INSERT INTO security_rate_buckets (scope, subject_hash, counter, window_start, window_ms, expires_at)
	VALUES (p_scope, p_subject, 1, v_now, p_window_ms, to_timestamp((v_now + p_window_ms * 2) / 1000.0))
	ON CONFLICT (scope, subject_hash) DO UPDATE SET
		counter = CASE
			WHEN v_now - security_rate_buckets.window_start >= security_rate_buckets.window_ms THEN 1
			ELSE security_rate_buckets.counter + 1 END,
		window_start = CASE
			WHEN v_now - security_rate_buckets.window_start >= security_rate_buckets.window_ms THEN v_now
			ELSE security_rate_buckets.window_start END,
		expires_at = to_timestamp((v_now + p_window_ms * 2) / 1000.0)
	RETURNING counter, window_start INTO v_counter, v_window_start;
	RETURN jsonb_build_object(
		'allowed', v_counter <= p_limit,
		'counter', v_counter,
		'limit', p_limit,
		'retry_after_seconds', GREATEST(0, CEIL((v_window_start + p_window_ms - v_now) / 1000.0))::int
	);
END;
$$;

REVOKE ALL ON TABLE security_rate_buckets FROM PUBLIC;
REVOKE ALL ON FUNCTION security_consume_rate_limit(text, text, integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security_consume_rate_limit(text, text, integer, bigint) TO biance_user;

-- 到期桶清理（migrate/维护侧调用；worker 周期任务 P2a 接管前由函数调用方兜底）
CREATE OR REPLACE FUNCTION security_cleanup_rate_buckets() RETURNS integer
LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
	WITH deleted AS (DELETE FROM security_rate_buckets WHERE expires_at < now() RETURNING 1)
	SELECT count(*)::integer FROM deleted;
$$;
REVOKE ALL ON FUNCTION security_cleanup_rate_buckets() FROM PUBLIC;
