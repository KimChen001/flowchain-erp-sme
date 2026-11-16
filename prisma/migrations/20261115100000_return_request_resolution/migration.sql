-- What the supplier owes for goods sent back (design audit L3-23): a credit
-- (the default, and every existing row) or a replacement. A replacement
-- reopens the received quantity on the purchase order line, so the
-- replacement shows as on order and can be received against the order.
-- Customer returns are always settled by a credit note for now.
ALTER TABLE "ReturnRequest"
  ADD COLUMN "resolution" TEXT NOT NULL DEFAULT 'credit';

ALTER TABLE "ReturnRequest"
  ADD CONSTRAINT "ReturnRequest_resolution_check"
  CHECK (
    "resolution" IN ('credit', 'replacement')
    AND ("resolution" = 'credit' OR "returnType" = 'supplier_return')
  );
