-- Runs on first-time volume initialization only.
-- Creates the non-superuser application role and (best-effort) the pgvector
-- extension so knowledge_chunks.embedding can be created by the guarded DDL
-- in migration 0007. On images without pgvector this block only raises a
-- NOTICE and startup continues (vector recall stays disabled).
CREATE ROLE biance_app LOGIN PASSWORD 'biance_app';
ALTER DATABASE biance_vision OWNER TO biance_app;
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available, skipping: %', SQLERRM;
END $$;
