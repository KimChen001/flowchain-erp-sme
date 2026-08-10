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

async function seedQuotation(prisma, {
  rfqId,
  rfqLineIds,
  supplierId,
  status,
  currency = "CNY",
  coverage = "complete",
  quotedAmount = "10.0000",
}) {
  const quotationId = `quotation-${supplierId}`;
  await prisma.supplier.upsert({
    where: { id: supplierId },
    create: { id: supplierId, tenantId, code: supplierId.toUpperCase(), name: `Supplier ${supplierId}` },
    update: {},
  });
  await prisma.supplierQuotation.create({
    data: { id: quotationId, tenantId, rfqId, supplierId, supplierName: `Stale ${supplierId}`, status, quotedAmount, currency },
  });
  const selectedLineIds = coverage === "complete" ? rfqLineIds : rfqLineIds.slice(0, 1);
  await prisma.supplierQuotationRevision.create({
    data: {
      id: `revision-${supplierId}`,
      tenantId,
      quotationId,
      revisionNumber: 1,
      status,
      currency,
      quotedAmount,
      submittedAt: ["submitted", "shortlisted", "not_selected", "withdrawn"].includes(status) ? fixedNow : null,
      source: "internal_recording",
      lines: {
        create: selectedLineIds.map((rfqLineId, index) => ({
          id: `revision-${supplierId}-line-${index + 1}`,
          rfqLineId,
          skuSnapshot: `SKU-${index + 1}`,
          quantity: "1.0000",
          unit: "EA",
          unitPrice: index === 0 ? "4.0000" : "6.0000",
          amount: index === 0 ? "4.0000" : "6.0000",
        })),
      },
    },
  });
}

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
      { id: "supplier-participation-planned", tenantId, code: "PART-PLAN", name: "Participation Planned" },
      { id: "supplier-participation-invited", tenantId, code: "PART-INV", name: "Participation Invited" },
      { id: "supplier-participation-declined", tenantId, code: "PART-DEC", name: "Participation Declined" },
      { id: "supplier-participation-withdrawn", tenantId, code: "PART-WD", name: "Participation Withdrawn" },
      { id: "supplier-participation-closed", tenantId, code: "PART-CLOSE", name: "Participation Closed" },
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
    for (const id of ["rfq-comparison-side", "rfq-comparison-single", "rfq-comparison-not-ready"]) {
      await prisma.rfq.create({
        data: {
          id,
          tenantId,
          title: id,
          status: "collecting_quotes",
          currency: "CNY",
          lines: { create: [
            { id: `${id}-line-1`, sku: `${id}-1`, itemName: `${id} Item 1`, quantity: "1.0000", unit: "EA" },
            { id: `${id}-line-2`, sku: `${id}-2`, itemName: `${id} Item 2`, quantity: "1.0000", unit: "EA" },
          ] },
        },
      });
    }
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

    const mainLineIds = ["rfq-comparison-line-1", "rfq-comparison-line-2"];
    for (const config of [
      { supplierId: "supplier-comparison-d", status: "draft", currency: "CNY", coverage: "complete" },
      { supplierId: "supplier-comparison-e", status: "withdrawn", currency: "CNY", coverage: "complete" },
      { supplierId: "supplier-comparison-f", status: "not_selected", currency: "CNY", coverage: "complete" },
      { supplierId: "supplier-comparison-g", status: "submitted", currency: "CNY", coverage: "partial" },
      { supplierId: "supplier-comparison-h", status: "shortlisted", currency: "USD", coverage: "complete", quotedAmount: "8.0000" },
    ]) {
      await seedQuotation(prisma, { rfqId: "rfq-comparison-main", rfqLineIds: mainLineIds, ...config });
    }
    for (const config of [
      { rfqId: "rfq-comparison-side", supplierId: "supplier-side-a", status: "submitted", currency: "CNY" },
      { rfqId: "rfq-comparison-side", supplierId: "supplier-side-b", status: "submitted", currency: "CNY" },
      { rfqId: "rfq-comparison-single", supplierId: "supplier-single", status: "submitted", currency: "CNY" },
      { rfqId: "rfq-comparison-not-ready", supplierId: "supplier-not-ready-draft", status: "draft", currency: "CNY" },
      { rfqId: "rfq-comparison-not-ready", supplierId: "supplier-not-ready-incomplete", status: "incomplete", currency: "CNY", coverage: "partial" },
    ]) {
      await seedQuotation(prisma, {
        ...config,
        rfqLineIds: [`${config.rfqId}-line-1`, `${config.rfqId}-line-2`],
      });
    }

    await prisma.rfqSupplierParticipation.createMany({ data: [
      { id: "participation-comparison-a", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-comparison-a", status: "response_recorded", respondedAt: fixedNow },
      { id: "participation-comparison-b", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-comparison-b", status: "response_recorded", respondedAt: fixedNow },
      { id: "participation-comparison-c", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-comparison-c", status: "planned" },
      { id: "participation-no-response-planned", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-participation-planned", status: "planned" },
      { id: "participation-no-response-invited", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-participation-invited", status: "invited_internal", invitedAt: new Date("2026-08-08T08:00:00.000Z") },
      { id: "participation-no-response-declined", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-participation-declined", status: "declined" },
      { id: "participation-no-response-withdrawn", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-participation-withdrawn", status: "withdrawn", withdrawnAt: new Date("2026-08-08T09:00:00.000Z") },
      { id: "participation-no-response-closed", tenantId, rfqId: "rfq-comparison-main", supplierId: "supplier-participation-closed", status: "closed" },
      { id: "participation-other-tenant", tenantId: otherTenantId, rfqId: "rfq-comparison-other", supplierId: "supplier-comparison-other", status: "invited_internal" },
    ] });
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
      assert.equal(comparison.participationAuthority, "authoritative");
      assert.equal(comparison.invitationDeliveryAuthority, "unavailable");
      assert.equal(comparison.externalSupplierIdentityAuthority, "unavailable");
      assert.deepEqual(comparison.currencies, ["CNY", "USD"]);
      assert.deepEqual(comparison.lines.map((line) => line.requestedQuantity), ["1.0000", "1.0000"]);
      assert.deepEqual(comparison.responses.map((response) => response.supplierId), [
        "supplier-comparison-a",
        "supplier-comparison-b",
        "supplier-comparison-c",
        "supplier-comparison-d",
        "supplier-comparison-e",
        "supplier-comparison-f",
        "supplier-comparison-g",
        "supplier-comparison-h",
      ]);

      const bySupplier = new Map(comparison.responses.map((response) => [response.supplierId, response]));

      const responseA = bySupplier.get("supplier-comparison-a");
      assert.equal(responseA.supplierName, "Comparison Supplier A");
      assert.equal(responseA.latestRevision.revisionNumber, 2);
      assert.equal(responseA.latestRevision.quotedAmount, "12345678901234.5679");
      assert.deepEqual(responseA.latestRevision.lines.map((line) => line.amount), ["12345678901234.5678", "0.0001"]);
      assert.equal(responseA.coverage.state, "complete");
      assert.equal(responseA.coverage.matchedLineCount, 2);
      assert.equal(responseA.comparisonEligibility, "eligible");
      assert.deepEqual(responseA.eligibilityReasons, []);

      const responseB = bySupplier.get("supplier-comparison-b");
      assert.equal(responseB.latestRevision.status, "incomplete");
      assert.equal(responseB.coverage.state, "partial");
      assert.deepEqual(responseB.coverage.missingRfqLineIds, ["rfq-comparison-line-2"]);
      assert.equal(responseB.comparisonEligibility, "not_ready");
      assert.deepEqual(responseB.eligibilityReasons, ["revision_status_incomplete"]);

      const responseC = bySupplier.get("supplier-comparison-c");
      assert.equal(responseC.authorityState, "revision_missing");
      assert.equal(responseC.latestRevision, null);
      assert.equal(responseC.coverage.state, "none");
      assert.equal(responseC.comparisonEligibility, "authority_missing");
      assert.deepEqual(responseC.eligibilityReasons, ["authoritative_revision_missing"]);

      assert.equal(bySupplier.get("supplier-comparison-d").comparisonEligibility, "not_ready");
      assert.deepEqual(bySupplier.get("supplier-comparison-d").eligibilityReasons, ["revision_status_draft"]);
      assert.equal(bySupplier.get("supplier-comparison-e").comparisonEligibility, "withdrawn");
      assert.equal(bySupplier.get("supplier-comparison-f").comparisonEligibility, "historical_only");
      assert.equal(bySupplier.get("supplier-comparison-g").comparisonEligibility, "incomplete_coverage");
      assert.deepEqual(bySupplier.get("supplier-comparison-g").eligibilityReasons, ["rfq_line_coverage_partial"]);
      const shortlisted = bySupplier.get("supplier-comparison-h");
      assert.equal(shortlisted.latestRevision.status, "shortlisted");
      assert.equal(shortlisted.latestRevision.currency, "USD");
      assert.equal(shortlisted.latestRevision.quotedAmount, "8.0000");
      assert.equal(shortlisted.comparisonEligibility, "eligible");

      assert.deepEqual(comparison.summary, {
        quotationCount: 8,
        authoritativeResponseCount: 7,
        submittedResponseCount: 2,
        completeCoverageCount: 5,
        eligibleResponseCount: 2,
      });
      assert.deepEqual(comparison.participationSummary, {
        participantCount: 8,
        plannedCount: 2,
        invitedInternalCount: 1,
        responseRecordedCount: 2,
        noResponseCount: 5,
        declinedCount: 1,
        withdrawnCount: 1,
        closedCount: 1,
      });
      assert.deepEqual(comparison.nonResponseParticipants.map((participant) => participant.supplierId), [
        "supplier-participation-closed",
        "supplier-participation-declined",
        "supplier-participation-invited",
        "supplier-participation-planned",
        "supplier-participation-withdrawn",
      ]);
      assert.equal(comparison.nonResponseParticipants.find((participant) => participant.supplierId === "supplier-participation-invited").invitedAt, "2026-08-08T08:00:00.000Z");
      assert.equal(comparison.nonResponseParticipants.find((participant) => participant.supplierId === "supplier-participation-declined").status, "declined");
      assert.equal(comparison.nonResponseParticipants.some((participant) => participant.supplierId === "supplier-comparison-other"), false);
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
      assert.equal(comparison.comparisonAvailability, "no_eligible_responses");
      assert.deepEqual(comparison.responses, []);
      assert.deepEqual(comparison.currencies, []);
      assert.equal(comparison.summary.quotationCount, 0);
      assert.equal(comparison.summary.eligibleResponseCount, 0);
      assert.equal(comparison.participationSummary.participantCount, 0);
      assert.deepEqual(comparison.nonResponseParticipants, []);
    });

    await t.test("availability counts only active eligible responses", async () => {
      const sideBySide = await service.getComparison("rfq-comparison-side", { identity });
      assert.equal(sideBySide.comparisonAvailability, "side_by_side_available");
      assert.equal(sideBySide.summary.eligibleResponseCount, 2);
      assert.deepEqual(sideBySide.currencies, ["CNY"]);

      const single = await service.getComparison("rfq-comparison-single", { identity });
      assert.equal(single.comparisonAvailability, "single_eligible_response");
      assert.equal(single.summary.eligibleResponseCount, 1);

      const notReady = await service.getComparison("rfq-comparison-not-ready", { identity });
      assert.equal(notReady.comparisonAvailability, "no_eligible_responses");
      assert.equal(notReady.summary.eligibleResponseCount, 0);
      assert.deepEqual(notReady.responses.map((response) => response.comparisonEligibility), ["not_ready", "not_ready"]);
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
