import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../../server/auth/authorization-backfill.mjs";
import { createRfqSupplierComparisonService } from "../../server/domain/rfq-supplier-comparison-service.mjs";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";

const tenantId = "tenant-rfq-comparison";
const otherTenantId = "tenant-rfq-comparison-other";
const actorId = "user-rfq-comparison-admin";
const identity = { authenticated: true, tenantId, userId: actorId, role: "admin", source: "test" };
const fixedNow = new Date("2026-08-08T12:00:00.000Z");

test("real PostgreSQL RFQ Supplier Comparison read authority", async (t) => {
  const prisma = await createPrismaClient(process.env);
  const service = createRfqSupplierComparisonService({ prisma, now: () => new Date(fixedNow) });
  try {
    await prisma.tenant.createMany({ data: [
      { id: tenantId, name: "RFQ Comparison" },
      { id: otherTenantId, name: "RFQ Comparison Other" },
    ] });
    await prisma.user.createMany({ data: [
      { id: actorId, tenantId, email: "admin@rfq-comparison.invalid", name: "Comparison Admin", role: "admin", status: "active" },
      { id: "user-rfq-comparison-viewer", tenantId, email: "viewer@rfq-comparison.invalid", name: "Comparison Viewer", role: "viewer", status: "active" },
    ] });
    await backfillTenantAuthorization(prisma, tenantId, { actorId, requestId: "rfq-comparison-gate" });
    await prisma.supplier.createMany({ data: [
      { id: "supplier-comparison-a", tenantId, code: "CMP-A", name: "Comparison Supplier A" },
      { id: "supplier-comparison-b", tenantId, code: "CMP-B", name: "Comparison Supplier B" },
      { id: "supplier-comparison-c", tenantId, code: "CMP-C", name: "Comparison Supplier C" },
      { id: "supplier-comparison-other", tenantId: otherTenantId, code: "CMP-OTHER", name: "Other Supplier" },
    ] });
    await prisma.rfq.create({
      data: {
        id: "rfq-comparison-main",
        tenantId,
        title: "Comparison Main",
        status: "collecting_quotes",
        currency: "CNY",
        lines: { create: [
          { id: "rfq-comparison-line-1", sku: "CMP-1", itemName: "Comparison Item 1", quantity: "1.0000", unit: "EA" },
          { id: "rfq-comparison-line-2", sku: "CMP-2", itemName: "Comparison Item 2", quantity: "1.0000", unit: "EA" },
        ] },
      },
    });
    await prisma.rfq.createMany({ data: [
      { id: "rfq-comparison-empty", tenantId, title: "Comparison Empty", status: "open", currency: "CNY" },
      { id: "rfq-comparison-other", tenantId: otherTenantId, title: "Comparison Other", status: "open", currency: "CNY" },
    ] });
    await prisma.supplierQuotation.createMany({ data: [
      { id: "quotation-comparison-a", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-comparison-a", supplierName: "Stale Supplier A", status: "draft", quotedAmount: "1.0000", currency: "EUR" },
      { id: "quotation-comparison-b", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-comparison-b", supplierName: "Comparison Supplier B", status: "submitted", quotedAmount: "999.0000", currency: "CNY" },
      { id: "quotation-comparison-c", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-comparison-c", supplierName: "Comparison Supplier C", status: "submitted", quotedAmount: "50.0000", currency: "CNY" },
      { id: "quotation-comparison-other", tenantId: otherTenantId, rfqId: "rfq-comparison-other", supplierId: "supplier-comparison-other", supplierName: "Other Supplier", status: "submitted", quotedAmount: "1.0000", currency: "CNY" },
    ] });
    await prisma.supplierQuotationRevision.create({
      data: {
        id: "revision-comparison-a-1",
        tenantId,
        quotationId: "quotation-comparison-a",
        revisionNumber: 1,
        status: "submitted",
        currency: "CNY",
        quotedAmount: "2.0000",
        source: "internal_recording",
        createdAt: new Date("2026-08-08T11:00:00.000Z"),
      },
    });
    await prisma.supplierQuotationRevision.create({
      data: {
        id: "revision-comparison-a-2",
        tenantId,
        quotationId: "quotation-comparison-a",
        revisionNumber: 2,
        status: "submitted",
        currency: "CNY",
        quotedAmount: "12345678901234.5679",
        submittedAt: new Date("2026-08-08T10:00:00.000Z"),
        source: "internal_recording",
        createdAt: new Date("2026-08-08T09:00:00.000Z"),
        lines: { create: [
          { id: "revision-comparison-a-2-line-1", rfqLineId: "rfq-comparison-line-1", skuSnapshot: "CMP-1", quantity: "1.0000", unit: "EA", unitPrice: "12345678901234.5678", amount: "12345678901234.5678" },
          { id: "revision-comparison-a-2-line-2", rfqLineId: "rfq-comparison-line-2", skuSnapshot: "CMP-2", quantity: "1.0000", unit: "EA", unitPrice: "0.0001", amount: "0.0001" },
        ] },
      },
    });
    await prisma.supplierQuotationRevision.create({
      data: {
        id: "revision-comparison-b-1",
        tenantId,
        quotationId: "quotation-comparison-b",
        revisionNumber: 1,
        status: "incomplete",
        currency: "USD",
        quotedAmount: "10.0000",
        source: "internal_recording",
        lines: { create: {
          id: "revision-comparison-b-1-line-1",
          rfqLineId: "rfq-comparison-line-1",
          skuSnapshot: "CMP-1",
          quantity: "1.0000",
          unit: "EA",
          unitPrice: "10.0000",
          amount: "10.0000",
        } },
      },
    });

    await t.test("latest revisions are compared without float loss, ranking, or stale parent fallback", async () => {
      const before = {
        audit: await prisma.auditLog.count(),
        feed: await prisma.domainChangeFeed.count(),
        commands: await prisma.businessCommandExecution.count(),
      };
      const comparison = await service.getComparison("rfq-comparison-main", { identity });
      assert.equal(comparison.generatedAt, fixedNow.toISOString());
      assert.equal(comparison.comparisonAvailability, "multi_currency_unconverted");
      assert.equal(comparison.commercialAuthority, "supplier_quotation_revision_max_revision_number");
      assert.equal(comparison.rankingAuthority, "unavailable");
      assert.equal(comparison.recommendationAuthority, "unavailable");
      assert.equal(comparison.awardAuthority, "unavailable");
      assert.equal(comparison.poConversionAuthority, "unavailable");
      assert.deepEqual(comparison.currencies, ["CNY", "USD"]);
      assert.deepEqual(comparison.lines.map((line) => line.requestedQuantity), ["1.0000", "1.0000"]);
      assert.deepEqual(comparison.responses.map((response) => response.supplierId), ["supplier-comparison-a", "supplier-comparison-b", "supplier-comparison-c"]);

      const responseA = comparison.responses[0];
      assert.equal(responseA.supplierName, "Comparison Supplier A");
      assert.equal(responseA.latestRevision.revisionNumber, 2);
      assert.equal(responseA.latestRevision.quotedAmount, "12345678901234.5679");
      assert.deepEqual(responseA.latestRevision.lines.map((line) => line.amount), ["12345678901234.5678", "0.0001"]);
      assert.equal(responseA.coverage.state, "complete");
      assert.equal(responseA.coverage.matchedLineCount, 2);

      const responseB = comparison.responses[1];
      assert.equal(responseB.latestRevision.status, "incomplete");
      assert.equal(responseB.coverage.state, "partial");
      assert.deepEqual(responseB.coverage.missingRfqLineIds, ["rfq-comparison-line-2"]);

      const responseC = comparison.responses[2];
      assert.equal(responseC.authorityState, "revision_missing");
      assert.equal(responseC.latestRevision, null);
      assert.equal(responseC.coverage.state, "none");
      assert.deepEqual(comparison.summary, {
        quotationCount: 3,
        authoritativeResponseCount: 2,
        submittedResponseCount: 1,
        completeCoverageCount: 1,
      });
      for (const response of comparison.responses) {
        for (const forbidden of ["score", "rank", "recommendation", "award", "poDraft"]) {
          assert.equal(Object.hasOwn(response, forbidden), false, forbidden);
        }
      }
      assert.deepEqual({
        audit: await prisma.auditLog.count(),
        feed: await prisma.domainChangeFeed.count(),
        commands: await prisma.businessCommandExecution.count(),
      }, before);
    });

    await t.test("empty comparison remains truthful", async () => {
      const comparison = await service.getComparison("rfq-comparison-empty", { identity });
      assert.equal(comparison.comparisonAvailability, "no_authoritative_responses");
      assert.deepEqual(comparison.responses, []);
      assert.deepEqual(comparison.currencies, []);
      assert.equal(comparison.summary.quotationCount, 0);
    });

    await t.test("permission and tenant isolation fail closed", async () => {
      await assert.rejects(
        () => service.getComparison("rfq-comparison-main", { identity: { authenticated: true, tenantId, userId: "user-rfq-comparison-viewer", role: "viewer", source: "test" } }),
        (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED" && error.status === 403,
      );
      await assert.rejects(
        () => service.getComparison("rfq-comparison-other", { identity }),
        (error) => error.code === "RFQ_NOT_FOUND" && error.status === 404,
      );
      await assert.rejects(
        () => service.getComparison("rfq-comparison-main", { identity: { authenticated: false } }),
        (error) => error.code === "AUTHENTICATION_REQUIRED" && error.status === 401,
      );
    });
  } finally {
    await prisma.$disconnect();
  }
});
