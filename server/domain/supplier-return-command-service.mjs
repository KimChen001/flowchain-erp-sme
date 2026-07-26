import { createHash, randomUUID } from "node:crypto";
import {
  assertWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import {
  buildSupplierReturnDraftPlan,
  buildSupplierReturnPostingPlan,
  buildSupplierReturnReversalPlan,
} from "./supplier-return-transaction-policy.mjs";
import {
  allocateTrackedQuarantineConsumption,
  QuarantineLineageError,
  reverseTrackedQuarantineConsumption,
} from "./quarantine-disposition-lineage.mjs";
import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";
import { assertAuthorized } from "../auth/authorization-service.mjs";

export const SUPPLIER_RETURN_COMMAND_TYPES = Object.freeze({
  create: "create_supplier_return_posting_draft",
  revise: "revise_supplier_return_posting_draft",
  ready: "ready_supplier_return_posting",
  cancel: "cancel_supplier_return_posting",
  post: "post_supplier_return_dispatch",
  reverse: "reverse_supplier_return_dispatch",
});

export class SupplierReturnCommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "SupplierReturnCommandError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new SupplierReturnCommandError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const executionWhere = (tenantId, commandType, idempotencyKey) => ({
  tenantId_commandType_idempotencyKey: {
    tenantId,
    commandType,
    idempotencyKey,
  },
});
const commandPermissions = Object.freeze({
  [SUPPLIER_RETURN_COMMAND_TYPES.create]: "returns.posting.prepare",
  [SUPPLIER_RETURN_COMMAND_TYPES.revise]: "returns.posting.prepare",
  [SUPPLIER_RETURN_COMMAND_TYPES.ready]: "returns.posting.ready",
  [SUPPLIER_RETURN_COMMAND_TYPES.cancel]: "returns.posting.cancel",
  [SUPPLIER_RETURN_COMMAND_TYPES.post]: "returns.posting.post",
  [SUPPLIER_RETURN_COMMAND_TYPES.reverse]: "returns.posting.reverse",
});

function stable(value, parent = "") {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parent));
    return ["lines"].includes(parent)
      ? rows.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        )
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

export const supplierReturnRequestHash = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

function required(value, label, code = "RETURN_POSTING_VALIDATION_FAILED") {
  const normalized = text(value);
  if (!normalized) fail(code, `${label} is required.`, 422);
  return normalized;
}

function version(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    fail(
      "RETURN_POSTING_VERSION_INVALID",
      `${label} must be a non-negative integer.`,
      422,
    );
  return parsed;
}

function normalizedLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    returnAuthorizationLineId: text(line.returnAuthorizationLineId),
    quantity: text(line.quantity),
    inventoryBalanceId: text(line.inventoryBalanceId),
    quarantineBalanceId: text(line.quarantineBalanceId),
  }));
}

