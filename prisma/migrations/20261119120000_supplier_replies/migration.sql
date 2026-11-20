-- Supplier replies (docs/supplier-reply-dates-design.md §5): one row per reply
-- a person pastes on a purchase order, with its reading, its checks and the
-- person's decision. activeKey is the order id while the card is open and NULL
-- after; PostgreSQL treats NULLs as distinct, so the unique index allows one
-- open card per order and any number of closed ones. messageId is NULL for a
-- pasted reply. quotedText is the quoted earlier message and signature cut
-- from the reply, kept for display and never read. Running this file a second
-- time changes nothing.

CREATE TABLE IF NOT EXISTS "SupplierReply" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "supplierId" TEXT,
  "activeKey" TEXT,
  "source" TEXT NOT NULL DEFAULT 'paste',
  "receivedOn" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "quotedTextHidden" BOOLEAN NOT NULL DEFAULT false,
  "quotedText" TEXT,
  "sender" TEXT,
  "messageId" TEXT,
  "inReplyTo" TEXT,
  "followUpAuditId" TEXT,
  "state" TEXT NOT NULL,
  "readingStatus" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "promptVersion" TEXT,
  "reading" JSONB,
  "check" JSONB,
  "usage" JSONB,
  "instructionsIgnored" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decision" TEXT,
  "reasonCode" TEXT,
  "note" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "editedLines" INTEGER NOT NULL DEFAULT 0,
  "revisionIds" JSONB,
  "notNowUntil" TEXT,
  "supersededById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierReply_tenantId_activeKey_key" ON "SupplierReply"("tenantId", "activeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierReply_tenantId_messageId_key" ON "SupplierReply"("tenantId", "messageId");
CREATE INDEX IF NOT EXISTS "SupplierReply_tenantId_purchaseOrderId_createdAt_idx" ON "SupplierReply"("tenantId", "purchaseOrderId", "createdAt");
CREATE INDEX IF NOT EXISTS "SupplierReply_tenantId_state_idx" ON "SupplierReply"("tenantId", "state");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupplierReply_tenantId_fkey') THEN
    ALTER TABLE "SupplierReply"
      ADD CONSTRAINT "SupplierReply_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupplierReply_purchaseOrderId_fkey') THEN
    ALTER TABLE "SupplierReply"
      ADD CONSTRAINT "SupplierReply_purchaseOrderId_fkey"
      FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
