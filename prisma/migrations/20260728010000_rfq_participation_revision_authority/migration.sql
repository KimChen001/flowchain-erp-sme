-- Fail closed before adding tenant-scoped authority or copying legacy facts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "SupplierQuotation"
    WHERE "rfqId" IS NULL OR btrim("rfqId") = ''
       OR "supplierId" IS NULL OR btrim("supplierId") = ''
  ) THEN
    RAISE EXCEPTION 'RFQ_REVISION_MISSING_RELATION: every legacy quotation must identify an RFQ and supplier' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SupplierQuotation"
    GROUP BY "tenantId", "rfqId", "supplierId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'RFQ_REVISION_DUPLICATE_SUPPLIER_RESPONSE: multiple legacy quotations exist for one tenant/RFQ/supplier' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SupplierQuotation" q
    LEFT JOIN "Rfq" r ON r."id" = q."rfqId" AND r."tenantId" = q."tenantId"
    LEFT JOIN "Supplier" s ON s."id" = q."supplierId" AND s."tenantId" = q."tenantId"
    WHERE r."id" IS NULL OR s."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'RFQ_REVISION_TENANT_RELATION_MISMATCH: quotation parent is missing or crosses a tenant boundary' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SupplierQuotationLine" l
    LEFT JOIN "SupplierQuotation" q ON q."id" = l."supplierQuotationId"
    WHERE q."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'RFQ_REVISION_MISSING_QUOTATION_PARENT: a legacy quotation line has no quotation parent' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "SupplierQuotation"
    WHERE CASE
      WHEN lower(btrim("status")) IN ('draft','incomplete','submitted','shortlisted','not_selected','withdrawn','received') THEN false
      WHEN btrim("status") IN ('草稿','已提交','已入围','未中选','已撤回') THEN false
      ELSE true
    END
  ) THEN
    RAISE EXCEPTION 'RFQ_REVISION_UNKNOWN_STATUS: legacy quotation status cannot be mapped to the canonical revision catalog' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM "SupplierQuotation" WHERE "quotedAmount" < 0)
    OR EXISTS (
      SELECT 1 FROM "SupplierQuotationLine"
      WHERE "quantity" < 0 OR "unitPrice" < 0 OR "amount" < 0
    )
  THEN
    RAISE EXCEPTION 'RFQ_REVISION_NEGATIVE_DECIMAL: legacy quotation amounts and quantities must be non-negative' USING ERRCODE = '23514';
  END IF;
END $$;

-- Composite identities are required by every new tenant-scoped relationship.
CREATE UNIQUE INDEX "Supplier_tenantId_id_key" ON "Supplier"("tenantId", "id");
CREATE UNIQUE INDEX "Rfq_tenantId_id_key" ON "Rfq"("tenantId", "id");
CREATE UNIQUE INDEX "SupplierQuotation_tenantId_id_key" ON "SupplierQuotation"("tenantId", "id");

ALTER TABLE "SupplierQuotation" DROP CONSTRAINT "SupplierQuotation_rfqId_fkey";
ALTER TABLE "SupplierQuotation" ADD CONSTRAINT "SupplierQuotation_tenantId_rfqId_fkey"
  FOREIGN KEY ("tenantId", "rfqId") REFERENCES "Rfq"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RfqSupplierParticipation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "rfqId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "invitedAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "withdrawnAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RfqSupplierParticipation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RfqSupplierParticipation_status_check" CHECK ("status" IN ('planned','invited_internal','response_recorded','declined','withdrawn','closed')),
  CONSTRAINT "RfqSupplierParticipation_version_check" CHECK ("version" >= 0)
);

CREATE TABLE "SupplierQuotationRevision" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quotationId" TEXT NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "quotedAmount" DECIMAL(18,4),
  "submittedAt" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "deliveryDate" TIMESTAMP(3),
  "paymentTerms" TEXT,
  "createdByActorId" TEXT,
  "source" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupplierQuotationRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierQuotationRevision_number_check" CHECK ("revisionNumber" > 0),
  CONSTRAINT "SupplierQuotationRevision_status_check" CHECK ("status" IN ('draft','incomplete','submitted','shortlisted','not_selected','withdrawn')),
  CONSTRAINT "SupplierQuotationRevision_currency_check" CHECK (btrim("currency") <> ''),
  CONSTRAINT "SupplierQuotationRevision_amount_check" CHECK ("quotedAmount" IS NULL OR "quotedAmount" >= 0),
  CONSTRAINT "SupplierQuotationRevision_source_check" CHECK (btrim("source") <> '')
);

