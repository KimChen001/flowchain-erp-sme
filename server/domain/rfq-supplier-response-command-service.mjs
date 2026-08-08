import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import {
  RFQ_STATUS,
  RFQ_SUPPLIER_PARTICIPATION_STATUS,
  SUPPLIER_QUOTATION_REVISION_STATUS,
  normalizeProcurementAuthorityStatus,
} from "./procurement-status-authority.mjs";

export class RfqSupplierResponseCommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "RfqSupplierResponseCommandError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const SCALE = 10_000n;
const MAX_DECIMAL_UNITS = 999_999_999_999_999_999n;
const supportedCurrencies = new Set(Intl.supportedValuesOf?.("currency") || ["CNY", "USD", "EUR"]);
const text = (value) => String(value ?? "").trim();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message, status = 400, details) => {
  throw new RfqSupplierResponseCommandError(code, message, status, details);
};

function inputObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RFQ_RESPONSE_PAYLOAD_INVALID", "The request body must be a JSON object.", 422);
  }
  return value;
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function expectedVersion(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail("RFQ_RESPONSE_VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422);
  }
  return parsed;
}

function decimalUnits(value, field, { positive = false } = {}) {
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) {
    fail("RFQ_RESPONSE_DECIMAL_INVALID", `${field} must be a fixed-precision Decimal with at most four fractional digits.`, 422, { field });
  }
  const [whole, fraction = ""] = raw.split(".");
  if ((whole.replace(/^0+/, "") || "0").length > 14) {
    fail("RFQ_RESPONSE_DECIMAL_INVALID", `${field} is outside the supported Decimal(18,4) range.`, 422, { field });
  }
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, "0"));
  if ((positive && units <= 0n) || (!positive && units < 0n) || units > MAX_DECIMAL_UNITS) {
    fail("RFQ_RESPONSE_DECIMAL_INVALID", `${field} is outside the supported Decimal(18,4) range.`, 422, { field });
  }
  return units;
}

function fixed(units) {
  if (units < 0n || units > MAX_DECIMAL_UNITS) {
    fail("RFQ_RESPONSE_AMOUNT_OVERFLOW", "The calculated amount exceeds Decimal(18,4).", 422);
  }
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

function lineAmount(quantity, unitPrice) {
  return (quantity * unitPrice + SCALE / 2n) / SCALE;
}

function optionalDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail("RFQ_RESPONSE_DATE_INVALID", `${field} must be a valid date.`, 422, { field });
  }
  return parsed.toISOString();
}

function canonicalPayload(kind, rfqId, supplierId, input = {}) {
  const source = inputObject(input);
  const targetRfqId = text(rfqId);
  const targetSupplierId = text(supplierId);
  if (!targetRfqId) fail("RFQ_ID_REQUIRED", "rfqId is required.", 422);
  if (!targetSupplierId) fail("SUPPLIER_ID_REQUIRED", "supplierId is required.", 422);
  const submissionMode = text(source.submissionMode).toLowerCase();
  if (!["draft", "submitted"].includes(submissionMode)) {
    fail("RFQ_RESPONSE_SUBMISSION_MODE_INVALID", "submissionMode must be draft or submitted.", 422);
  }
  const currency = text(source.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !supportedCurrencies.has(currency)) {
    fail("RFQ_RESPONSE_CURRENCY_INVALID", "currency must be a supported ISO 4217 code.", 422);
  }
  if (!Array.isArray(source.lines) || source.lines.length === 0) {
    fail("RFQ_RESPONSE_LINES_REQUIRED", "At least one RFQ response line is required.", 422);
  }
  const seen = new Set();
  const lines = source.lines.map((line, index) => {
    const rfqLineId = text(line?.rfqLineId);
    if (!rfqLineId) fail("RFQ_RESPONSE_LINE_ID_REQUIRED", "Every response line requires rfqLineId.", 422, { index });
    if (seen.has(rfqLineId)) fail("RFQ_RESPONSE_LINE_DUPLICATE", "An RFQ line may appear only once in a revision.", 422, { rfqLineId });
    seen.add(rfqLineId);
    const quantity = decimalUnits(line?.quantity, `lines[${index}].quantity`, { positive: true });
    const unitPrice = decimalUnits(line?.unitPrice, `lines[${index}].unitPrice`);
    return {
      rfqLineId,
      quantity: fixed(quantity),
      unitPrice: fixed(unitPrice),
      deliveryDate: optionalDate(line?.deliveryDate, `lines[${index}].deliveryDate`),
    };
  }).sort((left, right) => left.rfqLineId.localeCompare(right.rfqLineId));
  return {
    kind,
    rfqId: targetRfqId,
    supplierId: targetSupplierId,
    expectedVersion: expectedVersion(source.expectedVersion),
    submissionMode,
    currency,
    submittedAt: optionalDate(source.submittedAt, "submittedAt"),
    validUntil: optionalDate(source.validUntil, "validUntil"),
    deliveryDate: optionalDate(source.deliveryDate, "deliveryDate"),
    paymentTerms: text(source.paymentTerms) || null,
    lines,
  };
}

