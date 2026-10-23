-- W3-S2 存储收敛（docs/admin-isolation-plan.md §3.2）：
-- 1) auth_sessions：登录会话 PG 唯一真源（token 存 sha256，防库泄露后直接重放）；
--    purpose 用途标记（user/admin，签发入口决定），服务端拒绝跨用途使用；
--    本表新建即空 = 存量 sessions.json 会话全部失效（升级要求重新登录，不猜测用途）。
-- 2) login_guards：登录限速计数入 PG（跨域名合并计数 + 重启不丢）。
CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"token_hash" text PRIMARY KEY,
	"username" text NOT NULL,
	"role" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"expires_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "auth_sessions_expires_at_idx" ON "auth_sessions" ("expires_at");

CREATE TABLE IF NOT EXISTS "login_guards" (
	"ip" text PRIMARY KEY,
	"win_start" bigint NOT NULL,
	"win_count" integer NOT NULL,
	"fails" integer NOT NULL,
	"locked_until" bigint NOT NULL
);
