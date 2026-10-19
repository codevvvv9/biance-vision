-- P1-5 研究记忆（vertical-agent-architecture.md §6 P1-5）：
-- 链路 B（研究会话）的纯 PG 记忆表——收编链路 A aiMemory 的提取协议，
-- 不写任何 JSON 镜像。每用户上限 40（超额删最旧，裁剪在 memory.ts）；
-- 提取水位记在 conversations.context.memoryExtractedCount（jsonb，无需迁移）。

CREATE TABLE IF NOT EXISTS "research_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
	CREATE INDEX "research_memories_user_idx" ON "research_memories" ("user_id","created_at");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
