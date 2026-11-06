-- Duplicate supplier invoice checks (docs/bills-invoices-and-accounting-handoff.md).
-- The exact invoice number stays unique per supplier through
-- SupplierInvoice_tenant_supplier_number_key (20261002010000). Numbers that
-- differ only in format, and same-amount bills dated close together, are
-- flagged when the bill is read and approved; the approver dismisses a flag
-- with a reason, kept here, or cancels the bill. Nothing is held on its own.

CREATE TABLE "SupplierInvoiceDuplicateReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierInvoiceId" TEXT NOT NULL,
    "otherInvoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "basis" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierInvoiceDuplicateReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupplierInvoiceDuplicateReview_kind_check" CHECK ("kind" IN ('likely', 'possible')),
    CONSTRAINT "SupplierInvoiceDuplicateReview_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
    CONSTRAINT "SupplierInvoiceDuplicateReview_other_check" CHECK ("otherInvoiceId" <> "supplierInvoiceId")
);

CREATE INDEX "SupplierInvoiceDuplicateReview_tenantId_supplierInvoiceId_idx" ON "SupplierInvoiceDuplicateReview"("tenantId", "supplierInvoiceId");
CREATE INDEX "SupplierInvoiceDuplicateReview_otherInvoiceId_idx" ON "SupplierInvoiceDuplicateReview"("otherInvoiceId");

ALTER TABLE "SupplierInvoiceDuplicateReview" ADD CONSTRAINT "SupplierInvoiceDuplicateReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierInvoiceDuplicateReview" ADD CONSTRAINT "SupplierInvoiceDuplicateReview_supplierInvoiceId_fkey" FOREIGN KEY ("supplierInvoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierInvoiceDuplicateReview" ADD CONSTRAINT "SupplierInvoiceDuplicateReview_otherInvoiceId_fkey" FOREIGN KEY ("otherInvoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The same-amount check reads a supplier's bills of one currency by date.
CREATE INDEX "SupplierInvoice_tenantId_supplierId_currency_invoiceDate_idx" ON "SupplierInvoice"("tenantId", "supplierId", "currency", "invoiceDate");