function normalize(commandType, input = {}) {
  const idempotencyKey = required(
    input.idempotencyKey,
    "idempotencyKey",
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  let payload;
  if (commandType === SUPPLIER_RETURN_COMMAND_TYPES.create)
    payload = {
      authorizationId: required(input.authorizationId, "authorizationId"),
      postingNumber: required(input.postingNumber, "postingNumber"),
      expectedAuthorizationVersion: version(
        input.expectedAuthorizationVersion,
        "expectedAuthorizationVersion",
      ),
      lines: normalizedLines(input.lines),
    };
  else if (commandType === SUPPLIER_RETURN_COMMAND_TYPES.revise)
    payload = {
      postingId: required(input.postingId, "postingId"),
      postingNumber: required(input.postingNumber, "postingNumber"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
      lines: normalizedLines(input.lines),
    };
  else if (commandType === SUPPLIER_RETURN_COMMAND_TYPES.ready)
    payload = {
      postingId: required(input.postingId, "postingId"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
    };
  else if (commandType === SUPPLIER_RETURN_COMMAND_TYPES.cancel)
    payload = {
      postingId: required(input.postingId, "postingId"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
      reason: required(input.reason, "reason"),
    };
  else if (
    [
      SUPPLIER_RETURN_COMMAND_TYPES.post,
      SUPPLIER_RETURN_COMMAND_TYPES.reverse,
    ].includes(commandType)
  )
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
      ...(commandType === SUPPLIER_RETURN_COMMAND_TYPES.reverse
        ? { reason: required(input.reason, "reason") }
        : {}),
    };
  else
    fail(
      "RETURN_POSTING_COMMAND_INVALID",
      "Unknown supplier return command.",
      422,
    );
  return {
    idempotencyKey,
    payload,
    requestHash: supplierReturnRequestHash(payload),
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
      "The supplier return command is already in progress.",
      409,
    );
  return { ...execution.resultPayload, idempotentReplay: true };
}

function assertEnabled(env) {
  if (
    text(env.FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE).toLowerCase() !== "true"
  )
    fail(
      "RETURN_POSTING_CAPABILITY_NOT_AVAILABLE",
      "Supplier return posting requires database persistence and explicit enablement.",
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

async function lockTenantIds(tx, table, tenantId, ids) {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort()) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
      tenantId,
      id,
    );
    if (!rows.length) return false;
  }
  return true;
}

async function lockChildIds(tx, table, ids) {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort())
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
}

async function lockAuthorizationAggregate(tx, tenantId, authorizationId) {
  if (
    !(await lockTenantIds(tx, "ReturnAuthorization", tenantId, [
      authorizationId,
    ]))
  )
    fail(
      "RETURN_AUTHORIZATION_NOT_FOUND",
      "Return authorization was not found.",
      404,
    );
  const authorization = await tx.returnAuthorization.findFirst({
    where: { id: authorizationId, tenantId },
    select: { returnRequestId: true },
  });
  if (
    !(await lockTenantIds(tx, "ReturnRequest", tenantId, [
      authorization.returnRequestId,
    ]))
  )
    fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
  const authorizationLines = await tx.returnAuthorizationLine.findMany({
    where: { returnAuthorizationId: authorizationId },
    select: { id: true, returnRequestLineId: true },
  });
  await lockChildIds(
    tx,
    "ReturnAuthorizationLine",
    authorizationLines.map((line) => line.id),
  );
  await lockChildIds(
    tx,
    "ReturnRequestLine",
    authorizationLines.map((line) => line.returnRequestLineId),
  );
  return {
    returnRequestId: authorization.returnRequestId,
    authorizationLineIds: authorizationLines.map((line) => line.id),
  };
}

async function lockPostingAggregate(tx, tenantId, postingId) {
  const initial = await tx.returnPostingDocument.findFirst({
    where: { id: postingId, tenantId },
    select: { returnAuthorizationId: true },
  });
  if (!initial)
    fail("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404);
  const authorization = await lockAuthorizationAggregate(
    tx,
    tenantId,
    initial.returnAuthorizationId,
  );
  if (
    !(await lockTenantIds(tx, "ReturnPostingDocument", tenantId, [postingId]))
  )
    fail("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404);
  const lines = await tx.returnPostingLine.findMany({
    where: { returnPostingId: postingId },
    select: {
      id: true,
      inventoryBalanceId: true,
      quarantineBalanceId: true,
    },
  });
  await lockChildIds(
    tx,
    "ReturnPostingLine",
    lines.map((line) => line.id),
  );
  return { ...authorization, returnAuthorizationId: initial.returnAuthorizationId, lines };
}

async function lockBalances(tx, tenantId, lines) {
  const rows = lines
    .flatMap((line) => [
      line.inventoryBalanceId
        ? { table: "InventoryBalance", id: line.inventoryBalanceId }
        : null,
      line.quarantineBalanceId
        ? {
            table: "QuarantineInventoryBalance",
            id: line.quarantineBalanceId,
          }
        : null,
    ])
    .filter(Boolean)
    .filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.table === entry.table && candidate.id === entry.id,
        ) === index,
    )
    .sort((left, right) =>
      `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`),
    );
  for (const row of rows) {
    const locked = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${row.table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
      tenantId,
      row.id,
    );
    if (!locked.length)
      fail(
        "RETURN_POSTING_BALANCE_NOT_FOUND",
        "A supplier return balance was not found.",
        404,
        { balanceType: row.table, balanceId: row.id },
      );
  }
}

function postingModel(posting) {
  return {
    id: posting.id,
    postingNumber: posting.postingNumber,
    postingType: posting.postingType,
    workflowStatus: posting.workflowStatus,
    postingStatus: posting.postingStatus,
    warehouseId: posting.warehouseId,
    returnAuthorizationId: posting.returnAuthorizationId,
    version: posting.version,
  };
}

