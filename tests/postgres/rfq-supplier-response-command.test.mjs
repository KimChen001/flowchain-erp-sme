import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../../server/auth/authorization-backfill.mjs";
import {
  RfqSupplierResponseCommandError,
  createRfqSupplierResponseCommandService,
} from "../../server/domain/rfq-supplier-response-command-service.mjs";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";
import { createDbProcurementReadRepository } from "../../server/repositories/db-procurement-read-repository.mjs";

const tenantId = "tenant-rfq-response-command";
const otherTenantId = "tenant-rfq-response-command-other";
const actorId = "user-rfq-response-command";
const fixedNow = new Date("2026-07-29T10:00:00.000Z");
const identity = { authenticated: true, tenantId, userId: actorId, role: "admin", source: "test" };
const context = { identity };
const decimal = (value) => value?.toFixed(4);

function responseInput({
  key,
  supplierId,
  expectedVersion = 0,
  submissionMode = "submitted",
  lines = [
    { rfqLineId: "rfq-command-line-1", quantity: "3.3333", unitPrice: "0.3000" },
    { rfqLineId: "rfq-command-line-2", quantity: "2.0000", unitPrice: "4.5678" },
  ],
} = {}) {
  return {
    idempotencyKey: key,
    expectedVersion,
    supplierId,
    submissionMode,
    currency: "CNY",
    submittedAt: null,
    validUntil: "2026-08-31T00:00:00.000Z",
    deliveryDate: "2026-08-15T00:00:00.000Z",
    paymentTerms: "NET30",
    lines,
  };
}

async function expectCommandError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof RfqSupplierResponseCommandError || error?.name === "AuthorizationError", true);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