function canonicalRfqStatus(value) {
  try {
    return normalizeProcurementAuthorityStatus("rfq", value);
  } catch {
    return null;
  }
}

function canonicalParticipationStatus(value) {
  try {
    return normalizeProcurementAuthorityStatus("rfqSupplierParticipation", value);
  } catch {
    return null;
  }
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

export function createRfqSupplierResponseCommandService({
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
      fail("RFQ_RESPONSE_FAULT_INJECTED", `Fault injected at ${stage}.`, 500, { stage });
    }
  };

  async function execute(kind, rfqId, supplierId, input, context) {
    const client = await db();
    const permission = kind === "create" ? "procurement.rfq_response.create" : "procurement.rfq_response.revise";
    const commandType = permission;
    const initialActor = await actorFor(client, context, permission);
    const commandInput = inputObject(input);
    const idempotencyKey = text(commandInput.idempotencyKey);
    if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const payload = canonicalPayload(kind, rfqId, supplierId, commandInput);
    const requestHash = digest(payload);
    const executionWhere = {
      tenantId_commandType_idempotencyKey: {
        tenantId: initialActor.tenantId,
        commandType,
        idempotencyKey,
      },
    };
    const prior = replayExecution(await client.businessCommandExecution.findUnique({ where: executionWhere }), requestHash);
    if (prior) return prior;

    try {
      return await client.$transaction(async (tx) => {
        const actor = await actorFor(tx, context, permission);
        const inside = replayExecution(await tx.businessCommandExecution.findUnique({ where: executionWhere }), requestHash);
        if (inside) return inside;
        const execution = await tx.businessCommandExecution.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            commandType,
            idempotencyKey,
            requestHash,
            status: "pending",
            entityType: "SupplierQuotation",
          },
        });

        await tx.$queryRawUnsafe('SELECT "id" FROM "Rfq" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.rfqId);
        const rfq = await tx.rfq.findFirst({ where: { tenantId: actor.tenantId, id: payload.rfqId } });
        if (!rfq) fail("RFQ_NOT_FOUND", "RFQ was not found.", 404);
        const rfqStatus = canonicalRfqStatus(rfq.status);
        if (![RFQ_STATUS.OPEN, RFQ_STATUS.COLLECTING_QUOTES].includes(rfqStatus)) {
          fail("RFQ_RESPONSE_WORKFLOW_CONFLICT", "Supplier responses may be recorded only while the RFQ is open for responses.", 409, { rfqId: rfq.id, currentStatus: rfqStatus, availableActions: ["reload"] });
        }

        await tx.$queryRawUnsafe('SELECT "id" FROM "Supplier" WHERE "tenantId"=$1 AND "id"=$2 FOR UPDATE', actor.tenantId, payload.supplierId);
        const supplier = await tx.supplier.findFirst({ where: { tenantId: actor.tenantId, id: payload.supplierId } });
        if (!supplier) fail("SUPPLIER_NOT_FOUND", "Supplier was not found.", 404);

        await tx.$queryRawUnsafe('SELECT "id" FROM "RfqSupplierParticipation" WHERE "tenantId"=$1 AND "rfqId"=$2 AND "supplierId"=$3 FOR UPDATE', actor.tenantId, payload.rfqId, payload.supplierId);
        let participation = await tx.rfqSupplierParticipation.findUnique({
          where: { tenantId_rfqId_supplierId: { tenantId: actor.tenantId, rfqId: payload.rfqId, supplierId: payload.supplierId } },
        });
        const participationStatus = participation ? canonicalParticipationStatus(participation.status) : null;
        if (participation && !participationStatus) {
          fail("RFQ_PARTICIPATION_WORKFLOW_CONFLICT", "Supplier participation has an unsupported status.", 409);
        }
        if ([RFQ_SUPPLIER_PARTICIPATION_STATUS.DECLINED, RFQ_SUPPLIER_PARTICIPATION_STATUS.WITHDRAWN, RFQ_SUPPLIER_PARTICIPATION_STATUS.CLOSED].includes(participationStatus)) {
          fail("RFQ_PARTICIPATION_WORKFLOW_CONFLICT", "Supplier participation must be reopened before recording a response.", 409, { currentStatus: participationStatus });
        }

        await tx.$queryRawUnsafe('SELECT "id" FROM "SupplierQuotation" WHERE "tenantId"=$1 AND "rfqId"=$2 AND "supplierId"=$3 FOR UPDATE', actor.tenantId, payload.rfqId, payload.supplierId);
        let quotation = await tx.supplierQuotation.findUnique({
          where: { tenantId_rfqId_supplierId: { tenantId: actor.tenantId, rfqId: payload.rfqId, supplierId: payload.supplierId } },
        });
        let currentRevisionNumber = 0;
        if (quotation) {
          const latest = await tx.supplierQuotationRevision.findFirst({
            where: { tenantId: actor.tenantId, quotationId: quotation.id },
            orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          });
          currentRevisionNumber = latest?.revisionNumber || 0;
        }
        if (kind === "create" && quotation) {
          fail("RFQ_RESPONSE_AGGREGATE_EXISTS", "A supplier response aggregate already exists for this RFQ and Supplier.", 409, { entityId: quotation.id, currentRevisionNumber, availableActions: ["reload"] });
        }
        if (kind === "revise" && !quotation) {
          fail("SUPPLIER_QUOTATION_NOT_FOUND", "Supplier quotation was not found.", 404);
        }
        if (kind === "revise" && currentRevisionNumber < 1) {
          fail("RFQ_RESPONSE_REVISION_AUTHORITY_MISSING", "The quotation has no authoritative revision to append to.", 409, { entityId: quotation.id, currentRevisionNumber, availableActions: ["reload"] });
        }
        if (payload.expectedVersion !== currentRevisionNumber) {
          fail("RFQ_RESPONSE_VERSION_CONFLICT", "The quotation changed concurrently.", 409, { entityId: quotation?.id || `${payload.rfqId}:${payload.supplierId}`, expectedVersion: payload.expectedVersion, currentRevisionNumber, availableActions: ["reload"] });
        }

        const rfqLines = await tx.rfqLine.findMany({ where: { tenantId: actor.tenantId, rfqId: payload.rfqId }, orderBy: { id: "asc" } });
        const linesById = new Map(rfqLines.map((line) => [line.id, line]));
        for (const line of payload.lines) {
          if (!linesById.has(line.rfqLineId)) {
            fail("RFQ_RESPONSE_LINE_NOT_IN_RFQ", "Every response line must reference a line from the target RFQ.", 422, { rfqLineId: line.rfqLineId });
          }
        }
        if (payload.submissionMode === "submitted" && (payload.lines.length !== rfqLines.length || rfqLines.some((line) => !payload.lines.some((candidate) => candidate.rfqLineId === line.id)))) {
          fail("RFQ_RESPONSE_SUBMITTED_INCOMPLETE", "A submitted response must include every RFQ line exactly once.", 422, { requiredLineCount: rfqLines.length, suppliedLineCount: payload.lines.length });
        }

        const revisionStatus = payload.submissionMode === "submitted"
          ? SUPPLIER_QUOTATION_REVISION_STATUS.SUBMITTED
          : payload.lines.length === rfqLines.length
            ? SUPPLIER_QUOTATION_REVISION_STATUS.DRAFT
            : SUPPLIER_QUOTATION_REVISION_STATUS.INCOMPLETE;
        const calculatedLines = payload.lines.map((line) => {
          const rfqLine = linesById.get(line.rfqLineId);
          const quantity = decimalUnits(line.quantity, "quantity", { positive: true });
          const unitPrice = decimalUnits(line.unitPrice, "unitPrice");
          const amount = lineAmount(quantity, unitPrice);
          return {
            id: idFactory(),
            rfqLineId: rfqLine.id,
            itemId: rfqLine.itemId,
            skuSnapshot: rfqLine.sku,
            itemNameSnapshot: rfqLine.itemName,
            quantity: fixed(quantity),
            unit: rfqLine.unit,
            unitPrice: fixed(unitPrice),
            amount: fixed(amount),
            deliveryDate: line.deliveryDate ? new Date(line.deliveryDate) : null,
            metadata: { source: "internal_recording" },
          };
        });
        const quotedAmount = fixed(calculatedLines.reduce((sum, line) => sum + decimalUnits(line.amount, "amount"), 0n));
        const recordedAt = payload.submittedAt ? new Date(payload.submittedAt) : now();

        if (!participation) {
          participation = await tx.rfqSupplierParticipation.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              rfqId: payload.rfqId,
              supplierId: payload.supplierId,
              status: RFQ_SUPPLIER_PARTICIPATION_STATUS.RESPONSE_RECORDED,
              invitedAt: null,
              respondedAt: recordedAt,
              version: 0,
              metadata: { recordedInternally: true },
            },
          });
        } else if (participationStatus !== RFQ_SUPPLIER_PARTICIPATION_STATUS.RESPONSE_RECORDED || !participation.respondedAt) {
          participation = await tx.rfqSupplierParticipation.update({
            where: { id: participation.id },
            data: {
              status: RFQ_SUPPLIER_PARTICIPATION_STATUS.RESPONSE_RECORDED,
              respondedAt: participation.respondedAt || recordedAt,
              version: { increment: 1 },
              metadata: { ...jsonObject(participation.metadata), recordedInternally: true },
            },
          });
        }
        inject("after_participation_write");

        const revisionNumber = currentRevisionNumber + 1;
        const revisionId = idFactory();
        const summaryMetadata = {
          ...jsonObject(quotation?.metadata),
          commercialAuthority: "supplier_quotation_revision",
          currentRevisionNumber: revisionNumber,
          lastSubmissionMode: payload.submissionMode,
        };
        if (!quotation) {
          quotation = await tx.supplierQuotation.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              rfqId: payload.rfqId,
              supplierId: payload.supplierId,
              supplierName: supplier.name,
              status: revisionStatus,
              currency: payload.currency,
            },
          });
        }
        await tx.supplierQuotationRevision.create({
          data: {
            id: revisionId,
            tenantId: actor.tenantId,
            quotationId: quotation.id,
            revisionNumber,
            status: revisionStatus,
            currency: payload.currency,
            quotedAmount,
            submittedAt: payload.submissionMode === "submitted" ? recordedAt : payload.submittedAt ? recordedAt : null,
            validUntil: payload.validUntil ? new Date(payload.validUntil) : null,
            deliveryDate: payload.deliveryDate ? new Date(payload.deliveryDate) : null,
            paymentTerms: payload.paymentTerms,
            createdByActorId: actor.user.id,
            source: "internal_recording",
            metadata: { submissionMode: payload.submissionMode, recordedInternally: true },
            lines: { create: calculatedLines },
          },
        });
        inject("after_revision_write");
        quotation = await tx.supplierQuotation.update({
          where: { id: quotation.id },
          data: {
            supplierName: supplier.name,
            status: revisionStatus,
            quotedAmount,
            currency: payload.currency,
            submittedAt: payload.submissionMode === "submitted" ? recordedAt : payload.submittedAt ? recordedAt : null,
            metadata: summaryMetadata,
          },
        });

        const result = {
          entityType: "SupplierQuotation",
          entityId: quotation.id,
          entityVersion: revisionNumber,
          rfqId: payload.rfqId,
          supplierId: payload.supplierId,
          quotationId: quotation.id,
          revisionId,
          revisionNumber,
          status: revisionStatus,
          currency: payload.currency,
          quotedAmount,
          lineCount: calculatedLines.length,
          participationId: participation.id,
          participationVersion: participation.version,
          serverTime: now().toISOString(),
        };

        inject("before_audit");
        await tx.auditLog.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            actorId: actor.user.id,
            source: "rfq_supplier_response_command_service",
            module: "procurement",
            action: kind === "create" ? "supplier_response_recorded" : "supplier_quotation_revision_appended",
            entityType: "SupplierQuotation",
            entityId: quotation.id,
            summary: `${kind === "create" ? "Recorded" : "Revised"} internal supplier response ${quotation.id} at revision ${revisionNumber}.`,
            metadata: { commandType, rfqId: payload.rfqId, supplierId: payload.supplierId, quotationId: quotation.id, revisionId, revisionNumber, submissionMode: payload.submissionMode, idempotencyKey },
          },
        });
        await tx.domainChangeFeed.create({
          data: {
            tenantId: actor.tenantId,
            entityType: "SupplierQuotation",
            entityId: quotation.id,
            operation: "upsert",
            entityVersion: revisionNumber,
            actorId: actor.user.id,
            source: "rfq_supplier_response_command_service",
            requestId: idempotencyKey,
            payloadHash: digest({ quotationId: quotation.id, revisionId, revisionNumber, status: revisionStatus, quotedAmount }),
            sensitivityGroups: ["procurement_prices"],
            moduleKey: "procurement",
            authorizationClass: "procurement.prices.read",
            resourceTenantId: actor.tenantId,
          },
        });
        inject("before_command_completion");
        await tx.businessCommandExecution.update({
          where: { id: execution.id },
          data: { status: "completed", entityId: quotation.id, resultPayload: result, completedAt: now() },
        });
        return { ...result, idempotentReplay: false };
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error?.code === "P2002") {
        const committed = replayExecution(await client.businessCommandExecution.findUnique({ where: executionWhere }), requestHash);
        if (committed) return committed;
        fail("RFQ_RESPONSE_CONCURRENCY_CONFLICT", "Supplier response facts changed concurrently. Reload and retry.", 409, { expectedVersion: payload.expectedVersion, availableActions: ["reload"] });
      }
      if (error?.code === "P2034") {
        fail("RFQ_RESPONSE_CONCURRENCY_CONFLICT", "Supplier response facts changed concurrently. Reload and retry.", 409, { expectedVersion: payload.expectedVersion, availableActions: ["reload"] });
      }
      throw error;
    }
  }

  return {
    recordInitialResponse: (rfqId, input, context) => execute("create", rfqId, input?.supplierId, input, context),
    appendRevision: (rfqId, supplierId, input, context) => execute("revise", rfqId, supplierId, input, context),
  };
}
