import assert from "node:assert/strict";
import test from "node:test";
import { backfillTenantAuthorization } from "../../server/auth/authorization-backfill.mjs";
import { RfqAwardDecisionError, createRfqAwardDecisionService } from "../../server/domain/rfq-award-decision-service.mjs";
import { createRfqSupplierResponseCommandService } from "../../server/domain/rfq-supplier-response-command-service.mjs";
import { createPrismaClient } from "../../server/persistence/prisma-client.mjs";

const tenantId = "tenant-rfq-award";
const otherTenantId = "tenant-rfq-award-other";
const actorId = "user-rfq-award";
const identity = { authenticated: true, tenantId, userId: actorId, role: "admin", source: "test" };
const context = { identity };

const input = (facts, key, extra = {}) => ({
  supplierId: facts.supplierId,
  quotationId: facts.quotationId,
  quotationRevisionId: facts.revisionId,
  expectedQuotationRevisionNumber: facts.revisionNumber,
  decisionReason: "Commercial terms and delivery commitment reviewed.",
  idempotencyKey: key,
  ...extra,
});

async function expectError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof RfqAwardDecisionError || error?.name === "AuthorizationError", true);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("real PostgreSQL reviewed RFQ Award Decision authority", async (t) => {
  const prisma = await createPrismaClient(process.env);
  const service = createRfqAwardDecisionService({ prisma, now: () => new Date("2026-08-12T08:00:00.000Z") });
  let sequence = 0;

  async function facts(name, { status = "submitted", rfqStatus = "collecting_quotes", coverage = "complete", tenant = tenantId } = {}) {
    sequence += 1;
    const suffix = `${name}-${sequence}`;
    const supplierId = `supplier-${suffix}`;
    const rfqId = `rfq-${suffix}`;
    const quotationId = `quotation-${suffix}`;
    const revisionId = `revision-${suffix}`;
    await prisma.supplier.create({ data: { id: supplierId, tenantId: tenant, code: suffix.toUpperCase(), name: suffix } });
    await prisma.rfq.create({ data: {
      id: rfqId, tenantId: tenant, title: suffix, status: rfqStatus, currency: "CNY",
      lines: { create: [
        { id: `line-${suffix}-1`, sku: "A", quantity: "2.0000", unit: "EA" },
        { id: `line-${suffix}-2`, sku: "B", quantity: "1.0000", unit: "EA" },
      ] },
    } });
    await prisma.supplierQuotation.create({ data: { id: quotationId, tenantId: tenant, rfqId, supplierId, status, currency: "CNY", quotedAmount: "12.3456" } });
    await prisma.supplierQuotationRevision.create({ data: {
      id: revisionId, tenantId: tenant, quotationId, revisionNumber: 1, status, currency: "CNY", quotedAmount: "12.3456", source: "test",
      lines: { create: [
        { id: `revision-line-${suffix}-1`, rfqLineId: coverage === "unlinked" ? null : `line-${suffix}-1`, quantity: "2.0000", unitPrice: "5.0000", amount: "10.0000" },
        ...(coverage === "complete" ? [{ id: `revision-line-${suffix}-2`, rfqLineId: `line-${suffix}-2`, quantity: "1.0000", unitPrice: "2.3456", amount: "2.3456" }] : []),
      ] },
    } });
    return { supplierId, rfqId, quotationId, revisionId, revisionNumber: 1 };
  }

  try {
    await prisma.tenant.createMany({ data: [{ id: tenantId, name: "Award" }, { id: otherTenantId, name: "Award Other" }] });
    await prisma.user.createMany({ data: [
      { id: actorId, tenantId, email: "award@flowchain.invalid", name: "Award Actor", role: "admin", status: "active" },
      { id: "user-rfq-award-viewer", tenantId, email: "award-viewer@flowchain.invalid", name: "Viewer", role: "viewer", status: "active" },
      { id: "user-rfq-award-other", tenantId: otherTenantId, email: "award-other@flowchain.invalid", name: "Other", role: "admin", status: "active" },
    ] });
    await backfillTenantAuthorization(prisma, tenantId, { actorId, requestId: "award-test" });
    await backfillTenantAuthorization(prisma, otherTenantId, { actorId: "user-rfq-award-other", requestId: "award-other-test" });

    await t.test("submitted exact latest revision commits immutable evidence and exact read", async () => {
      const source = await facts("success");
      const before = {
        rfq: await prisma.rfq.findUnique({ where: { id: source.rfqId } }),
        quotations: await prisma.supplierQuotation.findMany({ where: { tenantId, rfqId: source.rfqId }, orderBy: { id: "asc" } }),
        revisions: await prisma.supplierQuotationRevision.findMany({ where: { tenantId, quotationId: source.quotationId }, orderBy: { revisionNumber: "asc" } }),
        purchaseOrders: await prisma.purchaseOrder.count({ where: { tenantId } }),
      };
      const result = await service.createAwardDecision(source.rfqId, input(source, "award-success"), context);
      assert.equal(result.idempotentReplay, false);
      assert.equal(result.quotedAmount, "12.3456");
      assert.equal(result.currency, "CNY");
      assert.equal(result.quotationRevisionId, source.revisionId);
      const read = await service.getAwardDecision(source.rfqId, context);
      const { idempotentReplay, ...createdFacts } = result;
      assert.deepEqual(read.awardDecision, createdFacts);
      assert.equal(await prisma.auditLog.count({ where: { entityId: result.entityId, source: "rfq_award_decision_service" } }), 1);
      assert.equal(await prisma.domainChangeFeed.count({ where: { entityId: result.entityId, operation: "create", entityVersion: 1 } }), 1);
      const after = {
        rfq: await prisma.rfq.findUnique({ where: { id: source.rfqId } }),
        quotations: await prisma.supplierQuotation.findMany({ where: { tenantId, rfqId: source.rfqId }, orderBy: { id: "asc" } }),
        revisions: await prisma.supplierQuotationRevision.findMany({ where: { tenantId, quotationId: source.quotationId }, orderBy: { revisionNumber: "asc" } }),
        purchaseOrders: await prisma.purchaseOrder.count({ where: { tenantId } }),
      };
      assert.deepEqual(after, before);
      await assert.rejects(prisma.rfqAwardDecision.update({ where: { id: result.entityId }, data: { decisionReason: "changed" } }), /RFQ_AWARD_DECISION_IMMUTABLE/);
      await assert.rejects(prisma.rfqAwardDecision.delete({ where: { id: result.entityId } }), /RFQ_AWARD_DECISION_IMMUTABLE/);
    });

    await t.test("shortlisted succeeds and client commercial fields are rejected", async () => {
      const shortlisted = await facts("shortlisted", { status: "shortlisted" });
      assert.equal((await service.createAwardDecision(shortlisted.rfqId, input(shortlisted, "award-shortlisted"), context)).quotedAmount, "12.3456");
      const rejected = await facts("client-amount");
      await expectError(service.createAwardDecision(rejected.rfqId, input(rejected, "award-client-amount", { quotedAmount: "0.0001" }), context), "RFQ_AWARD_INPUT_INVALID", 422);
    });

    await t.test("all non-eligible classes fail closed", async () => {
      for (const status of ["draft", "incomplete", "withdrawn", "not_selected"]) {
        const source = await facts(status, { status });
        await expectError(service.createAwardDecision(source.rfqId, input(source, `award-${status}`), context), "RFQ_AWARD_RESPONSE_NOT_ELIGIBLE", 409);
      }
      const partial = await facts("partial", { coverage: "partial" });
      await expectError(service.createAwardDecision(partial.rfqId, input(partial, "award-partial"), context), "RFQ_AWARD_RESPONSE_NOT_ELIGIBLE", 409);
      const unlinked = await facts("unlinked", { coverage: "unlinked" });
      await expectError(service.createAwardDecision(unlinked.rfqId, input(unlinked, "award-unlinked"), context), "RFQ_AWARD_RESPONSE_NOT_ELIGIBLE", 409);

      const missing = await facts("missing-authority");
      const missingQuotationId = `quotation-missing-empty-${sequence}`;
      const missingSupplierId = `supplier-missing-empty-${sequence}`;
      await prisma.supplier.create({ data: { id: missingSupplierId, tenantId, code: missingSupplierId.toUpperCase(), name: missingSupplierId } });
      await prisma.supplierQuotation.create({ data: { id: missingQuotationId, tenantId, rfqId: missing.rfqId, supplierId: missingSupplierId, status: "submitted", currency: "CNY", quotedAmount: "1.0000" } });
      Object.assign(missing, { supplierId: missingSupplierId, quotationId: missingQuotationId, revisionId: "missing-revision" });
      await expectError(service.createAwardDecision(missing.rfqId, input(missing, "award-missing-authority"), context), "RFQ_AWARD_RESPONSE_NOT_ELIGIBLE", 409);
    });

    await t.test("stale revision and workflow conflicts are stable", async () => {
      const stale = await facts("stale");
      await prisma.supplierQuotationRevision.create({ data: { id: `${stale.revisionId}-2`, tenantId, quotationId: stale.quotationId, revisionNumber: 2, status: "submitted", currency: "CNY", quotedAmount: "13.0000", source: "test" } });
      await expectError(service.createAwardDecision(stale.rfqId, input(stale, "award-stale"), context), "RFQ_AWARD_QUOTATION_VERSION_CONFLICT", 409);
      for (const status of ["draft", "open", "closed", "cancelled", "legacy_unknown"]) {
        const source = await facts(`workflow-${status}`, { rfqStatus: status });
        await expectError(service.createAwardDecision(source.rfqId, input(source, `award-workflow-${status}`), context), "RFQ_AWARD_WORKFLOW_CONFLICT", 409);
      }
    });

    await t.test("idempotency, uniqueness, permission, and tenant masking are governed", async () => {
      const source = await facts("idempotency");
      const first = await service.createAwardDecision(source.rfqId, input(source, "award-replay"), context);
      const replay = await service.createAwardDecision(source.rfqId, input(source, "award-replay"), context);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.entityId, first.entityId);
      await expectError(service.createAwardDecision(source.rfqId, input(source, "award-replay", { decisionReason: "Different" }), context), "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", 409);
      await expectError(service.createAwardDecision(source.rfqId, input(source, "award-other-key"), context), "RFQ_AWARD_ALREADY_EXISTS", 409);
      await expectError(service.createAwardDecision(source.rfqId, input(source, "award-denied"), { identity: { ...identity, userId: "user-rfq-award-viewer", role: "viewer" } }), "AUTHORIZATION_PERMISSION_DENIED", 403);
      const other = await facts("cross-tenant", { tenant: otherTenantId });
      await expectError(service.createAwardDecision(other.rfqId, input(other, "award-cross-tenant"), context), "RFQ_NOT_FOUND", 404);
    });

    await t.test("two-Supplier Award race produces exactly one immutable fact", async () => {
      const source = await facts("concurrent-a");
      const supplierB = `supplier-concurrent-b-${sequence}`;
      const quotationB = `quotation-concurrent-b-${sequence}`;
      const revisionB = `revision-concurrent-b-${sequence}`;
      await prisma.supplier.create({ data: { id: supplierB, tenantId, code: supplierB.toUpperCase(), name: supplierB } });
      await prisma.supplierQuotation.create({ data: { id: quotationB, tenantId, rfqId: source.rfqId, supplierId: supplierB, status: "submitted", currency: "CNY", quotedAmount: "11.0000" } });
      await prisma.supplierQuotationRevision.create({ data: {
        id: revisionB, tenantId, quotationId: quotationB, revisionNumber: 1, status: "submitted", currency: "CNY", quotedAmount: "11.0000", source: "test",
        lines: { create: [
          { id: `revision-line-concurrent-b-${sequence}-1`, rfqLineId: `line-concurrent-a-${sequence}-1`, quantity: "2.0000", unitPrice: "4.5000", amount: "9.0000" },
          { id: `revision-line-concurrent-b-${sequence}-2`, rfqLineId: `line-concurrent-a-${sequence}-2`, quantity: "1.0000", unitPrice: "2.0000", amount: "2.0000" },
        ] },
      } });
      const results = await Promise.allSettled([
        service.createAwardDecision(source.rfqId, input(source, "award-concurrent-a"), context),
        service.createAwardDecision(source.rfqId, input({ ...source, supplierId: supplierB, quotationId: quotationB, revisionId: revisionB }, "award-concurrent-b"), context),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "RFQ_AWARD_ALREADY_EXISTS").length, 1);
      assert.equal(await prisma.rfqAwardDecision.count({ where: { tenantId, rfqId: source.rfqId } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { tenantId, source: "rfq_award_decision_service", metadata: { path: ["rfqId"], equals: source.rfqId } } }), 1);
      assert.equal(await prisma.domainChangeFeed.count({ where: { tenantId, source: "rfq_award_decision_service", entityId: results.find((result) => result.status === "fulfilled").value.entityId } }), 1);
      assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId, commandType: "procurement.rfq_award.create", idempotencyKey: { in: ["award-concurrent-a", "award-concurrent-b"] }, status: "completed" } }), 1);
    });

    await t.test("Award freezes initial and appended Supplier Response writes", async () => {
      const awarded = await facts("freeze");
      await service.createAwardDecision(awarded.rfqId, input(awarded, "award-freeze"), context);
      const responseService = createRfqSupplierResponseCommandService({ prisma });
      const append = {
        idempotencyKey: "append-after-award", expectedVersion: 1, submissionMode: "submitted", currency: "CNY",
        lines: [
          { rfqLineId: `line-freeze-${sequence}-1`, quantity: "2.0000", unitPrice: "5.1000" },
          { rfqLineId: `line-freeze-${sequence}-2`, quantity: "1.0000", unitPrice: "2.4000" },
        ],
      };
      await assert.rejects(responseService.appendRevision(awarded.rfqId, awarded.supplierId, append, context), (error) => error.code === "RFQ_RESPONSE_AWARD_EXISTS" && error.status === 409);

      const extraSupplierId = `supplier-freeze-extra-${sequence}`;
      await prisma.supplier.create({ data: { id: extraSupplierId, tenantId, code: extraSupplierId.toUpperCase(), name: extraSupplierId } });
      await assert.rejects(responseService.recordInitialResponse(awarded.rfqId, {
        ...append, idempotencyKey: "initial-after-award", expectedVersion: 0, supplierId: extraSupplierId,
      }, context), (error) => error.code === "RFQ_RESPONSE_AWARD_EXISTS" && error.status === 409);
      assert.equal(await prisma.supplierQuotationRevision.count({ where: { tenantId, quotationId: awarded.quotationId } }), 1);
      assert.equal(await prisma.supplierQuotation.count({ where: { tenantId, rfqId: awarded.rfqId } }), 1);
    });

    await t.test("Award and Revision commands serialize with no Award-N plus Revision-N+1 state", async () => {
      const source = await facts("award-revision-race");
      const responseService = createRfqSupplierResponseCommandService({ prisma });
      const append = {
        idempotencyKey: "award-revision-race-append", expectedVersion: 1, submissionMode: "submitted", currency: "CNY",
        lines: [
          { rfqLineId: `line-award-revision-race-${sequence}-1`, quantity: "2.0000", unitPrice: "5.2000" },
          { rfqLineId: `line-award-revision-race-${sequence}-2`, quantity: "1.0000", unitPrice: "2.5000" },
        ],
      };
      const [awardResult, revisionResult] = await Promise.allSettled([
        service.createAwardDecision(source.rfqId, input(source, "award-revision-race-award"), context),
        responseService.appendRevision(source.rfqId, source.supplierId, append, context),
      ]);
      assert.equal([awardResult, revisionResult].filter((result) => result.status === "fulfilled").length, 1);
      const award = await prisma.rfqAwardDecision.findUnique({ where: { tenantId_rfqId: { tenantId, rfqId: source.rfqId } } });
      const revisions = await prisma.supplierQuotationRevision.findMany({ where: { tenantId, quotationId: source.quotationId }, orderBy: { revisionNumber: "asc" } });
      if (award) {
        assert.equal(award.quotationRevisionNumber, 1);
        assert.equal(revisions.length, 1);
        assert.equal(revisionResult.status, "rejected");
        assert.equal(revisionResult.reason.code, "RFQ_RESPONSE_AWARD_EXISTS");
      } else {
        assert.equal(revisions.length, 2);
        assert.equal(awardResult.status, "rejected");
        assert.equal(awardResult.reason.code, "RFQ_AWARD_QUOTATION_VERSION_CONFLICT");
      }
    });

    await t.test("fault injection rolls back Award, audit, feed, and execution", async () => {
      for (const stage of ["after_award_create", "after_audit_create", "after_change_feed_create", "after_command_completion"]) {
        const source = await facts(`fault-${stage}`);
        const faulted = createRfqAwardDecisionService({ prisma, faultInjection: stage });
        await expectError(faulted.createAwardDecision(source.rfqId, input(source, `award-fault-${stage}`), context), "RFQ_AWARD_FAULT_INJECTED", 500);
        assert.equal(await prisma.rfqAwardDecision.count({ where: { tenantId, rfqId: source.rfqId } }), 0);
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId, idempotencyKey: `award-fault-${stage}` } }), 0);
      }
    });

    await t.test("database composite keys reject mismatched exact authority", async () => {
      const left = await facts("fk-left");
      const right = await facts("fk-right");
      await assert.rejects(prisma.rfqAwardDecision.create({ data: {
        id: "award-invalid-fk", tenantId, rfqId: left.rfqId, supplierId: left.supplierId,
        quotationId: left.quotationId, quotationRevisionId: right.revisionId, quotationRevisionNumber: 1,
        currency: "CNY", quotedAmount: "12.3456", decisionReason: "Invalid relation", decidedByActorId: actorId, decidedAt: new Date(),
      } }), (error) => error.code === "P2003");
      await assert.rejects(prisma.rfqAwardDecision.create({ data: {
        id: "award-empty-reason", tenantId, rfqId: left.rfqId, supplierId: left.supplierId,
        quotationId: left.quotationId, quotationRevisionId: left.revisionId, quotationRevisionNumber: 1,
        currency: "CNY", quotedAmount: "12.3456", decisionReason: "   ", decidedByActorId: actorId, decidedAt: new Date(),
      } }), /RfqAwardDecision_reason_check/);
    });
  } finally {
    await prisma.$disconnect();
  }
});
