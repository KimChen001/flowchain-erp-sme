import { createHash, randomUUID } from "node:crypto";
import {
  assertWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import {
  buildQuarantineReleaseDraftPlan,
  buildQuarantineReleasePostingPlan,
  buildQuarantineReleaseReversalPlan,
  quarantineReleaseDecimalString as decimalString,
  quarantineReleaseDecimalUnits as decimalUnits,
} from "./quarantine-release-transaction-policy.mjs";
import {
  allocateTrackedQuarantineConsumption,
  QuarantineLineageError,
  reverseTrackedQuarantineConsumption,
} from "./quarantine-disposition-lineage.mjs";
import { assertAuthorized } from "../auth/authorization-service.mjs";

export class QuarantineReleaseCommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "QuarantineReleaseCommandError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new QuarantineReleaseCommandError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const TYPES = {
  create: "create_quarantine_release_draft",
  revise: "revise_quarantine_release_draft",
  ready: "ready_quarantine_release",
  cancel: "cancel_quarantine_release",
  post: "post_quarantine_release",
  reverse: "reverse_quarantine_release",
};
const commandPermissions = Object.freeze({
  [TYPES.create]: "returns.quarantine.release_prepare",
  [TYPES.revise]: "returns.quarantine.release_prepare",
  [TYPES.ready]: "returns.quarantine.release_prepare",
  [TYPES.cancel]: "returns.quarantine.release_prepare",
  [TYPES.post]: "returns.quarantine.release_post",
  [TYPES.reverse]: "returns.quarantine.release_reverse",
});

function stable(value, parent = "") {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parent));
    return parent === "lines"
      ? rows.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
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
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const required = (
  value,
  label,
  code = "RETURN_POSTING_VALIDATION_FAILED",
) => {
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
const normalizeLines = (rows = []) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    returnAuthorizationLineId: text(row.returnAuthorizationLineId),
    quantity: text(row.quantity),
    quarantineBalanceId: text(row.quarantineBalanceId),
    destinationInventoryBalanceId: text(
      row.destinationInventoryBalanceId,
    ),
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
      lines: normalizeLines(input.lines),
    };
  else if (type === TYPES.revise)
    payload = {
      postingId: required(input.postingId, "postingId"),
      postingNumber: required(input.postingNumber, "postingNumber"),
      expectedPostingVersion: version(
        input.expectedPostingVersion,
        "expectedPostingVersion",
      ),
      lines: normalizeLines(input.lines),
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
  else
    fail(
      "RETURN_POSTING_COMMAND_INVALID",
      "Unknown quarantine release command.",
      422,
    );
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
    fail(
      "COMMAND_EXECUTION_IN_PROGRESS",
      "The command is already in progress.",
      409,
    );
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
    text(env.FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE).toLowerCase() !==
      "true"
  )
    fail(
      "RETURN_POSTING_CAPABILITY_NOT_AVAILABLE",
      "Quarantine release requires database persistence and explicit enablement.",
      409,
    );
}

