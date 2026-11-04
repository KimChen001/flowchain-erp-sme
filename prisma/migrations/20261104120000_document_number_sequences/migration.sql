-- Document number sequences (owner decisions 2026-11-04): one row per
-- workspace, document type and month (YYYYMM in the workspace timezone),
-- holding the last number given out. shared/document-numbering.mjs has the
-- rules; server/domain/document-numbering.mjs advances a row with
-- INSERT … ON CONFLICT … RETURNING inside the creating transaction.
-- Running this file a second time changes nothing.

CREATE TABLE IF NOT EXISTS "DocumentNumberSequence" (
  "tenantId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "lastValue" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentNumberSequence_pkey" PRIMARY KEY ("tenantId", "documentType", "period"),
  CONSTRAINT "DocumentNumberSequence_lastValue_check" CHECK ("lastValue" >= 1),
  CONSTRAINT "DocumentNumberSequence_period_check" CHECK ("period" ~ '^[0-9]{6}$')
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentNumberSequence_tenantId_fkey') THEN
    ALTER TABLE "DocumentNumberSequence"
      ADD CONSTRAINT "DocumentNumberSequence_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
