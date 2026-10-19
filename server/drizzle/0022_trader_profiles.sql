-- P1-4 用户画像（vertical-agent-architecture.md §4.D/§6 P1-4）：
-- 长期研究偏好，独立 PG 表（红线 #6：不沿用 users.ts 的 JSON 镜像模式）。
-- leverageHabitMax 为描述性字段（历史持仓最大杠杆），不是授权上限。
-- run 创建时快照进 frozenConfig.raw.traderProfile（画像变更不影响历史 run）。

CREATE TABLE IF NOT EXISTS "trader_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"risk_profile" text,
	"experience_level" text,
	"leverage_habit_max" integer,
	"disclaimer_ack" boolean DEFAULT false NOT NULL,
	"confirmed_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
