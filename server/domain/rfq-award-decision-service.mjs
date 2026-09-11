import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { RFQ_STATUS, normalizeProcurementAuthorityStatus } from "./procurement-status-authority.mjs";
import { rfqComparisonEligibility, rfqRevisionCoverage } from "./rfq-comparison-eligibility.mjs";
import { exactRfqDecimalString } from "./rfq-commercial-decimal.mjs";

export class RfqAwardDecisionError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "RfqAwardDecisionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const COMMAND_TYPE = "procurement.rfq_award.create";
const SOURCE = "rfq_award_decision_service";
const text = (value) => String(value ?? "").trim();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message, status, details) => { throw new RfqAwardDecisionError(code, message, status, details); };

function canonicalId(value, code, label) {
  const id = text(value);
  if (!id) fail(code, `${label} is invalid.`, 422);
  return id;
}

function canonicalPayload(rfqId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("RFQ_AWARD_INPUT_INVALID", "The request body must be a JSON object.", 422);
  }
  for (const forbidden of ["quotedAmount", "currency", "price", "total"]) {
    if (Object.hasOwn(input, forbidden)) {
      fail("RFQ_AWARD_INPUT_INVALID", "Commercial values are derived from the selected quotation revision.", 422, { field: forbidden });
    }
  }
  const decisionReason = text(input.decisionReason);
  if (!decisionReason) fail("RFQ_AWARD_REASON_REQUIRED", "decisionReason is required.", 422);
  if (decisionReason.length > 2000) fail("RFQ_AWARD_REASON_TOO_LONG", "decisionReason must not exceed 2000 characters.", 422);
  const expectedQuotationRevisionNumber = Number(input.expectedQuotationRevisionNumber);
  if (!Number.isInteger(expectedQuotationRevisionNumber) || expectedQuotationRevisionNumber < 1) {
    fail("RFQ_AWARD_INPUT_INVALID", "expectedQuotationRevisionNumber must be a positive integer.", 422, { field: "expectedQuotationRevisionNumber" });
  }
  return {
    rfqId: canonicalId(rfqId, "RFQ_ID_INVALID", "rfqId"),
    supplierId: canonicalId(input.supplierId, "SUPPLIER_ID_INVALID", "supplierId"),
    quotationId: canonicalId(input.quotationId, "QUOTATION_ID_INVALID", "quotationId"),
    quotationRevisionId: canonicalId(input.quotationRevisionId, "REVISION_ID_INVALID", "quotationRevisionId"),
    expectedQuotationRevisionNumber,
    decisionReason,
  };
}

function canonicalRfqStatus(value) {
  try { return normalizeProcurementAuthorityStatus("rfq", value); } catch { return null; }
}

function replayExecution(row, requestHash) {
  if (!row) return null;
  if (row.requestHash !== requestHash) {
    fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with a different payload.", 409);
  }
  if (row.status !== "completed" || !row.resultPayload) {
    fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is already in progress.", 409);
  }
  return { ...row.resultPayload, idempotentReplay: true };
}

