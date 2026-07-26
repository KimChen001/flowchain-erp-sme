-- Phase 5.4B: schema-aware structured Intake and versioned custom fields.

ALTER TYPE "IntakeSourceType" ADD VALUE 'manual_paste' AFTER 'manual_upload';

CREATE TYPE "CustomFieldEntityType" AS ENUM ('supplier', 'item', 'customer');
CREATE TYPE "CustomFieldStatus" AS ENUM ('draft', 'published', 'retired');
CREATE TYPE "CustomFieldDataType" AS ENUM ('text', 'long_text', 'integer', 'decimal', 'date', 'boolean', 'single_select');

ALTER TABLE "IntakeBatch"
  ADD COLUMN "sourceProfile" JSONB,
  ADD COLUMN "parserVersion" TEXT,
  ADD COLUMN "selectedSheet" TEXT,
  ADD COLUMN "headerRowNumber" INTEGER,
  ADD COLUMN "mappingProfileId" TEXT;

ALTER TABLE "IntakeRecord"
  ADD COLUMN "sourceFormat" TEXT NOT NULL DEFAULT 'legacy_preview',
  ADD COLUMN "sheetName" TEXT,
  ADD COLUMN "headerRowNumber" INTEGER,
  ADD COLUMN "sourceLocator" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "normalizationEvidence" JSONB,
  ADD COLUMN "excludedByUserId" TEXT,
  ADD COLUMN "excludedAt" TIMESTAMP(3);

ALTER TABLE "MappingProfile"
  ADD COLUMN "targetSchemaId" TEXT,
  ADD COLUMN "targetSchemaVersion" INTEGER,
  ADD COLUMN "tenantSchemaHash" TEXT,
  ADD COLUMN "sourceFormat" TEXT;

CREATE TABLE "CustomFieldDefinition" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "entityType" "CustomFieldEntityType" NOT NULL,
  "fieldKey" TEXT NOT NULL,
  "status" "CustomFieldStatus" NOT NULL DEFAULT 'draft',
  "currentRevisionId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomFieldDefinition_field_key_check" CHECK ("fieldKey" ~ '^[a-z][a-z0-9_]{1,62}$')
);
CREATE UNIQUE INDEX "CustomFieldDefinition_tenantId_id_key" ON "CustomFieldDefinition"("tenantId", "id");
CREATE UNIQUE INDEX "CustomFieldDefinition_tenantId_entityType_fieldKey_key" ON "CustomFieldDefinition"("tenantId", "entityType", "fieldKey");
CREATE INDEX "CustomFieldDefinition_tenantId_entityType_status_idx" ON "CustomFieldDefinition"("tenantId", "entityType", "status");

CREATE TABLE "CustomFieldRevision" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "definitionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "dataType" "CustomFieldDataType" NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "defaultValue" JSONB,
  "validationRules" JSONB NOT NULL DEFAULT '{}',
  "searchable" BOOLEAN NOT NULL DEFAULT false,
  "filterable" BOOLEAN NOT NULL DEFAULT false,
  "reportable" BOOLEAN NOT NULL DEFAULT false,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFieldRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomFieldRevision_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "CustomFieldRevision_tenantId_id_key" ON "CustomFieldRevision"("tenantId", "id");
CREATE UNIQUE INDEX "CustomFieldRevision_tenantId_definitionId_version_key" ON "CustomFieldRevision"("tenantId", "definitionId", "version");
CREATE INDEX "CustomFieldRevision_tenantId_definitionId_createdAt_idx" ON "CustomFieldRevision"("tenantId", "definitionId", "createdAt");

CREATE TABLE "CustomFieldOption" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "CustomFieldOption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomFieldOption_position_check" CHECK ("position" >= 0),
  CONSTRAINT "CustomFieldOption_value_check" CHECK ("value" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
);
CREATE UNIQUE INDEX "CustomFieldOption_tenantId_id_key" ON "CustomFieldOption"("tenantId", "id");
CREATE UNIQUE INDEX "CustomFieldOption_tenantId_revisionId_value_key" ON "CustomFieldOption"("tenantId", "revisionId", "value");
CREATE INDEX "CustomFieldOption_tenantId_revisionId_position_idx" ON "CustomFieldOption"("tenantId", "revisionId", "position");

CREATE TABLE "IntakeSchemaSnapshot" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "recordType" TEXT NOT NULL,
  "coreSchemaId" TEXT NOT NULL,
  "coreSchemaVersion" INTEGER NOT NULL,
  "tenantSchemaHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "customFieldRevisionIds" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntakeSchemaSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntakeSchemaSnapshot_version_check" CHECK ("coreSchemaVersion" > 0),
  CONSTRAINT "IntakeSchemaSnapshot_hash_check" CHECK ("tenantSchemaHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "IntakeSchemaSnapshot_size_check" CHECK (octet_length("snapshot"::text) <= 262144)
);
CREATE UNIQUE INDEX "IntakeSchemaSnapshot_tenantId_id_key" ON "IntakeSchemaSnapshot"("tenantId", "id");
CREATE UNIQUE INDEX "IntakeSchemaSnapshot_tenantId_batchId_key" ON "IntakeSchemaSnapshot"("tenantId", "batchId");
CREATE INDEX "IntakeSchemaSnapshot_tenantId_recordType_createdAt_idx" ON "IntakeSchemaSnapshot"("tenantId", "recordType", "createdAt");

ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomFieldRevision" ADD CONSTRAINT "CustomFieldRevision_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomFieldRevision" ADD CONSTRAINT "CustomFieldRevision_tenantId_definitionId_fkey"
  FOREIGN KEY ("tenantId", "definitionId") REFERENCES "CustomFieldDefinition"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT "CustomFieldOption_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT "CustomFieldOption_tenantId_revisionId_fkey"
  FOREIGN KEY ("tenantId", "revisionId") REFERENCES "CustomFieldRevision"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntakeSchemaSnapshot" ADD CONSTRAINT "IntakeSchemaSnapshot_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntakeSchemaSnapshot" ADD CONSTRAINT "IntakeSchemaSnapshot_tenantId_batchId_fkey"
  FOREIGN KEY ("tenantId", "batchId") REFERENCES "IntakeBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the complete preceding permission allowlist and add only the three
-- versioned Custom Field permissions.
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
    || ' OR "permissionCode" IN (''custom_field.read'',''custom_field.manage'',''custom_field.publish''))';
END $$;
