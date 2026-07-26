import { createHash, randomUUID } from "node:crypto";
import {
  assertWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import {
  buildCustomerReturnDraftPlan,
  buildCustomerReturnPostingPlan,
  buildCustomerReturnReversalPlan,
} from "./customer-return-transaction-policy.mjs";
import { assertAuthorized } from "../auth/authorization-service.mjs";

export class CustomerReturnCommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "CustomerReturnCommandError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new CustomerReturnCommandError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const TYPES = {
  create: "create_customer_return_receipt_draft",
  revise: "revise_customer_return_receipt_draft",
  ready: "ready_customer_return_receipt",
  cancel: "cancel_customer_return_receipt",
  post: "post_customer_return_receipt",
  reverse: "reverse_customer_return_receipt",
};
const commandPermissions = Object.freeze({
  [TYPES.create]: "returns.posting.prepare",
  [TYPES.revise]: "returns.posting.prepare",
  [TYPES.ready]: "returns.posting.ready",
  [TYPES.cancel]: "returns.posting.cancel",
  [TYPES.post]: "returns.posting.post",
  [TYPES.reverse]: "returns.posting.reverse",
});

function stable(value, parent = "") {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parent));
    return parent === "lines"
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
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const required = (value, label, code = "RETURN_POSTING_VALIDATION_FAILED") => {
  const result = text(value);
  if (!result) fail(code, `${label} is required.`, 422);
  return result;
};
const version = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    fail(
      "RETURN_POSTING_VERSION_INVALID",
      `${label} must be a non-negative integer.`,
      422,
    );
  return parsed;
};
const lines = (rows = []) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    returnAuthorizationLineId: text(row.returnAuthorizationLineId),
    quantity: text(row.quantity),
    quarantineBalanceId: text(row.quarantineBalanceId),
    inventoryBalanceId: text(row.inventoryBalanceId),
  }));

