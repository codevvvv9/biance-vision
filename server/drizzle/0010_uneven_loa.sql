CREATE TABLE "case_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"market_type" text NOT NULL,
	"interval" text NOT NULL,
	"at_time" bigint NOT NULL,
	"visible_context" jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"annotation" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"concept" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drafted_by" text DEFAULT 'template' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "case_windows_series_idx" ON "case_windows" USING btree ("symbol","market_type","interval","at_time");--> statement-breakpoint
CREATE INDEX "rule_cards_concept_idx" ON "rule_cards" USING btree ("concept","status");