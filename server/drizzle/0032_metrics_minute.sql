-- P2b-1 分钟指标（方案 §11.1）：进程内存分桶 → 分钟批快照（metric_batches，
-- producer/bootId/seq 唯一=幂等）→ worker 聚合到 metrics_minute（维度唯一，
-- 重试不重复加 count）。30 天清理（worker 周期）。
CREATE TABLE IF NOT EXISTS "observability_metric_batches" (
	"producer" text NOT NULL,
	"instance_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"seq" integer NOT NULL,
	"minute" timestamptz NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"processed_at" timestamptz,
	CONSTRAINT "observability_metric_batches_pk" PRIMARY KEY ("producer", "instance_id", "boot_id", "seq")
);
CREATE INDEX IF NOT EXISTS "observability_metric_batches_pending_idx" ON "observability_metric_batches" ("processed_at") WHERE "processed_at" IS NULL;

CREATE TABLE IF NOT EXISTS "observability_metrics_minute" (
	"service" text NOT NULL,
	"minute" timestamptz NOT NULL,
	"dimension" text NOT NULL,
	"counts" jsonb NOT NULL,
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "observability_metrics_minute_pk" PRIMARY KEY ("service", "minute", "dimension")
);

-- 聚合受控函数：领取一批未处理 batch（FOR UPDATE SKIP LOCKED，跨 worker 安全），
-- 逐维度 upsert 到 metrics_minute（jsonb 数值合并=幂等），标记 processed。
CREATE OR REPLACE FUNCTION observability_aggregate_batches(p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
	v_batch RECORD;
	v_dim RECORD;
	v_merged jsonb;
	v_done integer := 0;
BEGIN
	FOR v_batch IN
		SELECT * FROM observability_metric_batches
		WHERE processed_at IS NULL
		ORDER BY seq LIMIT p_limit
		FOR UPDATE SKIP LOCKED
	LOOP
		FOR v_dim IN SELECT * FROM jsonb_each(v_batch.payload) AS d(dimension, counts)
		LOOP
			SELECT jsonb_strip_nulls(jsonb_build_object(
				'count', COALESCE((m.counts->>'count')::bigint, 0) + COALESCE((v_dim.counts->>'count')::bigint, 0),
				'latency', (
					SELECT jsonb_object_agg(bucket, COALESCE((m.counts->'latency'->>bucket)::bigint, 0) + COALESCE((v_dim.counts->'latency'->>bucket)::bigint, 0))
					FROM jsonb_object_keys(COALESCE(v_dim.counts->'latency', '{}'::jsonb)) AS bucket
				))) INTO v_merged
			FROM observability_metrics_minute m
			WHERE m.service = split_part(v_batch.producer, ':', 1)
			  AND m.minute = v_batch.minute AND m.dimension = v_dim.dimension;
			INSERT INTO observability_metrics_minute (service, minute, dimension, counts)
			VALUES (split_part(v_batch.producer, ':', 1), v_batch.minute, v_dim.dimension,
				COALESCE(v_merged, v_dim.counts))
			ON CONFLICT (service, minute, dimension) DO UPDATE SET counts = EXCLUDED.counts, updated_at = now();
		END LOOP;
		UPDATE observability_metric_batches SET processed_at = now()
		WHERE producer = v_batch.producer AND instance_id = v_batch.instance_id
		  AND boot_id = v_batch.boot_id AND seq = v_batch.seq;
		v_done := v_done + 1;
	END LOOP;
	RETURN v_done;
END;
$$;

REVOKE ALL ON TABLE observability_metric_batches, observability_metrics_minute FROM PUBLIC;
REVOKE ALL ON FUNCTION observability_aggregate_batches(integer) FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE observability_metric_batches TO biance_user;
GRANT EXECUTE ON FUNCTION observability_aggregate_batches(integer) TO biance_user;
-- metrics_minute 只经受控函数写；admin-api 查询（owner 权限）不需要给 biance_user