function mapAward(row) {
  return {
    entityType: "RfqAwardDecision",
    entityId: row.id,
    rfqId: row.rfqId,
    supplierId: row.supplierId,
    quotationId: row.quotationId,
    quotationRevisionId: row.quotationRevisionId,
    quotationRevisionNumber: row.quotationRevisionNumber,
    currency: row.currency,
    quotedAmount: exactRfqDecimalString(row.quotedAmount),
    decisionReason: row.decisionReason,
    decidedByActorId: row.decidedByActorId,
    decidedAt: row.decidedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function createRfqAwardDecisionService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
  faultInjection,
} = {}) {
  const db = async () => prisma || getPrismaClient(env);
  const actorFor = async (client, context, permission) => {
    const actor = await resolveProvisionedActor(client, context?.identity || context);
    assertAuthorized({ actor, permission, tenantId: actor.tenantId });
    return actor;
  };
  const inject = (stage) => {
    if (text(faultInjection || env.FLOWCHAIN_TEST_FAULT_INJECTION) === stage) {
      fail("RFQ_AWARD_FAULT_INJECTED", "The Award command failed.", 500);
    }
  };

  async function createAwardDecision(rfqId, input, context) {
    const client = await db();
    const initialActor = await actorFor(client, context, COMMAND_TYPE);
    const idempotencyKey = text(input?.idempotencyKey);
    if (!idempotencyKey) fail("RFQ_AWARD_INPUT_INVALID", "idempotencyKey is required.", 422, { field: "idempotencyKey" });
    const payload = canonicalPayload(rfqId, input);
    const requestHash = digest(payload);
    const executionWhere = { tenantId_commandType_idempotencyKey: { tenantId: initialActor.tenantId, commandType: COMMAND_TYPE, idempotencyKey } };
    const prior = replayExecution(await client.businessCommandExecution.findUnique({ where: executionWhere }), requestHash);
    if (prior) return prior;

    try {
      return await client.$transaction(async (tx) => {
        const actor = await actorFor(tx, context, COMMAND_TYPE);
        const inside = replayExecution(await tx.businessCommandExecution.findUnique({ where: executionWhere }), requestHash);
        if (inside) return inside;
        const execution = await tx.businessCommandExecution.create({ data: {
          id: idFactory(), tenantId: actor.tenantId, commandType: COMMAND_TYPE, idempotencyKey,
          requestHash, status: "pending", entityType: "RfqAwardDecision",
        } });

        await tx.$queryRawUnsafe('SELECT "id" FROM "Rfq" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.rfqId);
        const rfq = await tx.rfq.findFirst({ where: { tenantId: actor.tenantId, id: payload.rfqId } });
        if (!rfq) fail("RFQ_NOT_FOUND", "RFQ was not found.", 404);
        const rfqStatus = canonicalRfqStatus(rfq.status);
        if (rfqStatus !== RFQ_STATUS.COLLECTING_QUOTES) {
          fail("RFQ_AWARD_WORKFLOW_CONFLICT", "An Award may be recorded only while the RFQ is collecting quotes.", 409, { currentStatus: rfqStatus });
        }

        const existing = await tx.rfqAwardDecision.findUnique({ where: { tenantId_rfqId: { tenantId: actor.tenantId, rfqId: payload.rfqId } } });
        if (existing) fail("RFQ_AWARD_ALREADY_EXISTS", "This RFQ already has a formal Award Decision.", 409, { awardDecisionId: existing.id });

        await tx.$queryRawUnsafe('SELECT "id" FROM "Supplier" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.supplierId);
        const supplier = await tx.supplier.findFirst({ where: { tenantId: actor.tenantId, id: payload.supplierId } });
        if (!supplier) fail("SUPPLIER_NOT_FOUND", "Supplier was not found.", 404);

        await tx.$queryRawUnsafe('SELECT "id" FROM "SupplierQuotation" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.quotationId);
        const quotation = await tx.supplierQuotation.findFirst({ where: {
          tenantId: actor.tenantId, id: payload.quotationId, rfqId: payload.rfqId, supplierId: payload.supplierId,
        } });
        if (!quotation) fail("SUPPLIER_QUOTATION_NOT_FOUND", "Supplier quotation was not found.", 404);

        await tx.$queryRawUnsafe('SELECT "id" FROM "SupplierQuotationRevision" WHERE "tenantId"=$1 AND "quotationId"=$2 ORDER BY "revisionNumber" DESC, "createdAt" DESC, "id" DESC LIMIT 1 FOR UPDATE', actor.tenantId, payload.quotationId);
        const latest = await tx.supplierQuotationRevision.findFirst({
          where: { tenantId: actor.tenantId, quotationId: payload.quotationId },
          orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          include: { lines: true },
        });
        if (!latest) {
          fail("RFQ_AWARD_RESPONSE_NOT_ELIGIBLE", "The selected response has no authoritative quotation revision.", 409, {
            eligibility: "authority_missing",
            reasons: ["authoritative_revision_missing"],
          });
        }
        if (latest.id !== payload.quotationRevisionId || latest.revisionNumber !== payload.expectedQuotationRevisionNumber) {
          fail("RFQ_AWARD_QUOTATION_VERSION_CONFLICT", "The quotation changed after review.", 409, { currentRevisionId: latest.id, currentRevisionNumber: latest.revisionNumber });
        }

        const rfqLines = await tx.rfqLine.findMany({ where: { tenantId: actor.tenantId, rfqId: payload.rfqId }, orderBy: { id: "asc" } });
        const coverage = rfqRevisionCoverage(rfqLines, latest.lines);
        const eligibility = rfqComparisonEligibility({ revision: latest, coverageState: coverage.state });
        const quotedAmount = exactRfqDecimalString(latest.quotedAmount);
        if (eligibility.state !== "eligible" || !quotedAmount || !text(latest.currency)) {
          fail("RFQ_AWARD_RESPONSE_NOT_ELIGIBLE", "The selected latest response is not eligible for Award.", 409, { eligibility: eligibility.state, reasons: eligibility.reasons, coverageState: coverage.state });
        }

        const decidedAt = now();
        const award = await tx.rfqAwardDecision.create({ data: {
          id: idFactory(), tenantId: actor.tenantId, rfqId: payload.rfqId, supplierId: payload.supplierId,
          quotationId: payload.quotationId, quotationRevisionId: latest.id, quotationRevisionNumber: latest.revisionNumber,
          currency: latest.currency, quotedAmount, decisionReason: payload.decisionReason,
          decidedByActorId: actor.user.id, decidedAt,
          metadata: { authority: "human_reviewed_exact_quotation_revision", eligibility: eligibility.state },
        } });
        inject("after_award_create");
        const result = mapAward(award);

        await tx.auditLog.create({ data: {
          id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: SOURCE, module: "procurement",
          action: "rfq_award_decision_recorded", entityType: "RfqAwardDecision", entityId: award.id,
          summary: `Recorded reviewed RFQ Award Decision ${award.id}.`,
          metadata: { commandType: COMMAND_TYPE, awardDecisionId: award.id, rfqId: payload.rfqId, supplierId: payload.supplierId,
            quotationId: payload.quotationId, quotationRevisionId: latest.id, quotationRevisionNumber: latest.revisionNumber,
            actorId: actor.user.id, decisionReason: payload.decisionReason, currency: latest.currency, quotedAmount, requestId: idempotencyKey },
        } });
        inject("after_audit_create");
        await tx.domainChangeFeed.create({ data: {
          tenantId: actor.tenantId, entityType: "RfqAwardDecision", entityId: award.id, operation: "create", entityVersion: 1,
          actorId: actor.user.id, source: SOURCE, requestId: idempotencyKey,
          payloadHash: digest({ awardDecisionId: award.id, rfqId: payload.rfqId, supplierId: payload.supplierId,
            quotationId: payload.quotationId, quotationRevisionId: latest.id, quotationRevisionNumber: latest.revisionNumber,
            currency: latest.currency, quotedAmount, decisionReason: payload.decisionReason }),
          sensitivityGroups: ["procurement_prices"], moduleKey: "procurement",
          authorizationClass: COMMAND_TYPE, resourceTenantId: actor.tenantId,
        } });
        inject("after_change_feed_create");
        await tx.businessCommandExecution.update({ where: { id: execution.id }, data: {
          status: "completed", entityId: award.id, resultPayload: result, completedAt: now(),
        } });
        inject("after_command_completion");
        return { ...result, idempotentReplay: false };
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error?.code === "P2002" || error?.code === "P2034") {
        const committed = replayExecution(await client.businessCommandExecution.findUnique({ where: executionWhere }), requestHash);
        if (committed) return committed;
        const existingAward = await client.rfqAwardDecision.findUnique({
          where: { tenantId_rfqId: { tenantId: initialActor.tenantId, rfqId: payload.rfqId } },
          select: { id: true },
        });
        if (existingAward) {
          fail("RFQ_AWARD_ALREADY_EXISTS", "This RFQ already has a formal Award Decision.", 409, { awardDecisionId: existingAward.id });
        }
        const latest = await client.supplierQuotationRevision.findFirst({
          where: { tenantId: initialActor.tenantId, quotationId: payload.quotationId },
          orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          select: { id: true, revisionNumber: true },
        });
        if (latest && (latest.id !== payload.quotationRevisionId || latest.revisionNumber !== payload.expectedQuotationRevisionNumber)) {
          fail("RFQ_AWARD_QUOTATION_VERSION_CONFLICT", "The quotation changed after review.", 409, { currentRevisionId: latest.id, currentRevisionNumber: latest.revisionNumber });
        }
        fail("RFQ_AWARD_ALREADY_EXISTS", "Award facts changed concurrently. Reload and retry.", 409);
      }
      throw error;
    }
  }

  async function getAwardDecision(rfqId, context) {
    const client = await db();
    const actor = await actorFor(client, context, "procurement.prices.read");
    const targetRfqId = canonicalId(rfqId, "RFQ_ID_INVALID", "rfqId");
    const rfq = await client.rfq.findFirst({ where: { tenantId: actor.tenantId, id: targetRfqId }, select: { id: true } });
    if (!rfq) fail("RFQ_NOT_FOUND", "RFQ was not found.", 404);
    const award = await client.rfqAwardDecision.findUnique({ where: { tenantId_rfqId: { tenantId: actor.tenantId, rfqId: targetRfqId } } });
    return { awardDecision: award ? mapAward(award) : null };
  }

  return { createAwardDecision, getAwardDecision };
}
