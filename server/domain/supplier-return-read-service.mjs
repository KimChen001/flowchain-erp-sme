import {
  assertWarehouseAccess,
  hasWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import {
  buildSupplierReturnDraftPlan,
  buildSupplierReturnPostingPlan,
  buildSupplierReturnReversalPlan,
  supplierReturnDecimalString as decimalString,
  supplierReturnDecimalUnits as decimalUnits,
} from "./supplier-return-transaction-policy.mjs";
import { assertAuthorized, can } from "../auth/authorization-service.mjs";
import { executableAuthorizedUnits } from "./return-authorization-closure-policy.mjs";

export class SupplierReturnReadError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "SupplierReturnReadError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value) => String(value ?? "").trim();
const fixed = (value) => decimalString(decimalUnits(value || 0));

function capabilityState(capability) {
  return capability || {
    id: "return-posting",
    enabled: false,
    readReady: true,
    writeReady: false,
  };
}

function publicLine(line) {
  return {
    id: line.id,
    returnAuthorizationLineId: line.returnAuthorizationLineId,
    returnRequestLineId: line.returnRequestLineId,
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    unit: line.unit,
    quantity: line.quantity || fixed(line.quantityUnits),
    dispositionRoute: line.dispositionRoute,
    balanceType: line.balanceType,
    balanceId: line.balanceId,
    inventoryBalanceId: line.inventoryBalanceId,
    quarantineBalanceId: line.quarantineBalanceId,
    warehouseId: line.warehouseId,
    location: line.location,
    locationKey: line.locationKey,
    remainingAuthorizedBefore: line.remainingAuthorizedBefore,
    remainingAuthorizedAfter: line.remainingAuthorizedAfter,
    version: line.version,
  };
}

function publicImpact(impact) {
  return Object.fromEntries(
    Object.entries(impact).filter(([key]) => key !== "quantityUnits"),
  );
}

function publicMovement(fact) {
  return Object.fromEntries(
    Object.entries(fact).filter(
      ([key]) => key !== "quantityUnits" && key !== "movement",
    ),
  );
}

function planModel(plan) {
  return {
    allowed: plan.allowed,
    blockingIssues: plan.blockingIssues,
    warnings: plan.warnings,
    normalizedPlan: {
      ...plan.normalizedPlan,
      lines: (plan.normalizedPlan?.lines || []).map(publicLine),
    },
    balanceImpacts: (plan.balanceImpacts || []).map(publicImpact),
    documentImpacts: plan.documentImpacts || [],
    movementFacts: (plan.movementFacts || []).map(publicMovement),
    reconciliationImpacts: plan.reconciliationImpacts || [],
    totalAuthorizedQuantity: plan.totalAuthorizedQuantity,
    executedQuantityBefore: plan.executedQuantityBefore,
    executedQuantityAfter: plan.executedQuantityAfter,
    authorizationStatusAfter: plan.authorizationStatusAfter,
    requestStatusAfter: plan.requestStatusAfter,
  };
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
    readyAt: posting.readyAt?.toISOString?.() || null,
    readyById: posting.readyById,
    cancelledAt: posting.cancelledAt?.toISOString?.() || null,
    cancelledById: posting.cancelledById,
    cancellationReason: posting.cancellationReason,
    postedAt: posting.postedAt?.toISOString?.() || null,
    postedById: posting.postedById,
    reversedAt: posting.reversedAt?.toISOString?.() || null,
    reversedById: posting.reversedById,
    reversalReason: posting.reversalReason,
    postingBatchId: posting.metadata?.postingBatchId || null,
    reversalPostingBatchId:
      posting.metadata?.reversalPostingBatchId || null,
  };
}

const sum = (values) =>
  decimalString(values.reduce((total, value) => total + decimalUnits(value || 0), 0n));

