-- Contract records (docs/contracts-module-design.md, step K1). A contract is a
-- record of an agreement signed outside FlowChain: its key terms, its dates and
-- its signed files. People set three statuses (draft, active, terminated);
-- what a contract shows (notice due, ending, ended, renewed) is read from its
-- dates on each read (shared/contract-status.mjs).
--
-- Start, end, signed and terminated dates are calendar days stored at 00:00
-- UTC as entered, like due dates (#170).

CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "externalReference" TEXT,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "counterpartyType" TEXT NOT NULL DEFAULT 'supplier',
    "supplierId" TEXT,
    "ownerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "signedOn" TIMESTAMP(3),
    "renewal" TEXT NOT NULL DEFAULT 'none',
    "noticeDays" INTEGER NOT NULL DEFAULT 0,
    "reminderDays" INTEGER NOT NULL DEFAULT 60,
    "paymentTermsId" TEXT,
    "currency" TEXT,
    "totalValue" DECIMAL(18,4),
    "notes" TEXT,
    "renewsContractId" TEXT,
    "terminatedOn" TIMESTAMP(3),
    "terminationReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "terminatedById" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Contract_number_check" CHECK ("number" ~ '^CT-[0-9A-F]{8}$'),
    CONSTRAINT "Contract_title_check" CHECK (length(trim("title")) > 0),
    CONSTRAINT "Contract_type_check" CHECK ("type" IN ('purchase_agreement', 'service_agreement', 'nda', 'quality_agreement', 'other')),
    -- Suppliers only in K1 (D1); a supplier contract names its supplier.
    CONSTRAINT "Contract_counterparty_check" CHECK ("counterpartyType" = 'supplier' AND "supplierId" IS NOT NULL),
    CONSTRAINT "Contract_status_check" CHECK ("status" IN ('draft', 'active', 'terminated')),
    CONSTRAINT "Contract_renewal_check" CHECK ("renewal" IN ('none', 'automatic', 'by_agreement')),
    CONSTRAINT "Contract_notice_days_check" CHECK ("noticeDays" BETWEEN 0 AND 730),
    CONSTRAINT "Contract_reminder_days_check" CHECK ("reminderDays" BETWEEN 0 AND 365),
    CONSTRAINT "Contract_dates_check" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate"),
    CONSTRAINT "Contract_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "Contract_total_value_check" CHECK ("totalValue" IS NULL OR ("totalValue" >= 0 AND "currency" IS NOT NULL)),
    CONSTRAINT "Contract_renews_self_check" CHECK ("renewsContractId" IS NULL OR "renewsContractId" <> "id"),
    CONSTRAINT "Contract_version_check" CHECK ("version" >= 1),
    -- Activation needs the signed date and the start date (D3); a terminated
    -- contract was active first.
    CONSTRAINT "Contract_activation_check" CHECK (
      "status" = 'draft'
      OR ("signedOn" IS NOT NULL AND "startDate" IS NOT NULL AND "activatedAt" IS NOT NULL)
    ),
    -- A terminated contract keeps when and why; no other contract has either.
    CONSTRAINT "Contract_termination_check" CHECK (
      ("status" = 'terminated' AND "terminatedOn" IS NOT NULL AND length(trim("terminationReason")) > 0)
      OR ("status" <> 'terminated' AND "terminatedOn" IS NULL AND "terminationReason" IS NULL)
    )
);

CREATE TABLE "ContractAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "metadata" JSONB,

    CONSTRAINT "ContractAttachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContractAttachment_status_check" CHECK (
      ("status" = 'active' AND "deletedAt" IS NULL)
      OR ("status" = 'deleted' AND "deletedAt" IS NOT NULL)
    )
);

CREATE INDEX "Contract_tenantId_supplierId_idx" ON "Contract"("tenantId", "supplierId");
CREATE INDEX "Contract_tenantId_status_endDate_idx" ON "Contract"("tenantId", "status", "endDate");
CREATE INDEX "Contract_tenantId_ownerId_idx" ON "Contract"("tenantId", "ownerId");
CREATE INDEX "Contract_tenantId_renewsContractId_idx" ON "Contract"("tenantId", "renewsContractId");
CREATE UNIQUE INDEX "Contract_tenantId_id_key" ON "Contract"("tenantId", "id");
CREATE UNIQUE INDEX "Contract_tenantId_number_key" ON "Contract"("tenantId", "number");
CREATE INDEX "ContractAttachment_tenantId_contractId_status_idx" ON "ContractAttachment"("tenantId", "contractId", "status");
CREATE UNIQUE INDEX "ContractAttachment_tenantId_id_key" ON "ContractAttachment"("tenantId", "id");

-- The supplier, the owner, the contract renewed and the staged upload are of
-- the same workspace: every reference carries the tenant.
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenantId_ownerId_fkey" FOREIGN KEY ("tenantId", "ownerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenantId_renewsContractId_fkey" FOREIGN KEY ("tenantId", "renewsContractId") REFERENCES "Contract"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractAttachment" ADD CONSTRAINT "ContractAttachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractAttachment" ADD CONSTRAINT "ContractAttachment_tenantId_contractId_fkey" FOREIGN KEY ("tenantId", "contractId") REFERENCES "Contract"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractAttachment" ADD CONSTRAINT "ContractAttachment_tenantId_uploadId_fkey" FOREIGN KEY ("tenantId", "uploadId") REFERENCES "StagedUpload"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
