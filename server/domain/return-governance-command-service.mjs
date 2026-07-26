import { createHash, randomUUID } from "node:crypto";
import {
  assertWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import {
  buildReturnAuthorizationPlan,
  buildReturnRequestPlan,
} from "./return-governance-policy.mjs";
import { assertAuthorized } from "../auth/authorization-service.mjs";

export class ReturnGovernanceError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "ReturnGovernanceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new ReturnGovernanceError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const commandPermissions = Object.freeze({
  create_return_request: "returns.request.create",
  revise_return_request: "returns.request.revise",
  submit_return_request: "returns.request.submit",
  cancel_return_request: "returns.request.cancel",
  authorize_return_request: "returns.authorization.approve",
  reject_return_request: "returns.authorization.reject",
  cancel_return_authorization: "returns.authorization.cancel",
  expire_return_authorization: "returns.authorization.expire",
});
const executionWhere = (tenantId, commandType, idempotencyKey) => ({
  tenantId_commandType_idempotencyKey: {
    tenantId,
    commandType,
    idempotencyKey,
  },
});

function stable(value, parent = "") {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parent));
    return ["lines"].includes(parent)
      ? rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : rows;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key], key)]),
    );
  return value;
}

export const returnGovernanceRequestHash = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

function version(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    fail(
      "RETURN_VERSION_INVALID",
      `${label} must be a non-negative integer.`,
      422,
    );
  return parsed;
}

function required(value, label, code = "RETURN_VALIDATION_FAILED") {
  const normalized = text(value);
  if (!normalized) fail(code, `${label} is required.`, 422);
  return normalized;
}

function normalizedLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((row) => ({
    sourceDocumentLineId: text(row.sourceDocumentLineId),
    requestedQuantity: text(row.requestedQuantity),
    reasonCode: text(row.reasonCode),
    conditionCode: text(row.conditionCode),
  }));
}

function normalizedAuthorizationLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((row) => ({
    returnRequestLineId: text(row.returnRequestLineId),
    authorizedQuantity: text(row.authorizedQuantity),
    dispositionRoute: text(row.dispositionRoute),
  }));
}

