-- Phase 5.4A: tenant-scoped Universal Intake domain foundation.

CREATE TYPE "IntakeSourceType" AS ENUM ('manual_upload', 'email_attachment', 'api', 'system_export');
CREATE TYPE "IntakeBatchStatus" AS ENUM ('uploaded', 'profiling', 'mapping_required', 'normalizing', 'validation_required', 'ready_for_review', 'approved', 'committing', 'completed', 'failed', 'cancelled');
CREATE TYPE "IntakeRecordStatus" AS ENUM ('parsed', 'mapping_required', 'invalid', 'warning', 'valid', 'excluded');
CREATE TYPE "MappingProfileStatus" AS ENUM ('draft', 'active', 'retired');
CREATE TYPE "FieldTransformType" AS ENUM ('identity', 'trim', 'uppercase', 'lowercase', 'date', 'decimal', 'integer', 'boolean', 'currency_code');
CREATE TYPE "ValidationIssueSeverity" AS ENUM ('error', 'warning', 'info');
CREATE TYPE "ReviewSessionStatus" AS ENUM ('open', 'approved', 'rejected', 'cancelled');
CREATE TYPE "ReviewDecision" AS ENUM ('approved', 'rejected');
CREATE TYPE "CommitAttemptStatus" AS ENUM ('pending', 'blocked', 'succeeded', 'failed');

CREATE TABLE "InboundArtifact" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceType" "IntakeSourceType" NOT NULL DEFAULT 'manual_upload',
  "originalFilename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "checksumSha256" TEXT NOT NULL,
  "storageProvider" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "sourceExternalId" TEXT,
  "uploadedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "InboundArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundArtifact_size_check" CHECK ("sizeBytes" >= 0),
  CONSTRAINT "InboundArtifact_checksum_check" CHECK ("checksumSha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "InboundArtifact_tenantId_id_key" ON "InboundArtifact"("tenantId", "id");
CREATE UNIQUE INDEX "InboundArtifact_tenantId_checksumSha256_key" ON "InboundArtifact"("tenantId", "checksumSha256");
CREATE UNIQUE INDEX "InboundArtifact_tenantId_sourceType_sourceExternalId_key" ON "InboundArtifact"("tenantId", "sourceType", "sourceExternalId");
CREATE INDEX "InboundArtifact_tenantId_createdAt_idx" ON "InboundArtifact"("tenantId", "createdAt");
CREATE INDEX "InboundArtifact_tenantId_sourceType_createdAt_idx" ON "InboundArtifact"("tenantId", "sourceType", "createdAt");

CREATE TABLE "IntakeBatch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "batchType" TEXT NOT NULL,
  "status" "IntakeBatchStatus" NOT NULL DEFAULT 'uploaded',
  "recordCount" INTEGER NOT NULL DEFAULT 0,
  "validRecordCount" INTEGER NOT NULL DEFAULT 0,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "IntakeBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntakeBatch_counts_check" CHECK ("recordCount" >= 0 AND "validRecordCount" >= 0 AND "warningCount" >= 0 AND "errorCount" >= 0),
  CONSTRAINT "IntakeBatch_version_check" CHECK ("version" >= 0)
);
CREATE UNIQUE INDEX "IntakeBatch_tenantId_id_key" ON "IntakeBatch"("tenantId", "id");
CREATE INDEX "IntakeBatch_tenantId_status_createdAt_idx" ON "IntakeBatch"("tenantId", "status", "createdAt");
CREATE INDEX "IntakeBatch_tenantId_artifactId_idx" ON "IntakeBatch"("tenantId", "artifactId");

CREATE TABLE "IntakeRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "sourcePayload" JSONB NOT NULL,
  "normalizedPayload" JSONB,
  "recordType" TEXT NOT NULL,
  "status" "IntakeRecordStatus" NOT NULL DEFAULT 'parsed',
  "fingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntakeRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntakeRecord_row_check" CHECK ("rowNumber" > 0)
);
CREATE UNIQUE INDEX "IntakeRecord_tenantId_id_key" ON "IntakeRecord"("tenantId", "id");
CREATE UNIQUE INDEX "IntakeRecord_tenantId_batchId_rowNumber_key" ON "IntakeRecord"("tenantId", "batchId", "rowNumber");
CREATE INDEX "IntakeRecord_tenantId_batchId_status_idx" ON "IntakeRecord"("tenantId", "batchId", "status");
CREATE INDEX "IntakeRecord_tenantId_batchId_fingerprint_idx" ON "IntakeRecord"("tenantId", "batchId", "fingerprint");

CREATE TABLE "MappingProfile" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "recordType" TEXT NOT NULL,
  "sourceSignature" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "MappingProfileStatus" NOT NULL DEFAULT 'draft',
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MappingProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MappingProfile_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "MappingProfile_tenantId_id_key" ON "MappingProfile"("tenantId", "id");
CREATE UNIQUE INDEX "MappingProfile_tenantId_recordType_sourceSignature_version_key" ON "MappingProfile"("tenantId", "recordType", "sourceSignature", "version");
CREATE UNIQUE INDEX "MappingProfile_one_active_signature_key" ON "MappingProfile"("tenantId", "recordType", "sourceSignature") WHERE "status" = 'active';
CREATE INDEX "MappingProfile_tenantId_status_updatedAt_idx" ON "MappingProfile"("tenantId", "status", "updatedAt");

