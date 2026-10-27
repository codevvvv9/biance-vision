-- 0038：内部固定套餐 internal（docs/specs/membership.md）
-- 仿 0035 trial 种子模式，但连发布+上架一起做（public=false 无误售风险，升级后管理端即可授予）。
-- 幂等 + 冲突校验：已存在 internal 草稿 / revision 1 版本 / 已发布到其他版本时，
-- 配置不一致即 RAISE 终止迁移（显式暴露人工介入），绝不静默绑定到错误版本。
INSERT INTO membership_plans(id, draft, updated_by)
VALUES ('internal', '{"name":"内部账号","nameEn":"Internal","description":"内部与开发测试账号，不对外销售","descriptionEn":"Internal testing account, not for sale","durationUnit":"lifetime","durationCount":1,"price":"0","introPrice":"0","currency":"USDT","dailyLimit":null,"requestsPerMinute":60,"chatProfile":"default","researchProfile":"default","features":{"chat":true,"research":true,"translate":true},"public":false,"sortOrder":0}'::jsonb, 'migration')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
  expected constant jsonb := '{"name":"内部账号","nameEn":"Internal","description":"内部与开发测试账号，不对外销售","descriptionEn":"Internal testing account, not for sale","durationUnit":"lifetime","durationCount":1,"price":"0","introPrice":"0","currency":"USDT","dailyLimit":null,"requestsPerMinute":60,"chatProfile":"default","researchProfile":"default","features":{"chat":true,"research":true,"translate":true},"public":false,"sortOrder":0}'::jsonb;
  actual jsonb;
BEGIN
  SELECT draft INTO actual FROM membership_plans WHERE id = 'internal';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'membership_plans.internal 已存在但配置与期望不一致；请人工核对后重试（期望 %，实际 %）', expected, actual;
  END IF;
END $$;
--> statement-breakpoint
-- 同 plan 同 revision 若已被其他版本占用（例如管理端手工建过 internal 并发布），
-- 不抢占、不平移，直接显式失败让人工处理
DO $$
DECLARE
  clash text;
BEGIN
  SELECT id INTO clash FROM membership_plan_versions
  WHERE plan_id = 'internal' AND revision = 1 AND id <> '5f2d8c1e-9b47-4a6b-8c3d-1e2f3a4b5c6d';
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'internal 套餐 revision 1 已存在其他版本（%），拒绝静默改绑；请人工处理', clash;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO membership_plan_versions(id, plan_id, revision, config, created_by)
VALUES ('5f2d8c1e-9b47-4a6b-8c3d-1e2f3a4b5c6d', 'internal', 1, '{"name":"内部账号","nameEn":"Internal","description":"内部与开发测试账号，不对外销售","descriptionEn":"Internal testing account, not for sale","durationUnit":"lifetime","durationCount":1,"price":"0","introPrice":"0","currency":"USDT","dailyLimit":null,"requestsPerMinute":60,"chatProfile":"default","researchProfile":"default","features":{"chat":true,"research":true,"translate":true},"public":false,"sortOrder":0}'::jsonb, 'migration')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
  expected constant jsonb := '{"name":"内部账号","nameEn":"Internal","description":"内部与开发测试账号，不对外销售","descriptionEn":"Internal testing account, not for sale","durationUnit":"lifetime","durationCount":1,"price":"0","introPrice":"0","currency":"USDT","dailyLimit":null,"requestsPerMinute":60,"chatProfile":"default","researchProfile":"default","features":{"chat":true,"research":true,"translate":true},"public":false,"sortOrder":0}'::jsonb;
  actual jsonb;
BEGIN
  SELECT config INTO actual FROM membership_plan_versions WHERE id = '5f2d8c1e-9b47-4a6b-8c3d-1e2f3a4b5c6d';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'internal revision 1 版本内容与期望不一致；请人工核对';
  END IF;
END $$;
--> statement-breakpoint
-- 原子抢占发布：未发布的 internal 绑定 migration 版本并上架
UPDATE membership_plans
SET published_version_id = '5f2d8c1e-9b47-4a6b-8c3d-1e2f3a4b5c6d', enabled = true,
    updated_at = now(), updated_by = 'migration'
WHERE id = 'internal' AND published_version_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  bound text;
BEGIN
  SELECT published_version_id INTO bound FROM membership_plans WHERE id = 'internal';
  IF bound IS DISTINCT FROM '5f2d8c1e-9b47-4a6b-8c3d-1e2f3a4b5c6d' THEN
    RAISE EXCEPTION 'internal 套餐已发布到其他版本（%），拒绝静默改绑；请人工处理', bound;
  END IF;
END $$;
