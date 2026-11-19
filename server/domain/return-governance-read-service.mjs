import {
  assertWarehouseAccess,
  resolveProvisionedActor,
} from "./pilot-identity.mjs";
import {
  buildReturnAuthorizationPlan,
  buildReturnRequestPlan,
  returnGovernanceFixed as fixed,
  returnGovernanceUnits as units,
} from "./return-governance-policy.mjs";
import {
  buildReturnAuthorizationClosurePlan,
  isLivePosting,
} from "./return-authorization-closure-policy.mjs";
import { assertAuthorized, can } from "../auth/authorization-service.mjs";
import { approvalAuthorIds, selfApprovalCheck } from "./self-approval.mjs";

export class ReturnGovernanceReadError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "ReturnGovernanceReadError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new ReturnGovernanceReadError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const iso = (value) => (value ? new Date(value).toISOString() : null);

function page(query = {}) {
  const number = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const size = Math.min(
    100,
    Math.max(1, Number.parseInt(query.pageSize, 10) || 20),
  );
  return { page: number, pageSize: size, skip: (number - 1) * size };
}

function order(query = {}, fields = {}) {
  const requested = text(query.sort);
  const field = fields[requested] || fields.updatedAt || "updatedAt";
  const direction = text(query.direction).toLowerCase() === "asc" ? "asc" : "desc";
  return [{ [field]: direction }, { id: "asc" }];
}