test("real PostgreSQL RFQ Supplier Response command kernel", async (t) => {
  const prisma = await createPrismaClient(process.env);
  const service = createRfqSupplierResponseCommandService({ prisma, now: () => new Date(fixedNow) });
  try {
    await prisma.tenant.createMany({ data: [
      { id: tenantId, name: "RFQ Response Command" },
      { id: otherTenantId, name: "RFQ Response Command Other" },
    ] });
    await prisma.user.createMany({ data: [
      { id: actorId, tenantId, email: "rfq-command@flowchain.invalid", name: "RFQ Command", role: "admin", status: "active" },
      { id: "user-rfq-response-viewer", tenantId, email: "rfq-viewer@flowchain.invalid", name: "RFQ Viewer", role: "viewer", status: "active" },
    ] });
    await backfillTenantAuthorization(prisma, tenantId, { actorId, requestId: "rfq-command-gate" });

    const supplierIds = [
      "supplier-command-main",
      "supplier-command-draft",
      "supplier-command-wrong-line",
      "supplier-command-duplicate-line",
      "supplier-command-incomplete",
      "supplier-command-closed",
      "supplier-command-cancelled",
      "supplier-command-draft-rfq",
      "supplier-command-unknown-rfq",
      "supplier-command-declined",
      "supplier-command-withdrawn",
      "supplier-command-cross-rfq",
      "supplier-command-denied",
      "supplier-command-fault-participation",
      "supplier-command-fault-revision",
      "supplier-command-fault-audit",
      "supplier-command-fault-completion",
    ];
    await prisma.supplier.createMany({ data: supplierIds.map((id) => ({ id, tenantId, code: id.toUpperCase(), name: id })) });
    await prisma.supplier.create({ data: { id: "supplier-command-other-tenant", tenantId: otherTenantId, code: "OTHER", name: "Other Tenant Supplier" } });

    await prisma.rfq.create({
      data: {
        id: "rfq-command-main",
        tenantId,
        title: "RFQ Command Main",
        status: "collecting_quotes",
        currency: "CNY",
        lines: { create: [
          { id: "rfq-command-line-1", sku: "SKU-1", itemName: "Item 1", quantity: "3.3333", unit: "EA" },
          { id: "rfq-command-line-2", sku: "SKU-2", itemName: "Item 2", quantity: "2.0000", unit: "EA" },
        ] },
      },
    });
    await prisma.rfq.create({ data: { id: "rfq-command-other", tenantId, title: "Other RFQ", status: "open", lines: { create: { id: "rfq-command-other-line", sku: "OTHER" } } } });
    await prisma.rfq.createMany({ data: [
      { id: "rfq-command-closed", tenantId, title: "Closed RFQ", status: "closed" },
      { id: "rfq-command-cancelled", tenantId, title: "Cancelled RFQ", status: "cancelled" },
      { id: "rfq-command-draft", tenantId, title: "Draft RFQ", status: "draft" },
      { id: "rfq-command-unknown", tenantId, title: "Unknown RFQ", status: "legacy_unknown" },
      { id: "rfq-command-other-tenant", tenantId: otherTenantId, title: "Other Tenant RFQ", status: "open" },
    ] });

    await t.test("initial response commits participation, revision authority, audit, feed, and command result atomically", async () => {
      const input = responseInput({ key: "initial-main", supplierId: "supplier-command-main" });
      const result = await service.recordInitialResponse("rfq-command-main", input, context);
      assert.equal(result.entityVersion, 1);
      assert.equal(result.revisionNumber, 1);
      assert.equal(result.idempotentReplay, false);
      assert.equal(result.status, "submitted");
      assert.equal(result.quotedAmount, "10.1356");

      const [participation, quotation, revision, execution, audit, feed] = await Promise.all([
        prisma.rfqSupplierParticipation.findUnique({ where: { tenantId_rfqId_supplierId: { tenantId, rfqId: "rfq-command-main", supplierId: "supplier-command-main" } } }),
        prisma.supplierQuotation.findUnique({ where: { id: result.quotationId } }),
        prisma.supplierQuotationRevision.findUnique({ where: { id: result.revisionId }, include: { lines: { orderBy: { rfqLineId: "asc" } } } }),
        prisma.businessCommandExecution.findUnique({ where: { tenantId_commandType_idempotencyKey: { tenantId, commandType: "procurement.rfq_response.create", idempotencyKey: "initial-main" } } }),
        prisma.auditLog.findFirst({ where: { tenantId, source: "rfq_supplier_response_command_service", entityId: result.quotationId } }),
        prisma.domainChangeFeed.findFirst({ where: { tenantId, source: "rfq_supplier_response_command_service", entityId: result.quotationId } }),
      ]);
      assert.equal(participation.status, "response_recorded");
      assert.equal(participation.invitedAt, null);
      assert.equal(participation.version, 0);
      assert.equal(quotation.status, "submitted");
      assert.equal(decimal(quotation.quotedAmount), "10.1356");
      assert.equal(quotation.metadata.currentRevisionNumber, 1);
      assert.equal(revision.lines.length, 2);
      assert.deepEqual(revision.lines.map((line) => decimal(line.amount)), ["1.0000", "9.1356"]);
      assert.equal(decimal(revision.quotedAmount), "10.1356");
      assert.equal(execution.status, "completed");
      assert.equal(execution.resultPayload.revisionNumber, 1);
      assert.equal(audit.actorId, actorId);
      assert.equal(audit.metadata.submissionMode, "submitted");
      assert.equal(feed.entityVersion, 1);
      assert.equal(feed.moduleKey, "procurement");
      assert.equal(feed.authorizationClass, "procurement.prices.read");
      assert.equal(feed.resourceTenantId, tenantId);

      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "initial-main-duplicate", supplierId: "supplier-command-main" }), context),
        "RFQ_RESPONSE_AGGREGATE_EXISTS",
        409,
      );
    });

    await t.test("append creates Revision 2 and preserves Revision 1", async () => {
      const quotation = await prisma.supplierQuotation.findUnique({ where: { tenantId_rfqId_supplierId: { tenantId, rfqId: "rfq-command-main", supplierId: "supplier-command-main" } } });
      const before = await prisma.supplierQuotationRevision.findFirst({ where: { tenantId, quotationId: quotation.id, revisionNumber: 1 }, include: { lines: { orderBy: { rfqLineId: "asc" } } } });
      const snapshot = JSON.stringify(before);
      const input = responseInput({
        key: "append-main-2",
        supplierId: "supplier-command-main",
        expectedVersion: 1,
        submissionMode: "draft",
        lines: [
          { rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "2.0000" },
          { rfqLineId: "rfq-command-line-2", quantity: "1.0000", unitPrice: "3.0000" },
        ],
      });
      const result = await service.appendRevision("rfq-command-main", "supplier-command-main", input, context);
      assert.equal(result.entityVersion, 2);
      assert.equal(result.revisionNumber, 2);
      assert.equal(result.status, "draft");
      assert.equal(result.quotedAmount, "5.0000");
      const unchanged = await prisma.supplierQuotationRevision.findUnique({ where: { id: before.id }, include: { lines: { orderBy: { rfqLineId: "asc" } } } });
      assert.equal(JSON.stringify(unchanged), snapshot);
      assert.equal(await prisma.supplierQuotationRevision.count({ where: { tenantId, quotationId: quotation.id } }), 2);
    });

    await t.test("idempotent replay returns the committed result and payload mismatch conflicts", async () => {
      const same = responseInput({
        key: "append-main-2",
        supplierId: "supplier-command-main",
        expectedVersion: 1,
        submissionMode: "draft",
        lines: [
          { rfqLineId: "rfq-command-line-2", quantity: "1.0000", unitPrice: "3.0000" },
          { rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "2.0000" },
        ],
      });
      const replay = await service.appendRevision("rfq-command-main", "supplier-command-main", same, context);
      assert.equal(replay.revisionNumber, 2);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(await prisma.supplierQuotationRevision.count({ where: { tenantId, quotationId: replay.quotationId } }), 2);

      const different = { ...same, paymentTerms: "NET45" };
      await expectCommandError(
        service.appendRevision("rfq-command-main", "supplier-command-main", different, context),
        "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        409,
      );
    });

    await t.test("stale and concurrent appends return stable conflicts with one next revision", async () => {
      await expectCommandError(
        service.appendRevision("rfq-command-main", "supplier-command-main", responseInput({ key: "append-stale", supplierId: "supplier-command-main", expectedVersion: 1 }), context),
        "RFQ_RESPONSE_VERSION_CONFLICT",
        409,
      );
      const append = (key, price) => service.appendRevision(
        "rfq-command-main",
        "supplier-command-main",
        responseInput({
          key,
          supplierId: "supplier-command-main",
          expectedVersion: 2,
          lines: [
            { rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: price },
            { rfqLineId: "rfq-command-line-2", quantity: "1.0000", unitPrice: "1.0000" },
          ],
        }),
        context,
      );
      const settled = await Promise.allSettled([append("append-race-a", "4.0000"), append("append-race-b", "5.0000")]);
      assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
      const loser = settled.find((item) => item.status === "rejected").reason;
      assert.ok(["RFQ_RESPONSE_VERSION_CONFLICT", "RFQ_RESPONSE_CONCURRENCY_CONFLICT"].includes(loser.code));
      const quotation = await prisma.supplierQuotation.findUnique({ where: { tenantId_rfqId_supplierId: { tenantId, rfqId: "rfq-command-main", supplierId: "supplier-command-main" } } });
      assert.equal(await prisma.supplierQuotationRevision.count({ where: { tenantId, quotationId: quotation.id, revisionNumber: 3 } }), 1);
    });

    await t.test("tenant, exact RFQ line, duplicate line, and submitted completeness checks fail closed", async () => {
      await expectCommandError(
        service.recordInitialResponse("rfq-command-other-tenant", responseInput({ key: "cross-tenant-rfq", supplierId: "supplier-command-cross-rfq", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_NOT_FOUND",
        404,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "cross-tenant-supplier", supplierId: "supplier-command-other-tenant" }), context),
        "SUPPLIER_NOT_FOUND",
        404,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "wrong-rfq-line", supplierId: "supplier-command-wrong-line", submissionMode: "draft", lines: [{ rfqLineId: "rfq-command-other-line", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_LINE_NOT_IN_RFQ",
        422,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "duplicate-rfq-line", supplierId: "supplier-command-duplicate-line", lines: [
          { rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" },
          { rfqLineId: "rfq-command-line-1", quantity: "2.0000", unitPrice: "2.0000" },
        ] }), context),
        "RFQ_RESPONSE_LINE_DUPLICATE",
        422,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "submitted-incomplete", supplierId: "supplier-command-incomplete", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_SUBMITTED_INCOMPLETE",
        422,
      );
    });

    await t.test("partial draft is incomplete and invited participation preserves evidence while incrementing version", async () => {
      const invitedAt = new Date("2026-07-28T08:00:00.000Z");
      await prisma.rfqSupplierParticipation.create({ data: { id: "participation-command-draft", tenantId, rfqId: "rfq-command-main", supplierId: "supplier-command-draft", status: "invited_internal", invitedAt, version: 4 } });
      const result = await service.recordInitialResponse(
        "rfq-command-main",
        responseInput({ key: "draft-partial", supplierId: "supplier-command-draft", submissionMode: "draft", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "0.1000" }] }),
        context,
      );
      assert.equal(result.status, "incomplete");
      assert.equal(result.quotedAmount, "0.1000");
      const participation = await prisma.rfqSupplierParticipation.findUnique({ where: { id: "participation-command-draft" } });
      assert.equal(participation.status, "response_recorded");
      assert.equal(participation.invitedAt.toISOString(), invitedAt.toISOString());
      assert.equal(participation.respondedAt.toISOString(), fixedNow.toISOString());
      assert.equal(participation.version, 5);
    });

    await t.test("pending command execution returns a stable in-progress conflict", async () => {
      const input = responseInput({ key: "draft-partial", supplierId: "supplier-command-draft", submissionMode: "draft", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "0.1000" }] });
      const execution = await prisma.businessCommandExecution.findUnique({ where: { tenantId_commandType_idempotencyKey: { tenantId, commandType: "procurement.rfq_response.create", idempotencyKey: "draft-partial" } } });
      await prisma.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "pending" } });
      try {
        await expectCommandError(
          service.recordInitialResponse("rfq-command-main", input, context),
          "COMMAND_EXECUTION_IN_PROGRESS",
          409,
        );
      } finally {
        await prisma.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed" } });
      }
    });

    await t.test("canonical RFQ detail reads the new latest revision and full history immediately", async () => {
      const repository = createDbProcurementReadRepository({ prisma, env: process.env });
      const detail = await repository.getDocument("rfq", "rfq-command-main", { tenantId });
      const quotation = detail.quotations.find((item) => item.supplierId === "supplier-command-main");
      assert.equal(quotation.latestRevision.revisionNumber, 3);
      assert.deepEqual(quotation.revisions.map((revision) => revision.revisionNumber), [3, 2, 1]);
      assert.equal(quotation.authorityState, "revision_authoritative");
      assert.equal(detail.suppliers.knownParticipants.find((item) => item.supplierId === "supplier-command-main").responseState, "response_recorded");
    });

    await t.test("closed, cancelled, declined, and withdrawn workflow facts reject writes", async () => {
      await expectCommandError(
        service.recordInitialResponse("rfq-command-closed", responseInput({ key: "closed-rfq", supplierId: "supplier-command-closed", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_WORKFLOW_CONFLICT",
        409,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-cancelled", responseInput({ key: "cancelled-rfq", supplierId: "supplier-command-cancelled", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_WORKFLOW_CONFLICT",
        409,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-draft", responseInput({ key: "draft-rfq", supplierId: "supplier-command-draft-rfq", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_WORKFLOW_CONFLICT",
        409,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-unknown", responseInput({ key: "unknown-rfq", supplierId: "supplier-command-unknown-rfq", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "1.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_WORKFLOW_CONFLICT",
        409,
      );
      await prisma.rfqSupplierParticipation.createMany({ data: [
        { id: "participation-command-declined", tenantId, rfqId: "rfq-command-main", supplierId: "supplier-command-declined", status: "declined" },
        { id: "participation-command-withdrawn", tenantId, rfqId: "rfq-command-main", supplierId: "supplier-command-withdrawn", status: "withdrawn" },
      ] });
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "declined-participation", supplierId: "supplier-command-declined" }), context),
        "RFQ_PARTICIPATION_WORKFLOW_CONFLICT",
        409,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "withdrawn-participation", supplierId: "supplier-command-withdrawn" }), context),
        "RFQ_PARTICIPATION_WORKFLOW_CONFLICT",
        409,
      );
    });

    await t.test("exact permission authorization and fixed Decimal validation are enforced", async () => {
      const viewerContext = { identity: { authenticated: true, tenantId, userId: "user-rfq-response-viewer", role: "viewer", source: "test" } };
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "viewer-denied", supplierId: "supplier-command-denied" }), viewerContext),
        "AUTHORIZATION_PERMISSION_DENIED",
        403,
      );
      await expectCommandError(
        service.recordInitialResponse("rfq-command-main", responseInput({ key: "invalid-decimal", supplierId: "supplier-command-denied", lines: [{ rfqLineId: "rfq-command-line-1", quantity: "0.0000", unitPrice: "1.0000" }] }), context),
        "RFQ_RESPONSE_DECIMAL_INVALID",
        422,
      );
    });

    for (const [fault, supplierId] of [
      ["after_participation_write", "supplier-command-fault-participation"],
      ["after_revision_write", "supplier-command-fault-revision"],
      ["before_audit", "supplier-command-fault-audit"],
      ["before_command_completion", "supplier-command-fault-completion"],
    ]) {
      await t.test(`${fault} rolls back every command fact`, async () => {
        const key = `fault-${fault}`;
        const faultService = createRfqSupplierResponseCommandService({ prisma, now: () => new Date(fixedNow), faultInjection: fault });
        const auditCount = await prisma.auditLog.count({ where: { tenantId, source: "rfq_supplier_response_command_service" } });
        const feedCount = await prisma.domainChangeFeed.count({ where: { tenantId, source: "rfq_supplier_response_command_service" } });
        await expectCommandError(
          faultService.recordInitialResponse("rfq-command-main", responseInput({ key, supplierId }), context),
          "RFQ_RESPONSE_FAULT_INJECTED",
          500,
        );
        assert.equal(await prisma.rfqSupplierParticipation.count({ where: { tenantId, rfqId: "rfq-command-main", supplierId } }), 0);
        assert.equal(await prisma.supplierQuotation.count({ where: { tenantId, rfqId: "rfq-command-main", supplierId } }), 0);
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId, commandType: "procurement.rfq_response.create", idempotencyKey: key } }), 0);
        assert.equal(await prisma.auditLog.count({ where: { tenantId, source: "rfq_supplier_response_command_service" } }), auditCount);
        assert.equal(await prisma.domainChangeFeed.count({ where: { tenantId, source: "rfq_supplier_response_command_service" } }), feedCount);
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});