function postingReconciliation(posting, movements, audit, consumedByAuthorizationLine, activePostingLineIds = new Set(), partialScope = false) {
  const postAudit = audit.find((entry) =>
    [
      "supplier_return_posted",
      "customer_return_received_to_quarantine",
      "quarantine_released_to_available",
    ].includes(entry.action),
  );
  const recordedImpacts = Array.isArray(postAudit?.metadata?.balanceImpacts)
    ? postAudit.metadata.balanceImpacts
    : [];
  const expectedTypes =
    posting.postingType === "quarantine_release"
      ? ["quarantine_release_out", "quarantine_release_available_in"]
      : posting.postingType === "customer_return_receipt"
        ? ["customer_return_quarantine_in"]
        : ["supplier_return_out"];
  const equal = (left, right) => decimalUnits(left || 0) === decimalUnits(right || 0);
  const check = (rule, matched, calculated, recorded) => ({ rule, status: matched ? "matched" : "mismatch", calculated: String(calculated ?? ""), recorded: String(recorded ?? "") });
  const lines = posting.lines.map((line) => {
    const lineMovements = movements.filter(
      (movement) => movement.sourceDocumentLineId === line.id,
    );
    const originals = lineMovements.filter(
      (movement) => !movement.reversalOfMovementId,
    );
    const expectedMovement = (movementType) => {
      const releaseAvailable = movementType === "quarantine_release_available_in";
      const balanceType = releaseAvailable ? "available" : movementType === "supplier_return_out" ? (line.inventoryBalanceId ? "available" : "quarantine") : "quarantine";
      const balanceId = releaseAvailable ? line.destinationInventoryBalanceId : balanceType === "available" ? line.inventoryBalanceId : line.quarantineBalanceId;
      const inbound = ["customer_return_quarantine_in", "quarantine_release_available_in"].includes(movementType);
      // A release may put stock at another location of the warehouse; lines
      // stored before that kept no destination location.
      const destination = releaseAvailable && line.destinationLocationKey != null;
      return { movementType, balanceType, balanceId, location: destination ? line.destinationLocation : line.location, locationKey: destination ? line.destinationLocationKey : line.locationKey, quantityIn: inbound ? line.quantity : 0, quantityOut: inbound ? 0 : line.quantity, adjustmentQty: 0 };
    };
    const movementChecks = expectedTypes.flatMap((movementType) => {
      const expected = expectedMovement(movementType);
      const candidates = originals.filter((movement) => movement.movementType === movementType);
      const movement = candidates[0];
      return [
        check(`movement_${movementType}_count`, candidates.length === 1, 1, candidates.length),
        check(`movement_${movementType}_identity`, Boolean(movement && movement.tenantId === posting.tenantId && movement.sourceDocumentType === "ReturnPostingDocument" && movement.sourceDocumentId === posting.id && movement.sourceDocumentLineId === line.id && movement.itemId === line.itemId && movement.sku === line.sku && text(movement.unit) === text(line.unit) && movement.warehouseId === line.warehouseId && text(movement.location) === text(expected.location) && text(movement.locationKey) === text(expected.locationKey) && movement.postingBatchId === posting.metadata?.postingBatchId && text(movement.metadata?.balanceType) === text(expected.balanceType) && text(movement.metadata?.balanceId) === text(expected.balanceId)), `${posting.tenantId}/${line.id}/${expected.balanceId}`, movement ? `${movement.tenantId}/${movement.sourceDocumentLineId}/${movement.metadata?.balanceId}` : "missing"),
        check(`movement_${movementType}_quantity_direction`, Boolean(movement && equal(movement.quantityIn, expected.quantityIn) && equal(movement.quantityOut, expected.quantityOut) && equal(movement.adjustmentQty, expected.adjustmentQty)), `${fixed(expected.quantityIn)}/${fixed(expected.quantityOut)}/${fixed(expected.adjustmentQty)}`, movement ? `${fixed(movement.quantityIn)}/${fixed(movement.quantityOut)}/${fixed(movement.adjustmentQty)}` : "missing"),
      ];
    });
    const balanceIds = [line.inventoryBalanceId, line.quarantineBalanceId, line.destinationInventoryBalanceId].filter(Boolean);
    const balanceImpacts = recordedImpacts.filter((impact) =>
      balanceIds.includes(impact.balanceId),
    );
    const consumedQuantity =
      consumedByAuthorizationLine.get(line.returnAuthorizationLineId) ||
      "0.0000";
    const authorizedQuantity = fixed(line.returnAuthorizationLine?.authorizedQuantity || 0);
    // A closed remainder is no longer executable.
    const remainingUnits = executableAuthorizedUnits(line.returnAuthorizationLine) - decimalUnits(consumedQuantity);
    const expectedAuthorizationStatus = remainingUnits <= 0n ? "executed" : decimalUnits(consumedQuantity) > 0n ? "partially_executed" : "approved";
    const expectedRequestStatus = remainingUnits <= 0n ? "executed" : decimalUnits(consumedQuantity) > 0n ? "partially_executed" : "authorized";
    const expectedBalances = expectedTypes.map(expectedMovement);
    const balanceChecks = expectedBalances.map((expected) => {
      const impact = balanceImpacts.find((entry) => entry.balanceId === expected.balanceId && text(entry.balanceType) === expected.balanceType && equal(entry.quantity, line.quantity));
      let math = Boolean(impact);
      if (impact && expected.balanceType === "available") math = math && equal(decimalUnits(impact.onHandAfter) - decimalUnits(impact.onHandBefore), expected.movementType === "supplier_return_out" ? -decimalUnits(line.quantity) : decimalUnits(line.quantity)) && equal(impact.reservedAfter, impact.reservedBefore) && equal(decimalUnits(impact.availableAfter) - decimalUnits(impact.availableBefore), expected.movementType === "supplier_return_out" ? -decimalUnits(line.quantity) : decimalUnits(line.quantity));
      if (impact && expected.balanceType === "quarantine") math = math && equal(decimalUnits(impact.onHandAfter) - decimalUnits(impact.onHandBefore), expected.movementType === "customer_return_quarantine_in" ? decimalUnits(line.quantity) : -decimalUnits(line.quantity));
      return check(`balance_${expected.balanceType}_${expected.balanceId}`, math, `${expected.balanceId}:${expected.balanceType}:${fixed(line.quantity)}`, impact ? `${impact.balanceId}:${impact.balanceType}:${fixed(impact.quantity)}:${impact.onHandBefore}->${impact.onHandAfter}` : "missing");
    });
    const reversalChecks = originals.map((original) => {
      const compensations = lineMovements.filter((movement) => movement.reversalOfMovementId === original.id);
      const compensation = compensations[0];
      const matched = posting.postingStatus !== "reversed" ? !original.reversedByMovementId && compensations.length === 0 : compensations.length === 1 && original.reversedByMovementId === compensation?.id && compensation?.postingBatchId !== original.postingBatchId && compensation?.tenantId === original.tenantId && compensation?.itemId === original.itemId && compensation?.sku === original.sku && compensation?.unit === original.unit && compensation?.warehouseId === original.warehouseId && text(compensation?.locationKey) === text(original.locationKey) && compensation?.metadata?.balanceId === original.metadata?.balanceId && equal(compensation?.quantityIn, original.quantityOut) && equal(compensation?.quantityOut, original.quantityIn) && equal(decimalUnits(compensation?.adjustmentQty), -decimalUnits(original.adjustmentQty));
      return check(`reversal_${original.id}`, matched, posting.postingStatus === "reversed" ? "one exact compensation" : "no compensation", compensations.map((movement) => movement.id).join(",") || "none");
    });
    const checks = [
      {
        rule: "request_authorization_posting_lineage",
        status:
          line.returnAuthorizationLine?.returnRequestLine?.id === line.returnAuthorizationLine?.returnRequestLineId &&
          line.returnAuthorizationLine?.returnRequestLine?.returnRequestId === posting.returnAuthorization?.returnRequest?.id
            ? "matched"
            : "mismatch",
        calculated: `${line.returnAuthorizationLine?.returnRequestLineId || ""}:${line.returnAuthorizationLine?.returnRequestLine?.returnRequestId || ""}`,
        recorded: posting.returnAuthorization?.returnRequest?.id || "",
      },
      ...movementChecks,
      ...balanceChecks,
      ...reversalChecks,
      check("authorization_current_posting_line_included", posting.postingStatus !== "posted" || activePostingLineIds.has(line.id), line.id, activePostingLineIds.has(line.id) ? line.id : "missing"),
      check("authorization_consumed_within_authorized", decimalUnits(consumedQuantity) <= decimalUnits(authorizedQuantity), consumedQuantity, authorizedQuantity),
      check("authorization_workflow_status", posting.returnAuthorization?.workflowStatus === expectedAuthorizationStatus, expectedAuthorizationStatus, posting.returnAuthorization?.workflowStatus),
      check("request_workflow_status", posting.returnAuthorization?.returnRequest?.workflowStatus === expectedRequestStatus, expectedRequestStatus, posting.returnAuthorization?.returnRequest?.workflowStatus),
    ];
    return {
      postingLineId: line.id,
      returnRequestLineId:
        line.returnAuthorizationLine?.returnRequestLineId || null,
      returnAuthorizationLineId: line.returnAuthorizationLineId,
      sku: line.sku,
      quantity: fixed(line.quantity),
      calculatedConsumedQuantity: fixed(consumedQuantity),
      authorizedQuantity,
      remainingQuantity: decimalString(remainingUnits),
      expectedAuthorizationStatus,
      recordedAuthorizationStatus: posting.returnAuthorization?.workflowStatus || null,
      status: checks.every((check) => check.status === "matched")
        ? "matched"
        : "mismatch",
      checks,
      balanceImpacts,
    };
  });
  return {
    status: partialScope ? "unavailable" : lines.every((line) => line.status === "matched")
      ? "matched"
      : "mismatch",
    limitationCodes: partialScope ? ["PARTIAL_WAREHOUSE_SCOPE"] : [],
    lineIsolation: true,
    crossLineNettingAllowed: false,
    lines,
  };
}

