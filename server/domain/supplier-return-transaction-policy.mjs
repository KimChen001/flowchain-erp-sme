import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";
import { executableAuthorizedUnits } from "./return-authorization-closure-policy.mjs";

const text = (value) => String(value ?? "").trim();
const fixed = (value) =>
  decimalString(typeof value === "bigint" ? value : decimalUnits(value || 0));
const issue = (code, message, status = 422, details) => ({
  code,
  message,
  status,
  details,
});
const result = (normalizedPlan, blockingIssues, extra = {}) => ({
  normalizedPlan,
  allowed: blockingIssues.length === 0,
  blockingIssues,
  warnings: [],
  balanceImpacts: [],
  documentImpacts: [],
  movementFacts: [],
  auditFacts: [],
  reconciliationImpacts: [],
  ...extra,
});

function positiveUnits(value, blockingIssues, details) {
  try {
    const units = decimalUnits(value);
    if (units <= 0n) throw new Error("non-positive");
    return units;
  } catch {
    blockingIssues.push(
      issue(
        "RETURN_POSTING_QUANTITY_INVALID",
        "Return posting quantity must be positive with at most four decimal places.",
        422,
        details,
      ),
    );
    return 0n;
  }
}

function sameUnits(actual, expected) {
  return decimalUnits(actual || 0) === decimalUnits(expected || 0);
}

function sameOptionalText(left, right) {
  return text(left) === text(right);
}

function executionStatuses(totalAuthorized, executed) {
  if (executed <= 0n)
    return { authorizationStatus: "approved", requestStatus: "authorized" };
  if (executed >= totalAuthorized)
    return { authorizationStatus: "executed", requestStatus: "executed" };
  return {
    authorizationStatus: "partially_executed",
    requestStatus: "partially_executed",
  };
}

function postedQuantities(authorization, excludedPostingId = "") {
  const used = new Map();
  for (const posting of authorization.postings || []) {
    if (
      posting.id === excludedPostingId ||
      posting.postingStatus !== "posted"
    )
      continue;
    for (const line of posting.lines || [])
      used.set(
        line.returnAuthorizationLineId,
        (used.get(line.returnAuthorizationLineId) || 0n) +
          decimalUnits(line.quantity),
      );
  }
  return used;
}

function totalAuthorizedUnits(authorization) {
  return (authorization.lines || []).reduce(
    (sum, line) => sum + executableAuthorizedUnits(line),
    0n,
  );
}

function totalPostedUnits(authorization, excludedPostingId = "") {
  return [...postedQuantities(authorization, excludedPostingId).values()].reduce(
    (sum, units) => sum + units,
    0n,
  );
}

async function loadAuthorization(prisma, tenantId, authorizationId) {
  return prisma.returnAuthorization.findFirst({
    where: { id: text(authorizationId), tenantId },
    include: {
      returnRequest: { include: { lines: true } },
      lines: {
        include: { returnRequestLine: true },
        orderBy: { id: "asc" },
      },
      postings: {
        include: { lines: true },
        orderBy: { id: "asc" },
      },
    },
  });
}

function validateSupplierAuthorization(authorization, blockingIssues, now) {
  if (!authorization) {
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_NOT_FOUND",
        "Return authorization was not found.",
        404,
      ),
    );
    return;
  }
  if (authorization.returnRequest.returnType !== "supplier_return")
    blockingIssues.push(
      issue(
        "RETURN_POSTING_TYPE_MISMATCH",
        "Supplier return dispatch requires a supplier return authorization.",
        409,
      ),
    );
  if (!["approved", "partially_executed"].includes(authorization.workflowStatus))
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_INVALID_STATE",
        "Only approved or partially executed authorizations can be posted.",
        409,
      ),
    );
  if (
    authorization.expiresAt &&
    authorization.expiresAt.getTime() <= now.getTime()
  )
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_EXPIRED",
        "The return authorization has expired.",
        409,
      ),
    );
}

