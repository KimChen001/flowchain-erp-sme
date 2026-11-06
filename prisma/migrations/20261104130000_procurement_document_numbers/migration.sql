-- Workspace document numbers for purchase requests, RFQs and purchase orders
-- (owner decisions 2026-11-04). Running this file a second time changes
-- nothing.
--
-- Their id is a global primary key and stays the internal id. The number
-- people see is a separate column, unique per workspace: new documents get
-- PREFIX-YYYYMM-NNNN from the workspace sequence when they are created, and
-- documents created before keep the number they already showed, their id.
-- (A purchase order's metadata.orderNumber equals its id for every order the
-- app created.)

ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "number" TEXT;
ALTER TABLE "Rfq" ADD COLUMN IF NOT EXISTS "number" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "number" TEXT;

UPDATE "PurchaseRequest" SET "number" = "id" WHERE "number" IS NULL;
UPDATE "Rfq" SET "number" = "id" WHERE "number" IS NULL;
UPDATE "PurchaseOrder" SET "number" = "id" WHERE "number" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseRequest_tenantId_number_key" ON "PurchaseRequest"("tenantId", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "Rfq_tenantId_number_key" ON "Rfq"("tenantId", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_tenantId_number_key" ON "PurchaseOrder"("tenantId", "number");
