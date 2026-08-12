-- Extend the code-owned permission catalog without rewriting prior migrations.
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

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" = ''procurement.rfq_award.create'')';
END $$;

INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT
  'AUTH-' || substr(md5(role."tenantId" || ':' || role."id" || ':procurement.rfq_award.create'), 1, 28),
  role."tenantId",
  role."id",
  'procurement.rfq_award.create'
FROM "TenantRole" AS role
WHERE role."isDefaultTemplate" = true
  AND role."roleKey" IN ('workspace-administrator', 'operations-manager')
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;

ALTER TABLE "DomainChangeFeed" DROP CONSTRAINT "DomainChangeFeed_operation_check";
ALTER TABLE "DomainChangeFeed" ADD CONSTRAINT "DomainChangeFeed_operation_check"
  CHECK ("operation" IN ('create','upsert','tombstone','access_epoch'));

CREATE UNIQUE INDEX "SupplierQuotation_tenantId_id_rfqId_supplierId_key"
  ON "SupplierQuotation"("tenantId", "id", "rfqId", "supplierId");
CREATE UNIQUE INDEX "SupplierQuotationRevision_tenantId_id_quotationId_revisionNumber_key"
  ON "SupplierQuotationRevision"("tenantId", "id", "quotationId", "revisionNumber");

CREATE TABLE "RfqAwardDecision" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "rfqId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "quotationId" TEXT NOT NULL,
  "quotationRevisionId" TEXT NOT NULL,
  "quotationRevisionNumber" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "quotedAmount" DECIMAL(18,4) NOT NULL,
  "decisionReason" TEXT NOT NULL,
  "decidedByActorId" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RfqAwardDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RfqAwardDecision_reason_check" CHECK (char_length(btrim("decisionReason")) BETWEEN 1 AND 2000),
  CONSTRAINT "RfqAwardDecision_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "RfqAwardDecision_amount_check" CHECK ("quotedAmount" >= 0),
  CONSTRAINT "RfqAwardDecision_revision_number_check" CHECK ("quotationRevisionNumber" > 0)
);

CREATE UNIQUE INDEX "RfqAwardDecision_tenantId_id_key" ON "RfqAwardDecision"("tenantId", "id");
CREATE UNIQUE INDEX "RfqAwardDecision_tenantId_rfqId_key" ON "RfqAwardDecision"("tenantId", "rfqId");
CREATE INDEX "RfqAwardDecision_tenantId_supplierId_idx" ON "RfqAwardDecision"("tenantId", "supplierId");
CREATE INDEX "RfqAwardDecision_tenantId_quotationId_quotationRevisionId_idx" ON "RfqAwardDecision"("tenantId", "quotationId", "quotationRevisionId");
CREATE INDEX "RfqAwardDecision_tenantId_decidedAt_idx" ON "RfqAwardDecision"("tenantId", "decidedAt");

ALTER TABLE "RfqAwardDecision" ADD CONSTRAINT "RfqAwardDecision_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqAwardDecision" ADD CONSTRAINT "RfqAwardDecision_tenantId_rfqId_fkey"
  FOREIGN KEY ("tenantId", "rfqId") REFERENCES "Rfq"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqAwardDecision" ADD CONSTRAINT "RfqAwardDecision_tenantId_supplierId_fkey"
  FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqAwardDecision" ADD CONSTRAINT "RfqAwardDecision_tenantId_quotationId_rfqId_supplierId_fkey"
  FOREIGN KEY ("tenantId", "quotationId", "rfqId", "supplierId")
  REFERENCES "SupplierQuotation"("tenantId", "id", "rfqId", "supplierId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqAwardDecision" ADD CONSTRAINT "RfqAwardDecision_tenantId_quotationRevisionId_quotationId_quotationRevisionNumber_fkey"
  FOREIGN KEY ("tenantId", "quotationRevisionId", "quotationId", "quotationRevisionNumber")
  REFERENCES "SupplierQuotationRevision"("tenantId", "id", "quotationId", "revisionNumber") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqAwardDecision" ADD CONSTRAINT "RfqAwardDecision_tenantId_decidedByActorId_fkey"
  FOREIGN KEY ("tenantId", "decidedByActorId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_rfq_award_decision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RFQ_AWARD_DECISION_IMMUTABLE' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RfqAwardDecision_immutable_update_delete"
BEFORE UPDATE OR DELETE ON "RfqAwardDecision"
FOR EACH ROW EXECUTE FUNCTION reject_rfq_award_decision_mutation();
