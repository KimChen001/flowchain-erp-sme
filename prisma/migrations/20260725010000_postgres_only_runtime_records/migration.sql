-- Durable tenant-scoped records that do not yet have a dedicated aggregate table.
CREATE TABLE "RuntimeRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "recordKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeRecord_tenantId_namespace_recordKey_key"
    ON "RuntimeRecord"("tenantId", "namespace", "recordKey");
CREATE INDEX "RuntimeRecord_tenantId_namespace_updatedAt_idx"
    ON "RuntimeRecord"("tenantId", "namespace", "updatedAt");

ALTER TABLE "RuntimeRecord"
    ADD CONSTRAINT "RuntimeRecord_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
