-- The original promise is now recorded when a purchase order is approved
-- (it was recorded only at issue). Lines of POs approved, issued or received
-- before that have none, so the supplier scorecard and the on-time KPI leave
-- them out. This backfills each such line once, from the best date on record:
--   1. the date before the line's first promise revision, when it was revised;
--   2. the line's own promised date (metadata.promisedDate);
--   3. the PO's expected date.
-- Dates are calendar days stored at 12:00 UTC, as the application writes them.
-- Lines that already have an original promise keep it (the trigger refuses a
-- change anyway); drafts, pending, rejected and cancelled POs are untouched;
-- a line with no date anywhere stays null.

-- A calendar day from a stored YYYY-MM-DD text, or null when it is not a real day.
CREATE FUNCTION flowchain_backfill_promise_day(value TEXT) RETURNS TIMESTAMP(3) AS $$
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN substring(value FROM 1 FOR 10)::date + TIME '12:00';
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

UPDATE "PurchaseOrderLine" AS line
SET "originalPromisedDate" = COALESCE(
  (
    SELECT revision."previousDate"::date + TIME '12:00'
    FROM "PurchaseOrderPromiseRevision" AS revision
    WHERE revision."purchaseOrderLineId" = line.id
    ORDER BY revision."createdAt" ASC, revision.id ASC
    LIMIT 1
  ),
  flowchain_backfill_promise_day(line.metadata->>'promisedDate'),
  po."expectedDate"::date + TIME '12:00'
)
FROM "PurchaseOrder" AS po
WHERE po.id = line."purchaseOrderId"
  AND line."originalPromisedDate" IS NULL
  AND po.status IN ('approved', 'issued', 'partially_received', 'fully_received', 'closed');

DROP FUNCTION flowchain_backfill_promise_day(TEXT);
