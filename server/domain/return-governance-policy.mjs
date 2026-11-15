import {
  outboundDecimalString as fixed,
  outboundDecimalUnits as units,
} from "./outbound-transaction-policy.mjs";

const ZERO = 0n;
const text = (value) => String(value ?? "").trim();
const sorted = (values) =>
  [...new Set(values.map(text).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
const issue = (code, message, status = 422, details) => ({
  code,
  message,
  status,
  ...(details ? { details } : {}),
});

function quantity(value, issues, label) {
  try {
    const parsed = units(value);
    if (parsed <= ZERO)
      issues.push(
        issue("RETURN_QUANTITY_INVALID", `${label} must be positive.`),
      );
    return parsed;
  } catch {
    issues.push(
      issue(
        "RETURN_QUANTITY_INVALID",
        `${label} must use at most four decimal places.`,
      ),
    );
    return null;
  }
}

function basePlan(operation, blockingIssues, extra = {}) {
  return {
    operation,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    warnings: [],
    inventoryMutation: false,
    factsToCreate: {
      inventoryBalances: 0,
      quarantineBalances: 0,
      inventoryMovements: 0,
      reservations: 0,
      shipments: 0,
      receivingDocuments: 0,
    },
    ...extra,
  };
}

function requestTypeContextAllowed(returnType, contextType) {
  return returnType === "customer_return"
    ? ["SalesOrder", "ShipmentDocument"].includes(contextType)
    : returnType === "supplier_return"
      ? ["PurchaseOrder", "ReceivingDocument"].includes(contextType)
      : false;
}

async function existingConsumption(
  prisma,
  tenantId,
  sourceDocumentType,
  sourceLineIds,
  currentRequestId,
) {
  const pendingStatuses = [
    "draft",
    "submitted",
    "authorized",
    "partially_executed",
  ];
  const pending = await prisma.returnRequestLine.findMany({
    where: {
      sourceDocumentType,
      sourceDocumentLineId: { in: sourceLineIds },
      returnRequest: {
        tenantId,
        workflowStatus: { in: pendingStatuses },
        ...(currentRequestId ? { id: { not: currentRequestId } } : {}),
      },
    },
    select: { sourceDocumentLineId: true, requestedQuantity: true },
  });
  const posted = await prisma.returnPostingLine.findMany({
    where: {
      returnAuthorizationLine: {
        returnRequestLine: {
          sourceDocumentType,
          sourceDocumentLineId: { in: sourceLineIds },
          returnRequest: { tenantId },
        },
      },
      returnPosting: {
        tenantId,
        postingStatus: "posted",
      },
    },
    select: {
      quantity: true,
      returnAuthorizationLine: {
        select: {
          returnRequestLine: {
            select: { sourceDocumentLineId: true },
          },
        },
      },
    },
  });
  const pendingByLine = new Map();
  const executedByLine = new Map();
  for (const row of pending)
    pendingByLine.set(
      row.sourceDocumentLineId,
      (pendingByLine.get(row.sourceDocumentLineId) || ZERO) +
        units(row.requestedQuantity),
    );
  for (const row of posted) {
    const lineId =
      row.returnAuthorizationLine.returnRequestLine.sourceDocumentLineId;
    executedByLine.set(
      lineId,
      (executedByLine.get(lineId) || ZERO) + units(row.quantity),
    );
  }
  return { pendingByLine, executedByLine };
}

async function customerSourceFacts(
  prisma,
  tenantId,
  contextType,
  contextId,
  lineIds,
  blockingIssues,
) {
  const rows = await prisma.shipmentLine.findMany({
    where: { id: { in: lineIds } },
    include: {
      shipment: { include: { salesOrder: true } },
      salesOrderLine: true,
      item: true,
      allocations: true,
    },
    orderBy: { id: "asc" },
  });
  if (rows.length !== lineIds.length) {
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_LINE_NOT_FOUND",
        "Every customer return line must reference a posted shipment line.",
        404,
      ),
    );
    return null;
  }
  for (const row of rows) {
    if (
      row.shipment.tenantId !== tenantId ||
      row.shipment.postingStatus !== "posted" ||
      row.shipment.reversedAt ||
      row.item.tenantId !== tenantId ||
      row.item.id !== row.itemId ||
      row.item.sku !== row.sku ||
      row.salesOrderLine.salesOrderId !== row.shipment.salesOrderId
    )
      blockingIssues.push(
        issue(
          "CUSTOMER_RETURN_SOURCE_INVALID",
          `Shipment line ${row.id} is not an authoritative posted customer-return source.`,
          409,
        ),
      );
  }
  const documentIds = sorted(rows.map((row) => row.shipmentId));
  if (documentIds.length !== 1)
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_DOCUMENT_MIXED",
        "A return request cannot combine lines from different physical source documents.",
      ),
    );
  const shipment = rows[0]?.shipment;
  if (
    shipment &&
    ((contextType === "ShipmentDocument" && shipment.id !== contextId) ||
      (contextType === "SalesOrder" && shipment.salesOrderId !== contextId))
  )
    blockingIssues.push(
      issue(
        "CUSTOMER_RETURN_CONTEXT_MISMATCH",
        "The shipment lines do not belong to the selected customer-return context.",
      ),
    );
  return {
    physicalDocumentType: "ShipmentDocument",
    physicalDocumentId: shipment?.id,
    physicalDocumentNumber: shipment?.shipmentNumber,
    partnerId: shipment?.salesOrder?.customerId || null,
    partnerName: shipment?.salesOrder?.customerName || null,
    lines: rows.map((row) => ({
      sourceDocumentType: "ShipmentDocument",
      sourceDocumentId: row.shipmentId,
      sourceDocumentLineId: row.id,
      sourceQuantityUnits: units(row.postedQuantity),
      itemId: row.itemId,
      sku: row.sku,
      itemName: row.salesOrderLine.itemName || row.item.name,
      unit: row.unit,
      warehouseIds: sorted(row.allocations.map((entry) => entry.warehouseId)),
    })),
  };
}

