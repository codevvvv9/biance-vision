-- P0-4 知识版本过滤补齐（vertical-agent-architecture.md §6 P0-4 / §3.2.7-C）：
-- run 冻结知识版本后新发布的规则卡/案例不得进入该 run 的检索（复现性）。
-- 规则卡已有 published_at；案例窗补发布时刻列，已发布行回填 created_at 作为发布上界
--（保守回填：不会让旧 run 误读到新案例；此后新发布写真实发布时刻）。
ALTER TABLE "case_windows" ADD COLUMN IF NOT EXISTS "published_at" timestamptz;
UPDATE "case_windows" SET "published_at" = "created_at" WHERE "published" = true AND "published_at" IS NULL;