function auditData({
  idFactory,
  actor,
  action,
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
    source: "supplier_return_command_service",
    module: "returns",
    action,
    entityType: "ReturnPostingDocument",
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

export function createSupplierReturnCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
  faultInjector = async () => {},
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
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "BusinessCommandExecution" WHERE "id" = $1 FOR UPDATE',
            execution.id,
          );
          const commandResult = await work(
            tx,
            actor,
            normalized.payload,
            normalized,
          );
          await faultInjector("before_command_complete", {
            tx,
            commandType,
            result: commandResult,
          });
          await tx.businessCommandExecution.update({
            where: { id: execution.id },
            data: {
              status: "completed",
              entityType: commandResult.entityType,
              entityId: commandResult.entityId,
              resultPayload: commandResult,
              completedAt: now(),
            },
          });
          return { ...commandResult, idempotentReplay: false };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof QuarantineLineageError)
        fail(error.code, error.message, error.status, error.details);
      if (
        error instanceof SupplierReturnCommandError ||
        error?.name === "PilotIdentityError"
      )
        throw error;
      if (isUnique(error)) {
        const concurrent = await prisma.businessCommandExecution.findUnique({
          where,
        });
        const replayed = replay(concurrent, normalized.requestHash);
        if (replayed) return replayed;
        if (/postingNumber/i.test(JSON.stringify(error?.meta || error)))
          fail(
            "RETURN_POSTING_NUMBER_CONFLICT",
            "Return posting number is already in use.",
            409,
          );
      }
      if (isUnique(error) || isConcurrency(error))
        fail(
          "RETURN_POSTING_CONCURRENT_CONFLICT",
          "Supplier return state changed in another transaction. Refresh and retry.",
          409,
        );
      throw error;
    }
  }

  async function createPostingDraft(input, context) {
    return execute(
      SUPPLIER_RETURN_COMMAND_TYPES.create,
      input,
      context,
      async (tx, actor, payload, normalized) => {
        await lockAuthorizationAggregate(
          tx,
          actor.tenantId,
          payload.authorizationId,
        );
        const authorization = await tx.returnAuthorization.findFirst({
          where: { id: payload.authorizationId, tenantId: actor.tenantId },
        });
        if (authorization.version !== payload.expectedAuthorizationVersion)
          fail(
            "RETURN_AUTHORIZATION_VERSION_CONFLICT",
            "Return authorization version does not match.",
            409,
          );
        const plan = enforce(
          await buildSupplierReturnDraftPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            authorizationId: payload.authorizationId,
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
            returnAuthorizationId: payload.authorizationId,
            postingType: "supplier_return_dispatch",
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
              inventoryBalanceId: line.inventoryBalanceId,
              quarantineBalanceId: line.quarantineBalanceId,
              metadata: {
                dispositionRoute: line.dispositionRoute,
                balanceType: line.balanceType,
              },
            },
          });
        const after = postingModel(posting);
        const audit = auditData({
          idFactory,
          actor,
          action: "supplier_return_posting_draft_created",
          entityId: posting.id,
          summary: `Supplier return posting ${posting.postingNumber} draft created.`,
          commandType: SUPPLIER_RETURN_COMMAND_TYPES.create,
          idempotencyKey: normalized.idempotencyKey,
          before: null,
          after,
          metadata: {
            returnAuthorizationId: payload.authorizationId,
            returnRequestId: plan.normalizedPlan.returnRequestId,
          },
        });
        await tx.auditLog.create({ data: audit });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: after,
          auditEventId: audit.id,
        };
      },
    );
  }

  async function revisePostingDraft(postingId, input, context) {
    return execute(
      SUPPLIER_RETURN_COMMAND_TYPES.revise,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        const locked = await lockPostingAggregate(
          tx,
          actor.tenantId,
          payload.postingId,
        );
        const posting = await tx.returnPostingDocument.findFirst({
          where: { id: payload.postingId, tenantId: actor.tenantId },
        });
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        if (
          posting.workflowStatus !== "draft" ||
          posting.postingStatus !== "unposted"
        )
          fail(
            "RETURN_POSTING_INVALID_STATE",
            "Only an unposted draft can be revised.",
            409,
          );
        const plan = enforce(
          await buildSupplierReturnDraftPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            authorizationId: locked.returnAuthorizationId,
            lines: payload.lines,
            now: now(),
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const before = postingModel(posting);
        await tx.returnPostingLine.deleteMany({
          where: { returnPostingId: posting.id },
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
              inventoryBalanceId: line.inventoryBalanceId,
              quarantineBalanceId: line.quarantineBalanceId,
              metadata: {
                dispositionRoute: line.dispositionRoute,
                balanceType: line.balanceType,
              },
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
        const after = postingModel(updated);
        const audit = auditData({
          idFactory,
          actor,
          action: "supplier_return_posting_draft_revised",
          entityId: posting.id,
          summary: `Supplier return posting ${updated.postingNumber} draft revised.`,
          commandType: SUPPLIER_RETURN_COMMAND_TYPES.revise,
          idempotencyKey: normalized.idempotencyKey,
          before,
          after,
        });
        await tx.auditLog.create({ data: audit });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: after,
          auditEventId: audit.id,
        };
      },
    );
  }

  async function readyPosting(postingId, input, context) {
    return execute(
      SUPPLIER_RETURN_COMMAND_TYPES.ready,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockPostingAggregate(tx, actor.tenantId, payload.postingId);
        const posting = await tx.returnPostingDocument.findFirst({
          where: { id: payload.postingId, tenantId: actor.tenantId },
        });
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        const plan = enforce(
          await buildSupplierReturnPostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            postingId: posting.id,
            now: now(),
            allowedWorkflowStatuses: ["draft"],
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const before = postingModel(posting);
        const occurredAt = now();
        const updated = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            workflowStatus: "ready",
            readyAt: occurredAt,
            readyById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const after = postingModel(updated);
        const audit = auditData({
          idFactory,
          actor,
          action: "supplier_return_posting_readied",
          entityId: posting.id,
          summary: `Supplier return posting ${posting.postingNumber} marked ready.`,
          commandType: SUPPLIER_RETURN_COMMAND_TYPES.ready,
          idempotencyKey: normalized.idempotencyKey,
          before,
          after,
        });
        await tx.auditLog.create({ data: audit });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: after,
          auditEventId: audit.id,
        };
      },
    );
  }

  async function cancelPosting(postingId, input, context) {
    return execute(
      SUPPLIER_RETURN_COMMAND_TYPES.cancel,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockPostingAggregate(tx, actor.tenantId, payload.postingId);
        const posting = await tx.returnPostingDocument.findFirst({
          where: { id: payload.postingId, tenantId: actor.tenantId },
        });
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        if (
          !["draft", "ready"].includes(posting.workflowStatus) ||
          posting.postingStatus !== "unposted"
        )
          fail(
            "RETURN_POSTING_INVALID_STATE",
            "Only a draft or ready unposted return can be cancelled.",
            409,
          );
        assertWarehouseAccess(actor, [posting.warehouseId], "operate");
        const before = postingModel(posting);
        const occurredAt = now();
        const updated = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            workflowStatus: "cancelled",
            cancelledAt: occurredAt,
            cancelledById: actor.user.id,
            cancellationReason: payload.reason,
            version: { increment: 1 },
          },
        });
        const after = postingModel(updated);
        const audit = auditData({
          idFactory,
          actor,
          action: "supplier_return_posting_cancelled",
          entityId: posting.id,
          summary: `Supplier return posting ${posting.postingNumber} cancelled: ${payload.reason}`,
          commandType: SUPPLIER_RETURN_COMMAND_TYPES.cancel,
          idempotencyKey: normalized.idempotencyKey,
          before,
          after,
          metadata: { reason: payload.reason },
        });
        await tx.auditLog.create({ data: audit });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: after,
          auditEventId: audit.id,
        };
      },
    );
  }

  async function postSupplierReturn(postingId, input, context) {
    return execute(
      SUPPLIER_RETURN_COMMAND_TYPES.post,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        const locked = await lockPostingAggregate(
          tx,
          actor.tenantId,
          payload.postingId,
        );
        const [posting, authorization, request] = await Promise.all([
          tx.returnPostingDocument.findFirst({
            where: { id: payload.postingId, tenantId: actor.tenantId },
          }),
          tx.returnAuthorization.findFirst({
            where: {
              id: locked.returnAuthorizationId,
              tenantId: actor.tenantId,
            },
          }),
          tx.returnRequest.findFirst({
            where: { id: locked.returnRequestId, tenantId: actor.tenantId },
          }),
        ]);
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        if (authorization.version !== payload.expectedAuthorizationVersion)
          fail(
            "RETURN_AUTHORIZATION_VERSION_CONFLICT",
            "Return authorization version does not match.",
            409,
          );
        if (request.version !== payload.expectedRequestVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        await lockBalances(tx, actor.tenantId, locked.lines);
        const plan = enforce(
          await buildSupplierReturnPostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            postingId: posting.id,
            now: now(),
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const postingBatchId = idFactory();
        const occurredAt = now();
        const movements = [];
        const quarantineRemaining = new Map(
          plan.normalizedPlan.lines
            .filter((line) => line.balanceType === "quarantine" && line.balance)
            .map((line) => [
              line.balanceId,
              {
                balance: line.balance,
                units: decimalUnits(line.balance.onHandQuantity),
              },
            ]),
        );
        for (const fact of plan.movementFacts) {
          const movement = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location,
              locationKey: fact.locationKey,
              movementType: "supplier_return_out",
              movementLabel: "Supplier return dispatched",
              movementDate: occurredAt,
              occurredAt,
              sourceDocument: posting.postingNumber,
              sourceDocumentType: "ReturnPostingDocument",
              sourceDocumentId: posting.id,
              sourceDocumentLineId: fact.postingLineId,
              quantityIn: "0.0000",
              quantityOut: fact.quantity,
              adjustmentQty: "0.0000",
              status: "posted",
              owner: actor.user.id,
              actorId: actor.user.id,
              unit: fact.unit,
              relatedReturnId: request.id,
              postingBatchId,
              inventoryImpact:
                fact.balanceType === "available"
                  ? "decrease_available_on_hand_reserved_unchanged_v1"
                  : "decrease_quarantine_on_hand_v1",
              metadata: {
                balanceType: fact.balanceType,
                balanceId: fact.balanceId,
                quarantineBalanceId:
                  fact.balanceType === "quarantine" ? fact.balanceId : null,
                returnPostingId: posting.id,
                returnAuthorizationId: authorization.id,
                returnRequestId: request.id,
              },
            },
          });
          movements.push(movement);
          if (fact.balanceType === "quarantine") {
            const layerState = quarantineRemaining.get(fact.balanceId);
            await allocateTrackedQuarantineConsumption({
              tx,
              tenantId: actor.tenantId,
              quarantineBalance: {
                ...layerState.balance,
                onHandQuantity: decimalString(layerState.units),
              },
              consumerMovement: movement,
              quantity: fact.quantity,
              idFactory,
            });
            layerState.units -= decimalUnits(fact.quantity);
          }
        }
        for (const impact of plan.balanceImpacts) {
          if (impact.balanceType === "available") {
            const updated = await tx.inventoryBalance.updateMany({
              where: {
                id: impact.balanceId,
                tenantId: actor.tenantId,
                version: impact.version,
                onHandQuantity: { gte: impact.quantity },
                availableQuantity: { gte: impact.quantity },
              },
              data: {
                onHandQuantity: impact.onHandAfter,
                reservedQuantity: impact.reservedAfter,
                availableQuantity: impact.availableAfter,
                version: { increment: 1 },
              },
            });
            if (updated.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Available inventory changed during supplier return posting.",
                409,
              );
          } else {
            const updated = await tx.quarantineInventoryBalance.updateMany({
              where: {
                id: impact.balanceId,
                tenantId: actor.tenantId,
                version: impact.version,
                onHandQuantity: { gte: impact.quantity },
              },
              data: {
                onHandQuantity: impact.onHandAfter,
                version: { increment: 1 },
              },
            });
            if (updated.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Quarantine inventory changed during supplier return posting.",
                409,
              );
          }
        }
        await tx.returnAuthorization.update({
          where: { id: authorization.id },
          data: {
            workflowStatus: plan.authorizationStatusAfter,
            version: { increment: 1 },
          },
        });
        await tx.returnRequest.update({
          where: { id: request.id },
          data: {
            workflowStatus: plan.requestStatusAfter,
            version: { increment: 1 },
          },
        });
        const updatedPosting = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            postingStatus: "posted",
            postedAt: occurredAt,
            postedById: actor.user.id,
            version: { increment: 1 },
            metadata: {
              ...(posting.metadata || {}),
              postingBatchId,
              movementIds: movements.map((movement) => movement.id),
            },
          },
        });
        const before = postingModel(posting);
        const after = postingModel(updatedPosting);
        const audit = auditData({
          idFactory,
          actor,
          action: "supplier_return_posted",
          entityId: posting.id,
          summary: `Supplier return posting ${posting.postingNumber} posted.`,
          commandType: SUPPLIER_RETURN_COMMAND_TYPES.post,
          idempotencyKey: normalized.idempotencyKey,
          before,
          after,
          metadata: {
            postingBatchId,
            movementIds: movements.map((movement) => movement.id),
            returnAuthorizationId: authorization.id,
            returnRequestId: request.id,
            balanceImpacts: plan.balanceImpacts.map((impact) => ({
              balanceType: impact.balanceType,
              balanceId: impact.balanceId,
              quantity: impact.quantity,
              onHandBefore: impact.onHandBefore,
              onHandAfter: impact.onHandAfter,
              ...(impact.balanceType === "available"
                ? {
                    reservedBefore: impact.reservedBefore,
                    reservedAfter: impact.reservedAfter,
                    availableBefore: impact.availableBefore,
                    availableAfter: impact.availableAfter,
                  }
                : {}),
            })),
          },
        });
        await tx.auditLog.create({ data: audit });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: after,
          returnAuthorization: {
            id: authorization.id,
            workflowStatus: plan.authorizationStatusAfter,
            version: authorization.version + 1,
          },
          returnRequest: {
            id: request.id,
            workflowStatus: plan.requestStatusAfter,
            version: request.version + 1,
          },
          postingBatchId,
          movementIds: movements.map((movement) => movement.id),
          auditEventId: audit.id,
        };
      },
    );
  }

  async function reverseSupplierReturn(postingId, input, context) {
    return execute(
      SUPPLIER_RETURN_COMMAND_TYPES.reverse,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        const locked = await lockPostingAggregate(
          tx,
          actor.tenantId,
          payload.postingId,
        );
        const [posting, authorization, request] = await Promise.all([
          tx.returnPostingDocument.findFirst({
            where: { id: payload.postingId, tenantId: actor.tenantId },
          }),
          tx.returnAuthorization.findFirst({
            where: {
              id: locked.returnAuthorizationId,
              tenantId: actor.tenantId,
            },
          }),
          tx.returnRequest.findFirst({
            where: { id: locked.returnRequestId, tenantId: actor.tenantId },
          }),
        ]);
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        if (authorization.version !== payload.expectedAuthorizationVersion)
          fail(
            "RETURN_AUTHORIZATION_VERSION_CONFLICT",
            "Return authorization version does not match.",
            409,
          );
        if (request.version !== payload.expectedRequestVersion)
          fail(
            "RETURN_REQUEST_VERSION_CONFLICT",
            "Return request version does not match.",
            409,
          );
        await lockBalances(tx, actor.tenantId, locked.lines);
        const originalMovements = await tx.inventoryMovement.findMany({
          where: {
            tenantId: actor.tenantId,
            sourceDocumentType: "ReturnPostingDocument",
            sourceDocumentId: posting.id,
            movementType: "supplier_return_out",
          },
          select: { id: true },
        });
        await lockTenantIds(
          tx,
          "InventoryMovement",
          actor.tenantId,
          originalMovements.map((movement) => movement.id),
        );
        const plan = enforce(
          await buildSupplierReturnReversalPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            postingId: posting.id,
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const postingBatchId = idFactory();
        const occurredAt = now();
        const movements = [];
        for (const impact of plan.balanceImpacts) {
          if (impact.balanceType === "available") {
            const updated = await tx.inventoryBalance.updateMany({
              where: {
                id: impact.balanceId,
                tenantId: actor.tenantId,
                version: impact.version,
              },
              data: {
                onHandQuantity: impact.onHandAfter,
                reservedQuantity: impact.reservedAfter,
                availableQuantity: impact.availableAfter,
                version: { increment: 1 },
              },
            });
            if (updated.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Available inventory changed during supplier return reversal.",
                409,
              );
          } else {
            const updated = await tx.quarantineInventoryBalance.updateMany({
              where: {
                id: impact.balanceId,
                tenantId: actor.tenantId,
                version: impact.version,
              },
              data: {
                onHandQuantity: impact.onHandAfter,
                version: { increment: 1 },
              },
            });
            if (updated.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Quarantine inventory changed during supplier return reversal.",
                409,
              );
          }
        }
        for (const fact of plan.movementFacts) {
          const reversal = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: fact.itemId,
              sku: fact.sku,
              itemName: fact.itemName,
              warehouseId: fact.warehouseId,
              location: fact.location,
              locationKey: fact.locationKey,
              movementType: "supplier_return_reversal",
              movementLabel: "Supplier return reversed",
              movementDate: occurredAt,
              occurredAt,
              sourceDocument: posting.postingNumber,
              sourceDocumentType: "ReturnPostingDocument",
              sourceDocumentId: posting.id,
              sourceDocumentLineId: fact.postingLineId,
              quantityIn: fact.quantity,
              quantityOut: "0.0000",
              adjustmentQty: "0.0000",
              status: "posted",
              owner: actor.user.id,
              actorId: actor.user.id,
              unit: fact.unit,
              relatedReturnId: request.id,
              postingBatchId,
              reversalOfMovementId: fact.originalMovementId,
              inventoryImpact:
                fact.balanceType === "available"
                  ? "restore_available_on_hand_reserved_unchanged_v1"
                  : "restore_quarantine_on_hand_v1",
              reason: payload.reason,
              metadata: {
                balanceType: fact.balanceType,
                balanceId: fact.balanceId,
                quarantineBalanceId:
                  fact.balanceType === "quarantine" ? fact.balanceId : null,
                returnPostingId: posting.id,
                returnAuthorizationId: authorization.id,
                returnRequestId: request.id,
                originalPostingBatchId: posting.metadata?.postingBatchId,
              },
            },
          });
          await tx.inventoryMovement.update({
            where: { id: fact.originalMovementId },
            data: { reversedByMovementId: reversal.id },
          });
          if (fact.balanceType === "quarantine")
            await reverseTrackedQuarantineConsumption({
              tx,
              tenantId: actor.tenantId,
              consumerMovementId: fact.originalMovementId,
              reversalMovementId: reversal.id,
              reversedAt: occurredAt,
            });
          movements.push(reversal);
        }
        await tx.returnAuthorization.update({
          where: { id: authorization.id },
          data: {
            workflowStatus: plan.authorizationStatusAfter,
            version: { increment: 1 },
          },
        });
        await tx.returnRequest.update({
          where: { id: request.id },
          data: {
            workflowStatus: plan.requestStatusAfter,
            version: { increment: 1 },
          },
        });
        const updatedPosting = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            postingStatus: "reversed",
            reversedAt: occurredAt,
            reversedById: actor.user.id,
            reversalReason: payload.reason,
            version: { increment: 1 },
            metadata: {
              ...(posting.metadata || {}),
              reversalPostingBatchId: postingBatchId,
              reversalMovementIds: movements.map((movement) => movement.id),
            },
          },
        });
        const before = postingModel(posting);
        const after = postingModel(updatedPosting);
        const audit = auditData({
          idFactory,
          actor,
          action: "supplier_return_reversed",
          entityId: posting.id,
          summary: `Supplier return posting ${posting.postingNumber} reversed: ${payload.reason}`,
          commandType: SUPPLIER_RETURN_COMMAND_TYPES.reverse,
          idempotencyKey: normalized.idempotencyKey,
          before,
          after,
          metadata: {
            reason: payload.reason,
            postingBatchId,
            originalPostingBatchId: posting.metadata?.postingBatchId,
            movementIds: movements.map((movement) => movement.id),
          },
        });
        await tx.auditLog.create({ data: audit });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: after,
          returnAuthorization: {
            id: authorization.id,
            workflowStatus: plan.authorizationStatusAfter,
            version: authorization.version + 1,
          },
          returnRequest: {
            id: request.id,
            workflowStatus: plan.requestStatusAfter,
            version: request.version + 1,
          },
          postingBatchId,
          movementIds: movements.map((movement) => movement.id),
          auditEventId: audit.id,
        };
      },
    );
  }

  return {
    createPostingDraft,
    revisePostingDraft,
    readyPosting,
    cancelPosting,
    postSupplierReturn,
    reverseSupplierReturn,
  };
}