CREATE TABLE "SupplierQuotationRevisionLine" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "rfqLineId" TEXT,
  "sourceQuotationLineId" TEXT,
  "itemId" TEXT,
  "skuSnapshot" TEXT,
  "itemNameSnapshot" TEXT,
  "quantity" DECIMAL(18,4),
  "unit" TEXT,
  "unitPrice" DECIMAL(18,4),
  "amount" DECIMAL(18,4),
  "deliveryDate" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupplierQuotationRevisionLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierQuotationRevisionLine_decimal_check" CHECK (
    ("quantity" IS NULL OR "quantity" >= 0)
    AND ("unitPrice" IS NULL OR "unitPrice" >= 0)
    AND ("amount" IS NULL OR "amount" >= 0)
  )
);

CREATE UNIQUE INDEX "RfqSupplierParticipation_tenantId_id_key" ON "RfqSupplierParticipation"("tenantId", "id");
CREATE UNIQUE INDEX "RfqSupplierParticipation_tenantId_rfqId_supplierId_key" ON "RfqSupplierParticipation"("tenantId", "rfqId", "supplierId");
CREATE INDEX "RfqSupplierParticipation_tenantId_rfqId_status_idx" ON "RfqSupplierParticipation"("tenantId", "rfqId", "status");
CREATE INDEX "RfqSupplierParticipation_tenantId_supplierId_status_idx" ON "RfqSupplierParticipation"("tenantId", "supplierId", "status");

CREATE UNIQUE INDEX "SupplierQuotationRevision_tenantId_id_key" ON "SupplierQuotationRevision"("tenantId", "id");
CREATE UNIQUE INDEX "SupplierQuotationRevision_tenantId_quotationId_revisionNumber_key" ON "SupplierQuotationRevision"("tenantId", "quotationId", "revisionNumber");
CREATE INDEX "SupplierQuotationRevision_tenantId_quotationId_revisionNumber_idx" ON "SupplierQuotationRevision"("tenantId", "quotationId", "revisionNumber");
CREATE INDEX "SupplierQuotationRevision_tenantId_createdAt_idx" ON "SupplierQuotationRevision"("tenantId", "createdAt");

CREATE UNIQUE INDEX "SupplierQuotationRevisionLine_tenantId_id_key" ON "SupplierQuotationRevisionLine"("tenantId", "id");
CREATE INDEX "SupplierQuotationRevisionLine_tenantId_revisionId_idx" ON "SupplierQuotationRevisionLine"("tenantId", "revisionId");
CREATE INDEX "SupplierQuotationRevisionLine_tenantId_rfqLineId_idx" ON "SupplierQuotationRevisionLine"("tenantId", "rfqLineId");
CREATE INDEX "SupplierQuotationRevisionLine_tenantId_sourceQuotationLineId_idx" ON "SupplierQuotationRevisionLine"("tenantId", "sourceQuotationLineId");

