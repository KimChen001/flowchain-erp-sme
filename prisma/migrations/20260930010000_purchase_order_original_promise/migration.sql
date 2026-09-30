-- The original promised date of a purchase order line, and the history of
-- every change to a line's promised date after the PO is issued.
-- Additive only: one nullable column and one new table. Existing lines keep a
-- null original promise; nothing is backfilled.

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "originalPromisedDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PurchaseOrderPromiseRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "previousDate" TIMESTAMP(3),
    "newDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderPromiseRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseOrderPromiseRevision_tenantId_purchaseOrderId_idx" ON "PurchaseOrderPromiseRevision"("tenantId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderPromiseRevision_purchaseOrderLineId_createdAt_idx" ON "PurchaseOrderPromiseRevision"("purchaseOrderLineId", "createdAt");

-- AddForeignKey
ALTER TABLE "PurchaseOrderPromiseRevision" ADD CONSTRAINT "PurchaseOrderPromiseRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderPromiseRevision" ADD CONSTRAINT "PurchaseOrderPromiseRevision_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Once set, the original promise never changes.
CREATE OR REPLACE FUNCTION flowchain_purchase_order_line_original_promise_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."originalPromisedDate" IS NOT NULL AND NEW."originalPromisedDate" IS DISTINCT FROM OLD."originalPromisedDate" THEN
    RAISE EXCEPTION 'The original promised date of a purchase order line cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PurchaseOrderLine_original_promise_immutable"
  BEFORE UPDATE OF "originalPromisedDate" ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION flowchain_purchase_order_line_original_promise_immutable();

-- Promise revisions are append-only history.
CREATE OR REPLACE FUNCTION flowchain_purchase_order_promise_revision_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Purchase order promise revisions are append-only and cannot be updated or deleted' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PurchaseOrderPromiseRevision_immutable"
  BEFORE UPDATE OR DELETE ON "PurchaseOrderPromiseRevision"
  FOR EACH ROW EXECUTE FUNCTION flowchain_purchase_order_promise_revision_immutable();
