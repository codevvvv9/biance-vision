CREATE TABLE "audit_records" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"session_key" text DEFAULT '' NOT NULL,
	"username" text NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"actions" jsonb NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_records_last_active_at_idx" ON "audit_records" USING btree ("last_active_at");