function balanceIdentityIssue(lineId, balanceType) {
  return issue(
    "RETURN_POSTING_BALANCE_IDENTITY_MISMATCH",
    `The ${balanceType} balance does not match the authorized return line.`,
    409,
    { returnAuthorizationLineId: lineId, balanceType },
  );
}

export async function buildSupplierReturnDraftPlan({
  prisma,
  tenantId,
  authorizationId,
  lines = [],
  now = new Date(),
}) {
  const blockingIssues = [];
  const authorization = await loadAuthorization(
    prisma,
    tenantId,
    authorizationId,
  );
  validateSupplierAuthorization(authorization, blockingIssues, now);
  if (!authorization)
    return result(
      { authorizationId: text(authorizationId), postingType: "supplier_return_dispatch", lines: [] },
      blockingIssues,
    );

  const submittedLines = Array.isArray(lines) ? lines : [];
  if (!submittedLines.length)
    blockingIssues.push(
      issue(
        "RETURN_POSTING_LINES_REQUIRED",
        "At least one supplier return posting line is required.",
      ),
    );

  const duplicateIds = submittedLines
    .map((line) => text(line.returnAuthorizationLineId))
    .filter((id, index, all) => id && all.indexOf(id) !== index);
  if (duplicateIds.length)
    blockingIssues.push(
      issue(
        "RETURN_POSTING_DUPLICATE_AUTHORIZATION_LINE",
        "A return authorization line can appear only once in a posting document.",
        409,
        { returnAuthorizationLineIds: [...new Set(duplicateIds)].sort() },
      ),
    );

  const availableIds = submittedLines
    .map((line) => text(line.inventoryBalanceId))
    .filter(Boolean);
  const quarantineIds = submittedLines
    .map((line) => text(line.quarantineBalanceId))
    .filter(Boolean);
  const [availableBalances, quarantineBalances] = await Promise.all([
    availableIds.length
      ? prisma.inventoryBalance.findMany({
          where: { tenantId, id: { in: availableIds } },
        })
      : [],
    quarantineIds.length
      ? prisma.quarantineInventoryBalance.findMany({
          where: { tenantId, id: { in: quarantineIds } },
        })
      : [],
  ]);
  const availableById = new Map(
    availableBalances.map((balance) => [balance.id, balance]),
  );
  const quarantineById = new Map(
    quarantineBalances.map((balance) => [balance.id, balance]),
  );
  const authorizationLines = new Map(
    authorization.lines.map((line) => [line.id, line]),
  );
  const used = postedQuantities(authorization);
  const normalizedLines = [];

  for (const submitted of submittedLines) {
    const authorizationLineId = text(submitted.returnAuthorizationLineId);
    const authorizationLine = authorizationLines.get(authorizationLineId);
    const quantityUnits = positiveUnits(
      submitted.quantity,
      blockingIssues,
      { returnAuthorizationLineId: authorizationLineId },
    );
    if (!authorizationLine) {
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_LINE_NOT_FOUND",
          "The posting line does not belong to the return authorization.",
          409,
          { returnAuthorizationLineId: authorizationLineId },
        ),
      );
      continue;
    }
    const requestLine = authorizationLine.returnRequestLine;
    const remaining =
      executableAuthorizedUnits(authorizationLine) -
      (used.get(authorizationLine.id) || 0n);
    if (quantityUnits > remaining)
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED",
          "Posting quantity exceeds the remaining authorized quantity.",
          409,
          {
            returnAuthorizationLineId: authorizationLine.id,
            remainingQuantity: fixed(remaining),
            postingQuantity: fixed(quantityUnits),
          },
        ),
      );

    const route = authorizationLine.dispositionRoute;
    const inventoryBalanceId = text(submitted.inventoryBalanceId);
    const quarantineBalanceId = text(submitted.quarantineBalanceId);
    const availableRoute = route === "return_from_available";
    const quarantineRoute = route === "return_from_quarantine";
    if (!availableRoute && !quarantineRoute) {
      blockingIssues.push(
        issue(
          "RETURN_DISPOSITION_ROUTE_NOT_EXECUTABLE",
          "The authorization route cannot be executed as a supplier return dispatch.",
          409,
          { dispositionRoute: route },
        ),
      );
      continue;
    }
    if (
      (availableRoute && (!inventoryBalanceId || quarantineBalanceId)) ||
      (quarantineRoute && (!quarantineBalanceId || inventoryBalanceId))
    )
      blockingIssues.push(
        issue(
          "RETURN_POSTING_BALANCE_SELECTION_INVALID",
          availableRoute
            ? "Available supplier returns require exactly one available inventory balance."
            : "Quarantine supplier returns require exactly one quarantine inventory balance.",
          422,
          { returnAuthorizationLineId: authorizationLine.id },
        ),
      );

    const balanceType = availableRoute ? "available" : "quarantine";
    const balance = availableRoute
      ? availableById.get(inventoryBalanceId)
      : quarantineById.get(quarantineBalanceId);
    if (!balance)
      blockingIssues.push(
        issue(
          "RETURN_POSTING_BALANCE_NOT_FOUND",
          "The selected supplier return source balance was not found.",
          404,
          {
            returnAuthorizationLineId: authorizationLine.id,
            balanceType,
            balanceId: availableRoute
              ? inventoryBalanceId
              : quarantineBalanceId,
          },
        ),
      );
    else {
      const balanceStatus = text(balance.status).toLowerCase();
      const statusInvalid = availableRoute
        ? Boolean(
            balanceStatus &&
              !["active", "available"].includes(balanceStatus),
          )
        : balanceStatus !== "active";
      if (
        balance.itemId !== requestLine.itemId ||
        balance.sku !== requestLine.sku ||
        !sameOptionalText(balance.unit, requestLine.unit) ||
        statusInvalid
      )
        blockingIssues.push(
          balanceIdentityIssue(authorizationLine.id, balanceType),
        );
    }

    normalizedLines.push({
      returnAuthorizationLineId: authorizationLine.id,
      returnRequestLineId: requestLine.id,
      itemId: requestLine.itemId,
      sku: requestLine.sku,
      itemName: requestLine.itemName,
      unit: requestLine.unit || null,
      quantity: fixed(quantityUnits),
      quantityUnits,
      dispositionRoute: route,
      balanceType,
      balanceId: balance?.id || (availableRoute ? inventoryBalanceId : quarantineBalanceId),
      inventoryBalanceId: availableRoute ? inventoryBalanceId : null,
      quarantineBalanceId: quarantineRoute ? quarantineBalanceId : null,
      warehouseId: balance?.warehouseId || "",
      location: balance?.location || null,
      locationKey: balance?.locationKey || "",
      balance,
      remainingAuthorizedBefore: fixed(remaining),
      remainingAuthorizedAfter: fixed(remaining - quantityUnits),
    });
  }

  const warehouseIds = [
    ...new Set(normalizedLines.map((line) => line.warehouseId).filter(Boolean)),
  ].sort();
  if (warehouseIds.length > 1)
    blockingIssues.push(
      issue(
        "RETURN_POSTING_MULTIPLE_WAREHOUSES_NOT_ALLOWED",
        "One return posting document must use a single warehouse.",
        409,
        { warehouseIds },
      ),
    );

  return result(
    {
      authorizationId: authorization.id,
      returnRequestId: authorization.returnRequestId,
      postingType: "supplier_return_dispatch",
      warehouseId: warehouseIds[0] || "",
      lines: normalizedLines,
    },
    blockingIssues,
    {
      authorization,
      warehouseIds,
      documentImpacts: [
        {
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          workflowStatus: authorization.workflowStatus,
        },
      ],
    },
  );
}

