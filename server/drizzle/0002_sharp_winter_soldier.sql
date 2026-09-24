CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"username" text NOT NULL,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"ok" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");