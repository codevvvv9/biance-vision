-- P1-5 幂等与操作外发箱（方案 §5/§11.1）：
-- 1) request_idempotency：唯一范围 (purpose, subject_hash, method, route, key)；
--    fingerprint=规范化请求指纹（不含 CSRF/传输元数据）；state=processing|completed；
--    completed 保留 24h（缓存语义）；processing 超 30s 视为争抢失败可重试（进程崩溃不留死键）。
-- 2) operation_outbox：operation_id+task_kind 唯一；业务事务提交后由 worker 投递、
--    崩溃可重投（P1-5 建表与清理函数；领取/投递循环接线随高成本任务批次启用）。
CREATE TABLE IF NOT EXISTS "request_idempotency" (
	"purpose" text NOT NULL,
	"subject_hash" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL DEFAULT 'processing',
	"response_body" jsonb,
	"status_code" integer,
	"operation_id" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"expires_at" timestamptz NOT NULL,
	CONSTRAINT "request_idempotency_scope_pk" PRIMARY KEY ("purpose", "subject_hash", "method", "route", "key")
);
CREATE INDEX IF NOT EXISTS "request_idempotency_expires_idx" ON "request_idempotency" ("expires_at");

CREATE TABLE IF NOT EXISTS "operation_outbox" (
	"operation_id" text NOT NULL,
	"task_kind" text NOT NULL,
	"business_ref" text NOT NULL,
	"state" text NOT NULL DEFAULT 'pending',
	"attempts" integer NOT NULL DEFAULT 0,
	"next_attempt_at" timestamptz NOT NULL DEFAULT now(),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "operation_outbox_op_pk" PRIMARY KEY ("operation_id", "task_kind")
);
CREATE INDEX IF NOT EXISTS "operation_outbox_pending_idx" ON "operation_outbox" ("state", "next_attempt_at");

-- 幂等争抢受控函数（原子）：无行/过期插入 processing；已有行按指纹与状态判定。
-- 返回 { verdict: 'fresh'|'replay'|'in_progress'|'conflict'|'stale_reclaim',
--         fingerprint, response_body, status_code }
CREATE OR REPLACE FUNCTION security_idempotency_claim(
	p_purpose text, p_subject text, p_method text, p_route text, p_key text,
	p_fingerprint text, p_processing_timeout_ms bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
	v_row request_idempotency%ROWTYPE;
BEGIN
	SELECT * INTO v_row FROM request_idempotency
	WHERE purpose = p_purpose AND subject_hash = p_subject AND method = p_method
	  AND route = p_route AND key = p_key AND expires_at > now();
	IF v_row IS NULL THEN
		INSERT INTO request_idempotency (purpose, subject_hash, method, route, key, fingerprint, state, expires_at)
		VALUES (p_purpose, p_subject, p_method, p_route, p_key, p_fingerprint, 'processing', now() + interval '24 hours')
		ON CONFLICT (purpose, subject_hash, method, route, key) DO UPDATE SET
			fingerprint = EXCLUDED.fingerprint, state = 'processing', response_body = NULL,
			status_code = NULL, created_at = now(), expires_at = EXCLUDED.expires_at
		WHERE request_idempotency.expires_at <= now()
		   OR (request_idempotency.state = 'processing'
		       AND (extract(epoch FROM (now() - request_idempotency.created_at)) * 1000) > p_processing_timeout_ms);
		IF FOUND THEN RETURN jsonb_build_object('verdict', 'fresh'); END IF;
		SELECT * INTO v_row FROM request_idempotency
		WHERE purpose = p_purpose AND subject_hash = p_subject AND method = p_method
		  AND route = p_route AND key = p_key;
	END IF;
	IF v_row.fingerprint <> p_fingerprint THEN
		RETURN jsonb_build_object('verdict', 'conflict');
	END IF;
	IF v_row.state = 'completed' THEN
		RETURN jsonb_build_object('verdict', 'replay', 'response_body', v_row.response_body, 'status_code', v_row.status_code);
	END IF;
	RETURN jsonb_build_object('verdict', 'in_progress');
END;
$$;

CREATE OR REPLACE FUNCTION security_idempotency_complete(
	p_purpose text, p_subject text, p_method text, p_route text, p_key text,
	p_status integer, p_body jsonb
) RETURNS void
LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
	UPDATE request_idempotency SET state = 'completed', status_code = p_status, response_body = p_body
	WHERE purpose = p_purpose AND subject_hash = p_subject AND method = p_method
	  AND route = p_route AND key = p_key;
$$;

REVOKE ALL ON TABLE request_idempotency, operation_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION security_idempotency_claim(text, text, text, text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION security_idempotency_complete(text, text, text, text, text, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security_idempotency_claim(text, text, text, text, text, text, bigint) TO biance_user;
GRANT EXECUTE ON FUNCTION security_idempotency_complete(text, text, text, text, text, integer, jsonb) TO biance_user;