function warehouseIds(lines = []) {
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

function canRead(actor, ids) {
  return (
    actor.allWarehouses ||
    ids.every((id) => actor.readWarehouseIds?.has(id))
  );
}

function permission(actor, code) { return can({ actor, permission: code, tenantId: actor.tenantId }); }

function requestModel(request) {
  return {
    id: request.id,
    requestNumber: request.requestNumber,
    returnType: request.returnType,
    workflowStatus: request.workflowStatus,
    partnerId: request.partnerId,
    partnerNameSnapshot: request.partnerNameSnapshot,
    contextDocumentType: request.contextDocumentType,
    contextDocumentId: request.contextDocumentId,
    sourceDocumentType: request.sourceDocumentType,
    sourceDocumentId: request.sourceDocumentId,
    sourceDocumentNumber: request.sourceDocumentNumber,
    reasonCode: request.reasonCode,
    reasonDetail: request.reasonDetail,
    resolution: request.resolution || "credit",
    requestedAt: iso(request.requestedAt),
    submittedAt: iso(request.submittedAt),
    rejectedAt: iso(request.rejectedAt),
    rejectionReason: request.rejectionReason,
    cancelledAt: iso(request.cancelledAt),
    cancellationReason: request.cancellationReason,
    version: request.version,
    createdAt: iso(request.createdAt),
    updatedAt: iso(request.updatedAt),
  };
}

function lineModel(line) {
  return {
    id: line.id,
    sourceDocumentType: line.sourceDocumentType,
    sourceDocumentId: line.sourceDocumentId,
    sourceDocumentLineId: line.sourceDocumentLineId,
    sourceQuantity: fixed(units(line.sourceQuantity || 0)),
    sourceWarehouseIds: Array.isArray(line.sourceWarehouseIds)
      ? line.sourceWarehouseIds
      : [],
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    requestedQuantity: fixed(units(line.requestedQuantity)),
    unit: line.unit,
    reasonCode: line.reasonCode,
    conditionCode: line.conditionCode,
    version: line.version,
  };
}

function authorizationModel(authorization) {
  const posted = postedByAuthorizationLine(authorization);
  return {
    id: authorization.id,
    authorizationNumber: authorization.authorizationNumber,
    returnRequestId: authorization.returnRequestId,
    workflowStatus: authorization.workflowStatus,
    authorizedAt: iso(authorization.authorizedAt),
    rejectedAt: iso(authorization.rejectedAt),
    rejectionReason: authorization.rejectionReason,
    cancelledAt: iso(authorization.cancelledAt),
    cancellationReason: authorization.cancellationReason,
    expiresAt: iso(authorization.expiresAt),
    expiredAt: iso(authorization.expiredAt),
    remainderClosedAt: iso(authorization.remainderClosedAt),
    remainderReason: authorization.remainderReason || null,
    version: authorization.version,
    createdAt: iso(authorization.createdAt),
    updatedAt: iso(authorization.updatedAt),
    lines: (authorization.lines || []).map((line) => ({
      id: line.id,
      returnRequestLineId: line.returnRequestLineId,
      authorizedQuantity: fixed(units(line.authorizedQuantity)),
      closedQuantity: fixed(units(line.closedQuantity || 0)),
      ...(posted
        ? { postedQuantity: fixed(posted.get(line.id) || 0n) }
        : {}),
      dispositionRoute: line.dispositionRoute,
      version: line.version,
    })),
  };
}

// Posted (not reversed) quantity per authorization line, when the postings
// and their lines were loaded.
function postedByAuthorizationLine(authorization) {
  const postings = authorization.postings;
  if (!Array.isArray(postings) || postings.some((row) => !Array.isArray(row.lines)))
    return null;
  const posted = new Map();
  for (const posting of postings) {
    if (posting.postingStatus !== "posted" || posting.reversedAt) continue;
    for (const line of posting.lines)
      posted.set(
        line.returnAuthorizationLineId,
        (posted.get(line.returnAuthorizationLineId) || 0n) + units(line.quantity),
      );
  }
  return posted;
}

function actionModel(actor, request, capabilities) {
  const requestEnabled = capabilities["return-request"]?.enabled === true;
  const authorizationEnabled =
    capabilities["return-authorization"]?.enabled === true;
  const canRevise =
    permission(actor, "returns.request.revise") &&
    (request.returnType !== "customer_return" ||
      permission(actor, "returns.customer_request.manage"));
  const canSubmit = permission(actor, "returns.request.submit");
  const canCancel = permission(actor, "returns.request.cancel");
  const requestAllowed = canRevise || canSubmit || canCancel;
  const activeAuthorization = request.authorizations?.some((row) =>
    ["draft", "approved", "partially_executed"].includes(row.workflowStatus),
  );
  const releaseAuthorizationAllowed =
    request.returnType === "customer_return" &&
    request.workflowStatus === "executed";
  return {
    revise:
      requestEnabled &&
      canRevise &&
      request.workflowStatus === "draft",
    submit:
      requestEnabled &&
      canSubmit &&
      request.workflowStatus === "draft",
    cancel:
      requestEnabled &&
      canCancel &&
      ["draft", "submitted"].includes(request.workflowStatus) &&
      !activeAuthorization,
    authorize:
      authorizationEnabled &&
      permission(actor, "returns.authorization.approve") &&
      (request.workflowStatus === "submitted" || releaseAuthorizationAllowed) &&
      !activeAuthorization,
    reject:
      authorizationEnabled &&
      permission(actor, "returns.authorization.reject") &&
      request.workflowStatus === "submitted" &&
      !activeAuthorization,
    blockingReasonCodes: [
      ...(!requestEnabled
        ? ["RETURN_REQUEST_CAPABILITY_NOT_AVAILABLE"]
        : []),
      ...(!authorizationEnabled
        ? ["RETURN_AUTHORIZATION_CAPABILITY_NOT_AVAILABLE"]
        : []),
      ...(!requestAllowed ? ["PERMISSION_DENIED"] : []),
    ],
  };
}

function authorizationActions(actor, authorization, capabilities, now) {
  const enabled = capabilities["return-authorization"]?.enabled === true;
  const unexecuted = ["draft", "approved"].includes(
    authorization.workflowStatus,
  );
  const live = authorization.postings.filter(isLivePosting);
  const noOpenPostings = live.every(
    (posting) => posting.postingStatus !== "unposted",
  );
  return {
    cancel: enabled && permission(actor, "returns.authorization.cancel") && unexecuted && !live.length,
    expire:
      enabled &&
      permission(actor, "returns.authorization.expire") &&
      unexecuted &&
      !live.length &&
      Boolean(authorization.expiresAt && authorization.expiresAt <= now),
    closeRemainder:
      enabled &&
      permission(actor, "returns.authorization.cancel") &&
      authorization.workflowStatus === "partially_executed" &&
      noOpenPostings,
    openPostingNumbers: live
      .filter((posting) => posting.postingStatus === "unposted")
      .map((posting) => posting.postingNumber),
    blockingReasonCodes: [
      ...(!enabled ? ["RETURN_AUTHORIZATION_CAPABILITY_NOT_AVAILABLE"] : []),
      ...(!permission(actor, "returns.authorization.cancel") && !permission(actor, "returns.authorization.expire") ? ["PERMISSION_DENIED"] : []),
    ],
  };
}

async function evidence(prisma, actor, entityType, entityIds) {
  const rows = await prisma.auditLog.findMany({
    where: {
      tenantId: actor.tenantId,
      entityType,
      entityId: { in: entityIds },
    },
    include: { actor: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    summary: row.summary,
    actor: row.actor
      ? { id: row.actor.id, name: row.actor.name, role: row.actor.role }
      : null,
    occurredAt: iso(row.createdAt),
    commandType: row.metadata?.commandType || row.action,
    idempotencyKey: row.metadata?.idempotencyKey || null,
    before: row.metadata?.before ?? null,
    after: row.metadata?.after ?? null,
  }));
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
    resolution: request.resolution || "credit",
    lines: request.lines.map((line) => ({
      sourceDocumentLineId: line.sourceDocumentLineId,
      requestedQuantity: String(line.requestedQuantity),
      reasonCode: line.reasonCode,
      conditionCode: line.conditionCode,
    })),
  };
}

