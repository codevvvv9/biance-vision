ALTER TABLE "prediction_models" ADD COLUMN "base_interval" text;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "calibrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "lease_owner" text;