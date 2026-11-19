-- Decision items (docs/drafted-decisions-design.md): one row per finding on
-- Today that a person decides on. activeKey is "kind:recordId" while the item
-- is open or decided and NULL once it is resolved or expired; PostgreSQL treats
-- NULLs as distinct, so the unique index allows one live item per record and
-- kind and any number of old ones. Running this file a second time changes
-- nothing.

CREATE TABLE IF NOT EXISTS "DecisionItem" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "activeKey" TEXT,
  "kind" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "decision" TEXT,
  "reasonCode" TEXT,
  "note" TEXT,
  "returnOn" TEXT,
  "snapshot" JSONB,
  "documentType" TEXT,
  "documentId" TEXT,
  "decidedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DecisionItem_tenantId_activeKey_key" ON "DecisionItem"("tenantId", "activeKey");
CREATE INDEX IF NOT EXISTS "DecisionItem_tenantId_state_idx" ON "DecisionItem"("tenantId", "state");
CREATE INDEX IF NOT EXISTS "DecisionItem_tenantId_kind_recordId_idx" ON "DecisionItem"("tenantId", "kind", "recordId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionItem_tenantId_fkey') THEN
    ALTER TABLE "DecisionItem"
      ADD CONSTRAINT "DecisionItem_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionItem_decidedById_fkey') THEN
    ALTER TABLE "DecisionItem"
      ADD CONSTRAINT "DecisionItem_decidedById_fkey"
      FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
