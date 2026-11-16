-- A partly executed return authorization can close its unexecuted remainder
-- (a customer sends back 3 of 5 authorized units). The closed quantity is
-- kept per line so later postings, reversals and reconciliation use
-- authorized - closed as the line's executable quantity.
ALTER TABLE "ReturnAuthorization"
  ADD COLUMN "remainderClosedAt" TIMESTAMP(3),
  ADD COLUMN "remainderClosedById" TEXT,
  ADD COLUMN "remainderReason" TEXT;

ALTER TABLE "ReturnAuthorizationLine"
  ADD COLUMN "closedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "ReturnAuthorizationLine"
  ADD CONSTRAINT "ReturnAuthorizationLine_closed_quantity_check"
  CHECK ("closedQuantity" >= 0 AND "closedQuantity" <= "authorizedQuantity");

-- A quarantine release may put stock at another location of the same
-- warehouse. NULL keeps the earlier meaning: the line's own location.
ALTER TABLE "ReturnPostingLine"
  ADD COLUMN "destinationLocation" TEXT,
  ADD COLUMN "destinationLocationKey" TEXT;