function aggregatePostingBalances(lines, blockingIssues) {
  const grouped = new Map();
  for (const line of lines) {
    if (!line.balance) continue;
    const key = `${line.balanceType}:${line.balance.id}`;
    const aggregate = grouped.get(key) || {
      balanceType: line.balanceType,
      balance: line.balance,
      quantityUnits: 0n,
      postingLineIds: [],
      authorizationLineIds: [],
    };
    aggregate.quantityUnits += line.quantityUnits;
    aggregate.postingLineIds.push(line.id);
    aggregate.authorizationLineIds.push(line.returnAuthorizationLineId);
    grouped.set(key, aggregate);
  }

  const impacts = [];
  for (const aggregate of [...grouped.values()].sort((left, right) =>
    `${left.balanceType}:${left.balance.id}`.localeCompare(
      `${right.balanceType}:${right.balance.id}`,
    ),
  )) {
    const onHandBefore = decimalUnits(aggregate.balance.onHandQuantity);
    const onHandAfter = onHandBefore - aggregate.quantityUnits;
    if (aggregate.balanceType === "available") {
      const reservedBefore = decimalUnits(
        aggregate.balance.reservedQuantity || 0,
      );
      const availableBefore = decimalUnits(
        aggregate.balance.availableQuantity || 0,
      );
      const availableAfter = availableBefore - aggregate.quantityUnits;
      if (availableBefore !== onHandBefore - reservedBefore)
        blockingIssues.push(
          issue(
            "RETURN_INVENTORY_BALANCE_INTEGRITY_FAILED",
            "Available inventory balance is internally inconsistent.",
            409,
            {
              balanceId: aggregate.balance.id,
              onHandBefore: fixed(onHandBefore),
              reservedBefore: fixed(reservedBefore),
              availableBefore: fixed(availableBefore),
            },
          ),
        );
      if (
        availableBefore < aggregate.quantityUnits ||
        onHandAfter < reservedBefore ||
        availableAfter < 0n
      )
        blockingIssues.push(
          issue(
            "RETURN_AVAILABLE_INVENTORY_INSUFFICIENT",
            "Available inventory is insufficient for the supplier return.",
            409,
            {
              balanceId: aggregate.balance.id,
              requestedQuantity: fixed(aggregate.quantityUnits),
              availableBefore: fixed(availableBefore),
              onHandBefore: fixed(onHandBefore),
              reservedBefore: fixed(reservedBefore),
            },
          ),
        );
      impacts.push({
        balanceType: "available",
        balanceId: aggregate.balance.id,
        version: aggregate.balance.version,
        quantityUnits: aggregate.quantityUnits,
        quantity: fixed(aggregate.quantityUnits),
        onHandBefore: fixed(onHandBefore),
        onHandAfter: fixed(onHandAfter),
        reservedBefore: fixed(reservedBefore),
        reservedAfter: fixed(reservedBefore),
        availableBefore: fixed(availableBefore),
        availableAfter: fixed(availableAfter),
        postingLineIds: aggregate.postingLineIds.sort(),
        authorizationLineIds: aggregate.authorizationLineIds.sort(),
      });
    } else {
      if (onHandAfter < 0n)
        blockingIssues.push(
          issue(
            "RETURN_QUARANTINE_INVENTORY_INSUFFICIENT",
            "Quarantine inventory is insufficient for the supplier return.",
            409,
            {
              balanceId: aggregate.balance.id,
              requestedQuantity: fixed(aggregate.quantityUnits),
              onHandBefore: fixed(onHandBefore),
            },
          ),
        );
      impacts.push({
        balanceType: "quarantine",
        balanceId: aggregate.balance.id,
        version: aggregate.balance.version,
        quantityUnits: aggregate.quantityUnits,
        quantity: fixed(aggregate.quantityUnits),
        onHandBefore: fixed(onHandBefore),
        onHandAfter: fixed(onHandAfter),
        postingLineIds: aggregate.postingLineIds.sort(),
        authorizationLineIds: aggregate.authorizationLineIds.sort(),
      });
    }
  }
  return impacts;
}

