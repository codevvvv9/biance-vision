-- P1-6 共享活动租约（方案 §4.4/§11.1）：用户 2/全局 4 高成本执行、SSE 跨进程
-- 活动上限的多副本口径。resource 唯一（如 'expensive:global'、'expensive:user:alice'、
-- 'sse:process:<id>'）；generation=fencing token（恢复过期租约时旧持有者不再有
-- 写入权）；默认 90 秒到期、30 秒续约由函数参数给定。
-- 单副本部署下进程内硬限已是事实全局；本表就绪供多副本扩容接线
-- （方案 §4.4：接共享租约后才允许以多副本扩大用户 API）。
CREATE TABLE IF NOT EXISTS "security_leases" (
	"resource" text PRIMARY KEY,
	"owner" text NOT NULL,
	"purpose" text NOT NULL DEFAULT '',
	"generation" bigint NOT NULL DEFAULT 1,
	"acquired_at" timestamptz NOT NULL DEFAULT now(),
	"lease_until" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "security_leases_until_idx" ON "security_leases" ("lease_until");

-- 获取租约：过期可抢占（generation+1 = 旧持有者 fencing 失效）；返回 { acquired, generation }
CREATE OR REPLACE FUNCTION security_acquire_lease(
	p_resource text, p_owner text, p_purpose text, p_ttl_ms bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
	v_gen bigint;
BEGIN
	INSERT INTO security_leases (resource, owner, purpose, generation, lease_until)
	VALUES (p_resource, p_owner, p_purpose, 1, now() + make_interval(secs => p_ttl_ms / 1000.0))
	ON CONFLICT (resource) DO UPDATE SET
		owner = EXCLUDED.owner, purpose = EXCLUDED.purpose,
		generation = security_leases.generation + 1,
		acquired_at = now(), lease_until = EXCLUDED.lease_until
	WHERE security_leases.lease_until <= now()
	   OR security_leases.owner = EXCLUDED.owner;
	IF (SELECT owner FROM security_leases WHERE resource = p_resource) = p_owner THEN
		SELECT generation INTO v_gen FROM security_leases WHERE resource = p_resource;
		RETURN jsonb_build_object('acquired', true, 'generation', v_gen);
	END IF;
	RETURN jsonb_build_object('acquired', false);
END;
$$;

-- 续约：仅当前持有者且未过期才延长（同 generation）；过期/换主返回 false
CREATE OR REPLACE FUNCTION security_renew_lease(
	p_resource text, p_owner text, p_ttl_ms bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
	UPDATE security_leases SET lease_until = now() + make_interval(secs => p_ttl_ms / 1000.0)
	WHERE resource = p_resource AND owner = p_owner AND lease_until > now();
	RETURN FOUND;
END;
$$;

-- 释放（幂等）：仅持有者删除
CREATE OR REPLACE FUNCTION security_release_lease(p_resource text, p_owner text) RETURNS void
LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
	DELETE FROM security_leases WHERE resource = p_resource AND owner = p_owner;
$$;

REVOKE ALL ON TABLE security_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION security_acquire_lease(text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION security_renew_lease(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION security_release_lease(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security_acquire_lease(text, text, text, bigint) TO biance_user;
GRANT EXECUTE ON FUNCTION security_renew_lease(text, text, bigint) TO biance_user;
GRANT EXECUTE ON FUNCTION security_release_lease(text, text) TO biance_user;
