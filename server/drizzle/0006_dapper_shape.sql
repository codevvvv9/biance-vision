CREATE TABLE "ingest_state" (
	"venue" text DEFAULT 'binance' NOT NULL,
	"market_type" text NOT NULL,
	"price_type" text NOT NULL,
	"symbol" text NOT NULL,
	"interval" text NOT NULL,
	"last_closed_open_time" bigint,
	"last_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gap_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	CONSTRAINT "ingest_state_venue_market_type_price_type_symbol_interval_pk" PRIMARY KEY("venue","market_type","price_type","symbol","interval")
);
--> statement-breakpoint
CREATE TABLE "market_candles" (
	"venue" text DEFAULT 'binance' NOT NULL,
	"market_type" text NOT NULL,
	"price_type" text NOT NULL,
	"symbol" text NOT NULL,
	"interval" text NOT NULL,
	"open_time" bigint NOT NULL,
	"close_time" bigint NOT NULL,
	"open" numeric NOT NULL,
	"high" numeric NOT NULL,
	"low" numeric NOT NULL,
	"close" numeric NOT NULL,
	"volume" numeric,
	"quote_volume" numeric,
	"trades" integer,
	"is_closed" boolean NOT NULL,
	"event_time" bigint,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "market_candles_venue_market_type_price_type_symbol_interval_open_time_pk" PRIMARY KEY("venue","market_type","price_type","symbol","interval","open_time")
);
--> statement-breakpoint
CREATE TABLE "market_funding_rates" (
	"venue" text DEFAULT 'binance' NOT NULL,
	"market_type" text NOT NULL,
	"symbol" text NOT NULL,
	"funding_time" bigint NOT NULL,
	"funding_rate" numeric NOT NULL,
	"mark_price" numeric,
	CONSTRAINT "market_funding_rates_venue_market_type_symbol_funding_time_pk" PRIMARY KEY("venue","market_type","symbol","funding_time")
);
--> statement-breakpoint
CREATE TABLE "market_open_interest" (
	"venue" text DEFAULT 'binance' NOT NULL,
	"market_type" text NOT NULL,
	"symbol" text NOT NULL,
	"interval" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"sum_open_interest" numeric NOT NULL,
	"sum_open_interest_value" numeric,
	CONSTRAINT "market_open_interest_venue_market_type_symbol_interval_timestamp_pk" PRIMARY KEY("venue","market_type","symbol","interval","timestamp")
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"market_type" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"per_interval" jsonb NOT NULL,
	"price_as_of" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "structure_events" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"symbol" text NOT NULL,
	"market_type" text NOT NULL,
	"interval" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"kind" text NOT NULL,
	"direction" text,
	"at_index" integer NOT NULL,
	"at_time" bigint NOT NULL,
	"known_at_index" integer,
	"known_at_time" bigint,
	"bar_indices" jsonb NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "market_candles_close_time_idx" ON "market_candles" USING btree ("symbol","market_type","price_type","interval","close_time");--> statement-breakpoint
CREATE INDEX "market_snapshots_symbol_idx" ON "market_snapshots" USING btree ("symbol","market_type","as_of");--> statement-breakpoint
CREATE INDEX "structure_events_snapshot_idx" ON "structure_events" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "structure_events_series_idx" ON "structure_events" USING btree ("symbol","market_type","interval","at_time");