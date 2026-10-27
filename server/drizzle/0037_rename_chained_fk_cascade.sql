-- 用户改名（2026-10-27 补链）：0036 把 → users 的三条 FK 改为 ON UPDATE CASCADE，
-- 但 membership_grants / receipts / redemptions → membership_accounts 的三条链式 FK
-- 仍为 NO ACTION——持有会员授予的真实用户改名时，users→accounts 的级联会被这些
-- 子行阻止（事务回滚，不丢数据但功能对目标场景失效）。本迁移把链式 FK 同样改为
-- ON UPDATE CASCADE（ON DELETE 语义保持不变），使整条会员链随 users 一语句级联。
-- 幂等：DROP IF EXISTS 后重建。
ALTER TABLE "membership_grants" DROP CONSTRAINT IF EXISTS "membership_grants_username_fkey";--> statement-breakpoint
ALTER TABLE "membership_grants" ADD CONSTRAINT "membership_grants_username_fkey" FOREIGN KEY ("username") REFERENCES "membership_accounts"("username") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "membership_receipts" DROP CONSTRAINT IF EXISTS "membership_receipts_username_fkey";--> statement-breakpoint
ALTER TABLE "membership_receipts" ADD CONSTRAINT "membership_receipts_username_fkey" FOREIGN KEY ("username") REFERENCES "membership_accounts"("username") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "membership_redemptions" DROP CONSTRAINT IF EXISTS "membership_redemptions_username_fkey";--> statement-breakpoint
ALTER TABLE "membership_redemptions" ADD CONSTRAINT "membership_redemptions_username_fkey" FOREIGN KEY ("username") REFERENCES "membership_accounts"("username") ON UPDATE CASCADE;