export async function buildSupplierReturnPostingPlan({
  prisma,
  tenantId,
  postingId,
  now = new Date(),
  allowedWorkflowStatuses = ["ready"],
}) {
  const posting = await prisma.returnPostingDocument.findFirst({
    where: { id: text(postingId), tenantId },
    include: {
      lines: { orderBy: { id: "asc" } },
      returnAuthorization: {
        include: {
          returnRequest: { include: { lines: true } },
          lines: {
            include: { returnRequestLine: true },
            orderBy: { id: "asc" },
          },
          postings: {
            include: { lines: true },
            orderBy: { id: "asc" },
          },
        },
      },
    },
  });
  if (!posting)
    return result(
      { postingId: text(postingId), postingType: "supplier_return_dispatch" },
      [issue("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404)],
    );

  const draftPlan = await buildSupplierReturnDraftPlan({
    prisma,
    tenantId,
    authorizationId: posting.returnAuthorizationId,
    lines: posting.lines.map((line) => ({
      returnAuthorizationLineId: line.returnAuthorizationLineId,
      quantity: line.quantity,
      inventoryBalanceId: line.inventoryBalanceId,
      quarantineBalanceId: line.quarantineBalanceId,
    })),
    now,
  });
  const blockingIssues = [...draftPlan.blockingIssues];
  if (posting.postingType !== "supplier_return_dispatch")
    blockingIssues.push(
      issue(
        "RETURN_POSTING_TYPE_MISMATCH",
        "Only supplier return dispatch can use this transaction kernel.",
        409,
      ),
    );
  if (
    !allowedWorkflowStatuses.includes(posting.workflowStatus) ||
    posting.postingStatus !== "unposted"
  )
    blockingIssues.push(
      issue(
        "RETURN_POSTING_INVALID_STATE",
        "The return posting is not in a valid state for this action.",
        409,
        {
          workflowStatus: posting.workflowStatus,
          postingStatus: posting.postingStatus,
        },
      ),
    );

  const persistedByAuthorizationLine = new Map(
    posting.lines.map((line) => [line.returnAuthorizationLineId, line]),
  );
  const quantityPlans = draftPlan.normalizedPlan.lines.map((line) => ({
    ...line,
    id: persistedByAuthorizationLine.get(line.returnAuthorizationLineId)?.id,
    version:
      persistedByAuthorizationLine.get(line.returnAuthorizationLineId)?.version,
  }));
  for (const line of quantityPlans) {
    const persisted = persistedByAuthorizationLine.get(
      line.returnAuthorizationLineId,
    );
    if (
      !persisted ||
      persisted.itemId !== line.itemId ||
      persisted.sku !== line.sku ||
      persisted.itemName !== line.itemName ||
      !sameOptionalText(persisted.unit, line.unit) ||
      persisted.warehouseId !== line.warehouseId ||
      !sameOptionalText(persisted.locationKey, line.locationKey) ||
      !sameUnits(persisted.quantity, line.quantity) ||
      text(persisted.inventoryBalanceId) !==
        text(line.inventoryBalanceId) ||
      text(persisted.quarantineBalanceId) !==
        text(line.quarantineBalanceId)
    )
      blockingIssues.push(
        issue(
          "RETURN_POSTING_LINE_IDENTITY_MISMATCH",
          "Stored supplier return posting facts no longer match the authorization and selected balance.",
          409,
          { postingLineId: persisted?.id || null },
        ),
      );
  }
  if (
    posting.warehouseId !== draftPlan.normalizedPlan.warehouseId ||
    posting.warehouseId !== quantityPlans[0]?.warehouseId
  )
    blockingIssues.push(
      issue(
        "RETURN_POSTING_WAREHOUSE_IDENTITY_MISMATCH",
        "Return posting warehouse no longer matches its authoritative lines.",
        409,
      ),
    );
  const balanceImpacts = aggregatePostingBalances(
    quantityPlans,
    blockingIssues,
  );
  const authorization = posting.returnAuthorization;
  const postedBefore = totalPostedUnits(authorization, posting.id);
  const postingQuantity = quantityPlans.reduce(
    (sum, line) => sum + line.quantityUnits,
    0n,
  );
  const totalAuthorized = totalAuthorizedUnits(authorization);
  const statuses = executionStatuses(
    totalAuthorized,
    postedBefore + postingQuantity,
  );
  const movementFacts = quantityPlans.map((line) => ({
    postingLineId: line.id,
    returnAuthorizationLineId: line.returnAuthorizationLineId,
    returnRequestLineId: line.returnRequestLineId,
    movementType: "supplier_return_out",
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    unit: line.unit,
    warehouseId: line.warehouseId,
    location: line.location,
    locationKey: line.locationKey,
    quantityUnits: line.quantityUnits,
    quantity: line.quantity,
    balanceType: line.balanceType,
    balanceId: line.balanceId,
  }));

  return result(
    {
      postingId: posting.id,
      postingNumber: posting.postingNumber,
      postingType: posting.postingType,
      returnAuthorizationId: posting.returnAuthorizationId,
      returnRequestId: authorization.returnRequestId,
      warehouseId: posting.warehouseId,
      lines: quantityPlans,
    },
    blockingIssues,
    {
      posting,
      authorization,
      warehouseIds: draftPlan.warehouseIds,
      balanceImpacts,
      movementFacts,
      documentImpacts: [
        {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          postingStatusBefore: posting.postingStatus,
          postingStatusAfter: "posted",
        },
        {
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          workflowStatusBefore: authorization.workflowStatus,
          workflowStatusAfter: statuses.authorizationStatus,
          executedQuantityBefore: fixed(postedBefore),
          executedQuantityAfter: fixed(postedBefore + postingQuantity),
          authorizedQuantity: fixed(totalAuthorized),
        },
        {
          entityType: "ReturnRequest",
          entityId: authorization.returnRequestId,
          workflowStatusBefore: authorization.returnRequest.workflowStatus,
          workflowStatusAfter: statuses.requestStatus,
        },
      ],
      authorizationStatusAfter: statuses.authorizationStatus,
      requestStatusAfter: statuses.requestStatus,
      totalAuthorizedQuantity: fixed(totalAuthorized),
      executedQuantityBefore: fixed(postedBefore),
      executedQuantityAfter: fixed(postedBefore + postingQuantity),
    },
  );
}

function validSupplierReturnMovement({
  movement,
  posting,
  postingLine,
  requestId,
}) {
  const balanceType = postingLine.inventoryBalanceId
    ? "available"
    : "quarantine";
  const balanceId =
    postingLine.inventoryBalanceId || postingLine.quarantineBalanceId;
  return Boolean(
    movement &&
      movement.tenantId === posting.tenantId &&
      movement.sourceDocumentType === "ReturnPostingDocument" &&
      movement.sourceDocumentId === posting.id &&
      movement.sourceDocumentLineId === postingLine.id &&
      movement.movementType === "supplier_return_out" &&
      movement.itemId === postingLine.itemId &&
      movement.sku === postingLine.sku &&
      movement.warehouseId === postingLine.warehouseId &&
      sameOptionalText(movement.locationKey, postingLine.locationKey) &&
      sameOptionalText(movement.unit, postingLine.unit) &&
      sameUnits(movement.quantityIn, 0) &&
      sameUnits(movement.quantityOut, postingLine.quantity) &&
      sameUnits(movement.adjustmentQty, 0) &&
      text(movement.postingBatchId) &&
      movement.postingBatchId === posting.metadata?.postingBatchId &&
      movement.relatedReturnId === requestId &&
      movement.metadata?.balanceType === balanceType &&
      movement.metadata?.balanceId === balanceId &&
      movement.metadata?.returnPostingId === posting.id &&
      movement.metadata?.returnAuthorizationId ===
        posting.returnAuthorizationId &&
      movement.metadata?.returnRequestId === requestId &&
      !movement.reversedByMovementId
  );
}

export async function buildSupplierReturnReversalPlan({
  prisma,
  tenantId,
  postingId,
}) {
  const posting = await prisma.returnPostingDocument.findFirst({
    where: { id: text(postingId), tenantId },
    include: {
      lines: { orderBy: { id: "asc" } },
      returnAuthorization: {
        include: {
          returnRequest: true,
          lines: true,
          postings: {
            include: { lines: true },
            orderBy: { id: "asc" },
          },
        },
      },
    },
  });
  if (!posting)
    return result(
      { postingId: text(postingId), postingType: "supplier_return_dispatch" },
      [issue("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404)],
    );
  const blockingIssues = [];
  if (
    posting.postingType !== "supplier_return_dispatch" ||
    posting.postingStatus !== "posted" ||
    posting.reversedAt ||
    !text(posting.metadata?.postingBatchId)
  )
    blockingIssues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "The supplier return posting is not safely reversible.",
        409,
      ),
    );

  const movements = await prisma.inventoryMovement.findMany({
    where: {
      tenantId,
      sourceDocumentType: "ReturnPostingDocument",
      sourceDocumentId: posting.id,
      movementType: "supplier_return_out",
    },
    orderBy: { id: "asc" },
  });
  const movementByLine = new Map(
    movements.map((movement) => [movement.sourceDocumentLineId, movement]),
  );
  if (
    movements.length !== posting.lines.length ||
    posting.lines.some(
      (line) =>
        !validSupplierReturnMovement({
          movement: movementByLine.get(line.id),
          posting,
          postingLine: line,
          requestId: posting.returnAuthorization.returnRequestId,
        }),
    )
  )
    blockingIssues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "Original supplier return movement identity does not match the posting.",
        409,
      ),
    );

  const availableIds = posting.lines
    .map((line) => line.inventoryBalanceId)
    .filter(Boolean);
  const quarantineIds = posting.lines
    .map((line) => line.quarantineBalanceId)
    .filter(Boolean);
  const [availableBalances, quarantineBalances] = await Promise.all([
    availableIds.length
      ? prisma.inventoryBalance.findMany({
          where: { tenantId, id: { in: availableIds } },
        })
      : [],
    quarantineIds.length
      ? prisma.quarantineInventoryBalance.findMany({
          where: { tenantId, id: { in: quarantineIds } },
        })
      : [],
  ]);
  const balances = new Map([
    ...availableBalances.map((balance) => [`available:${balance.id}`, balance]),
    ...quarantineBalances.map((balance) => [
      `quarantine:${balance.id}`,
      balance,
    ]),
  ]);
  const quantityPlans = posting.lines.map((line) => {
    const balanceType = line.inventoryBalanceId
      ? "available"
      : "quarantine";
    const balanceId = line.inventoryBalanceId || line.quarantineBalanceId;
    const balance = balances.get(`${balanceType}:${balanceId}`);
    if (
      !balance ||
      balance.itemId !== line.itemId ||
      balance.sku !== line.sku ||
      balance.warehouseId !== line.warehouseId ||
      !sameOptionalText(balance.locationKey, line.locationKey)
    )
      blockingIssues.push(
        issue(
          "RETURN_REVERSAL_NOT_SAFE",
          "The current balance identity no longer matches the original posting.",
          409,
          { postingLineId: line.id, balanceType, balanceId },
        ),
      );
    return {
      ...line,
      balanceType,
      balanceId,
      balance,
      quantityUnits: decimalUnits(line.quantity),
      movement: movementByLine.get(line.id),
    };
  });

  const grouped = new Map();
  for (const line of quantityPlans) {
    if (!line.balance) continue;
    const key = `${line.balanceType}:${line.balanceId}`;
    const aggregate = grouped.get(key) || {
      balanceType: line.balanceType,
      balance: line.balance,
      quantityUnits: 0n,
      postingLineIds: [],
    };
    aggregate.quantityUnits += line.quantityUnits;
    aggregate.postingLineIds.push(line.id);
    grouped.set(key, aggregate);
  }
  const balanceImpacts = [...grouped.values()]
    .sort((left, right) =>
      `${left.balanceType}:${left.balance.id}`.localeCompare(
        `${right.balanceType}:${right.balance.id}`,
      ),
    )
    .map((aggregate) => {
      const onHandBefore = decimalUnits(aggregate.balance.onHandQuantity);
      const onHandAfter = onHandBefore + aggregate.quantityUnits;
      if (aggregate.balanceType === "available") {
        const reserved = decimalUnits(
          aggregate.balance.reservedQuantity || 0,
        );
        const availableBefore = decimalUnits(
          aggregate.balance.availableQuantity || 0,
        );
        if (availableBefore !== onHandBefore - reserved)
          blockingIssues.push(
            issue(
              "RETURN_REVERSAL_NOT_SAFE",
              "Available inventory balance is internally inconsistent.",
              409,
              { balanceId: aggregate.balance.id },
            ),
          );
        return {
          balanceType: "available",
          balanceId: aggregate.balance.id,
          version: aggregate.balance.version,
          quantityUnits: aggregate.quantityUnits,
          quantity: fixed(aggregate.quantityUnits),
          onHandBefore: fixed(onHandBefore),
          onHandAfter: fixed(onHandAfter),
          reservedBefore: fixed(reserved),
          reservedAfter: fixed(reserved),
          availableBefore: fixed(availableBefore),
          availableAfter: fixed(availableBefore + aggregate.quantityUnits),
          postingLineIds: aggregate.postingLineIds.sort(),
        };
      }
      return {
        balanceType: "quarantine",
        balanceId: aggregate.balance.id,
        version: aggregate.balance.version,
        quantityUnits: aggregate.quantityUnits,
        quantity: fixed(aggregate.quantityUnits),
        onHandBefore: fixed(onHandBefore),
        onHandAfter: fixed(onHandAfter),
        postingLineIds: aggregate.postingLineIds.sort(),
      };
    });

  const authorization = posting.returnAuthorization;
  const totalAuthorized = totalAuthorizedUnits(authorization);
  const executedAfter = totalPostedUnits(authorization, posting.id);
  const statuses = executionStatuses(totalAuthorized, executedAfter);
  const movementFacts = quantityPlans.map((line) => ({
    postingLineId: line.id,
    movementType: "supplier_return_reversal",
    originalMovementId: line.movement?.id,
    quantityUnits: line.quantityUnits,
    quantity: fixed(line.quantityUnits),
    balanceType: line.balanceType,
    balanceId: line.balanceId,
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    unit: line.unit,
    warehouseId: line.warehouseId,
    location: line.location,
    locationKey: line.locationKey,
  }));

  return result(
    {
      postingId: posting.id,
      postingNumber: posting.postingNumber,
      postingType: posting.postingType,
      returnAuthorizationId: posting.returnAuthorizationId,
      returnRequestId: authorization.returnRequestId,
      warehouseId: posting.warehouseId,
      lines: quantityPlans,
    },
    blockingIssues,
    {
      posting,
      authorization,
      warehouseIds: [posting.warehouseId],
      balanceImpacts,
      movementFacts,
      authorizationStatusAfter: statuses.authorizationStatus,
      requestStatusAfter: statuses.requestStatus,
      totalAuthorizedQuantity: fixed(totalAuthorized),
      executedQuantityAfter: fixed(executedAfter),
      documentImpacts: [
        {
          entityType: "ReturnPostingDocument",
          entityId: posting.id,
          postingStatusBefore: "posted",
          postingStatusAfter: "reversed",
        },
        {
          entityType: "ReturnAuthorization",
          entityId: authorization.id,
          workflowStatusBefore: authorization.workflowStatus,
          workflowStatusAfter: statuses.authorizationStatus,
        },
        {
          entityType: "ReturnRequest",
          entityId: authorization.returnRequestId,
          workflowStatusBefore: authorization.returnRequest.workflowStatus,
          workflowStatusAfter: statuses.requestStatus,
        },
      ],
    },
  );
}

export {
  decimalString as supplierReturnDecimalString,
  decimalUnits as supplierReturnDecimalUnits,
};