ALTER TABLE "RfqSupplierParticipation" ADD CONSTRAINT "RfqSupplierParticipation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqSupplierParticipation" ADD CONSTRAINT "RfqSupplierParticipation_tenantId_rfqId_fkey"
  FOREIGN KEY ("tenantId", "rfqId") REFERENCES "Rfq"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqSupplierParticipation" ADD CONSTRAINT "RfqSupplierParticipation_tenantId_supplierId_fkey"
  FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierQuotationRevision" ADD CONSTRAINT "SupplierQuotationRevision_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierQuotationRevision" ADD CONSTRAINT "SupplierQuotationRevision_tenantId_quotationId_fkey"
  FOREIGN KEY ("tenantId", "quotationId") REFERENCES "SupplierQuotation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierQuotationRevision" ADD CONSTRAINT "SupplierQuotationRevision_tenantId_createdByActorId_fkey"
  FOREIGN KEY ("tenantId", "createdByActorId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierQuotationRevisionLine" ADD CONSTRAINT "SupplierQuotationRevisionLine_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierQuotationRevisionLine" ADD CONSTRAINT "SupplierQuotationRevisionLine_tenantId_revisionId_fkey"
  FOREIGN KEY ("tenantId", "revisionId") REFERENCES "SupplierQuotationRevision"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One deterministic Revision 1 and participation fact for every safe legacy response.
INSERT INTO "SupplierQuotationRevision" (
  "id", "tenantId", "quotationId", "revisionNumber", "status", "currency", "quotedAmount",
  "submittedAt", "source", "metadata", "createdAt"
)
SELECT
  'sqr_' || md5(q."tenantId" || E'\x1f' || q."id" || E'\x1f1'),
  q."tenantId",
  q."id",
  1,
  CASE
    WHEN lower(btrim(q."status")) = 'received' THEN 'submitted'
    WHEN btrim(q."status") = '草稿' THEN 'draft'
    WHEN btrim(q."status") = '已提交' THEN 'submitted'
    WHEN btrim(q."status") = '已入围' THEN 'shortlisted'
    WHEN btrim(q."status") = '未中选' THEN 'not_selected'
    WHEN btrim(q."status") = '已撤回' THEN 'withdrawn'
    ELSE lower(btrim(q."status"))
  END,
  q."currency",
  q."quotedAmount",
  q."submittedAt",
  'legacy_backfill',
  q."metadata",
  q."createdAt"
FROM "SupplierQuotation" q;

INSERT INTO "SupplierQuotationRevisionLine" (
  "id", "tenantId", "revisionId", "sourceQuotationLineId", "itemId", "skuSnapshot",
  "itemNameSnapshot", "quantity", "unit", "unitPrice", "amount", "metadata", "createdAt"
)
SELECT
  'sqrl_' || md5(q."tenantId" || E'\x1f' || q."id" || E'\x1f' || l."id" || E'\x1f1'),
  q."tenantId",
  'sqr_' || md5(q."tenantId" || E'\x1f' || q."id" || E'\x1f1'),
  l."id",
  l."itemId",
  l."sku",
  l."itemName",
  l."quantity",
  l."unit",
  l."unitPrice",
  l."amount",
  l."metadata",
  q."createdAt"
FROM "SupplierQuotationLine" l
JOIN "SupplierQuotation" q ON q."id" = l."supplierQuotationId";

INSERT INTO "RfqSupplierParticipation" (
  "id", "tenantId", "rfqId", "supplierId", "status", "respondedAt", "metadata", "createdAt", "updatedAt"
)
SELECT
  'rfqsp_' || md5(q."tenantId" || E'\x1f' || q."rfqId" || E'\x1f' || q."supplierId"),
  q."tenantId",
  q."rfqId",
  q."supplierId",
  'response_recorded',
  coalesce(q."submittedAt", q."createdAt"),
  jsonb_build_object('backfilledFromQuotationId', q."id"),
  q."createdAt",
  q."updatedAt"
FROM "SupplierQuotation" q;

-- Revisions are append-only authority. INSERT remains available for future commands.
CREATE OR REPLACE FUNCTION flowchain_supplier_quotation_revision_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Supplier quotation revisions are append-only and cannot be updated or deleted' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupplierQuotationRevision_immutable"
  BEFORE UPDATE OR DELETE ON "SupplierQuotationRevision"
  FOR EACH ROW EXECUTE FUNCTION flowchain_supplier_quotation_revision_immutable();

CREATE OR REPLACE FUNCTION flowchain_supplier_quotation_revision_line_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Supplier quotation revision lines are append-only and cannot be updated or deleted' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupplierQuotationRevisionLine_immutable"
  BEFORE UPDATE OR DELETE ON "SupplierQuotationRevisionLine"
  FOR EACH ROW EXECUTE FUNCTION flowchain_supplier_quotation_revision_line_immutable();