async function lockTenantIds(tx, table, tenantId, ids) {
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
async function lockChildIds(tx, table, ids) {
  for (const id of [...new Set(ids.filter(Boolean))].sort())
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
}
async function lockAuthorization(tx, tenantId, authorizationId) {
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
  const lines = await tx.returnAuthorizationLine.findMany({
    where: { returnAuthorizationId: authorizationId },
    select: { id: true, returnRequestLineId: true },
  });
  await lockChildIds(
    tx,
    "ReturnAuthorizationLine",
    lines.map((line) => line.id),
  );
  await lockChildIds(
    tx,
    "ReturnRequestLine",
    lines.map((line) => line.returnRequestLineId),
  );
  return { requestId: authorization.returnRequestId };
}
async function lockPosting(tx, tenantId, postingId) {
  const initial = await tx.returnPostingDocument.findFirst({
    where: { id: postingId, tenantId },
    select: { returnAuthorizationId: true },
  });
  if (!initial)
    fail("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404);
  const authorization = await lockAuthorization(
    tx,
    tenantId,
    initial.returnAuthorizationId,
  );
  await lockTenantIds(tx, "ReturnPostingDocument", tenantId, [postingId]);
  const lines = await tx.returnPostingLine.findMany({
    where: { returnPostingId: postingId },
    select: {
      id: true,
      quarantineBalanceId: true,
      destinationInventoryBalanceId: true,
    },
  });
  await lockChildIds(
    tx,
    "ReturnPostingLine",
    lines.map((line) => line.id),
  );
  return {
    ...authorization,
    authorizationId: initial.returnAuthorizationId,
    lines,
  };
}
async function lockBalances(tx, tenantId, lines) {
  const rows = lines
    .flatMap((line) => [
      line.destinationInventoryBalanceId
        ? {
            table: "InventoryBalance",
            id: line.destinationInventoryBalanceId,
          }
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
        "A quarantine release balance was not found.",
        404,
        { balanceType: row.table, balanceId: row.id },
      );
  }
}

const postingModel = (posting) => ({
  id: posting.id,
  postingNumber: posting.postingNumber,
  postingType: posting.postingType,
  workflowStatus: posting.workflowStatus,
  postingStatus: posting.postingStatus,
  warehouseId: posting.warehouseId,
  returnAuthorizationId: posting.returnAuthorizationId,
  version: posting.version,
});
const auditData = ({
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
  source: "quarantine_release_command_service",
  module: "returns",
  action,
  entityType: "ReturnPostingDocument",
  entityId: posting.id,
  summary,
  metadata: {
    commandType,
    idempotencyKey,
    before,
    after,
    ...(metadata || {}),
  },
});

export function createQuarantineReleaseCommandService({
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
    const where = executionWhere(
      identity.tenantId,
      type,
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
        {
          isolationLevel: "Serializable",
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      if (error instanceof QuarantineLineageError)
        fail(error.code, error.message, error.status, error.details);
      if (
        error instanceof QuarantineReleaseCommandError ||
        error?.name === "PilotIdentityError"
      )
        throw error;
      if (error?.code === "P2002") {
        const repeated = replay(
          await prisma.businessCommandExecution.findUnique({ where }),
          normalized.requestHash,
        );
        if (repeated) return repeated;
        if (/postingNumber/i.test(JSON.stringify(error?.meta || error)))
          fail(
            "RETURN_POSTING_NUMBER_CONFLICT",
            "Return posting number is already in use.",
            409,
          );
      }
      if (
        error?.code === "P2034" ||
        error?.code === "P2002" ||
        /serialization|deadlock|write conflict/i.test(text(error?.message))
      )
        fail(
          "RETURN_POSTING_CONCURRENT_CONFLICT",
          "Quarantine release state changed in another transaction. Refresh and retry.",
          409,
        );
      throw error;
    }
  }

  async function createDraft(input, context) {
    return execute(
      TYPES.create,
      input,
      context,
      async (tx, actor, payload, normalized) => {
        await lockAuthorization(
          tx,
          actor.tenantId,
          payload.authorizationId,
        );
        const authorization = await tx.returnAuthorization.findFirst({
          where: {
            id: payload.authorizationId,
            tenantId: actor.tenantId,
          },
        });
        if (
          authorization.version !== payload.expectedAuthorizationVersion
        )
          fail(
            "RETURN_AUTHORIZATION_VERSION_CONFLICT",
            "Return authorization version does not match.",
            409,
          );
        const plan = enforce(
          await buildQuarantineReleaseDraftPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            authorizationId: authorization.id,
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
            returnAuthorizationId: authorization.id,
            postingType: "quarantine_release",
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
              returnAuthorizationLineId:
                line.returnAuthorizationLineId,
              itemId: line.itemId,
              sku: line.sku,
              itemName: line.itemName,
              quantity: line.quantity,
              unit: line.unit,
              warehouseId: line.warehouseId,
              location: line.location,
              locationKey: line.locationKey,
              quarantineBalanceId: line.quarantineBalanceId,
              destinationInventoryBalanceId:
                line.destinationInventoryBalanceId,
              metadata: {
                dispositionRoute: "release_quarantine_to_available",
                balanceType: "quarantine_to_available",
              },
            },
          });
        const event = auditData({
          idFactory,
          actor,
          action: "quarantine_release_draft_created",
          posting,
          summary: `Quarantine release ${posting.postingNumber} draft created.`,
          commandType: TYPES.create,
          idempotencyKey: normalized.idempotencyKey,
          before: null,
          after: postingModel(posting),
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: postingModel(posting),
          auditEventId: event.id,
        };
      },
    );
  }

  async function reviseDraft(postingId, input, context) {
    return execute(
      TYPES.revise,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        const locked = await lockPosting(tx, actor.tenantId, postingId);
        const posting = await tx.returnPostingDocument.findFirst({
          where: { id: postingId, tenantId: actor.tenantId },
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
            "Only an unposted release draft can be revised.",
            409,
          );
        const plan = enforce(
          await buildQuarantineReleaseDraftPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            authorizationId: locked.authorizationId,
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
              returnAuthorizationLineId:
                line.returnAuthorizationLineId,
              itemId: line.itemId,
              sku: line.sku,
              itemName: line.itemName,
              quantity: line.quantity,
              unit: line.unit,
              warehouseId: line.warehouseId,
              location: line.location,
              locationKey: line.locationKey,
              quarantineBalanceId: line.quarantineBalanceId,
              destinationInventoryBalanceId:
                line.destinationInventoryBalanceId,
              metadata: {
                dispositionRoute: "release_quarantine_to_available",
                balanceType: "quarantine_to_available",
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
        const event = auditData({
          idFactory,
          actor,
          action: "quarantine_release_draft_revised",
          posting,
          summary: `Quarantine release ${updated.postingNumber} draft revised.`,
          commandType: TYPES.revise,
          idempotencyKey: normalized.idempotencyKey,
          before,
          after: postingModel(updated),
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: postingModel(updated),
          auditEventId: event.id,
        };
      },
    );
  }

  async function readyPosting(postingId, input, context) {
    return execute(
      TYPES.ready,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockPosting(tx, actor.tenantId, postingId);
        const posting = await tx.returnPostingDocument.findFirst({
          where: { id: postingId, tenantId: actor.tenantId },
        });
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        const plan = enforce(
          await buildQuarantineReleasePostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            postingId,
            now: now(),
            allowedWorkflowStatuses: ["draft"],
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const updated = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            workflowStatus: "ready",
            readyAt: now(),
            readyById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const event = auditData({
          idFactory,
          actor,
          action: "quarantine_release_readied",
          posting,
          summary: `Quarantine release ${posting.postingNumber} marked ready.`,
          commandType: TYPES.ready,
          idempotencyKey: normalized.idempotencyKey,
          before: postingModel(posting),
          after: postingModel(updated),
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: postingModel(updated),
          auditEventId: event.id,
        };
      },
    );
  }

  async function cancelPosting(postingId, input, context) {
    return execute(
      TYPES.cancel,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        await lockPosting(tx, actor.tenantId, postingId);
        const posting = await tx.returnPostingDocument.findFirst({
          where: { id: postingId, tenantId: actor.tenantId },
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
            "Only an unposted quarantine release can be cancelled.",
            409,
          );
        assertWarehouseAccess(actor, [posting.warehouseId], "operate");
        const updated = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            workflowStatus: "cancelled",
            cancelledAt: now(),
            cancelledById: actor.user.id,
            cancellationReason: payload.reason,
            version: { increment: 1 },
          },
        });
        const event = auditData({
          idFactory,
          actor,
          action: "quarantine_release_cancelled",
          posting,
          summary: `Quarantine release ${posting.postingNumber} cancelled: ${payload.reason}`,
          commandType: TYPES.cancel,
          idempotencyKey: normalized.idempotencyKey,
          before: postingModel(posting),
          after: postingModel(updated),
          metadata: { reason: payload.reason },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: postingModel(updated),
          auditEventId: event.id,
        };
      },
    );
  }

  async function postRelease(postingId, input, context) {
    return execute(
      TYPES.post,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        const locked = await lockPosting(tx, actor.tenantId, postingId);
        const [posting, authorization, request] = await Promise.all([
          tx.returnPostingDocument.findFirst({
            where: { id: postingId, tenantId: actor.tenantId },
          }),
          tx.returnAuthorization.findFirst({
            where: {
              id: locked.authorizationId,
              tenantId: actor.tenantId,
            },
          }),
          tx.returnRequest.findFirst({
            where: { id: locked.requestId, tenantId: actor.tenantId },
          }),
        ]);
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        if (
          authorization.version !== payload.expectedAuthorizationVersion
        )
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
          await buildQuarantineReleasePostingPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            postingId,
            now: now(),
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const occurredAt = now();
        const postingBatchId = idFactory();
        const movementByLine = new Map();
        const sourceRemaining = new Map(
          plan.normalizedPlan.lines.map((line) => [
            line.quarantineBalanceId,
            {
              balance: line.source,
              units: decimalUnits(line.source.onHandQuantity),
            },
          ]),
        );
        for (const line of plan.normalizedPlan.lines) {
          const out = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: line.itemId,
              sku: line.sku,
              itemName: line.itemName,
              warehouseId: line.warehouseId,
              location: line.location,
              locationKey: line.locationKey,
              movementType: "quarantine_release_out",
              movementLabel: "Quarantine inventory released",
              movementDate: occurredAt,
              occurredAt,
              sourceDocument: posting.postingNumber,
              sourceDocumentType: "ReturnPostingDocument",
              sourceDocumentId: posting.id,
              sourceDocumentLineId: line.id,
              quantityIn: "0.0000",
              quantityOut: line.quantity,
              adjustmentQty: "0.0000",
              status: "posted",
              owner: actor.user.id,
              actorId: actor.user.id,
              unit: line.unit,
              relatedReturnId: request.id,
              postingBatchId,
              inventoryImpact: "decrease_quarantine_on_hand_v1",
              metadata: {
                balanceType: "quarantine",
                balanceId: line.quarantineBalanceId,
                quarantineBalanceId: line.quarantineBalanceId,
                destinationInventoryBalanceId:
                  line.destinationInventoryBalanceId,
                returnPostingId: posting.id,
                returnAuthorizationId: authorization.id,
                returnRequestId: request.id,
              },
            },
          });
          const sourceState = sourceRemaining.get(
            line.quarantineBalanceId,
          );
          await allocateTrackedQuarantineConsumption({
            tx,
            tenantId: actor.tenantId,
            quarantineBalance: {
              ...sourceState.balance,
              onHandQuantity: decimalString(sourceState.units),
            },
            consumerMovement: out,
            quantity: line.quantity,
            idFactory,
          });
          sourceState.units -= decimalUnits(line.quantity);
          movementByLine.set(line.id, { out });
        }
        for (const impact of plan.balanceImpacts) {
          if (impact.balanceType === "quarantine") {
            const changed =
              await tx.quarantineInventoryBalance.updateMany({
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
            if (changed.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Quarantine inventory changed during release.",
                409,
              );
          } else {
            const changed = await tx.inventoryBalance.updateMany({
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
            if (changed.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Destination available inventory changed during release.",
                409,
              );
          }
        }
        const destinationImpactById = new Map(
          plan.balanceImpacts
            .filter((impact) => impact.balanceType === "available")
            .map((impact) => [impact.balanceId, impact]),
        );
        for (const line of plan.normalizedPlan.lines) {
          const destinationImpact = destinationImpactById.get(
            line.destinationInventoryBalanceId,
          );
          const inbound = await tx.inventoryMovement.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              itemId: line.itemId,
              sku: line.sku,
              itemName: line.itemName,
              warehouseId: line.warehouseId,
              location: line.location,
              locationKey: line.locationKey,
              movementType: "quarantine_release_available_in",
              movementLabel: "Quarantine release added to available inventory",
              movementDate: occurredAt,
              occurredAt,
              sourceDocument: posting.postingNumber,
              sourceDocumentType: "ReturnPostingDocument",
              sourceDocumentId: posting.id,
              sourceDocumentLineId: line.id,
              quantityIn: line.quantity,
              quantityOut: "0.0000",
              adjustmentQty: "0.0000",
              status: "posted",
              owner: actor.user.id,
              actorId: actor.user.id,
              unit: line.unit,
              relatedReturnId: request.id,
              postingBatchId,
              inventoryImpact:
                "increase_available_on_hand_reserved_unchanged_v1",
              metadata: {
                balanceType: "available",
                balanceId: line.destinationInventoryBalanceId,
                inventoryBalanceId: line.destinationInventoryBalanceId,
                quarantineBalanceId: line.quarantineBalanceId,
                returnPostingId: posting.id,
                returnAuthorizationId: authorization.id,
                returnRequestId: request.id,
                destinationVersionAfter: destinationImpact.version + 1,
                destinationOnHandAfter: destinationImpact.onHandAfter,
                destinationReservedAfter: destinationImpact.reservedAfter,
                destinationAvailableAfter:
                  destinationImpact.availableAfter,
              },
            },
          });
          movementByLine.get(line.id).inbound = inbound;
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
        const movementIds = [...movementByLine.values()].flatMap((row) => [
          row.out.id,
          row.inbound.id,
        ]);
        const updated = await tx.returnPostingDocument.update({
          where: { id: posting.id },
          data: {
            postingStatus: "posted",
            postedAt: occurredAt,
            postedById: actor.user.id,
            version: { increment: 1 },
            metadata: {
              ...(posting.metadata || {}),
              postingBatchId,
              movementIds,
              tenantNetQuantity: "0.0000",
            },
          },
        });
        const event = auditData({
          idFactory,
          actor,
          action: "quarantine_released_to_available",
          posting,
          summary: `Quarantine release ${posting.postingNumber} posted with zero tenant net inventory change.`,
          commandType: TYPES.post,
          idempotencyKey: normalized.idempotencyKey,
          before: postingModel(posting),
          after: postingModel(updated),
          metadata: {
            postingBatchId,
            movementIds,
            tenantNetQuantity: "0.0000",
            balanceImpacts: plan.balanceImpacts.map(
              ({ quantityUnits, ...impact }) => impact,
            ),
          },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: postingModel(updated),
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
          movementIds,
          tenantNetQuantity: "0.0000",
          auditEventId: event.id,
        };
      },
    );
  }

  async function reverseRelease(postingId, input, context) {
    return execute(
      TYPES.reverse,
      { ...input, postingId },
      context,
      async (tx, actor, payload, normalized) => {
        const locked = await lockPosting(tx, actor.tenantId, postingId);
        const [posting, authorization, request] = await Promise.all([
          tx.returnPostingDocument.findFirst({
            where: { id: postingId, tenantId: actor.tenantId },
          }),
          tx.returnAuthorization.findFirst({
            where: {
              id: locked.authorizationId,
              tenantId: actor.tenantId,
            },
          }),
          tx.returnRequest.findFirst({
            where: { id: locked.requestId, tenantId: actor.tenantId },
          }),
        ]);
        if (posting.version !== payload.expectedPostingVersion)
          fail(
            "RETURN_POSTING_VERSION_CONFLICT",
            "Return posting version does not match.",
            409,
          );
        if (
          authorization.version !== payload.expectedAuthorizationVersion
        )
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
        const originals = await tx.inventoryMovement.findMany({
          where: {
            tenantId: actor.tenantId,
            sourceDocumentType: "ReturnPostingDocument",
            sourceDocumentId: posting.id,
            movementType: {
              in: [
                "quarantine_release_out",
                "quarantine_release_available_in",
              ],
            },
          },
          select: { id: true },
        });
        await lockTenantIds(
          tx,
          "InventoryMovement",
          actor.tenantId,
          originals.map((row) => row.id),
        );
        const plan = enforce(
          await buildQuarantineReleaseReversalPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            postingId,
          }),
        );
        assertWarehouseAccess(actor, plan.warehouseIds, "operate");
        const occurredAt = now();
        const postingBatchId = idFactory();
        for (const impact of plan.balanceImpacts) {
          if (impact.balanceType === "available") {
            const changed = await tx.inventoryBalance.updateMany({
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
            if (changed.count !== 1)
              fail(
                "RETURN_REVERSAL_NOT_SAFE",
                "Destination available inventory changed during reversal.",
                409,
              );
          } else {
            const changed =
              await tx.quarantineInventoryBalance.updateMany({
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
            if (changed.count !== 1)
              fail(
                "RETURN_POSTING_CONCURRENT_CONFLICT",
                "Quarantine inventory changed during release reversal.",
                409,
              );
          }
        }
        const movements = [];
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
              movementType: fact.movementType,
              movementLabel:
                fact.balanceType === "available"
                  ? "Quarantine release reversed from available inventory"
                  : "Quarantine inventory restored after release reversal",
              movementDate: occurredAt,
              occurredAt,
              sourceDocument: posting.postingNumber,
              sourceDocumentType: "ReturnPostingDocument",
              sourceDocumentId: posting.id,
              sourceDocumentLineId: fact.postingLineId,
              quantityIn:
                fact.balanceType === "quarantine"
                  ? fact.quantity
                  : "0.0000",
              quantityOut:
                fact.balanceType === "available"
                  ? fact.quantity
                  : "0.0000",
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
                  ? "decrease_available_on_hand_reserved_unchanged_v1"
                  : "restore_quarantine_on_hand_v1",
              reason: payload.reason,
              metadata: {
                balanceType: fact.balanceType,
                balanceId: fact.balanceId,
                returnPostingId: posting.id,
                returnAuthorizationId: authorization.id,
                returnRequestId: request.id,
                originalPostingBatchId:
                  posting.metadata?.postingBatchId,
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
        const updated = await tx.returnPostingDocument.update({
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
              reversalMovementIds: movements.map((row) => row.id),
            },
          },
        });
        const event = auditData({
          idFactory,
          actor,
          action: "quarantine_release_reversed",
          posting,
          summary: `Quarantine release ${posting.postingNumber} reversed: ${payload.reason}`,
          commandType: TYPES.reverse,
          idempotencyKey: normalized.idempotencyKey,
          before: postingModel(posting),
          after: postingModel(updated),
          metadata: {
            reason: payload.reason,
            postingBatchId,
            movementIds: movements.map((row) => row.id),
            tenantNetQuantity: "0.0000",
          },
        });
        await tx.auditLog.create({ data: event });
        return {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          posting: postingModel(updated),
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
          movementIds: movements.map((row) => row.id),
          tenantNetQuantity: "0.0000",
          auditEventId: event.id,
        };
      },
    );
  }

  return {
    createDraft,
    reviseDraft,
    readyPosting,
    cancelPosting,
    postRelease,
    reverseRelease,
  };
}
