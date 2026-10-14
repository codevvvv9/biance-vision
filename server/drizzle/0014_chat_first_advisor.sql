ALTER TABLE "portfolio_positions" ADD COLUMN IF NOT EXISTS "confirm_fp" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portfolio_positions_user_confirm_fp_uq" ON "portfolio_positions" ("user_id", "confirm_fp") WHERE "confirm_fp" IS NOT NULL;
