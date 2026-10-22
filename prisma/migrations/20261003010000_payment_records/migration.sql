-- Light payment records (docs/bills-invoices-and-accounting-handoff.md, step 2).
-- A record says that money was paid to a supplier or received from a customer
-- outside FlowChain. It lowers the outstanding amount of one bill to pay or one
-- receivable; FlowChain never moves money. A wrong record is voided with a
-- reason, never edited or deleted.

CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "obligationType" TEXT NOT NULL,
    "payableObligationId" TEXT,
    "receivableObligationId" TEXT,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "recordedById" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentRecord_type_check" CHECK ("obligationType" IN ('payable', 'receivable')),
    -- Exactly one obligation, of the stated type.
    CONSTRAINT "PaymentRecord_exact_obligation_check" CHECK (
      ("obligationType" = 'payable' AND "payableObligationId" IS NOT NULL AND "receivableObligationId" IS NULL)
      OR ("obligationType" = 'receivable' AND "receivableObligationId" IS NOT NULL AND "payableObligationId" IS NULL)
    ),
    CONSTRAINT "PaymentRecord_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "PaymentRecord_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "PaymentRecord_method_check" CHECK ("method" IN ('check', 'ach', 'wire', 'card', 'cash', 'other')),
    CONSTRAINT "PaymentRecord_status_check" CHECK ("status" IN ('recorded', 'voided')),
    -- A voided record keeps who voided it, when and why.
    CONSTRAINT "PaymentRecord_void_check" CHECK (
      ("status" = 'recorded' AND "voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
      OR ("status" = 'voided' AND "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND length(trim("voidReason")) > 0)
    )
);

CREATE INDEX "PaymentRecord_tenantId_payableObligationId_idx" ON "PaymentRecord"("tenantId", "payableObligationId");
CREATE INDEX "PaymentRecord_tenantId_receivableObligationId_idx" ON "PaymentRecord"("tenantId", "receivableObligationId");
CREATE INDEX "PaymentRecord_tenantId_paymentDate_idx" ON "PaymentRecord"("tenantId", "paymentDate");
CREATE UNIQUE INDEX "PaymentRecord_tenantId_id_key" ON "PaymentRecord"("tenantId", "id");

ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenantId_payableObligationId_fkey" FOREIGN KEY ("tenantId", "payableObligationId") REFERENCES "PayableObligation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenantId_receivableObligationId_fkey" FOREIGN KEY ("tenantId", "receivableObligationId") REFERENCES "ReceivableObligation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Extend the code-owned permission catalog without rewriting prior migrations,
-- unless it already allows the new codes. Running this part again changes
-- nothing.
DO $$
DECLARE
  prior_definition TEXT;
  prior_expression TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO prior_definition
    FROM pg_constraint
   WHERE conrelid = '"TenantRolePermission"'::regclass
     AND conname = 'TenantRolePermission_permissionCode_catalog_check';

  IF prior_definition IS NULL THEN
    RAISE EXCEPTION 'FLOWCHAIN_PERMISSION_CATALOG_CONSTRAINT_MISSING';
  END IF;

  IF position('finance.payable.record_payment' IN prior_definition) > 0 THEN
    RETURN;
  END IF;

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" IN (''finance.payable.record_payment'',''finance.receivable.record_payment''))';
END $$;

-- Existing default roles receive the same grants as a fresh authorization
-- backfill (defaultRoleTemplates in server/auth/permission-catalog.mjs): the
-- workspace administrator, the operations manager and the finance specialist,
-- who already approve bills and issue invoices. Administrators can remove
-- these grants afterwards and they stay removed. Custom roles are left to
-- workspace administrators.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT
  'AUTH-' || substr(md5(role."tenantId" || ':' || role."id" || ':' || grant_row.code), 1, 28),
  role."tenantId",
  role."id",
  grant_row.code
FROM "TenantRole" AS role
JOIN (VALUES
  ('workspace-administrator', 'finance.payable.record_payment'),
  ('workspace-administrator', 'finance.receivable.record_payment'),
  ('operations-manager', 'finance.payable.record_payment'),
  ('operations-manager', 'finance.receivable.record_payment'),
  ('finance-specialist', 'finance.payable.record_payment'),
  ('finance-specialist', 'finance.receivable.record_payment')
) AS grant_row(role_key, code) ON grant_row.role_key = role."roleKey"
WHERE role."isDefaultTemplate" = true
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
