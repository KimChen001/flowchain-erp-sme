ALTER TABLE "AiKnowledgeChunk"
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "embedding" JSONB,
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "embeddingDimensions" INTEGER,
  ADD COLUMN "embeddedAt" TIMESTAMP(3);

CREATE INDEX "AiKnowledgeChunk_embeddingModel_embeddingDimensions_idx"
  ON "AiKnowledgeChunk"("embeddingModel", "embeddingDimensions");
