-- Supplier tiers and business owners (docs/supplier-tiers-design.md, T1).
-- Every existing supplier starts as not tiered, with no owner.
ALTER TABLE "Supplier"
  ADD COLUMN "tier" INTEGER,
  ADD COLUMN "tierReason" TEXT,
  ADD COLUMN "tierSetById" TEXT,
  ADD COLUMN "tierSetAt" TIMESTAMP(3),
  ADD COLUMN "businessOwnerId" TEXT;

ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tier_check" CHECK ("tier" IS NULL OR "tier" BETWEEN 1 AND 3);

CREATE INDEX "Supplier_tenantId_tier_idx" ON "Supplier"("tenantId", "tier");
CREATE INDEX "Supplier_tenantId_businessOwnerId_idx" ON "Supplier"("tenantId", "businessOwnerId");

ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tierSetById_fkey" FOREIGN KEY ("tierSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessOwnerId_fkey" FOREIGN KEY ("businessOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
