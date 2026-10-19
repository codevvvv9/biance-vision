-- P0-4 as-of 复现性修正（2026-10-19 审查）：知识发布历史表。
-- 问题：publishedRuleCards/publishedCasesForRetrieval 的 as-of 过滤同时要求
-- 「当前仍为 published 且 publishedAt<=asOf」——规则卡发布新版在同一行覆盖
-- version/publishedAt（旧版发布时刻丢失），案例取消发布清空 publishedAt、重新发布
-- 改写发布时刻：历史重放结果随后续管理操作漂移。
-- 修正：knowledge_publications 为 append-only 发布事件表（不可变），规则卡发布时
-- 快照 concept+content；as-of 检索按「每个 ref 在 asOf 前最后一次发布」重放，
-- 与当前状态（归档/下架/新版）完全解耦。取消发布只影响最新语义（无 asOf）检索。

CREATE TABLE IF NOT EXISTS "knowledge_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"concept" text,
	"content_snapshot" jsonb,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_publications_kind_published_idx" ON "knowledge_publications" ("kind","published_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_publications_ref_idx" ON "knowledge_publications" ("kind","ref_id","published_at");

-- 回填：存量已发布规则卡/案例按当前 publishedAt 补一条发布事件（此前无历史可考，
-- 以现存最早可见时刻为界；新发布起走代码路径追加）。
INSERT INTO "knowledge_publications" ("id", "kind", "ref_id", "version", "concept", "content_snapshot", "published_at")
SELECT
	'pub-backfill-card-' || c.id,
	'rulecard',
	c.id,
	c.version,
	c.concept,
	jsonb_build_object('concept', c.concept, 'version', c.version, 'content', c.content),
	c.published_at
FROM "rule_cards" c
WHERE c.status = 'published' AND c.published_at IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "knowledge_publications" ("id", "kind", "ref_id", "version", "published_at")
SELECT
	'pub-backfill-case-' || w.id,
	'case',
	w.id,
	1,
	w.published_at
FROM "case_windows" w
WHERE w.published = true AND w.published_at IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
