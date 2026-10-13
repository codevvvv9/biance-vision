CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"intent" text,
	"run_id" text,
	"card" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"step" text,
	"payload" jsonb,
	"at" bigint NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
ALTER TABLE "event_quotes" ADD COLUMN "order_state" text DEFAULT 'preview' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_quotes" ADD COLUMN "strike_status" text DEFAULT 'preview' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_quotes" ADD COLUMN "preview_as_of" bigint;--> statement-breakpoint
ALTER TABLE "event_quotes" ADD COLUMN "event_risk_budget" numeric;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "input_pack_key" text;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "quality" jsonb;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "symbol" text DEFAULT '*' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "market_type" text DEFAULT 'usdm_perp' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "price_type" text DEFAULT 'index' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "target_type" text DEFAULT 'strike_relative' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "validated_duration_range" jsonb;--> statement-breakpoint
ALTER TABLE "prediction_models" ADD COLUMN "validation_policy_version" text;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "frozen_config" jsonb;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "conversation_id" text;--> statement-breakpoint
CREATE INDEX "conversation_messages_conv_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
-- 旧模型（ready/stale，旧目标定义）统一转 retired：待按新门槛重新验证，
-- 不得自动视为 published；旧预测行保留原目标语义，不追溯改写。
UPDATE "prediction_models" SET "status" = 'retired' WHERE "status" IN ('ready', 'stale');