async function supplierSourceFacts(
  prisma,
  tenantId,
  contextType,
  contextId,
  lineIds,
  blockingIssues,
) {
  const rows = await prisma.receivingLine.findMany({
    where: { id: { in: lineIds } },
    include: { receivingDocument: true },
    orderBy: { id: "asc" },
  });
  if (rows.length !== lineIds.length) {
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_LINE_NOT_FOUND",
        "Every supplier return line must reference a posted receiving line.",
        404,
      ),
    );
    return null;
  }
  const itemIds = sorted(rows.map((row) => row.itemId));
  const items = itemIds.length
    ? await prisma.item.findMany({
        where: { tenantId, id: { in: itemIds } },
        orderBy: { id: "asc" },
      })
    : [];
  const itemsById = new Map(items.map((row) => [row.id, row]));
  for (const row of rows) {
    const item = itemsById.get(row.itemId);
    if (
      row.receivingDocument.tenantId !== tenantId ||
      row.receivingDocument.postingStatus !== "posted" ||
      row.receivingDocument.reversedAt ||
      !item ||
      item.sku !== row.sku ||
      !row.warehouseId
    )
      blockingIssues.push(
        issue(
          "SUPPLIER_RETURN_SOURCE_INVALID",
          `Receiving line ${row.id} is not an authoritative posted supplier-return source.`,
          409,
        ),
      );
  }
  const documentIds = sorted(rows.map((row) => row.receivingDocumentId));
  if (documentIds.length !== 1)
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_DOCUMENT_MIXED",
        "A return request cannot combine lines from different physical source documents.",
      ),
    );
  const receiving = rows[0]?.receivingDocument;
  if (
    receiving &&
    ((contextType === "ReceivingDocument" && receiving.id !== contextId) ||
      (contextType === "PurchaseOrder" && receiving.poId !== contextId))
  )
    blockingIssues.push(
      issue(
        "SUPPLIER_RETURN_CONTEXT_MISMATCH",
        "The receiving lines do not belong to the selected supplier-return context.",
      ),
    );
  let purchaseOrder = null;
  if (receiving?.poId)
    purchaseOrder = await prisma.purchaseOrder.findFirst({
      where: { id: receiving.poId, tenantId },
    });
  return {
    physicalDocumentType: "ReceivingDocument",
    physicalDocumentId: receiving?.id,
    physicalDocumentNumber: receiving?.documentNumber,
    partnerId: receiving?.supplierId || purchaseOrder?.supplierId || null,
    partnerName:
      receiving?.supplierName || purchaseOrder?.supplierName || null,
    lines: rows.map((row) => ({
      sourceDocumentType: "ReceivingDocument",
      sourceDocumentId: row.receivingDocumentId,
      sourceDocumentLineId: row.id,
      sourceQuantityUnits: units(row.acceptedQty || 0),
      itemId: row.itemId,
      sku: row.sku,
      itemName: row.itemName || itemsById.get(row.itemId)?.name,
      unit: row.unit,
      warehouseIds: sorted([row.warehouseId]),
    })),
  };
}

