CREATE TABLE "event_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"strike_price" numeric NOT NULL,
	"expiry_at" bigint NOT NULL,
	"as_of" bigint NOT NULL,
	"stake" numeric NOT NULL,
	"total_payout" numeric NOT NULL,
	"direction" text NOT NULL,
	"ref_price" numeric,
	"note" text,
	"estimated_outcome" text,
	"user_confirmed_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"stance" text DEFAULT 'support' NOT NULL,
	"ref_id" text NOT NULL,
	"doc_version_id" text,
	"page_no" integer,
	"figure_id" text,
	"content_hash" text,
	"source_tier" text,
	"text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"qty" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"leverage" integer NOT NULL,
	"margin_mode" text NOT NULL,
	"risk_budget" numeric NOT NULL,
	"stop_price" numeric,
	"liquidation_price" numeric,
	"confirmed_at" bigint NOT NULL,
	"stale_after_hours" integer DEFAULT 72 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_models" (
	"id" text PRIMARY KEY NOT NULL,
	"model_version" text NOT NULL,
	"horizon" text NOT NULL,
	"trained_until" bigint NOT NULL,
	"feature_version" text NOT NULL,
	"status" text DEFAULT 'training' NOT NULL,
	"metrics" jsonb,
	"artifact_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prediction_models_model_version_unique" UNIQUE("model_version")
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"quote_id" text,
	"symbol" text NOT NULL,
	"market_type" text NOT NULL,
	"horizon" text NOT NULL,
	"model_version" text NOT NULL,
	"feature_version" text NOT NULL,
	"probability_up" double precision,
	"quantiles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"estimated_outcome" text,
	"user_confirmed_outcome" text,
	"outcome_source" text,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unavailable_reason" text,
	"resolved_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"product" text NOT NULL,
	"symbol" text NOT NULL,
	"market_type" text NOT NULL,
	"horizon" text NOT NULL,
	"question" text,
	"position_id" text,
	"quote_id" text,
	"as_of" bigint NOT NULL,
	"snapshot_id" text,
	"config_version" text,
	"knowledge_version" text,
	"rule_version" text,
	"model_version" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error" text,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" bigint,
	"ended_at" bigint,
	"summary" text,
	"cost_ms" integer,
	"error" text,
	"attempt" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_quotes_user_idx" ON "event_quotes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_items_run_idx" ON "evidence_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "portfolio_positions_user_idx" ON "portfolio_positions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "predictions_user_idx" ON "predictions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "predictions_quote_idx" ON "predictions" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "research_runs_user_idx" ON "research_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "research_runs_status_idx" ON "research_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "run_steps_run_idx" ON "run_steps" USING btree ("run_id","step");