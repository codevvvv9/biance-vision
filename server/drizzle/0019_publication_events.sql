-- 发布历史补全（2026-10-19 二轮审查）：
-- 1) event_type 列：案例取消发布记 'unpublish' 事件——as-of 重放按「每个 ref 在该时刻的
--    最后一条事件」判断有效性（最后事件为 publish → 该版本有效；unpublish → 已下架）。
--    此前取消发布不记事件，历史时刻无法判断是否已下架。
-- 2) 规则卡 as-of 语义修正由代码层完成：同概念新版是新行新 id，发布历史按 ref_id 去重
--    会同时返回新旧两版——改为按 concept 取「as-of 前最后一次发布」的生效版本（迁移无需回填）。

ALTER TABLE "knowledge_publications" ADD COLUMN IF NOT EXISTS "event_type" text DEFAULT 'publish' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_publications_kind_event_idx" ON "knowledge_publications" ("kind","event_type","published_at");
