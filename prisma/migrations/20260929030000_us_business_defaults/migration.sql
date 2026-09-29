-- US-first business defaults for NEW rows only.
-- Existing rows are unchanged: SET DEFAULT never rewrites stored values, and
-- this migration deliberately has no UPDATE. Existing tenants keep their stored
-- countryCode, locale, currency and timezone, and existing documents keep
-- their stored currency.
BEGIN;
ALTER TABLE "Tenant"
  ALTER COLUMN "countryCode" SET DEFAULT 'US',
  ALTER COLUMN "locale" SET DEFAULT 'en-US',
  ALTER COLUMN "currency" SET DEFAULT 'USD',
  ALTER COLUMN "timezone" SET DEFAULT 'America/New_York';
ALTER TABLE "PurchaseRequest" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "Rfq" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "SupplierQuotation" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "PurchaseOrder" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "ReceivingDocument" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "SupplierInvoice" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "ThreeWayMatch" ALTER COLUMN "currency" SET DEFAULT 'USD';
COMMIT;
