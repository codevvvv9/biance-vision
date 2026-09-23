CREATE TABLE "alert_history" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text,
	"symbol" text NOT NULL,
	"type" text,
	"value" double precision,
	"note" text,
	"message" text NOT NULL,
	"price" double precision NOT NULL,
	"change_pct" double precision NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"type" text NOT NULL,
	"value" double precision NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"armed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_history_triggered_at_idx" ON "alert_history" USING btree ("triggered_at");