CREATE TABLE "FieldMapping" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "mappingProfileId" TEXT NOT NULL,
  "sourceField" TEXT NOT NULL,
  "targetField" TEXT NOT NULL,
  "transformType" "FieldTransformType" NOT NULL DEFAULT 'identity',
  "required" BOOLEAN NOT NULL DEFAULT false,
  "defaultValue" JSONB,
  "position" INTEGER NOT NULL,
  CONSTRAINT "FieldMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldMapping_position_check" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "FieldMapping_tenantId_id_key" ON "FieldMapping"("tenantId", "id");
CREATE UNIQUE INDEX "FieldMapping_tenantId_mappingProfileId_sourceField_key" ON "FieldMapping"("tenantId", "mappingProfileId", "sourceField");
CREATE INDEX "FieldMapping_tenantId_mappingProfileId_position_idx" ON "FieldMapping"("tenantId", "mappingProfileId", "position");

CREATE TABLE "ValidationIssue" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "recordId" TEXT,
  "severity" "ValidationIssueSeverity" NOT NULL,
  "code" TEXT NOT NULL,
  "field" TEXT,
  "message" TEXT NOT NULL,
  "details" JSONB,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "resolvedByUserId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ValidationIssue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ValidationIssue_resolution_check" CHECK (("resolved" = false AND "resolvedAt" IS NULL AND "resolvedByUserId" IS NULL) OR ("resolved" = true AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL))
);
CREATE UNIQUE INDEX "ValidationIssue_tenantId_id_key" ON "ValidationIssue"("tenantId", "id");
CREATE INDEX "ValidationIssue_tenantId_batchId_severity_resolved_idx" ON "ValidationIssue"("tenantId", "batchId", "severity", "resolved");
CREATE INDEX "ValidationIssue_tenantId_recordId_idx" ON "ValidationIssue"("tenantId", "recordId");

