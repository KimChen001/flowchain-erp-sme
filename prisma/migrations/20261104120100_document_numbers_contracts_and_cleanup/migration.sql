-- Document numbers, follow-up to 20261104120000_document_number_sequences.
-- Running this file a second time changes nothing.

-- Contracts take the workspace document number (PREFIX-YYYYMM-NNNN, the
-- prefix from Settings › Numbering). Contracts numbered before keep their
-- CT-XXXXXXXX numbers, so both forms are allowed.
ALTER TABLE "Contract" DROP CONSTRAINT IF EXISTS "Contract_number_check";
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_number_check"
  CHECK ("number" ~ '^CT-[0-9A-F]{8}$' OR "number" ~ '^[A-Z0-9]{1,8}-[0-9]{6}-[0-9]{4,}$');

-- A sequence row is bookkeeping, not a business record: it goes with its
-- workspace instead of blocking the workspace's removal.
ALTER TABLE "DocumentNumberSequence" DROP CONSTRAINT IF EXISTS "DocumentNumberSequence_tenantId_fkey";
ALTER TABLE "DocumentNumberSequence"
  ADD CONSTRAINT "DocumentNumberSequence_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
