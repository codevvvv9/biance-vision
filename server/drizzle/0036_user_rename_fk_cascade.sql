-- 用户改名（2026-10-27）：users.username 被三张会员表以真实外键引用。
-- 管理端改名在单事务内迁移全部关联；带 FK 的子表由 ON UPDATE CASCADE 级联
-- （ON DELETE 语义保持 NO ACTION 不变——删除用户仍被引用时依旧被阻止），
-- 无 FK 的用户名列（研究/聊天/画像等，见 server/src/admin/renameUser.ts 清单）
-- 由端点逐表 UPDATE。本迁移幂等：DROP IF EXISTS 后重建。
ALTER TABLE "membership_accounts" DROP CONSTRAINT IF EXISTS "membership_accounts_username_fkey";--> statement-breakpoint
ALTER TABLE "membership_accounts" ADD CONSTRAINT "membership_accounts_username_fkey" FOREIGN KEY ("username") REFERENCES "users"("username") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "membership_usage" DROP CONSTRAINT IF EXISTS "membership_usage_username_fkey";--> statement-breakpoint
ALTER TABLE "membership_usage" ADD CONSTRAINT "membership_usage_username_fkey" FOREIGN KEY ("username") REFERENCES "users"("username") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "membership_reservations" DROP CONSTRAINT IF EXISTS "membership_reservations_username_fkey";--> statement-breakpoint
ALTER TABLE "membership_reservations" ADD CONSTRAINT "membership_reservations_username_fkey" FOREIGN KEY ("username") REFERENCES "users"("username") ON UPDATE CASCADE;
