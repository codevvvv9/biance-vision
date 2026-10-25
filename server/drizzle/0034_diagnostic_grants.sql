-- P2a→P3-2 受控诊断授权（方案 §7/§11.1）：管理域 grant 绑定 admin 会话哈希+目标，
-- 15 分钟过期；撤销/登出清理；过期 30 天后清行。审计走既有 recordAudit。
CREATE TABLE IF NOT EXISTS "observability_diagnostic_grants" (
	"id" text PRIMARY KEY,
	"admin_subject" text NOT NULL,
	"admin_session_hash" text NOT NULL,
	"target" text NOT NULL DEFAULT '',
	"purpose" text NOT NULL DEFAULT 'diagnostics',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"expires_at" timestamptz NOT NULL,
	"revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "observability_diagnostic_grants_expires_idx" ON "observability_diagnostic_grants" ("expires_at");
