CREATE TABLE "agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"config_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"metrics" jsonb,
	"report" jsonb,
	"started_at" bigint,
	"ended_at" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "eval_datasets_kind_idx" ON "eval_datasets" USING btree ("kind","name","version");--> statement-breakpoint
CREATE INDEX "eval_runs_dataset_idx" ON "eval_runs" USING btree ("dataset_id","created_at");