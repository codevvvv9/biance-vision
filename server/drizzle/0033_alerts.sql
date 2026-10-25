-- P2b-3 运维告警（方案 §11.1/§12.3）：心跳类规则先行（v3.1 终审建议——单用户
-- 流量下 HTTP 窗口规则样本长期不足，心跳/新鲜度类才是有效信号）。
-- 活跃事件唯一 (rule_key, dimension)：同规则同维度合并为一个 incident；
-- 状态机 open→acknowledged→resolved（ack 只是接手≠恢复）；恢复需连续正常评估
-- 窗（恢复验证时间戳）；关闭 30 天后由清理任务移除。
-- 默认仅管理端展示；外部通知未配置（BV_OPS_WEBHOOK_SECRET_REF 未设=无外发，
-- delivery_outbox 随外发启用时交付——本批不建发送路径）。
CREATE TABLE IF NOT EXISTS "observability_alerts" (
	"rule_key" text NOT NULL,
	"rule_version" integer NOT NULL DEFAULT 1,
	"dimension" text NOT NULL DEFAULT '',
	"state" text NOT NULL DEFAULT 'open',
	"severity" text NOT NULL DEFAULT 'high',
	"first_seen" timestamptz NOT NULL DEFAULT now(),
	"last_seen" timestamptz NOT NULL DEFAULT now(),
	"normal_streak" integer NOT NULL DEFAULT 0,
	"resolved_at" timestamptz,
	"resolved_evidence" jsonb,
	"acked_by" text,
	"evidence" jsonb,
	CONSTRAINT "observability_alerts_pk" PRIMARY KEY ("rule_key", "dimension")
);
CREATE INDEX IF NOT EXISTS "observability_alerts_state_idx" ON "observability_alerts" ("state", "last_seen");