export function createSupplierReturnReadService({
  prisma,
  capability,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");
  const currentCapability = capabilityState(capability);

  async function actorFor(context) {
    const identity = context?.identity || context;
    return resolveProvisionedActor(prisma, identity);
  }

  async function previewDraft(authorizationId, input, context) {
    const actor = await actorFor(context);
    assertAuthorized({ actor, permission: "returns.posting.prepare", tenantId: actor.tenantId });
    const plan = await buildSupplierReturnDraftPlan({
      prisma,
      tenantId: actor.tenantId,
      authorizationId,
      lines: input?.lines,
      now: now(),
    });
    if (plan.warehouseIds?.length)
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
    return {
      dataSource: "Authoritative PostgreSQL",
      transactionType: "supplier_return_dispatch",
      capability: currentCapability,
      preview: planModel(plan),
    };
  }

  async function previewReady(postingId, context) {
    const actor = await actorFor(context);
    assertAuthorized({ actor, permission: "returns.posting.ready", tenantId: actor.tenantId });
    const plan = await buildSupplierReturnPostingPlan({
      prisma,
      tenantId: actor.tenantId,
      postingId,
      now: now(),
      allowedWorkflowStatuses: ["draft"],
    });
    if (plan.warehouseIds?.length)
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
    return {
      dataSource: "Authoritative PostgreSQL",
      transactionType: "supplier_return_dispatch",
      action: "ready",
      capability: currentCapability,
      preview: planModel(plan),
    };
  }

  async function previewPost(postingId, context) {
    const actor = await actorFor(context);
    assertAuthorized({ actor, permission: "returns.posting.post", tenantId: actor.tenantId });
    const plan = await buildSupplierReturnPostingPlan({
      prisma,
      tenantId: actor.tenantId,
      postingId,
      now: now(),
    });
    if (plan.warehouseIds?.length)
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
    return {
      dataSource: "Authoritative PostgreSQL",
      transactionType: "supplier_return_dispatch",
      action: "post",
      capability: currentCapability,
      preview: planModel(plan),
    };
  }

  async function previewReverse(postingId, context) {
    const actor = await actorFor(context);
    assertAuthorized({ actor, permission: "returns.posting.reverse", tenantId: actor.tenantId });
    const plan = await buildSupplierReturnReversalPlan({
      prisma,
      tenantId: actor.tenantId,
      postingId,
    });
    if (plan.warehouseIds?.length)
      assertWarehouseAccess(actor, plan.warehouseIds, "operate");
    return {
      dataSource: "Authoritative PostgreSQL",
      transactionType: "supplier_return_dispatch",
      action: "reverse",
      capability: currentCapability,
      preview: planModel(plan),
    };
  }

  async function postingWorkbench(postingId, context) {
    const actor = await actorFor(context);
    assertAuthorized({ actor, permission: "returns.posting.read", tenantId: actor.tenantId });
    const posting = await prisma.returnPostingDocument.findFirst({
      where: { id: text(postingId), tenantId: actor.tenantId },
      include: {
        lines: {
          include: {
            returnAuthorizationLine: {
              include: { returnRequestLine: true },
            },
          },
          orderBy: { id: "asc" },
        },
        returnAuthorization: {
          include: { returnRequest: true },
        },
      },
    });
    if (!posting)
      throw new SupplierReturnReadError(
        "RETURN_POSTING_NOT_FOUND",
        "Return posting was not found.",
        404,
      );
    assertWarehouseAccess(actor, [posting.warehouseId], "read", {
      maskExistence: true,
    });
    // Each posting button checks the permission its command requires (L8-20).
    const release = posting.postingType === "quarantine_release";
    const commandPermission = {
      revise: release ? "returns.quarantine.release_prepare" : "returns.posting.prepare",
      ready: release ? "returns.quarantine.release_prepare" : "returns.posting.ready",
      cancel: release ? "returns.quarantine.release_prepare" : "returns.posting.cancel",
      post: release ? "returns.quarantine.release_post" : "returns.posting.post",
      reverse: release ? "returns.quarantine.release_reverse" : "returns.posting.reverse",
    };
    const canOperateWith = (action) =>
      currentCapability.enabled &&
      can({ actor, permission: commandPermission[action], tenantId: actor.tenantId }) &&
      hasWarehouseAccess(actor, [posting.warehouseId], "operate");
    const [movements, audit, consumedPostings] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where: {
          tenantId: actor.tenantId,
          sourceDocumentType: "ReturnPostingDocument",
          sourceDocumentId: posting.id,
        },
        orderBy: { occurredAt: "asc" },
      }),
      prisma.auditLog.findMany({
        where: {
          tenantId: actor.tenantId,
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.returnPostingDocument.findMany({
        where: {
          tenantId: actor.tenantId,
          returnAuthorizationId: posting.returnAuthorizationId,
          postingStatus: "posted",
          reversedAt: null,
        },
        include: { lines: true },
      }),
    ]);
    const consumedByAuthorizationLine = new Map();
    for (const row of consumedPostings)
      for (const line of row.lines) {
        const values = [
          consumedByAuthorizationLine.get(line.returnAuthorizationLineId) ||
            "0.0000",
          line.quantity,
        ];
        consumedByAuthorizationLine.set(
          line.returnAuthorizationLineId,
          sum(values),
        );
      }
    const reconciliation = postingReconciliation(
      posting,
      movements,
      audit,
      consumedByAuthorizationLine,
      new Set(consumedPostings.flatMap((row) => row.lines.map((line) => line.id))),
      consumedPostings.some((row) => !hasWarehouseAccess(actor, [row.warehouseId], "read")),
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      capability: currentCapability,
      posting: postingModel(posting),
      returnAuthorization: {
        id: posting.returnAuthorization.id,
        authorizationNumber:
          posting.returnAuthorization.authorizationNumber,
        workflowStatus: posting.returnAuthorization.workflowStatus,
        version: posting.returnAuthorization.version,
      },
      returnRequest: {
        id: posting.returnAuthorization.returnRequest.id,
        requestNumber:
          posting.returnAuthorization.returnRequest.requestNumber,
        returnType: posting.returnAuthorization.returnRequest.returnType,
        workflowStatus:
          posting.returnAuthorization.returnRequest.workflowStatus,
        version: posting.returnAuthorization.returnRequest.version,
      },
      lines: posting.lines.map((line) => ({
        id: line.id,
        returnAuthorizationLineId: line.returnAuthorizationLineId,
        returnRequestLineId:
          line.returnAuthorizationLine.returnRequestLineId,
        sku: line.sku,
        itemName: line.itemName,
        quantity: fixed(line.quantity),
        unit: line.unit,
        warehouseId: line.warehouseId,
        location: line.location,
        locationKey: line.locationKey,
        balanceType:
          posting.postingType === "quarantine_release"
            ? "quarantine_to_available"
            : line.inventoryBalanceId
              ? "available"
              : "quarantine",
        balanceId:
          line.inventoryBalanceId || line.quarantineBalanceId,
        sourceBalanceId:
          line.inventoryBalanceId || line.quarantineBalanceId,
        destinationBalanceId:
          line.destinationInventoryBalanceId || null,
        // Set when a release put stock at a location of its own (L8-14).
        destinationLocation:
          line.destinationLocationKey == null ||
          line.destinationLocationKey === line.locationKey
            ? null
            : line.destinationLocation || null,
        dispositionRoute:
          line.returnAuthorizationLine.dispositionRoute,
      })),
      availableActions: {
        revise:
          canOperateWith("revise") &&
          posting.workflowStatus === "draft" &&
          posting.postingStatus === "unposted",
        ready:
          canOperateWith("ready") &&
          posting.workflowStatus === "draft" &&
          posting.postingStatus === "unposted",
        cancel:
          canOperateWith("cancel") &&
          ["draft", "ready"].includes(posting.workflowStatus) &&
          posting.postingStatus === "unposted",
        post:
          canOperateWith("post") &&
          posting.workflowStatus === "ready" &&
          posting.postingStatus === "unposted",
        reverse:
          canOperateWith("reverse") &&
          posting.postingStatus === "posted" &&
          !posting.reversedAt,
      },
      evidence: {
        movements: movements.map((movement) => ({
          id: movement.id,
          movementType: movement.movementType,
          postingBatchId: movement.postingBatchId,
          reversalOfMovementId: movement.reversalOfMovementId,
          reversedByMovementId: movement.reversedByMovementId,
          quantityIn: fixed(movement.quantityIn),
          quantityOut: fixed(movement.quantityOut),
          balanceType: movement.metadata?.balanceType,
          balanceId: movement.metadata?.balanceId,
          occurredAt: movement.occurredAt?.toISOString?.() || null,
        })),
        audit: audit.map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorId: entry.actorId,
          createdAt: entry.createdAt?.toISOString?.() || null,
          metadata: entry.metadata,
        })),
      },
      smartLinks: [
        {
          id: "return-request",
          label: "退货申请",
          path: `/app/inventory/returns/requests/${posting.returnAuthorization.returnRequest.id}`,
        },
        {
          id: "return-authorization",
          label: "退货授权",
          path: `/app/inventory/returns/authorizations/${posting.returnAuthorization.id}`,
        },
        {
          id: "inventory-movements",
          label: "库存流水",
          path: `/app/inventory/movements?sourceDocumentId=${encodeURIComponent(posting.id)}`,
        },
        ...(posting.lines.some((line) => line.quarantineBalanceId)
          ? [
              {
                id: "quarantine-inventory",
                label: "隔离库存",
                path: `/app/inventory/quarantine?sku=${encodeURIComponent(posting.lines[0]?.sku || "")}`,
              },
            ]
          : []),
      ],
      reconciliation,
      limitations:
        posting.postingType === "quarantine_release"
          ? [
              "Phase 4B.4 supports governed quarantine release to an existing available balance.",
              "Scrap, repair, refurbishment, destruction, and automatic disposition remain unavailable.",
            ]
          : posting.postingType === "customer_return_receipt"
          ? [
              "Phase 4B.3 customer return receipts increase quarantine inventory only.",
              "Release requires a separate governed quarantine release authorization.",
            ]
          : [
              "Phase 4B.2 supports supplier return dispatch from available or quarantine inventory.",
              "Quarantine release to available inventory remains unavailable until its transaction gate passes.",
            ],
    };
  }

  return {
    previewDraft,
    previewReady,
    previewPost,
    previewReverse,
    postingWorkbench,
  };
}