function preview(plan) {
  return {
    operation: plan.operation,
    allowed: plan.allowed,
    blockingIssues: plan.blockingIssues,
    warnings: plan.warnings,
    inventoryMutation: false,
    request: plan.request
      ? {
          ...plan.request,
          warehouseIds: plan.request.warehouseIds,
        }
      : null,
    lines: plan.lines || plan.authorization?.lines || [],
    authorization: plan.authorization
      ? {
          authorizationNumber: plan.authorization.authorizationNumber,
          expiresAt: iso(plan.authorization.expiresAt),
        }
      : null,
    factsToCreate: plan.factsToCreate,
  };
}

export function createReturnGovernanceReadService({
  prisma,
  capabilities = {},
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function actor(context) {
    return resolveProvisionedActor(prisma, context?.identity || context);
  }

  async function previewRequest(input, context, currentRequestId) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: currentRequestId ? "returns.request.revise" : "returns.request.create", tenantId: resolved.tenantId });
    if (text(input?.returnType) === "customer_return")
      assertAuthorized({ actor: resolved, permission: "returns.customer_request.manage", tenantId: resolved.tenantId });
    const plan = await buildReturnRequestPlan({
      prisma,
      tenantId: resolved.tenantId,
      input,
      currentRequestId,
    });
    if (plan.request)
      assertWarehouseAccess(resolved, plan.request.warehouseIds, "read");
    return preview(plan);
  }

  async function previewSubmit(requestId, context) {
    const resolved = await actor(context);
    const request = await prisma.returnRequest.findFirst({
      where: { id: text(requestId), tenantId: resolved.tenantId },
      include: { lines: true },
    });
    if (!request)
      fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
    assertAuthorized({ actor: resolved, permission: "returns.request.submit", tenantId: resolved.tenantId });
    assertWarehouseAccess(resolved, warehouseIds(request.lines), "read", {
      maskExistence: true,
    });
    const plan = await buildReturnRequestPlan({
      prisma,
      tenantId: resolved.tenantId,
      input: requestInput(request),
      currentRequestId: request.id,
    });
    return {
      ...preview(plan),
      operation: "submit_return_request",
      allowed: request.workflowStatus === "draft" && plan.allowed,
      blockingIssues:
        request.workflowStatus === "draft"
          ? plan.blockingIssues
          : [
              {
                code: "RETURN_REQUEST_NOT_DRAFT",
                message: "Only a draft return request can be submitted.",
                status: 409,
              },
              ...plan.blockingIssues,
            ],
    };
  }

  async function previewCancel(requestId, input, context) {
    const resolved = await actor(context);
    const request = await prisma.returnRequest.findFirst({
      where: { id: text(requestId), tenantId: resolved.tenantId },
      include: { lines: true, authorizations: true },
    });
    if (!request)
      fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
    assertWarehouseAccess(resolved, warehouseIds(request.lines), "read", {
      maskExistence: true,
    });
    const blockingIssues = [];
    if (!permission(resolved, "returns.request.cancel"))
      blockingIssues.push({
        code: "PERMISSION_DENIED",
        message: "Return request access is denied.",
        status: 403,
      });
    if (!["draft", "submitted"].includes(request.workflowStatus))
      blockingIssues.push({
        code: "RETURN_REQUEST_CANNOT_CANCEL",
        message: "Only a draft or submitted request can be cancelled.",
        status: 409,
      });
    if (!text(input?.reason))
      blockingIssues.push({
        code: "RETURN_REASON_REQUIRED",
        message: "A cancellation reason is required.",
        status: 422,
      });
    if (
      request.authorizations.some((row) =>
        ["draft", "approved", "partially_executed"].includes(
          row.workflowStatus,
        ),
      )
    )
      blockingIssues.push({
        code: "RETURN_AUTHORIZATION_ALREADY_ACTIVE",
        message: "An active authorization prevents request cancellation.",
        status: 409,
      });
    return {
      operation: "cancel_return_request",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      inventoryMutation: false,
      request: requestModel(request),
      factsToCreate: { auditEvents: 1, inventoryMovements: 0 },
    };
  }

  async function previewAuthorization(requestId, input, context) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: "returns.authorization.approve", tenantId: resolved.tenantId });
    const plan = await buildReturnAuthorizationPlan({
      prisma,
      tenantId: resolved.tenantId,
      requestId,
      input,
    });
    if (plan.request)
      assertWarehouseAccess(
        resolved,
        warehouseIds(plan.request.lines),
        "read",
        { maskExistence: true },
      );
    return preview(plan);
  }

  async function listRequests(query, context) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: "returns.request.read", tenantId: resolved.tenantId });
    const paging = page(query);
    const where = {
      tenantId: resolved.tenantId,
      ...(text(query.returnType) ? { returnType: text(query.returnType) } : {}),
      ...(text(query.workflowStatus)
        ? { workflowStatus: text(query.workflowStatus) }
        : {}),
      ...(text(query.sourceDocumentId)
        ? { sourceDocumentId: text(query.sourceDocumentId) }
        : {}),
    };
    const candidates = await prisma.returnRequest.findMany({
      where,
      include: { lines: true, authorizations: true },
      orderBy: order(query, {
        updatedAt: "updatedAt",
        createdAt: "createdAt",
        requestNumber: "requestNumber",
        workflowStatus: "workflowStatus",
      }),
    });
    const search = text(query.q).toLowerCase();
    const visible = candidates.filter(
      (row) =>
        canRead(resolved, warehouseIds(row.lines)) &&
        (!search ||
          [
            row.requestNumber,
            row.partnerNameSnapshot,
            row.sourceDocumentNumber,
            ...row.lines.flatMap((line) => [line.sku, line.itemName]),
          ]
            .filter(Boolean)
            .some((value) => text(value).toLowerCase().includes(search))),
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      page: paging.page,
      pageSize: paging.pageSize,
      total: visible.length,
      capabilities,
      requests: visible
        .slice(paging.skip, paging.skip + paging.pageSize)
        .map((row) => ({
          ...requestModel(row),
          lineCount: row.lines.length,
          authorizationStatuses: row.authorizations.map(
            (authorization) => authorization.workflowStatus,
          ),
          warehouseIds: warehouseIds(row.lines),
        })),
    };
  }

  async function listAuthorizations(query, context) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: "returns.authorization.read", tenantId: resolved.tenantId });
    const paging = page(query);
    const candidates = await prisma.returnAuthorization.findMany({
      where: {
        tenantId: resolved.tenantId,
        ...(text(query.workflowStatus)
          ? { workflowStatus: text(query.workflowStatus) }
          : {}),
        ...(text(query.returnType)
          ? { returnRequest: { returnType: text(query.returnType) } }
          : {}),
      },
      include: {
        lines: { orderBy: { id: "asc" } },
        postings: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        returnRequest: { include: { lines: true } },
      },
      orderBy: order(query, {
        updatedAt: "updatedAt",
        createdAt: "createdAt",
        authorizationNumber: "authorizationNumber",
        workflowStatus: "workflowStatus",
      }),
    });
    const search = text(query.q).toLowerCase();
    const visible = candidates.filter(
      (row) =>
        canRead(resolved, warehouseIds(row.returnRequest.lines)) &&
        (!search ||
          [
            row.authorizationNumber,
            row.returnRequest.requestNumber,
            row.returnRequest.partnerNameSnapshot,
            row.returnRequest.sourceDocumentNumber,
          ].some((value) => text(value).toLowerCase().includes(search))),
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      page: paging.page,
      pageSize: paging.pageSize,
      total: visible.length,
      capabilities,
      authorizations: visible
        .slice(paging.skip, paging.skip + paging.pageSize)
        .map((row) => ({
          ...authorizationModel(row),
          request: requestModel(row.returnRequest),
          postingCount: row.postings.length,
          postingStatuses: row.postings.map((posting) => posting.postingStatus),
          warehouseIds: warehouseIds(row.returnRequest.lines),
        })),
    };
  }

  async function listPostings(query, context) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: "returns.posting.read", tenantId: resolved.tenantId });
    const paging = page(query);
    const candidates = await prisma.returnPostingDocument.findMany({
      where: {
        tenantId: resolved.tenantId,
        ...(text(query.postingType)
          ? { postingType: text(query.postingType) }
          : {}),
        ...(text(query.postingStatus)
          ? { postingStatus: text(query.postingStatus) }
          : {}),
        ...(text(query.workflowStatus)
          ? { workflowStatus: text(query.workflowStatus) }
          : {}),
      },
      include: {
        lines: { orderBy: { id: "asc" } },
        returnAuthorization: {
          include: { returnRequest: { include: { lines: true } } },
        },
      },
      orderBy: order(query, {
        updatedAt: "updatedAt",
        createdAt: "createdAt",
        postingNumber: "postingNumber",
        postingStatus: "postingStatus",
      }),
    });
    const search = text(query.q).toLowerCase();
    const visible = candidates.filter(
      (row) =>
        canRead(resolved, [row.warehouseId]) &&
        canRead(
          resolved,
          warehouseIds(row.returnAuthorization.returnRequest.lines),
        ) &&
        (!search ||
          [
            row.postingNumber,
            row.returnAuthorization.authorizationNumber,
            row.returnAuthorization.returnRequest.requestNumber,
            ...row.lines.flatMap((line) => [line.sku, line.itemName]),
          ].some((value) => text(value).toLowerCase().includes(search))),
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      page: paging.page,
      pageSize: paging.pageSize,
      total: visible.length,
      capabilities,
      postings: visible
        .slice(paging.skip, paging.skip + paging.pageSize)
        .map((row) => ({
          id: row.id,
          postingNumber: row.postingNumber,
          postingType: row.postingType,
          workflowStatus: row.workflowStatus,
          postingStatus: row.postingStatus,
          warehouseId: row.warehouseId,
          version: row.version,
          postedAt: iso(row.postedAt),
          reversedAt: iso(row.reversedAt),
          updatedAt: iso(row.updatedAt),
          lineCount: row.lines.length,
          authorization: {
            id: row.returnAuthorization.id,
            authorizationNumber:
              row.returnAuthorization.authorizationNumber,
          },
          request: {
            id: row.returnAuthorization.returnRequest.id,
            requestNumber:
              row.returnAuthorization.returnRequest.requestNumber,
            returnType: row.returnAuthorization.returnRequest.returnType,
          },
        })),
    };
  }

  async function entryData(context) {
    const resolved = await actor(context);
    const [shipments, receivings] = await Promise.all([
      prisma.shipmentDocument.findMany({
        where: {
          tenantId: resolved.tenantId,
          postingStatus: "posted",
          reversedAt: null,
        },
        include: {
          salesOrder: true,
          lines: {
            include: { item: true, allocations: true },
            orderBy: { id: "asc" },
          },
        },
        orderBy: [{ postedAt: "desc" }, { id: "asc" }],
        take: 200,
      }),
      prisma.receivingDocument.findMany({
        where: {
          tenantId: resolved.tenantId,
          postingStatus: "posted",
          reversedAt: null,
        },
        include: { lines: { orderBy: { id: "asc" } } },
        orderBy: [{ postedAt: "desc" }, { id: "asc" }],
        take: 200,
      }),
    ]);
    const customerSources = shipments
      .map((row) => ({
        id: row.id,
        documentType: "ShipmentDocument",
        documentNumber: row.shipmentNumber,
        contextDocumentType: "SalesOrder",
        contextDocumentId: row.salesOrderId,
        partnerId: row.salesOrder.customerId,
        partnerName: row.salesOrder.customerName,
        postedAt: iso(row.postedAt),
        lines: row.lines.map((line) => ({
          id: line.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.item?.name || line.sku,
          quantity: fixed(units(line.postedQuantity)),
          unit: line.unit,
          warehouseIds: [
            ...new Set(line.allocations.map((allocation) => allocation.warehouseId)),
          ].sort(),
        })),
      }))
      .filter(
        (row) =>
          row.lines.length > 0 &&
          row.lines.every((line) => canRead(resolved, line.warehouseIds)),
      );
    const supplierSources = receivings
      .map((row) => ({
        id: row.id,
        documentType: "ReceivingDocument",
        documentNumber: row.documentNumber || row.id,
        contextDocumentType: "PurchaseOrder",
        contextDocumentId: row.poId,
        partnerId: row.supplierId,
        partnerName: row.supplierName,
        postedAt: iso(row.postedAt),
        lines: row.lines.map((line) => ({
          id: line.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName || line.sku,
          quantity: fixed(units(line.acceptedQty || 0)),
          unit: line.unit,
          warehouseIds: [text(line.warehouseId || row.warehouseId)].filter(Boolean),
        })),
      }))
      .filter(
        (row) =>
          row.lines.length > 0 &&
          row.lines.every((line) => canRead(resolved, line.warehouseIds)),
      );
    return {
      dataSource: "Authoritative PostgreSQL",
      capabilities,
      sources: {
        customer_return: customerSources,
        supplier_return: supplierSources,
      },
      availableActions: {
        createCustomerReturn: permission(resolved, "returns.request.create"),
        createSupplierReturn: permission(resolved, "returns.request.create"),
      },
      selectionPolicy: {
        explicitSourceDocumentRequired: true,
        explicitSourceLineRequired: true,
        implicitFirstSelection: false,
      },
    };
  }

  async function requestWorkbench(requestId, context) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: "returns.request.read", tenantId: resolved.tenantId });
    const request = await prisma.returnRequest.findFirst({
      where: { id: text(requestId), tenantId: resolved.tenantId },
      include: {
        lines: { orderBy: { id: "asc" } },
        authorizations: {
          include: { lines: { orderBy: { id: "asc" } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!request)
      fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
    assertWarehouseAccess(resolved, warehouseIds(request.lines), "read", {
      maskExistence: true,
    });
    const authorizationIds = request.authorizations.map((row) => row.id);
    const [requestEvidence, authorizationEvidence] = await Promise.all([
      evidence(prisma, resolved, "ReturnRequest", [request.id]),
      authorizationIds.length
        ? evidence(
            prisma,
            resolved,
            "ReturnAuthorization",
            authorizationIds,
          )
        : [],
    ]);
    // Authorize and Reject are not offered to who requested or submitted the
    // return while someone else who reads its warehouses may authorize it, as
    // the authorization command rules (design audit C4, L8-25).
    const actions = actionModel(resolved, request, capabilities);
    const selfBlocked = (actions.authorize || actions.reject) && (await selfApprovalCheck(prisma, {
      tenantId: resolved.tenantId,
      actorId: resolved.user?.id,
      authorIds: approvalAuthorIds("return_authorization", request),
      permissionCode: "returns.authorization.approve",
      warehouseIds: warehouseIds(request.lines),
    })).blocked;
    const availableActions = selfBlocked ? { ...actions, authorize: false, reject: false } : actions;
    return {
      dataSource: "Authoritative PostgreSQL",
      request: requestModel(request),
      lines: request.lines.map(lineModel),
      authorizations: request.authorizations.map(authorizationModel),
      availableActions,
      // Whether this reader may authorize the return now.
      canApprove: availableActions.authorize === true,
      evidence: [...requestEvidence, ...authorizationEvidence].sort((a, b) =>
        String(a.occurredAt).localeCompare(String(b.occurredAt)),
      ),
      capabilities,
      inventoryMutation: false,
      limitations: [
        "Phase 4B.1 governs requests and authorizations only. It does not post or reverse inventory.",
      ],
    };
  }

  async function authorizationWorkbench(authorizationId, context) {
    const resolved = await actor(context);
    assertAuthorized({ actor: resolved, permission: "returns.authorization.read", tenantId: resolved.tenantId });
    const authorization = await prisma.returnAuthorization.findFirst({
      where: { id: text(authorizationId), tenantId: resolved.tenantId },
      include: {
        lines: { orderBy: { id: "asc" } },
        postings: { include: { lines: true } },
        returnRequest: {
          include: { lines: { orderBy: { id: "asc" } } },
        },
      },
    });
    if (!authorization)
      fail(
        "RETURN_AUTHORIZATION_NOT_FOUND",
        "Return authorization was not found.",
        404,
      );
    assertWarehouseAccess(
      resolved,
      warehouseIds(authorization.returnRequest.lines),
      "read",
      { maskExistence: true },
    );
    return {
      dataSource: "Authoritative PostgreSQL",
      authorization: authorizationModel(authorization),
      request: requestModel(authorization.returnRequest),
      requestLines: authorization.returnRequest.lines.map(lineModel),
      availableActions: authorizationActions(
        resolved,
        authorization,
        capabilities,
        now(),
      ),
      evidence: await evidence(
        prisma,
        resolved,
        "ReturnAuthorization",
        [authorization.id],
      ),
      capabilities,
      inventoryMutation: false,
      limitations: [
        "Phase 4B.1 authorization does not execute a physical return.",
      ],
    };
  }

  async function previewReject(requestId, input, context) {
    const resolved = await actor(context);
    const request = await prisma.returnRequest.findFirst({
      where: { id: text(requestId), tenantId: resolved.tenantId },
      include: { lines: true, authorizations: true },
    });
    if (!request)
      fail("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404);
    assertWarehouseAccess(resolved, warehouseIds(request.lines), "read", {
      maskExistence: true,
    });
    const blockingIssues = [];
    if (!permission(resolved, "returns.authorization.reject"))
      blockingIssues.push({
        code: "PERMISSION_DENIED",
        message: "Return request access is denied.",
        status: 403,
      });
    if (request.workflowStatus !== "submitted")
      blockingIssues.push({
        code: "RETURN_REQUEST_NOT_SUBMITTED",
        message: "Only a submitted return request can be rejected.",
        status: 409,
      });
    if (!text(input?.authorizationNumber))
      blockingIssues.push({
        code: "RETURN_AUTHORIZATION_NUMBER_REQUIRED",
        message: "authorizationNumber is required.",
        status: 422,
      });
    if (!text(input?.reason))
      blockingIssues.push({
        code: "RETURN_REASON_REQUIRED",
        message: "A rejection reason is required.",
        status: 422,
      });
    if (
      request.authorizations.some((row) =>
        ["draft", "approved", "partially_executed"].includes(
          row.workflowStatus,
        ),
      )
    )
      blockingIssues.push({
        code: "RETURN_AUTHORIZATION_ALREADY_ACTIVE",
        message: "An active authorization prevents request rejection.",
        status: 409,
      });
    return {
      operation: "reject_return_request",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      warnings: [],
      inventoryMutation: false,
      request: requestModel(request),
      factsToCreate: { auditEvents: 1, inventoryMovements: 0 },
    };
  }

  // Preview of cancel, expire or close remainder on an authorization.
  async function previewAuthorizationClosure(
    authorizationId,
    action,
    input,
    context,
  ) {
    const resolved = await actor(context);
    assertAuthorized({
      actor: resolved,
      permission:
        action === "expire"
          ? "returns.authorization.expire"
          : "returns.authorization.cancel",
      tenantId: resolved.tenantId,
    });
    const plan = await buildReturnAuthorizationClosurePlan({
      prisma,
      tenantId: resolved.tenantId,
      authorizationId,
      action,
      now: now(),
    });
    if (plan.authorization)
      assertWarehouseAccess(resolved, plan.warehouseIds, "read", {
        maskExistence: true,
      });
    else if (plan.blockingIssues[0]?.status === 404)
      fail(
        plan.blockingIssues[0].code,
        plan.blockingIssues[0].message,
        404,
      );
    const blockingIssues = [...plan.blockingIssues];
    if (action !== "expire" && !text(input?.reason))
      blockingIssues.push({
        code: "RETURN_REASON_REQUIRED",
        message: "A reason is required.",
        status: 422,
      });
    return {
      operation: plan.operation,
      allowed: blockingIssues.length === 0,
      blockingIssues,
      warnings: [],
      inventoryMutation: false,
      lines: plan.lines || [],
      authorizationStatusAfter: plan.authorizationStatusAfter || null,
      requestStatusAfter: plan.requestStatusAfter || null,
      factsToCreate: { auditEvents: 1, inventoryMovements: 0 },
    };
  }

  return {
    entryData,
    previewRequest,
    previewSubmit,
    previewCancel,
    previewReject,
    previewAuthorizationClosure,
    previewAuthorization,
    listRequests,
    listAuthorizations,
    listPostings,
    requestWorkbench,
    authorizationWorkbench,
  };
}

// The button rules, exported for unit tests.
export {
  actionModel as returnRequestAvailableActions,
  authorizationActions as returnAuthorizationAvailableActions,
};
