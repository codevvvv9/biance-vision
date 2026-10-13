CREATE TABLE "knowledge_chunks" (
	"id" text NOT NULL,
	"doc_id" text NOT NULL,
	"doc_version_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"page_no" integer,
	"figure_id" text,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_doc_version_id_chunk_index_pk" PRIMARY KEY("doc_version_id","chunk_index"),
	CONSTRAINT "knowledge_chunks_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"file_name" text DEFAULT '' NOT NULL,
	"blob_key" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"source_tier" text DEFAULT 'community' NOT NULL,
	"access" text DEFAULT 'public' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"error" text,
	"parse_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_manifest_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"access" text NOT NULL,
	"source_tier" text NOT NULL,
	"import_method" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"doc_id" text,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"doc_version_ids" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_versions_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE INDEX "knowledge_chunks_doc_idx" ON "knowledge_chunks" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_terms_gin" ON "knowledge_chunks" USING gin ("terms");--> statement-breakpoint
CREATE INDEX "knowledge_documents_status_idx" ON "knowledge_documents" USING btree ("status","updated_at");--> statement-breakpoint
-- 向量列（可选能力，手写补充）：pgvector 扩展可用时补建 embedding 列与 hnsw 索引。
-- app 连接账号非超级用户/镜像无扩展时 CREATE EXTENSION 失败 → 仅 NOTICE 跳过，
-- 迁移不中断；检索层运行时探测列存在性，禁用向量召回并显式记录（见 knowledge/vector.ts）。
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector 扩展不可用，跳过向量索引：%', SQLERRM;
END
$$;--> statement-breakpoint
-- 4096 维对齐当前 embedding 能力（Qwen3-VL-Embedding-8B 全维度）。
-- 注意：pgvector 的 hnsw/ivfflat 索引上限 2000 维，4096 维只能精确扫描——
-- 知识库当前规模（数千 chunk 内）毫秒级返回；换 ≤2000 维模型时可改回并补建 ANN 索引。
DO $$
BEGIN
    ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(4096);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'knowledge_chunks.embedding 未创建（pgvector 未启用）：%', SQLERRM;
END
$$;