CREATE TABLE "ReviewSession" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "status" "ReviewSessionStatus" NOT NULL DEFAULT 'open',
  "reviewedByUserId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "decision" "ReviewDecision",
  "comment" TEXT,
  CONSTRAINT "ReviewSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReviewSession_completion_check" CHECK (("status" = 'open' AND "completedAt" IS NULL AND "decision" IS NULL) OR ("status" <> 'open' AND "completedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ReviewSession_tenantId_id_key" ON "ReviewSession"("tenantId", "id");
CREATE UNIQUE INDEX "ReviewSession_one_open_batch_key" ON "ReviewSession"("tenantId", "batchId") WHERE "status" = 'open';
CREATE INDEX "ReviewSession_tenantId_batchId_status_idx" ON "ReviewSession"("tenantId", "batchId", "status");

CREATE TABLE "CommitAttempt" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "status" "CommitAttemptStatus" NOT NULL DEFAULT 'blocked',
  "idempotencyKey" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  CONSTRAINT "CommitAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommitAttempt_phase_5_4a_blocked_check" CHECK ("status" = 'blocked')
);
CREATE UNIQUE INDEX "CommitAttempt_tenantId_id_key" ON "CommitAttempt"("tenantId", "id");
CREATE UNIQUE INDEX "CommitAttempt_tenantId_idempotencyKey_key" ON "CommitAttempt"("tenantId", "idempotencyKey");
CREATE INDEX "CommitAttempt_tenantId_batchId_createdAt_idx" ON "CommitAttempt"("tenantId", "batchId", "createdAt");

CREATE TABLE "SourceReference" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "externalSystem" TEXT NOT NULL,
  "externalReference" TEXT,
  "externalMessageId" TEXT,
  "externalThreadId" TEXT,
  "sourceUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceReference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceReference_tenantId_id_key" ON "SourceReference"("tenantId", "id");
CREATE INDEX "SourceReference_tenantId_artifactId_idx" ON "SourceReference"("tenantId", "artifactId");
CREATE INDEX "SourceReference_tenantId_externalSystem_externalReference_idx" ON "SourceReference"("tenantId", "externalSystem", "externalReference");

ALTER TABLE "InboundArtifact" ADD CONSTRAINT "InboundArtifact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntakeBatch" ADD CONSTRAINT "IntakeBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntakeBatch" ADD CONSTRAINT "IntakeBatch_tenantId_artifactId_fkey" FOREIGN KEY ("tenantId", "artifactId") REFERENCES "InboundArtifact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntakeRecord" ADD CONSTRAINT "IntakeRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntakeRecord" ADD CONSTRAINT "IntakeRecord_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "IntakeBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MappingProfile" ADD CONSTRAINT "MappingProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FieldMapping" ADD CONSTRAINT "FieldMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FieldMapping" ADD CONSTRAINT "FieldMapping_tenantId_mappingProfileId_fkey" FOREIGN KEY ("tenantId", "mappingProfileId") REFERENCES "MappingProfile"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "IntakeBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "IntakeRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_tenant_record_guard_fkey" FOREIGN KEY ("tenantId", "recordId") REFERENCES "IntakeRecord"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewSession" ADD CONSTRAINT "ReviewSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewSession" ADD CONSTRAINT "ReviewSession_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "IntakeBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommitAttempt" ADD CONSTRAINT "CommitAttempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommitAttempt" ADD CONSTRAINT "CommitAttempt_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "IntakeBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceReference" ADD CONSTRAINT "SourceReference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceReference" ADD CONSTRAINT "SourceReference_tenantId_artifactId_fkey" FOREIGN KEY ("tenantId", "artifactId") REFERENCES "InboundArtifact"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Extend the code-owned permission catalog without mutating prior migrations.
ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check";
ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK (
  "permissionCode" IN (
    'settings.workspace.read','settings.workspace.manage','settings.users.read','settings.users.manage','settings.roles.read','settings.roles.manage','settings.roles.assign','settings.numbering.read','settings.numbering.manage','settings.review_policy.read','settings.review_policy.manage','settings.modules.read','settings.modules.manage','settings.import.manage','settings.warehouse_import.manage','settings.diagnostics.read','settings.export.read','audit.read','audit.read_sensitive',
    'returns.request.read','returns.request.create','returns.request.revise','returns.request.submit','returns.request.cancel','returns.customer_request.manage','returns.authorization.read','returns.authorization.approve','returns.authorization.reject','returns.authorization.cancel','returns.authorization.expire','returns.posting.read','returns.posting.prepare','returns.posting.ready','returns.posting.post','returns.posting.cancel','returns.posting.reverse','returns.quarantine.read','returns.quarantine.release_prepare','returns.quarantine.release_post','returns.quarantine.release_reverse',
    'receiving.read','receiving.prepare','receiving.post','receiving.reverse','sales_order.read','sales_order.create','sales_order.revise','sales_order.submit','sales_order.cancel','shipment.read','shipment.prepare','shipment.post','shipment.reverse','inventory.balance.read','inventory.transfer.read','inventory.transfer.create','inventory.transfer.post','inventory.transfer.reverse','inventory.count.read','inventory.count.create','inventory.count.submit','inventory.count.review','inventory.count.post','inventory.count.reverse','inventory.adjustment.read','inventory.adjustment.create','inventory.adjustment.approve','inventory.adjustment.post','inventory.adjustment.reverse',
    'finance.overview.read','finance.amounts.read','finance.partner_snapshot.read','procurement.prices.read','finance.supplier_invoice.read','finance.supplier_invoice.create','finance.supplier_invoice.revise','finance.supplier_invoice.submit','finance.supplier_invoice.approve','finance.three_way_match.read','finance.three_way_match.execute','finance.match_exception.review','finance.payable.read','finance.payable.hold','finance.payable.release','finance.payable.mark_export_ready','finance.supplier_credit.read','finance.supplier_credit.create','finance.supplier_credit.approve','finance.customer_invoice.read','finance.customer_invoice.create','finance.customer_invoice.submit','finance.customer_invoice.approve','finance.customer_invoice.issue','finance.receivable.read','finance.receivable.dispute','finance.receivable.resolve_dispute','finance.receivable.record_external_reference','finance.customer_credit.read','finance.customer_credit.create','finance.customer_credit.approve',
    'finance.cashbook.read','finance.cashbook.manage','finance.settlement.read','finance.settlement.create','finance.settlement.revise','finance.settlement.submit','finance.settlement.approve','finance.settlement.reject','finance.settlement.cancel','finance.settlement.post','finance.settlement.reverse','finance.settlement.reconciliation.read','finance.advance.read','finance.advance.create','finance.advance.submit','finance.advance.approve','finance.advance.post','finance.advance.reverse','finance.internal_transfer.read','finance.internal_transfer.create','finance.internal_transfer.submit','finance.internal_transfer.approve','finance.internal_transfer.post','finance.internal_transfer.reverse','finance.settlement_discount.apply','finance.settlement_attachment.read','finance.settlement_attachment.manage',
    'finance.bank_statement.read','finance.bank_statement.import','finance.bank_statement.validate','finance.bank_statement.commit','finance.bank_statement.void','finance.bank_statement.export','finance.bank_mapping.read','finance.bank_mapping.manage','finance.bank_reconciliation.read','finance.bank_reconciliation.generate_candidates','finance.bank_reconciliation.confirm','finance.bank_reconciliation.reverse','finance.bank_reconciliation.dismiss_candidate','finance.bank_reconciliation.resolve_exception','finance.bank_reconciliation.export',
    'procurement.purchase_order.read','procurement.purchase_order.approve','procurement.purchase_order.reject','procurement.purchase_order.revise','mobile.sync.use','mobile.tasks.read','mobile.procurement.approval.read','mobile.procurement.approval.execute','mobile.receiving.read','mobile.receiving.prepare','mobile.receiving.post',
    'intake.artifact.create','intake.artifact.read','intake.batch.create','intake.batch.read','intake.batch.cancel','intake.mapping.manage','intake.review','intake.commit'
  )
);
