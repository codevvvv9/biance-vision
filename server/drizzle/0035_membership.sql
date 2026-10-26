CREATE TABLE membership_plans (
 id text PRIMARY KEY, draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 published_version_id text, enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL
);
--> statement-breakpoint
CREATE TABLE membership_plan_versions (
 id text PRIMARY KEY, plan_id text NOT NULL REFERENCES membership_plans(id), revision integer NOT NULL,
 config jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
 UNIQUE(plan_id, revision)
);
--> statement-breakpoint
CREATE TABLE membership_campaigns (
 id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT false,
 capacity integer NOT NULL CHECK(capacity >= 0), starts_at timestamptz, ends_at timestamptz,
 revision integer NOT NULL DEFAULT 1, updated_by text NOT NULL,
 CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE membership_accounts (
 username text PRIMARY KEY REFERENCES users(username), disabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL
);
--> statement-breakpoint
CREATE TABLE membership_grants (
 id text PRIMARY KEY, username text NOT NULL REFERENCES membership_accounts(username),
 version_id text NOT NULL REFERENCES membership_plan_versions(id), starts_at timestamptz NOT NULL,
 ends_at timestamptz, revoked_at timestamptz, note text NOT NULL, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX membership_grants_user_time ON membership_grants(username, starts_at DESC) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE membership_receipts (
 id text PRIMARY KEY, username text NOT NULL REFERENCES membership_accounts(username),
 grant_id text NOT NULL REFERENCES membership_grants(id), operation_id text NOT NULL UNIQUE, fingerprint text NOT NULL,
 action text NOT NULL, expected_amount numeric(18,6) NOT NULL CHECK(expected_amount >= 0),
 paid_amount numeric(18,6) NOT NULL CHECK(paid_amount >= 0), currency text NOT NULL CHECK(currency = 'USDT'),
 paid_at timestamptz NOT NULL, payment_reference text NOT NULL, note text NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 voided_at timestamptz, void_reason text
);
CREATE INDEX membership_receipts_user_time ON membership_receipts(username, created_at DESC);
--> statement-breakpoint
CREATE TABLE membership_redemptions (
 campaign_id text NOT NULL REFERENCES membership_campaigns(id), username text NOT NULL REFERENCES membership_accounts(username),
 receipt_id text NOT NULL UNIQUE REFERENCES membership_receipts(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id, username)
);
--> statement-breakpoint
CREATE TABLE membership_usage (
 username text NOT NULL REFERENCES users(username), day text NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used >= 0),
 window_at bigint NOT NULL DEFAULT 0, window_used integer NOT NULL DEFAULT 0 CHECK(window_used >= 0),
 PRIMARY KEY(username, day)
);
--> statement-breakpoint
CREATE TABLE membership_reservations (
 id text PRIMARY KEY, username text NOT NULL REFERENCES users(username), day text NOT NULL,
 operation_key text, fingerprint text NOT NULL, state text NOT NULL CHECK(state IN ('reserved','accepted','refunded')),
 response jsonb, status_code integer, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(username, operation_key)
);
CREATE INDEX membership_reservations_created ON membership_reservations(created_at) WHERE state = 'reserved';
CREATE INDEX membership_reservations_completed ON membership_reservations(created_at) WHERE state <> 'reserved';
--> statement-breakpoint
CREATE TABLE membership_refresh_settings (
 id text PRIMARY KEY CHECK(id = 'global'), config jsonb NOT NULL, revision integer NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL
);
INSERT INTO membership_refresh_settings VALUES ('global', '{"userSeconds":60,"adminSeconds":60,"publicSeconds":60}', 1, now(), 'migration');
INSERT INTO membership_campaigns(id,name,capacity,updated_by) VALUES ('founders','前 100 位首次付费用户 / First 100 paying members',100,'migration');
--> statement-breakpoint
INSERT INTO membership_plans(id,draft,updated_by)
SELECT code, jsonb_build_object(
 'name',name,'nameEn',en,'description','','descriptionEn','', 'durationUnit',unit,'durationCount',n,
 'price',price,'introPrice',intro,'currency','USDT','dailyLimit',quota,'requestsPerMinute',6,
 'chatProfile','default','researchProfile','default','features','{"chat":true,"research":true,"translate":true}'::jsonb,
 'public',true,'sortOrder',sort
), 'migration'
FROM (VALUES
 ('trial','14 天试用','14-day trial','day',14,'0','0',10,0),
 ('monthly','月付会员','Monthly','month',1,'15','8',100,1),
 ('yearly','年付会员','Annual','year',1,'120','60',100,2),
 ('lifetime','终身会员','Lifetime','lifetime',1,'299','100',100,3)
) AS seed(code,name,en,unit,n,price,intro,quota,sort);