function normalize(type, input = {}) {
  const idempotencyKey = required(
    input.idempotencyKey,
    "idempotencyKey",
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  let payload;
  if (type === TYPES.create)
    payload = {
      authorizationId: required(input.authorizationId, "authorizationId"),
      postingNumber: required(input.postingNumber, "postingNumber"),
      expectedAuthorizationVersion: version(
        input.expectedAuthorizationVersion,
        "expectedAuthorizationVersion",
      ),
      lines: lines(input.lines),
    };
  else if (type === TYPES.revise)
    payload = {
      postingId: required(input.postingId, "postingId"),
      postingNumber: required(input.postingNumber, "postingNumber"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
      lines: lines(input.lines),
    };
  else if ([TYPES.ready, TYPES.cancel].includes(type))
    payload = {
      postingId: required(input.postingId, "postingId"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
      ...(type === TYPES.cancel
        ? { reason: required(input.reason, "reason") }
        : {}),
    };
  else if ([TYPES.post, TYPES.reverse].includes(type))
    payload = {
      postingId: required(input.postingId, "postingId"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
      expectedAuthorizationVersion: version(
        input.expectedAuthorizationVersion,
        "expectedAuthorizationVersion",
      ),
      expectedRequestVersion: version(
        input.expectedRequestVersion,
        "expectedRequestVersion",
      ),
      ...(type === TYPES.reverse
        ? { reason: required(input.reason, "reason") }
        : {}),
    };
  else fail("RETURN_POSTING_COMMAND_INVALID", "Unknown customer return command.", 422);
  return { idempotencyKey, payload, requestHash: hash(payload) };
}

const executionWhere = (tenantId, commandType, idempotencyKey) => ({
  tenantId_commandType_idempotencyKey: {
    tenantId,
    commandType,
    idempotencyKey,
  },
});
function replay(execution, requestHash) {
  if (!execution) return null;
  if (execution.requestHash !== requestHash)
    fail(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "The idempotency key was already used with a different payload.",
      409,
    );
  if (execution.status !== "completed" || !execution.resultPayload)
    fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is already in progress.", 409);
  return { ...execution.resultPayload, idempotentReplay: true };
}
function enforce(plan) {
  if (!plan.allowed) {
    const first = plan.blockingIssues[0];
    fail(first.code, first.message, first.status, first.details);
  }
  return plan;
}
function assertEnabled(env) {
  if (
    text(env.FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE).toLowerCase() !== "true"
  )
    fail(
      "RETURN_POSTING_CAPABILITY_NOT_AVAILABLE",
      "Customer return receipt requires database persistence and explicit enablement.",
      409,
    );
}

async function lockTenant(tx, table, tenantId, ids) {
  for (const id of [...new Set(ids.filter(Boolean))].sort()) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
      tenantId,
      id,
    );
    if (!rows.length) return false;
  }
  return true;
}
async function lockChildren(tx, table, ids) {
  for (const id of [...new Set(ids.filter(Boolean))].sort())
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
}
async function lockAuthorization(tx, tenantId, authorizationId) {
  if (!(await lockTenant(tx, "ReturnAuthorization", tenantId, [authorizationId])))
    fail("RETURN_AUTHORIZATION_NOT_FOUND", "Return authorization was not found.", 404);
  const auth = await tx.returnAuthorization.findFirst({
    where: { id: authorizationId, tenantId },
    select: { returnRequestId: true },
  });
  if (!(await lockTenant(tx, "ReturnRequest", tenantId, [auth.returnRequestId])))
    fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
  const authLines = await tx.returnAuthorizationLine.findMany({
    where: { returnAuthorizationId: authorizationId },
    select: { id: true, returnRequestLineId: true },
  });
  await lockChildren(
    tx,
    "ReturnAuthorizationLine",
    authLines.map((row) => row.id),
  );
  await lockChildren(
    tx,
    "ReturnRequestLine",
    authLines.map((row) => row.returnRequestLineId),
  );
  return { requestId: auth.returnRequestId };
}
async function lockPosting(tx, tenantId, postingId) {
  const initial = await tx.returnPostingDocument.findFirst({
    where: { id: postingId, tenantId },
    select: { returnAuthorizationId: true },
  });
  if (!initial)
    fail("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404);
  const aggregate = await lockAuthorization(
    tx,
    tenantId,
    initial.returnAuthorizationId,
  );
  await lockTenant(tx, "ReturnPostingDocument", tenantId, [postingId]);
  const postingLines = await tx.returnPostingLine.findMany({
    where: { returnPostingId: postingId },
    select: { id: true, quarantineBalanceId: true },
  });
  await lockChildren(
    tx,
    "ReturnPostingLine",
    postingLines.map((row) => row.id),
  );
  return {
    ...aggregate,
    authorizationId: initial.returnAuthorizationId,
    lines: postingLines,
  };
}
async function lockBalances(tx, tenantId, rows) {
  for (const id of [
    ...new Set(rows.map((row) => row.quarantineBalanceId).filter(Boolean)),
  ].sort()) {
    const locked = await tx.$queryRawUnsafe(
      'SELECT "id" FROM "QuarantineInventoryBalance" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE',
      tenantId,
      id,
    );
    if (!locked.length)
      fail("RETURN_POSTING_BALANCE_NOT_FOUND", "Quarantine balance was not found.", 404);
  }
}
const model = (posting) => ({
  id: posting.id,
  postingNumber: posting.postingNumber,
  postingType: posting.postingType,
  workflowStatus: posting.workflowStatus,
  postingStatus: posting.postingStatus,
  warehouseId: posting.warehouseId,
  returnAuthorizationId: posting.returnAuthorizationId,
  version: posting.version,
});
const audit = ({
  idFactory,
  actor,
  action,
  posting,
  summary,
  commandType,
  idempotencyKey,
  before,
  after,
  metadata,
}) => ({
  id: idFactory(),
  tenantId: actor.tenantId,
  actorId: actor.user.id,
  source: "customer_return_command_service",
  module: "returns",
  action,
  entityType: "ReturnPostingDocument",
  entityId: posting.id,
  summary,
  metadata: { commandType, idempotencyKey, before, after, ...(metadata || {}) },
});

export function createCustomerReturnCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");
  async function execute(type, input, context, work) {
    assertEnabled(env);
    const identity = context?.identity || context;
    if (!identity?.authenticated || !text(identity.tenantId))
      fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    const normalized = normalize(type, input);
    const where = executionWhere(identity.tenantId, type, normalized.idempotencyKey);
    const outside = replay(
      await prisma.businessCommandExecution.findUnique({ where }),
      normalized.requestHash,
    );
    if (outside) return outside;
    try {
      return await prisma.$transaction(
        async (tx) => {
          const actor = await resolveProvisionedActor(tx, identity);
          assertAuthorized({ actor, permission: commandPermissions[type], tenantId: actor.tenantId });
          const inside = replay(
            await tx.businessCommandExecution.findUnique({ where }),
            normalized.requestHash,
          );
          if (inside) return inside;
          const execution = await tx.businessCommandExecution.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              commandType: type,
              idempotencyKey: normalized.idempotencyKey,
              requestHash: normalized.requestHash,
              status: "pending",
            },
          });
          const result = await work(tx, actor, normalized.payload, normalized);
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
        error instanceof CustomerReturnCommandError ||
        error?.name === "PilotIdentityError"
      )
        throw error;
      if (error?.code === "P2002") {
        const concurrent = await prisma.businessCommandExecution.findUnique({
          where,
        });
        const repeated = replay(concurrent, normalized.requestHash);
        if (repeated) return repeated;
        if (/postingNumber/i.test(JSON.stringify(error?.meta || error)))
          fail("RETURN_POSTING_NUMBER_CONFLICT", "Return posting number is already in use.", 409);
      }
      if (
        error?.code === "P2034" ||
        error?.code === "P2002" ||
        /serialization|deadlock|write conflict/i.test(text(error?.message))
      )
        fail(
          "RETURN_POSTING_CONCURRENT_CONFLICT",
          "Customer return state changed in another transaction. Refresh and retry.",
          409,
        );
      throw error;
    }
  }

  async function createDraft(input, context) {
    return execute(TYPES.create, input, context, async (tx, actor, payload, normalized) => {
      await lockAuthorization(tx, actor.tenantId, payload.authorizationId);
      const auth = await tx.returnAuthorization.findFirst({
        where: { id: payload.authorizationId, tenantId: actor.tenantId },
      });
      if (auth.version !== payload.expectedAuthorizationVersion)
        fail("RETURN_AUTHORIZATION_VERSION_CONFLICT", "Return authorization version does not match.", 409);
      const plan = enforce(
        await buildCustomerReturnDraftPlan({
          prisma: tx,
          tenantId: actor.tenantId,
          authorizationId: auth.id,
          lines: payload.lines,
          now: now(),
        }),
      );
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
      const posting = await tx.returnPostingDocument.create({
        data: {
          id: idFactory(),
          tenantId: actor.tenantId,
          postingNumber: payload.postingNumber,
          returnAuthorizationId: auth.id,
          postingType: "customer_return_receipt",
          workflowStatus: "draft",
          postingStatus: "unposted",
          warehouseId: plan.normalizedPlan.warehouseId,
        },
      });
      for (const line of plan.normalizedPlan.lines)
        await tx.returnPostingLine.create({
          data: {
            id: idFactory(),
            returnPostingId: posting.id,
            returnAuthorizationLineId: line.returnAuthorizationLineId,
            itemId: line.itemId,
            sku: line.sku,
            itemName: line.itemName,
            quantity: line.quantity,
            unit: line.unit,
            warehouseId: line.warehouseId,
            location: line.location,
            locationKey: line.locationKey,
            quarantineBalanceId: line.quarantineBalanceId,
            metadata: { dispositionRoute: "receive_to_quarantine", balanceType: "quarantine" },
          },
        });
      const event = audit({
        idFactory,
        actor,
        action: "customer_return_receipt_draft_created",
        posting,
        summary: `Customer return receipt ${posting.postingNumber} draft created.`,
        commandType: TYPES.create,
        idempotencyKey: normalized.idempotencyKey,
        before: null,
        after: model(posting),
      });
      await tx.auditLog.create({ data: event });
      return { entityType: "ReturnPostingDocument", entityId: posting.id, posting: model(posting), auditEventId: event.id };
    });
  }

  async function reviseDraft(postingId, input, context) {
    return execute(TYPES.revise, { ...input, postingId }, context, async (tx, actor, payload, normalized) => {
      const locked = await lockPosting(tx, actor.tenantId, postingId);
      const posting = await tx.returnPostingDocument.findFirst({
        where: { id: postingId, tenantId: actor.tenantId },
      });
      if (posting.version !== payload.expectedPostingVersion)
        fail("RETURN_POSTING_VERSION_CONFLICT", "Return posting version does not match.", 409);
      if (posting.workflowStatus !== "draft" || posting.postingStatus !== "unposted")
        fail("RETURN_POSTING_INVALID_STATE", "Only an unposted draft can be revised.", 409);
      const plan = enforce(
        await buildCustomerReturnDraftPlan({
          prisma: tx,
          tenantId: actor.tenantId,
          authorizationId: locked.authorizationId,
          lines: payload.lines,
          now: now(),
        }),
      );
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
      const before = model(posting);
      await tx.returnPostingLine.deleteMany({ where: { returnPostingId: posting.id } });
      for (const line of plan.normalizedPlan.lines)
        await tx.returnPostingLine.create({
          data: {
            id: idFactory(),
            returnPostingId: posting.id,
            returnAuthorizationLineId: line.returnAuthorizationLineId,
            itemId: line.itemId,
            sku: line.sku,
            itemName: line.itemName,
            quantity: line.quantity,
            unit: line.unit,
            warehouseId: line.warehouseId,
            location: line.location,
            locationKey: line.locationKey,
            quarantineBalanceId: line.quarantineBalanceId,
            metadata: { dispositionRoute: "receive_to_quarantine", balanceType: "quarantine" },
          },
        });
      const updated = await tx.returnPostingDocument.update({
        where: { id: posting.id },
        data: {
          postingNumber: payload.postingNumber,
          warehouseId: plan.normalizedPlan.warehouseId,
          version: { increment: 1 },
        },
      });
      const event = audit({
        idFactory, actor, action: "customer_return_receipt_draft_revised", posting,
        summary: `Customer return receipt ${updated.postingNumber} draft revised.`,
        commandType: TYPES.revise, idempotencyKey: normalized.idempotencyKey,
        before, after: model(updated),
      });
      await tx.auditLog.create({ data: event });
      return { entityType: "ReturnPostingDocument", entityId: posting.id, posting: model(updated), auditEventId: event.id };
    });
  }

  async function readyPosting(postingId, input, context) {
    return execute(TYPES.ready, { ...input, postingId }, context, async (tx, actor, payload, normalized) => {
      await lockPosting(tx, actor.tenantId, postingId);
      const posting = await tx.returnPostingDocument.findFirst({ where: { id: postingId, tenantId: actor.tenantId } });
      if (posting.version !== payload.expectedPostingVersion)
        fail("RETURN_POSTING_VERSION_CONFLICT", "Return posting version does not match.", 409);
      const plan = enforce(
        await buildCustomerReturnPostingPlan({
          prisma: tx, tenantId: actor.tenantId, postingId, now: now(), allowedWorkflowStatuses: ["draft"],
        }),
      );
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
      const updated = await tx.returnPostingDocument.update({
        where: { id: posting.id },
        data: { workflowStatus: "ready", readyAt: now(), readyById: actor.user.id, version: { increment: 1 } },
      });
      const event = audit({
        idFactory, actor, action: "customer_return_receipt_readied", posting,
        summary: `Customer return receipt ${posting.postingNumber} marked ready.`,
        commandType: TYPES.ready, idempotencyKey: normalized.idempotencyKey,
        before: model(posting), after: model(updated),
      });
      await tx.auditLog.create({ data: event });
      return { entityType: "ReturnPostingDocument", entityId: posting.id, posting: model(updated), auditEventId: event.id };
    });
  }

  async function cancelPosting(postingId, input, context) {
    return execute(TYPES.cancel, { ...input, postingId }, context, async (tx, actor, payload, normalized) => {
      await lockPosting(tx, actor.tenantId, postingId);
      const posting = await tx.returnPostingDocument.findFirst({ where: { id: postingId, tenantId: actor.tenantId } });
      if (posting.version !== payload.expectedPostingVersion)
        fail("RETURN_POSTING_VERSION_CONFLICT", "Return posting version does not match.", 409);
      if (!["draft", "ready"].includes(posting.workflowStatus) || posting.postingStatus !== "unposted")
        fail("RETURN_POSTING_INVALID_STATE", "Only an unposted receipt can be cancelled.", 409);
      assertWarehouseAccess(actor, [posting.warehouseId], "operate");
      const updated = await tx.returnPostingDocument.update({
        where: { id: posting.id },
        data: {
          workflowStatus: "cancelled", cancelledAt: now(), cancelledById: actor.user.id,
          cancellationReason: payload.reason, version: { increment: 1 },
        },
      });
      const event = audit({
        idFactory, actor, action: "customer_return_receipt_cancelled", posting,
        summary: `Customer return receipt ${posting.postingNumber} cancelled: ${payload.reason}`,
        commandType: TYPES.cancel, idempotencyKey: normalized.idempotencyKey,
        before: model(posting), after: model(updated), metadata: { reason: payload.reason },
      });
      await tx.auditLog.create({ data: event });
      return { entityType: "ReturnPostingDocument", entityId: posting.id, posting: model(updated), auditEventId: event.id };
    });
  }

  async function postReceipt(postingId, input, context) {
    return execute(TYPES.post, { ...input, postingId }, context, async (tx, actor, payload, normalized) => {
      const locked = await lockPosting(tx, actor.tenantId, postingId);
      const [posting, auth, request] = await Promise.all([
        tx.returnPostingDocument.findFirst({ where: { id: postingId, tenantId: actor.tenantId } }),
        tx.returnAuthorization.findFirst({ where: { id: locked.authorizationId, tenantId: actor.tenantId } }),
        tx.returnRequest.findFirst({ where: { id: locked.requestId, tenantId: actor.tenantId } }),
      ]);
      if (posting.version !== payload.expectedPostingVersion)
        fail("RETURN_POSTING_VERSION_CONFLICT", "Return posting version does not match.", 409);
      if (auth.version !== payload.expectedAuthorizationVersion)
        fail("RETURN_AUTHORIZATION_VERSION_CONFLICT", "Return authorization version does not match.", 409);
      if (request.version !== payload.expectedRequestVersion)
        fail("RETURN_REQUEST_VERSION_CONFLICT", "Return request version does not match.", 409);
      await lockBalances(tx, actor.tenantId, locked.lines);
      const plan = enforce(
        await buildCustomerReturnPostingPlan({ prisma: tx, tenantId: actor.tenantId, postingId, now: now() }),
      );
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
      const occurredAt = now(), postingBatchId = idFactory(), movements = [];
      for (const fact of plan.movementFacts)
        movements.push(
          await tx.inventoryMovement.create({
            data: {
              id: idFactory(), tenantId: actor.tenantId, itemId: fact.itemId, sku: fact.sku,
              itemName: fact.itemName, warehouseId: fact.warehouseId, location: fact.location,
              locationKey: fact.locationKey, movementType: "customer_return_quarantine_in",
              movementLabel: "Customer return received to quarantine", movementDate: occurredAt,
              occurredAt, sourceDocument: posting.postingNumber,
              sourceDocumentType: "ReturnPostingDocument", sourceDocumentId: posting.id,
              sourceDocumentLineId: fact.postingLineId, quantityIn: fact.quantity,
              quantityOut: "0.0000", adjustmentQty: "0.0000", status: "posted",
              owner: actor.user.id, actorId: actor.user.id, unit: fact.unit,
              relatedReturnId: request.id, postingBatchId,
              inventoryImpact: "increase_quarantine_on_hand_available_unchanged_v1",
              metadata: {
                balanceType: "quarantine", balanceId: fact.balanceId,
                quarantineBalanceId: fact.balanceId, returnPostingId: posting.id,
                returnAuthorizationId: auth.id, returnRequestId: request.id,
              },
            },
          }),
        );
      for (const impact of plan.balanceImpacts) {
        const changed = await tx.quarantineInventoryBalance.updateMany({
          where: { id: impact.balanceId, tenantId: actor.tenantId, version: impact.version },
          data: { onHandQuantity: impact.onHandAfter, version: { increment: 1 } },
        });
        if (changed.count !== 1)
          fail("RETURN_POSTING_CONCURRENT_CONFLICT", "Quarantine inventory changed during customer receipt.", 409);
      }
      await tx.returnAuthorization.update({
        where: { id: auth.id },
        data: { workflowStatus: plan.authorizationStatusAfter, version: { increment: 1 } },
      });
      await tx.returnRequest.update({
        where: { id: request.id },
        data: { workflowStatus: plan.requestStatusAfter, version: { increment: 1 } },
      });
      const updated = await tx.returnPostingDocument.update({
        where: { id: posting.id },
        data: {
          postingStatus: "posted", postedAt: occurredAt, postedById: actor.user.id,
          version: { increment: 1 },
          metadata: { ...(posting.metadata || {}), postingBatchId, movementIds: movements.map((row) => row.id) },
        },
      });
      const event = audit({
        idFactory, actor, action: "customer_return_received_to_quarantine", posting,
        summary: `Customer return receipt ${posting.postingNumber} posted to quarantine.`,
        commandType: TYPES.post, idempotencyKey: normalized.idempotencyKey,
        before: model(posting), after: model(updated),
        metadata: {
          postingBatchId,
          movementIds: movements.map((row) => row.id),
          balanceImpacts: plan.balanceImpacts.map(
            ({ quantityUnits, ...impact }) => impact,
          ),
        },
      });
      await tx.auditLog.create({ data: event });
      return {
        entityType: "ReturnPostingDocument", entityId: posting.id, posting: model(updated),
        returnAuthorization: { id: auth.id, workflowStatus: plan.authorizationStatusAfter, version: auth.version + 1 },
        returnRequest: { id: request.id, workflowStatus: plan.requestStatusAfter, version: request.version + 1 },
        postingBatchId, movementIds: movements.map((row) => row.id), auditEventId: event.id,
      };
    });
  }

  async function reverseReceipt(postingId, input, context) {
    return execute(TYPES.reverse, { ...input, postingId }, context, async (tx, actor, payload, normalized) => {
      const locked = await lockPosting(tx, actor.tenantId, postingId);
      const [posting, auth, request] = await Promise.all([
        tx.returnPostingDocument.findFirst({ where: { id: postingId, tenantId: actor.tenantId } }),
        tx.returnAuthorization.findFirst({ where: { id: locked.authorizationId, tenantId: actor.tenantId } }),
        tx.returnRequest.findFirst({ where: { id: locked.requestId, tenantId: actor.tenantId } }),
      ]);
      if (posting.version !== payload.expectedPostingVersion)
        fail("RETURN_POSTING_VERSION_CONFLICT", "Return posting version does not match.", 409);
      if (auth.version !== payload.expectedAuthorizationVersion)
        fail("RETURN_AUTHORIZATION_VERSION_CONFLICT", "Return authorization version does not match.", 409);
      if (request.version !== payload.expectedRequestVersion)
        fail("RETURN_REQUEST_VERSION_CONFLICT", "Return request version does not match.", 409);
      await lockBalances(tx, actor.tenantId, locked.lines);
      const originals = await tx.inventoryMovement.findMany({
        where: {
          tenantId: actor.tenantId, sourceDocumentType: "ReturnPostingDocument",
          sourceDocumentId: posting.id, movementType: "customer_return_quarantine_in",
        },
        select: { id: true },
      });
      await lockTenant(tx, "InventoryMovement", actor.tenantId, originals.map((row) => row.id));
      const plan = enforce(
        await buildCustomerReturnReversalPlan({ prisma: tx, tenantId: actor.tenantId, postingId }),
      );
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
      const occurredAt = now(), postingBatchId = idFactory(), movements = [];
      for (const impact of plan.balanceImpacts) {
        const changed = await tx.quarantineInventoryBalance.updateMany({
          where: {
            id: impact.balanceId, tenantId: actor.tenantId, version: impact.version,
            onHandQuantity: { gte: impact.quantity },
          },
          data: { onHandQuantity: impact.onHandAfter, version: { increment: 1 } },
        });
        if (changed.count !== 1)
          fail("RETURN_POSTING_CONCURRENT_CONFLICT", "Quarantine inventory changed during receipt reversal.", 409);
      }
      for (const fact of plan.movementFacts) {
        const reversal = await tx.inventoryMovement.create({
          data: {
            id: idFactory(), tenantId: actor.tenantId, itemId: fact.itemId, sku: fact.sku,
            itemName: fact.itemName, warehouseId: fact.warehouseId, location: fact.location,
            locationKey: fact.locationKey, movementType: "customer_return_receipt_reversal",
            movementLabel: "Customer return receipt reversed", movementDate: occurredAt,
            occurredAt, sourceDocument: posting.postingNumber,
            sourceDocumentType: "ReturnPostingDocument", sourceDocumentId: posting.id,
            sourceDocumentLineId: fact.postingLineId, quantityIn: "0.0000",
            quantityOut: fact.quantity, adjustmentQty: "0.0000", status: "posted",
            owner: actor.user.id, actorId: actor.user.id, unit: fact.unit,
            relatedReturnId: request.id, postingBatchId,
            reversalOfMovementId: fact.originalMovementId,
            inventoryImpact: "decrease_quarantine_on_hand_v1", reason: payload.reason,
            metadata: {
              balanceType: "quarantine", balanceId: fact.balanceId,
              quarantineBalanceId: fact.balanceId, returnPostingId: posting.id,
              returnAuthorizationId: auth.id, returnRequestId: request.id,
              originalPostingBatchId: posting.metadata?.postingBatchId,
            },
          },
        });
        await tx.inventoryMovement.update({
          where: { id: fact.originalMovementId },
          data: { reversedByMovementId: reversal.id },
        });
        movements.push(reversal);
      }
      await tx.returnAuthorization.update({
        where: { id: auth.id },
        data: { workflowStatus: plan.authorizationStatusAfter, version: { increment: 1 } },
      });
      await tx.returnRequest.update({
        where: { id: request.id },
        data: { workflowStatus: plan.requestStatusAfter, version: { increment: 1 } },
      });
      const updated = await tx.returnPostingDocument.update({
        where: { id: posting.id },
        data: {
          postingStatus: "reversed", reversedAt: occurredAt, reversedById: actor.user.id,
          reversalReason: payload.reason, version: { increment: 1 },
          metadata: {
            ...(posting.metadata || {}), reversalPostingBatchId: postingBatchId,
            reversalMovementIds: movements.map((row) => row.id),
          },
        },
      });
      const event = audit({
        idFactory, actor, action: "customer_return_receipt_reversed", posting,
        summary: `Customer return receipt ${posting.postingNumber} reversed: ${payload.reason}`,
        commandType: TYPES.reverse, idempotencyKey: normalized.idempotencyKey,
        before: model(posting), after: model(updated),
        metadata: { reason: payload.reason, postingBatchId, movementIds: movements.map((row) => row.id) },
      });
      await tx.auditLog.create({ data: event });
      return {
        entityType: "ReturnPostingDocument", entityId: posting.id, posting: model(updated),
        returnAuthorization: { id: auth.id, workflowStatus: plan.authorizationStatusAfter, version: auth.version + 1 },
        returnRequest: { id: request.id, workflowStatus: plan.requestStatusAfter, version: request.version + 1 },
        postingBatchId, movementIds: movements.map((row) => row.id), auditEventId: event.id,
      };
    });
  }

  return {
    createDraft,
    reviseDraft,
    readyPosting,
    cancelPosting,
    postReceipt,
    reverseReceipt,
  };
}