export async function buildReturnRequestPlan({
  prisma,
  tenantId,
  input = {},
  currentRequestId,
}) {
  const blockingIssues = [];
  const returnType = text(input.returnType);
  const requestNumber = text(input.requestNumber);
  const contextDocumentType = text(
    input.contextDocumentType || input.sourceDocumentType,
  );
  const contextDocumentId = text(
    input.contextDocumentId || input.sourceDocumentId,
  );
  const reasonCode = text(input.reasonCode);
  const lineInputs = Array.isArray(input.lines) ? input.lines : [];
  if (!["supplier_return", "customer_return"].includes(returnType))
    blockingIssues.push(
      issue(
        "RETURN_TYPE_INVALID",
        "returnType must be supplier_return or customer_return.",
      ),
    );
  if (!requestNumber)
    blockingIssues.push(
      issue("RETURN_REQUEST_NUMBER_REQUIRED", "requestNumber is required."),
    );
  if (!requestTypeContextAllowed(returnType, contextDocumentType))
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_TYPE_INVALID",
        "The selected source document type is not valid for this return type.",
      ),
    );
  if (!contextDocumentId)
    blockingIssues.push(
      issue("RETURN_SOURCE_REQUIRED", "A source document is required."),
    );
  if (!reasonCode)
    blockingIssues.push(
      issue("RETURN_REASON_REQUIRED", "A return reason is required."),
    );
  if (!lineInputs.length)
    blockingIssues.push(
      issue("RETURN_LINES_REQUIRED", "At least one return line is required."),
    );

  const lineIds = lineInputs.map((row) => text(row.sourceDocumentLineId));
  if (lineIds.some((id) => !id))
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_LINE_REQUIRED",
        "Every return line requires sourceDocumentLineId.",
      ),
    );
  if (new Set(lineIds).size !== lineIds.length)
    blockingIssues.push(
      issue(
        "RETURN_SOURCE_LINE_DUPLICATE",
        "A return request cannot contain the same source line more than once.",
      ),
    );
  const quantityByLine = new Map();
  for (const row of lineInputs) {
    const lineId = text(row.sourceDocumentLineId);
    quantityByLine.set(
      lineId,
      quantity(row.requestedQuantity, blockingIssues, `Line ${lineId}`),
    );
  }
  if (blockingIssues.length)
    return basePlan("return_request", blockingIssues);

  const source =
    returnType === "customer_return"
      ? await customerSourceFacts(
          prisma,
          tenantId,
          contextDocumentType,
          contextDocumentId,
          lineIds,
          blockingIssues,
        )
      : await supplierSourceFacts(
          prisma,
          tenantId,
          contextDocumentType,
          contextDocumentId,
          lineIds,
          blockingIssues,
        );
  if (!source || blockingIssues.length)
    return basePlan("return_request", blockingIssues);

  const { pendingByLine, executedByLine } = await existingConsumption(
    prisma,
    tenantId,
    source.physicalDocumentType,
    lineIds,
    currentRequestId,
  );
  const inputByLine = new Map(
    lineInputs.map((row) => [text(row.sourceDocumentLineId), row]),
  );
  const resolvedLines = source.lines.map((row) => {
    const { sourceQuantityUnits, ...sourceIdentity } = row;
    const requested = quantityByLine.get(row.sourceDocumentLineId);
    const pending = pendingByLine.get(row.sourceDocumentLineId) || ZERO;
    const executed = executedByLine.get(row.sourceDocumentLineId) || ZERO;
    const remaining = sourceQuantityUnits - pending - executed;
    if (sourceQuantityUnits <= ZERO)
      blockingIssues.push(
        issue(
          "RETURN_SOURCE_QUANTITY_UNAVAILABLE",
          `Source line ${row.sourceDocumentLineId} has no posted quantity available for return.`,
          409,
        ),
      );
    if (requested !== null && requested > remaining)
      blockingIssues.push(
        issue(
          "RETURN_QUANTITY_EXCEEDS_SOURCE",
          `Requested quantity exceeds the unconsumed source quantity for line ${row.sourceDocumentLineId}.`,
          409,
          {
            sourceQuantity: fixed(sourceQuantityUnits),
            otherActiveRequestedQuantity: fixed(pending),
            executedReturnQuantity: fixed(executed),
            remainingQuantity: fixed(remaining),
          },
        ),
      );
    const submitted = inputByLine.get(row.sourceDocumentLineId);
    return {
      ...sourceIdentity,
      sourceQuantity: fixed(sourceQuantityUnits),
      requestedQuantity: fixed(requested || ZERO),
      otherActiveRequestedQuantity: fixed(pending),
      executedReturnQuantity: fixed(executed),
      remainingQuantityBeforeRequest: fixed(remaining),
      reasonCode: text(submitted?.reasonCode || reasonCode),
      conditionCode: text(submitted?.conditionCode) || null,
    };
  });
  return basePlan("return_request", blockingIssues, {
    request: {
      requestNumber,
      returnType,
      contextDocumentType,
      contextDocumentId,
      sourceDocumentType: source.physicalDocumentType,
      sourceDocumentId: source.physicalDocumentId,
      sourceDocumentNumber: source.physicalDocumentNumber || null,
      partnerId: source.partnerId,
      partnerNameSnapshot: source.partnerName,
      reasonCode,
      reasonDetail: text(input.reasonDetail) || null,
      warehouseIds: sorted(
        resolvedLines.flatMap((row) => row.warehouseIds),
      ),
    },
    lines: resolvedLines,
  });
}

