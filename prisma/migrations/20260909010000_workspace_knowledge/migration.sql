CREATE TABLE "AiKnowledgeDocument" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  "title" TEXT NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'en-US',
  "requiredPermission" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AiKnowledgeDocument_tenantId_status_idx" ON "AiKnowledgeDocument"("tenantId", "status");
CREATE TABLE "AiKnowledgeChunk" (
  "id" TEXT PRIMARY KEY,
  "documentId" TEXT NOT NULL REFERENCES "AiKnowledgeDocument"("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  UNIQUE ("documentId", "position")
);
