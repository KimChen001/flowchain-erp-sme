-- The date a purchase order was issued to the supplier. The Issue action
-- writes it once; it never changes afterwards (the trigger below refuses a
-- change). Price history and supplier figures date a PO by it.
--
-- POs issued before the column existed are backfilled once, from the first
-- record of the issue that exists:
--   1. metadata.issuedAt, which the Issue action has always written;
--   2. the earliest purchase_order_issue audit row for the PO;
--   3. the first "issue" step in metadata.approvalTimeline.
-- A PO with none of these (seeded or imported as issued, or received without
-- being issued) keeps a null issue date, shown as "Issue date not recorded".

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "issuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_issuedAt_idx" ON "PurchaseOrder"("tenantId", "issuedAt");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_itemId_idx" ON "PurchaseOrderLine"("itemId");

-- An instant from a stored ISO date-time text, as UTC, or null when it is not one.
CREATE FUNCTION flowchain_backfill_issued_instant(value TEXT) RETURNS TIMESTAMP(3) AS $$
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN (value::timestamptz AT TIME ZONE 'UTC')::timestamp(3);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

UPDATE "PurchaseOrder" AS po
SET "issuedAt" = COALESCE(
  flowchain_backfill_issued_instant(po.metadata->>'issuedAt'),
  (
    SELECT audit."createdAt"
    FROM "AuditLog" AS audit
    WHERE audit."tenantId" = po."tenantId"
      AND audit."entityType" = 'PurchaseOrder'
      AND audit."entityId" = po.id
      AND audit.action = 'purchase_order_issue'
    ORDER BY audit."createdAt" ASC, audit.id ASC
    LIMIT 1
  ),
  (
    SELECT flowchain_backfill_issued_instant(step.value->>'at')
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(po.metadata->'approvalTimeline') = 'array' THEN po.metadata->'approvalTimeline' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS step(value, position)
    WHERE step.value->>'action' = 'issue'
      AND flowchain_backfill_issued_instant(step.value->>'at') IS NOT NULL
    ORDER BY step.position ASC
    LIMIT 1
  )
)
WHERE po."issuedAt" IS NULL;

DROP FUNCTION flowchain_backfill_issued_instant(TEXT);

-- Once set, the issue date never changes.
CREATE OR REPLACE FUNCTION flowchain_purchase_order_issued_at_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."issuedAt" IS NOT NULL AND NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" THEN
    RAISE EXCEPTION 'The issue date of a purchase order cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PurchaseOrder_issued_at_immutable"
  BEFORE UPDATE OF "issuedAt" ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION flowchain_purchase_order_issued_at_immutable();