export async function buildReturnAuthorizationPlan({
  prisma,
  tenantId,
  requestId,
  input = {},
}) {
  const blockingIssues = [];
  const request = await prisma.returnRequest.findFirst({
    where: { id: text(requestId), tenantId },
    include: {
      lines: { orderBy: { id: "asc" } },
      authorizations: {
        include: {
          lines: true,
          postings: {
            include: { lines: true },
          },
        },
      },
    },
  });
  if (!request)
    return basePlan("return_authorization", [
      issue("RETURN_REQUEST_NOT_FOUND", "Return request was not found.", 404),
    ]);
  const inputLines = Array.isArray(input.lines) ? input.lines : [];
  const releaseOnly =
    inputLines.length > 0 &&
    inputLines.every(
      (entry) =>
        text(entry.dispositionRoute) ===
        "release_quarantine_to_available",
    );
  const validRequestState =
    request.workflowStatus === "submitted" ||
    (request.returnType === "customer_return" &&
      request.workflowStatus === "executed" &&
      releaseOnly);
  if (!validRequestState)
    blockingIssues.push(
      issue(
        "RETURN_REQUEST_NOT_SUBMITTED",
        "Only a submitted return request, or an executed customer return awaiting governed quarantine release, can be authorized.",
        409,
      ),
    );
  const activeAuthorizations = request.authorizations.filter((authorization) =>
    ["draft", "approved", "partially_executed"].includes(
      authorization.workflowStatus,
    ),
  );
  if (activeAuthorizations.length)
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_ALREADY_ACTIVE",
        "The return request already has an active authorization.",
        409,
      ),
    );
  const authorizationNumber = text(input.authorizationNumber);
  if (!authorizationNumber)
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_NUMBER_REQUIRED",
        "authorizationNumber is required.",
      ),
    );
  if (!inputLines.length)
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_LINES_REQUIRED",
        "At least one authorization line is required.",
      ),
    );
  const lineIds = inputLines.map((row) => text(row.returnRequestLineId));
  if (new Set(lineIds).size !== lineIds.length)
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_LINE_DUPLICATE",
        "An authorization cannot contain the same request line twice.",
      ),
    );
  const requestLines = new Map(request.lines.map((row) => [row.id, row]));
  const releasedByRequestLine = new Map();
  const receivedByRequestLine = new Map();
  const dispatchedByRequestLine = new Map();
  for (const historicalAuthorization of request.authorizations) {
    const requestLineByAuthorizationLine = new Map(
      historicalAuthorization.lines.map((line) => [
        line.id,
        line.returnRequestLineId,
      ]),
    );
    for (const posting of historicalAuthorization.postings) {
      if (posting.postingStatus !== "posted") continue;
      const target =
        posting.postingType === "customer_return_receipt"
          ? receivedByRequestLine
          : posting.postingType === "quarantine_release"
            ? releasedByRequestLine
            : posting.postingType === "supplier_return_dispatch"
              ? dispatchedByRequestLine
              : null;
      if (!target) continue;
      for (const line of posting.lines) {
        const requestLineId = requestLineByAuthorizationLine.get(
          line.returnAuthorizationLineId,
        );
        if (!requestLineId) continue;
        target.set(
          requestLineId,
          (target.get(requestLineId) || ZERO) + units(line.quantity),
        );
      }
    }
  }
  const normalized = [];
  for (const entry of inputLines) {
    const requestLine = requestLines.get(text(entry.returnRequestLineId));
    if (!requestLine) {
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_LINE_INVALID",
          "Every authorization line must belong to the selected return request.",
        ),
      );
      continue;
    }
    const authorized = quantity(
      entry.authorizedQuantity,
      blockingIssues,
      `Authorization line ${requestLine.id}`,
    );
    const dispositionRoute = text(entry.dispositionRoute);
    // A new receive or dispatch authorization covers only what earlier
    // authorizations of this request have not already executed (L8-04).
    const alreadyExecuted =
      dispositionRoute === "release_quarantine_to_available"
        ? ZERO
        : (receivedByRequestLine.get(requestLine.id) || ZERO) +
          (dispatchedByRequestLine.get(requestLine.id) || ZERO);
    if (
      authorized !== null &&
      authorized > units(requestLine.requestedQuantity) - alreadyExecuted
    )
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_EXCEEDS_REQUEST",
          `Authorized quantity exceeds requested quantity for line ${requestLine.id}.`,
          409,
          alreadyExecuted > ZERO
            ? { alreadyExecutedQuantity: fixed(alreadyExecuted) }
            : undefined,
        ),
      );
    const allowedRoutes =
      request.returnType === "customer_return"
        ? releaseOnly
          ? ["release_quarantine_to_available"]
          : ["receive_to_quarantine"]
        : ["return_from_available", "return_from_quarantine"];
    if (!allowedRoutes.includes(dispositionRoute))
      blockingIssues.push(
        issue(
          "RETURN_DISPOSITION_NOT_ALLOWED",
          "The disposition route is not allowed for the current return type and lifecycle stage.",
        ),
      );
    if (dispositionRoute === "release_quarantine_to_available") {
      const releasable =
        (receivedByRequestLine.get(requestLine.id) || ZERO) -
        (releasedByRequestLine.get(requestLine.id) || ZERO);
      if (authorized !== null && authorized > releasable)
        blockingIssues.push(
          issue(
            "RETURN_RELEASE_EXCEEDS_RECEIVED_QUARANTINE",
            `Release authorization exceeds received, unreleased quarantine quantity for line ${requestLine.id}.`,
            409,
            { releasableQuantity: fixed(releasable) },
          ),
        );
    }
    normalized.push({
      returnRequestLineId: requestLine.id,
      authorizedQuantity: fixed(authorized || ZERO),
      dispositionRoute,
      requestedQuantity: fixed(units(requestLine.requestedQuantity)),
    });
  }
  return basePlan("return_authorization", blockingIssues, {
    request,
    authorization: {
      authorizationNumber,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      lines: normalized,
    },
  });
}

export const returnGovernanceFixed = fixed;
export const returnGovernanceUnits = units;