function normalize(commandType, input = {}) {
  const idempotencyKey = required(
    input.idempotencyKey,
    "idempotencyKey",
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  let payload;
  if (commandType === "create_return_request")
    payload = {
      requestNumber: text(input.requestNumber),
      returnType: text(input.returnType),
      contextDocumentType: text(
        input.contextDocumentType || input.sourceDocumentType,
      ),
      contextDocumentId: text(
        input.contextDocumentId || input.sourceDocumentId,
      ),
      reasonCode: text(input.reasonCode),
      reasonDetail: text(input.reasonDetail),
      lines: normalizedLines(input.lines),
    };
  else if (commandType === "revise_return_request")
    payload = {
      requestId: required(input.requestId, "requestId"),
      expectedVersion: version(input.expectedVersion, "expectedVersion"),
      requestNumber: text(input.requestNumber),
      returnType: text(input.returnType),
      contextDocumentType: text(
        input.contextDocumentType || input.sourceDocumentType,
      ),
      contextDocumentId: text(
        input.contextDocumentId || input.sourceDocumentId,
      ),
      reasonCode: text(input.reasonCode),
      reasonDetail: text(input.reasonDetail),
      lines: normalizedLines(input.lines),
    };
  else if (
    ["submit_return_request", "cancel_return_request"].includes(commandType)
  )
    payload = {
      requestId: required(input.requestId, "requestId"),
      expectedVersion: version(input.expectedVersion, "expectedVersion"),
      ...(commandType === "cancel_return_request"
        ? { reason: required(input.reason, "reason") }
        : {}),
    };
  else if (commandType === "authorize_return_request")
    payload = {
      requestId: required(input.requestId, "requestId"),
      expectedRequestVersion: version(
        input.expectedRequestVersion,
        "expectedRequestVersion",
      ),
      authorizationNumber: text(input.authorizationNumber),
      expiresAt: text(input.expiresAt),
      lines: normalizedAuthorizationLines(input.lines),
    };
  else if (commandType === "reject_return_request")
    payload = {
      requestId: required(input.requestId, "requestId"),
      expectedRequestVersion: version(
        input.expectedRequestVersion,
        "expectedRequestVersion",
      ),
      authorizationNumber: required(
        input.authorizationNumber,
        "authorizationNumber",
      ),
      reason: required(input.reason, "reason"),
    };
  else if (
    [
      "cancel_return_authorization",
      "expire_return_authorization",
    ].includes(commandType)
  )
    payload = {
      authorizationId: required(input.authorizationId, "authorizationId"),
      expectedAuthorizationVersion: version(
        input.expectedAuthorizationVersion,
        "expectedAuthorizationVersion",
      ),
      expectedRequestVersion: version(
        input.expectedRequestVersion,
        "expectedRequestVersion",
      ),
      ...(commandType === "cancel_return_authorization"
        ? { reason: required(input.reason, "reason") }
        : {}),
    };
  else
    fail("RETURN_COMMAND_INVALID", "Unknown return governance command.", 422);
  return {
    idempotencyKey,
    payload,
    requestHash: returnGovernanceRequestHash(payload),
  };
}

function replay(execution, requestHash) {
  if (!execution) return null;
  if (execution.requestHash !== requestHash)
    fail(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "The idempotency key was already used with a different payload.",
      409,
    );
  if (execution.status !== "completed" || !execution.resultPayload)
    fail(
      "COMMAND_EXECUTION_IN_PROGRESS",
      "The command is already in progress.",
      409,
    );
  return { ...execution.resultPayload, idempotentReplay: true };
}

function assertEnabled(env) {
  if (
    text(env.FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE).toLowerCase() !== "true"
  )
    fail(
      "RETURN_GOVERNANCE_CAPABILITY_NOT_AVAILABLE",
      "Return governance requires database persistence and explicit enablement.",
      409,
    );
}

function enforce(plan) {
  if (!plan.allowed) {
    const first = plan.blockingIssues[0];
    fail(first.code, first.message, first.status, first.details);
  }
  return plan;
}

async function lockTenantRow(tx, table, tenantId, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
    tenantId,
    id,
  );
  return rows.length > 0;
}

async function lockRequest(tx, tenantId, requestId) {
  if (!await lockTenantRow(tx, "ReturnRequest", tenantId, requestId))
    fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
  const lines = await tx.returnRequestLine.findMany({
    where: { returnRequestId: requestId },
    select: { id: true },
  });
  for (const id of lines.map((row) => row.id).sort())
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "ReturnRequestLine" WHERE "id" = $1 FOR UPDATE',
      id,
    );
}

function requestInput(request) {
  return {
    requestNumber: request.requestNumber,
    returnType: request.returnType,
    contextDocumentType:
      request.contextDocumentType || request.sourceDocumentType,
    contextDocumentId: request.contextDocumentId || request.sourceDocumentId,
    reasonCode: request.reasonCode,
    reasonDetail: request.reasonDetail,
    lines: request.lines.map((line) => ({
      sourceDocumentLineId: line.sourceDocumentLineId,
      requestedQuantity: String(line.requestedQuantity),
      reasonCode: line.reasonCode,
      conditionCode: line.conditionCode,
    })),
  };
}

function requestModel(request) {
  return {
    id: request.id,
    requestNumber: request.requestNumber,
    returnType: request.returnType,
    workflowStatus: request.workflowStatus,
    version: request.version,
  };
}

function authorizationModel(authorization) {
  return {
    id: authorization.id,
    authorizationNumber: authorization.authorizationNumber,
    returnRequestId: authorization.returnRequestId,
    workflowStatus: authorization.workflowStatus,
    expiresAt: authorization.expiresAt?.toISOString?.() || null,
    version: authorization.version,
  };
}

function audit({
  idFactory,
  actor,
  action,
  entityType,
  entityId,
  summary,
  commandType,
  idempotencyKey,
  before,
  after,
  metadata,
}) {
  return {
    id: idFactory(),
    tenantId: actor.tenantId,
    actorId: actor.user.id,
    source: "return_governance_command_service",
    module: "returns",
    action,
    entityType,
    entityId,
    summary,
    metadata: {
      commandType,
      idempotencyKey,
      before,
      after,
      ...(metadata || {}),
    },
  };
}

