-- A cancelled supplier invoice keeps its number on record, but the number no
-- longer blocks the supplier's corrected invoice: the per-supplier unique
-- invoice number now applies to invoices that are not cancelled.
DROP INDEX IF EXISTS "SupplierInvoice_tenant_supplier_number_key";
CREATE UNIQUE INDEX "SupplierInvoice_tenant_supplier_number_key"
  ON "SupplierInvoice"("tenantId", "supplierId", "invoiceNumber")
  WHERE "invoiceNumber" IS NOT NULL AND "status" <> 'cancelled';
