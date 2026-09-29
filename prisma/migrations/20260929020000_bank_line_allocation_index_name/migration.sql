-- PostgreSQL truncated both the ("tenantId", "bankStatementLineId") index and the
-- foreign key on the same columns to the same 63-character name. Prisma cannot
-- declare two objects with one name, so give the index Prisma's default name.
ALTER INDEX "BankReconciliationBankLineAllocation_tenantId_bankStatementLine"
  RENAME TO "BankReconciliationBankLineAllocation_tenantId_bankStatement_idx";