const isUnique = (error) => error?.code === "P2002";
const isConcurrency = (error) =>
  error?.code === "P2034" ||
  /serialization|deadlock|write conflict/i.test(text(error?.message));

export function createReturnGovernanceCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function execute(commandType, input, context, work) {
    assertEnabled(env);
    const identity = context?.identity || context;
    if (!identity?.authenticated || !text(identity.tenantId))
      fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    const normalized = normalize(commandType, input);
    const where = executionWhere(
      identity.tenantId,
      commandType,
      normalized.idempotencyKey,
    );
    const outside = replay(
      await prisma.businessCommandExecution.findUnique({ where }),
      normalized.requestHash,
    );
    if (outside) return outside;
    try {
      return await prisma.$transaction(
        async (tx) => {
          const actor = await resolveProvisionedActor(tx, identity);
          assertAuthorized({ actor, permission: commandPermissions[commandType], tenantId: actor.tenantId });
          if (normalized.payload.returnType === "customer_return")
            assertAuthorized({ actor, permission: "returns.customer_request.manage", tenantId: actor.tenantId });
          const inside = replay(
            await tx.businessCommandExecution.findUnique({ where }),
            normalized.requestHash,
          );
          if (inside) return inside;
          const execution = await tx.businessCommandExecution.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              commandType,
              idempotencyKey: normalized.idempotencyKey,
              requestHash: normalized.requestHash,
              status: "pending",
            },
          });
          const result = await work(
            tx,
            actor,
            normalized.payload,
            normalized,
          );
          await tx.businessCommandExecution.update({
            where: { id: execution.id },
            data: {
              status: "completed",
              entityType: result.entityType,
              entityId: result.entityId,
              resultPayload: result,
              completedAt: now(),
            },
          });
          return { ...result, idempotentReplay: false };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (
        error instanceof ReturnGovernanceError ||
        error?.name === "PilotIdentityError"
      )
        throw error;
      if (isUnique(error)) {
        const concurrent = await prisma.businessCommandExecution.findUnique({
          where,
        });
        const result = replay(concurrent, normalized.requestHash);
        if (result) return result;
        if (/requestNumber/i.test(JSON.stringify(error?.meta || error)))
          fail(
            "RETURN_REQUEST_NUMBER_CONFLICT",
            "Return request number is already in use.",
            409,
          );
        if (/authorizationNumber/i.test(JSON.stringify(error?.meta || error)))
          fail(
            "RETURN_AUTHORIZATION_NUMBER_CONFLICT",
            "Return authorization number is already in use.",
            409,
          );
        if (
          /one_active_per_request|returnRequestId/i.test(
            JSON.stringify(error?.meta || error),
          )
        )
          fail(
            "RETURN_AUTHORIZATION_ALREADY_ACTIVE",
            "The return request already has an active authorization.",
            409,
          );
      }
      if (isConcurrency(error) || isUnique(error))
        fail(
          "RETURN_GOVERNANCE_CONCURRENT_CONFLICT",
          "Return governance state changed in another transaction. Refresh and retry.",
          409,
        );
      throw error;
    }
  }

  async function createRequest(input, context) {
    return execute(
      "create_return_request",
      input,
      context,
      async (tx, actor, payload, normalized) => {
        const plan = enforce(
          await buildReturnRequestPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: payload,
          }),
        );
        assertWarehouseAccess(actor, plan.request.warehouseIds, "read");
        const created = await tx.returnRequest.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            requestNumber: plan.request.requestNumber,
            returnType: plan.request.returnType,
            partnerId: plan.request.partnerId,
            partnerNameSnapshot: plan.request.partnerNameSnapshot,
            sourceDocumentType: plan.request.sourceDocumentType,
            sourceDocumentId: plan.request.sourceDocumentId,
            sourceDocumentNumber: plan.request.sourceDocumentNumber,
            contextDocumentType: plan.request.contextDocumentType,
            contextDocumentId: plan.request.contextDocumentId,
            reasonCode: plan.request.reasonCode,
            reasonDetail: plan.request.reasonDetail,
            workflowStatus: "draft",
            requestedById: actor.user.id,
            lines: {
              create: plan.lines.map((line) => ({
                id: idFactory(),
                sourceDocumentType: line.sourceDocumentType,
                sourceDocumentId: line.sourceDocumentId,
                sourceDocumentLineId: line.sourceDocumentLineId,
                sourceQuantity: line.sourceQuantity,
                sourceWarehouseIds: line.warehouseIds,
                itemId: line.itemId,
                sku: line.sku,
                itemName: line.itemName,
                requestedQuantity: line.requestedQuantity,
                unit: line.unit,
                reasonCode: line.reasonCode,
                conditionCode: line.conditionCode,
              })),
            },
          },
          include: { lines: true },
        });
        const event = audit({
          idFactory,
          actor,
          action: "return_request_created",
          entityType: "ReturnRequest",
          entityId: created.id,
          summary: `Return request ${created.requestNumber} created as draft.`,
          commandType: "create_return_request",
          idempotencyKey: normalized.idempotencyKey,
          before: null,
          after: requestModel(created),
          metadata: { lineIds: created.lines.map((line) => line.id) },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnRequest",
          entityId: created.id,
          request: requestModel(created),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  async function reviseRequest(requestId, input, context) {
    return execute(
      "revise_return_request",
      { ...input, requestId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockRequest(tx, actor.tenantId, payload.requestId);
        const current = await tx.returnRequest.findFirst({
          where: { id: payload.requestId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (current.workflowStatus !== "draft")
          fail(
            "RETURN_REQUEST_FROZEN",
            "Only a draft return request can be revised.",
            409,
          );
        if (current.version !== payload.expectedVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        const plan = enforce(
          await buildReturnRequestPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: payload,
            currentRequestId: current.id,
          }),
        );
        assertWarehouseAccess(actor, plan.request.warehouseIds, "read");
        const before = requestModel(current);
        await tx.returnRequestLine.deleteMany({
          where: { returnRequestId: current.id },
        });
        const updated = await tx.returnRequest.update({
          where: { id: current.id },
          data: {
            requestNumber: plan.request.requestNumber,
            returnType: plan.request.returnType,
            partnerId: plan.request.partnerId,
            partnerNameSnapshot: plan.request.partnerNameSnapshot,
            sourceDocumentType: plan.request.sourceDocumentType,
            sourceDocumentId: plan.request.sourceDocumentId,
            sourceDocumentNumber: plan.request.sourceDocumentNumber,
            contextDocumentType: plan.request.contextDocumentType,
            contextDocumentId: plan.request.contextDocumentId,
            reasonCode: plan.request.reasonCode,
            reasonDetail: plan.request.reasonDetail,
            version: { increment: 1 },
            lines: {
              create: plan.lines.map((line) => ({
                id: idFactory(),
                sourceDocumentType: line.sourceDocumentType,
                sourceDocumentId: line.sourceDocumentId,
                sourceDocumentLineId: line.sourceDocumentLineId,
                sourceQuantity: line.sourceQuantity,
                sourceWarehouseIds: line.warehouseIds,
                itemId: line.itemId,
                sku: line.sku,
                itemName: line.itemName,
                requestedQuantity: line.requestedQuantity,
                unit: line.unit,
                reasonCode: line.reasonCode,
                conditionCode: line.conditionCode,
              })),
            },
          },
          include: { lines: true },
        });
        const event = audit({
          idFactory,
          actor,
          action: "return_request_revised",
          entityType: "ReturnRequest",
          entityId: updated.id,
          summary: `Return request ${updated.requestNumber} revised.`,
          commandType: "revise_return_request",
          idempotencyKey: normalized.idempotencyKey,
          before,
          after: requestModel(updated),
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnRequest",
          entityId: updated.id,
          request: requestModel(updated),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  async function submitRequest(requestId, input, context) {
    return execute(
      "submit_return_request",
      { ...input, requestId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockRequest(tx, actor.tenantId, payload.requestId);
        const current = await tx.returnRequest.findFirst({
          where: { id: payload.requestId, tenantId: actor.tenantId },
          include: { lines: { orderBy: { id: "asc" } } },
        });
        if (current.workflowStatus !== "draft")
          fail(
            "RETURN_REQUEST_NOT_DRAFT",
            "Only a draft return request can be submitted.",
            409,
          );
        if (current.version !== payload.expectedVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        const plan = enforce(
          await buildReturnRequestPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: requestInput(current),
            currentRequestId: current.id,
          }),
        );
        assertWarehouseAccess(actor, plan.request.warehouseIds, "read");
        const factsBySourceLine = new Map(
          plan.lines.map((line) => [line.sourceDocumentLineId, line]),
        );
        for (const line of current.lines) {
          const fact = factsBySourceLine.get(line.sourceDocumentLineId);
          await tx.returnRequestLine.update({
            where: { id: line.id },
            data: {
              sourceDocumentType: fact.sourceDocumentType,
              sourceDocumentId: fact.sourceDocumentId,
              sourceQuantity: fact.sourceQuantity,
              sourceWarehouseIds: fact.warehouseIds,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              unit: fact.unit,
            },
          });
        }
        const updated = await tx.returnRequest.update({
          where: { id: current.id },
          data: {
            sourceDocumentType: plan.request.sourceDocumentType,
            sourceDocumentId: plan.request.sourceDocumentId,
            sourceDocumentNumber: plan.request.sourceDocumentNumber,
            partnerId: plan.request.partnerId,
            partnerNameSnapshot: plan.request.partnerNameSnapshot,
            workflowStatus: "submitted",
            submittedAt: now(),
            submittedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const event = audit({
          idFactory,
          actor,
          action: "return_request_submitted",
          entityType: "ReturnRequest",
          entityId: updated.id,
          summary: `Return request ${updated.requestNumber} submitted.`,
          commandType: "submit_return_request",
          idempotencyKey: normalized.idempotencyKey,
          before: requestModel(current),
          after: requestModel(updated),
          metadata: { sourceFactsFrozen: true },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnRequest",
          entityId: updated.id,
          request: requestModel(updated),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  async function cancelRequest(requestId, input, context) {
    return execute(
      "cancel_return_request",
      { ...input, requestId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockRequest(tx, actor.tenantId, payload.requestId);
        const current = await tx.returnRequest.findFirst({
          where: { id: payload.requestId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        assertWarehouseAccess(actor, sortedWarehouseIds(current.lines), "read");
        if (!["draft", "submitted"].includes(current.workflowStatus))
          fail(
            "RETURN_REQUEST_CANNOT_CANCEL",
            "Only a draft or unapproved submitted request can be cancelled.",
            409,
          );
        if (current.version !== payload.expectedVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        const active = await tx.returnAuthorization.count({
          where: {
            returnRequestId: current.id,
            workflowStatus: {
              in: ["draft", "approved", "partially_executed"],
            },
          },
        });
        if (active)
          fail(
            "RETURN_AUTHORIZATION_ALREADY_ACTIVE",
            "A request with an active authorization cannot be cancelled.",
            409,
          );
        const updated = await tx.returnRequest.update({
          where: { id: current.id },
          data: {
            workflowStatus: "cancelled",
            cancelledAt: now(),
            cancelledById: actor.user.id,
            cancellationReason: payload.reason,
            version: { increment: 1 },
          },
        });
        const event = audit({
          idFactory,
          actor,
          action: "return_request_cancelled",
          entityType: "ReturnRequest",
          entityId: updated.id,
          summary: `Return request ${updated.requestNumber} cancelled.`,
          commandType: "cancel_return_request",
          idempotencyKey: normalized.idempotencyKey,
          before: requestModel(current),
          after: requestModel(updated),
          metadata: { reason: payload.reason },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnRequest",
          entityId: updated.id,
          request: requestModel(updated),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  async function authorizeRequest(requestId, input, context) {
    return execute(
      "authorize_return_request",
      { ...input, requestId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockRequest(tx, actor.tenantId, payload.requestId);
        const current = await tx.returnRequest.findFirst({
          where: { id: payload.requestId, tenantId: actor.tenantId },
        });
        if (current.version !== payload.expectedRequestVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        const plan = enforce(
          await buildReturnAuthorizationPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            requestId: payload.requestId,
            input: payload,
          }),
        );
        const warehouseIds = sortedWarehouseIds(plan.request.lines);
        assertWarehouseAccess(actor, warehouseIds, "read");
        if (
          plan.authorization.expiresAt &&
          (!Number.isFinite(plan.authorization.expiresAt.getTime()) ||
            plan.authorization.expiresAt <= now())
        )
          fail(
            "RETURN_AUTHORIZATION_EXPIRY_INVALID",
            "expiresAt must be a valid future timestamp.",
            422,
          );
        const authorization = await tx.returnAuthorization.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            authorizationNumber: plan.authorization.authorizationNumber,
            returnRequestId: current.id,
            workflowStatus: "approved",
            authorizedAt: now(),
            authorizedById: actor.user.id,
            expiresAt: plan.authorization.expiresAt,
            lines: {
              create: plan.authorization.lines.map((line) => ({
                id: idFactory(),
                returnRequestLineId: line.returnRequestLineId,
                authorizedQuantity: line.authorizedQuantity,
                dispositionRoute: line.dispositionRoute,
              })),
            },
          },
          include: { lines: true },
        });
        const updatedRequest = await tx.returnRequest.update({
          where: { id: current.id },
          data: {
            workflowStatus: "authorized",
            version: { increment: 1 },
          },
        });
        const event = audit({
          idFactory,
          actor,
          action: "return_request_authorized",
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          summary: `Return request ${current.requestNumber} authorized as ${authorization.authorizationNumber}.`,
          commandType: "authorize_return_request",
          idempotencyKey: normalized.idempotencyKey,
          before: { request: requestModel(current), authorization: null },
          after: {
            request: requestModel(updatedRequest),
            authorization: authorizationModel(authorization),
          },
          metadata: {
            authorizationLineIds: authorization.lines.map((line) => line.id),
          },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          request: requestModel(updatedRequest),
          authorization: authorizationModel(authorization),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  async function rejectRequest(requestId, input, context) {
    return execute(
      "reject_return_request",
      { ...input, requestId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockRequest(tx, actor.tenantId, payload.requestId);
        const current = await tx.returnRequest.findFirst({
          where: { id: payload.requestId, tenantId: actor.tenantId },
          include: { lines: true },
        });
        if (current.workflowStatus !== "submitted")
          fail(
            "RETURN_REQUEST_NOT_SUBMITTED",
            "Only a submitted return request can be rejected.",
            409,
          );
        if (current.version !== payload.expectedRequestVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        assertWarehouseAccess(actor, sortedWarehouseIds(current.lines), "read");
        const rejectedAt = now();
        const authorization = await tx.returnAuthorization.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            authorizationNumber: payload.authorizationNumber,
            returnRequestId: current.id,
            workflowStatus: "rejected",
            rejectedAt,
            rejectedById: actor.user.id,
            rejectionReason: payload.reason,
          },
        });
        const updatedRequest = await tx.returnRequest.update({
          where: { id: current.id },
          data: {
            workflowStatus: "rejected",
            rejectedAt,
            rejectedById: actor.user.id,
            rejectionReason: payload.reason,
            version: { increment: 1 },
          },
        });
        const event = audit({
          idFactory,
          actor,
          action: "return_request_rejected",
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          summary: `Return request ${current.requestNumber} rejected.`,
          commandType: "reject_return_request",
          idempotencyKey: normalized.idempotencyKey,
          before: { request: requestModel(current), authorization: null },
          after: {
            request: requestModel(updatedRequest),
            authorization: authorizationModel(authorization),
          },
          metadata: { reason: payload.reason },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          request: requestModel(updatedRequest),
          authorization: authorizationModel(authorization),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  async function closeAuthorization(commandType, authorizationId, input, context) {
    return execute(
      commandType,
      { ...input, authorizationId },
      context,
      async (tx, actor, payload, normalized) => {
        if (
          !await lockTenantRow(
            tx,
            "ReturnAuthorization",
            actor.tenantId,
            payload.authorizationId,
          )
        )
          fail(
            "RETURN_AUTHORIZATION_NOT_FOUND",
            "Return authorization was not found.",
            404,
          );
        const authorization = await tx.returnAuthorization.findFirst({
          where: { id: payload.authorizationId, tenantId: actor.tenantId },
          include: {
            returnRequest: { include: { lines: true } },
            postings: true,
          },
        });
        await lockRequest(
          tx,
          actor.tenantId,
          authorization.returnRequestId,
        );
        if (authorization.version !== payload.expectedAuthorizationVersion)
          fail(
            "RETURN_AUTHORIZATION_VERSION_CONFLICT",
            "Return authorization version does not match.",
            409,
          );
        if (
          authorization.returnRequest.version !== payload.expectedRequestVersion
        )
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        if (!["draft", "approved"].includes(authorization.workflowStatus))
          fail(
            "RETURN_AUTHORIZATION_CANNOT_CLOSE",
            "Only an unexecuted active authorization can be closed.",
            409,
          );
        if (authorization.postings.length)
          fail(
            "RETURN_AUTHORIZATION_CANNOT_CLOSE",
            "An authorization with posting history cannot be closed.",
            409,
          );
        if (
          commandType === "expire_return_authorization" &&
          (!authorization.expiresAt || authorization.expiresAt > now())
        )
          fail(
            "RETURN_AUTHORIZATION_NOT_EXPIRED",
            "The authorization has not reached its expiration timestamp.",
            409,
          );
        assertWarehouseAccess(
          actor,
          sortedWarehouseIds(authorization.returnRequest.lines),
          "read",
        );
        const status =
          commandType === "expire_return_authorization"
            ? "expired"
            : "cancelled";
        const closedAt = now();
        const updatedAuthorization = await tx.returnAuthorization.update({
          where: { id: authorization.id },
          data:
            status === "expired"
              ? {
                  workflowStatus: status,
                  expiredAt: closedAt,
                  expiredById: actor.user.id,
                  version: { increment: 1 },
                }
              : {
                  workflowStatus: status,
                  cancelledAt: closedAt,
                  cancelledById: actor.user.id,
                  cancellationReason: payload.reason,
                  version: { increment: 1 },
                },
        });
        const updatedRequest = await tx.returnRequest.update({
          where: { id: authorization.returnRequestId },
          data: {
            workflowStatus: "submitted",
            version: { increment: 1 },
          },
        });
        const event = audit({
          idFactory,
          actor,
          action:
            status === "expired"
              ? "return_authorization_expired"
              : "return_authorization_cancelled",
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          summary: `Return authorization ${authorization.authorizationNumber} ${status}.`,
          commandType,
          idempotencyKey: normalized.idempotencyKey,
          before: {
            request: requestModel(authorization.returnRequest),
            authorization: authorizationModel(authorization),
          },
          after: {
            request: requestModel(updatedRequest),
            authorization: authorizationModel(updatedAuthorization),
          },
          metadata:
            status === "cancelled" ? { reason: payload.reason } : undefined,
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          request: requestModel(updatedRequest),
          authorization: authorizationModel(updatedAuthorization),
          auditEventId: event.id,
          inventoryMutation: false,
        };
      },
    );
  }

  return {
    createRequest,
    reviseRequest,
    submitRequest,
    cancelRequest,
    authorizeRequest,
    rejectRequest,
    cancelAuthorization: (id, input, context) =>
      closeAuthorization("cancel_return_authorization", id, input, context),
    expireAuthorization: (id, input, context) =>
      closeAuthorization("expire_return_authorization", id, input, context),
  };
}

function sortedWarehouseIds(lines = []) {
  return [
    ...new Set(
      lines.flatMap((line) =>
        Array.isArray(line.sourceWarehouseIds)
          ? line.sourceWarehouseIds.map(text).filter(Boolean)
          : [],
      ),
    ),
  ].sort();
}
