-- 20260728010000_rfq_participation_revision_authority moved the RfqLine -> Rfq
-- foreign key to ("tenantId", "rfqId") but kept the baseline ("rfqId") index.
-- RfqLine reads and the cascading foreign key filter on both columns.
CREATE INDEX "RfqLine_tenantId_rfqId_idx" ON "RfqLine"("tenantId", "rfqId");
DROP INDEX "RfqLine_rfqId_idx";
