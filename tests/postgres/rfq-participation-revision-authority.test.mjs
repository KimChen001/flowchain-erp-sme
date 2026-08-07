import assert from "node:assert/strict";
import test from "node:test";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";
import { createDbProcurementReadRepository } from "../../server/repositories/db-procurement-read-repository.mjs";

const tenantId = "tenant-rfq-revision-authority";

test("real PostgreSQL RFQ participation and append-only revision authority", async () => {
  const prisma = await createPrismaClient(process.env);
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: "RFQ Revision Authority" } });
    await prisma.supplier.createMany({ data: [
      { id: "supplier-rfq-response", tenantId, code: "RFQ-RESPONSE", name: "Response Supplier" },
      { id: "supplier-rfq-no-response", tenantId, code: "RFQ-NO-RESPONSE", name: "No Response Supplier" },
      { id: "supplier-rfq-planned", tenantId, code: "RFQ-PLANNED", name: "Planned Supplier" },
      { id: "supplier-rfq-declined", tenantId, code: "RFQ-DECLINED", name: "Declined Supplier" },
      { id: "supplier-rfq-withdrawn", tenantId, code: "RFQ-WITHDRAWN", name: "Withdrawn Supplier" },
    ] });
    await prisma.rfq.create({ data: { id: "rfq-revision-authority", tenantId, title: "Revision Authority RFQ", status: "collecting_quotes", currency: "CNY", lines: { create: { id: "rfq-revision-line", sku: "REV-SKU", itemName: "Revision Item", quantity: "2.0000", unit: "EA" } } } });
    await prisma.supplierQuotation.create({ data: { id: "quotation-revision-authority", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-response", supplierName: "Response Supplier", status: "submitted", quotedAmount: "20.0000", currency: "CNY", lines: { create: { id: "legacy-quotation-line", sku: "REV-SKU", itemName: "Revision Item", quantity: "2.0000", unit: "EA", unitPrice: "10.0000", amount: "20.0000" } } } });
    await prisma.rfqSupplierParticipation.createMany({ data: [
      { id: "participation-response", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-response", status: "response_recorded", respondedAt: new Date("2026-07-27T09:00:00Z") },
      { id: "participation-no-response", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-no-response", status: "invited_internal", invitedAt: new Date("2026-07-27T08:00:00Z") },
      { id: "participation-planned", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-planned", status: "planned" },
      { id: "participation-declined", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-declined", status: "declined", invitedAt: new Date("2026-07-27T07:00:00Z") },
      { id: "participation-withdrawn", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-withdrawn", status: "withdrawn", invitedAt: new Date("2026-07-27T06:00:00Z"), withdrawnAt: new Date("2026-07-27T10:00:00Z") },
    ] });
    await prisma.supplierQuotationRevision.create({ data: { id: "revision-two", tenantId, quotationId: "quotation-revision-authority", revisionNumber: 2, status: "submitted", currency: "CNY", quotedAmount: "19.5000", source: "internal_recording", lines: { create: { id: "revision-line-two", rfqLineId: "rfq-revision-line", sourceQuotationLineId: "legacy-quotation-line", skuSnapshot: "REV-SKU", itemNameSnapshot: "Revision Item", quantity: "2.0000", unit: "EA", unitPrice: "9.7500", amount: "19.5000" } } } });
    await prisma.supplierQuotationRevision.create({ data: { id: "revision-one", tenantId, quotationId: "quotation-revision-authority", revisionNumber: 1, status: "submitted", currency: "CNY", quotedAmount: "20.0000", source: "internal_recording" } });

    const repository = createDbProcurementReadRepository({ env: process.env, prisma });
    const detail = await repository.getDocument("rfq", "rfq-revision-authority", { tenantId });
    assert.equal(detail.suppliers.participantCount, 5);
    assert.equal(detail.suppliers.responseRecordedCount, 1);
    assert.equal(detail.suppliers.noResponseCount, 2);
    assert.equal(detail.suppliers.invitedInternalCount, 3);
    assert.equal(detail.suppliers.participationAuthority, "authoritative");
    assert.equal(detail.suppliers.invitationDeliveryAuthority, "unavailable");
    assert.equal(detail.suppliers.externalSupplierIdentityAuthority, "unavailable");
    assert.equal(detail.suppliers.knownParticipants.find((item) => item.supplierId === "supplier-rfq-no-response").responseState, "no_response");
    assert.equal(detail.quotations[0].latestRevision.revisionNumber, 2);
    assert.deepEqual(detail.quotations[0].revisions.map((revision) => revision.revisionNumber), [2, 1]);
    assert.equal(detail.quotations[0].latestRevision.lines[0].unitPrice, 9.75);

    await assert.rejects(() => prisma.supplierQuotationRevision.update({ where: { id: "revision-two" }, data: { quotedAmount: "1.0000" } }), /append-only/);
    await assert.rejects(() => prisma.supplierQuotationRevisionLine.delete({ where: { id: "revision-line-two" } }), /append-only/);
    await prisma.supplierQuotationRevision.create({ data: { id: "revision-three", tenantId, quotationId: "quotation-revision-authority", revisionNumber: 3, status: "submitted", currency: "CNY", quotedAmount: "19.0000", source: "internal_recording" } });
    assert.equal(await prisma.supplierQuotationRevision.count({ where: { tenantId, quotationId: "quotation-revision-authority" } }), 3);

    await prisma.tenant.create({ data: { id: "tenant-rfq-revision-other", name: "Other RFQ Tenant" } });
    await prisma.supplier.create({ data: { id: "supplier-rfq-other", tenantId: "tenant-rfq-revision-other", code: "RFQ-OTHER", name: "Other Supplier" } });
    await prisma.rfq.create({ data: { id: "rfq-revision-authority-other", tenantId: "tenant-rfq-revision-other", title: "Other Tenant RFQ", status: "collecting_quotes" } });
    await prisma.supplierQuotation.create({ data: { id: "quotation-other-tenant", tenantId: "tenant-rfq-revision-other", rfqId: "rfq-revision-authority-other", supplierId: "supplier-rfq-other", status: "submitted" } });
    await assert.rejects(() => prisma.rfqSupplierParticipation.create({ data: { id: "participation-cross-tenant", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-other", status: "planned" } }));
    await assert.rejects(() => prisma.supplierQuotation.create({ data: { id: "quotation-cross-tenant-supplier", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-other", status: "submitted" } }));
    await assert.rejects(() => prisma.supplierQuotation.create({ data: { id: "quotation-null-rfq", tenantId, rfqId: null, supplierId: "supplier-rfq-response", status: "submitted" } }));
    await assert.rejects(() => prisma.supplierQuotation.create({ data: { id: "quotation-null-supplier", tenantId, rfqId: "rfq-revision-authority", supplierId: null, status: "submitted" } }));
    await assert.rejects(() => prisma.supplierQuotation.create({ data: { id: "quotation-duplicate", tenantId, rfqId: "rfq-revision-authority", supplierId: "supplier-rfq-response", supplierName: "Response Supplier", status: "submitted" } }));
    await assert.rejects(() => prisma.supplierQuotationRevisionLine.create({ data: { id: "revision-line-duplicate", tenantId, revisionId: "revision-two", rfqLineId: "rfq-revision-line", quantity: "1.0000", unitPrice: "1.0000", amount: "1.0000" } }));

    await prisma.rfq.create({ data: { id: "rfq-revision-same-tenant-other", tenantId, title: "Same Tenant Other RFQ", status: "collecting_quotes", lines: { create: { id: "rfq-line-same-tenant-other", sku: "OTHER-SKU" } } } });
    await prisma.supplierQuotation.create({ data: { id: "quotation-same-supplier-other-rfq", tenantId, rfqId: "rfq-revision-same-tenant-other", supplierId: "supplier-rfq-response", status: "submitted" } });
    assert.equal(await prisma.supplierQuotation.count({ where: { tenantId, supplierId: "supplier-rfq-response" } }), 2);

    // The database enforces tenant identity; the future append command must enforce same-RFQ line identity.
    await prisma.supplierQuotationRevisionLine.create({ data: { id: "revision-line-same-tenant-other-rfq", tenantId, revisionId: "revision-one", rfqLineId: "rfq-line-same-tenant-other", quantity: "1.0000", unitPrice: "1.0000", amount: "1.0000" } });
    assert.equal(await prisma.supplierQuotationRevisionLine.count({ where: { id: "revision-line-same-tenant-other-rfq" } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});
