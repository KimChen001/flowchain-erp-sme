DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pgvector is unavailable; FlowChain will retain JSONB vector fallback';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "AiKnowledgeChunk" ADD COLUMN IF NOT EXISTS "embeddingVector" vector;
  END IF;
END $$;
