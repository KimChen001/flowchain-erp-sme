-- Model calls per workspace and month, for the AI spend cap (the owner's AI
-- direction of 2026-10-05). Empty until a workspace calls a model.
CREATE TABLE "AiUsageMonthly" (
    "tenantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputUnits" INTEGER NOT NULL DEFAULT 0,
    "outputUnits" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageMonthly_pkey" PRIMARY KEY ("tenantId","month")
);

ALTER TABLE "AiUsageMonthly" ADD CONSTRAINT "AiUsageMonthly_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
