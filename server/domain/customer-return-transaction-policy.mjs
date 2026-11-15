import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";
import { activeTrackedConsumption } from "./quarantine-disposition-lineage.mjs";
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
  reconciliationImpacts: [],
  ...extra,
});
const same = (left, right) => text(left) === text(right);
const sameUnits = (left, right) =>
  decimalUnits(left || 0) === decimalUnits(right || 0);

function positive(value, issues, details) {
  try {
    const units = decimalUnits(value);
    if (units <= 0n) throw new Error();
    return units;
  } catch {
    issues.push(
      issue(
        "RETURN_POSTING_QUANTITY_INVALID",
        "Customer return receipt quantity must be positive with at most four decimal places.",
        422,
        details,
      ),
    );
    return 0n;
  }
}

function statuses(total, executed) {
  if (executed <= 0n)
    return { authorization: "approved", request: "authorized" };
  if (executed >= total)
    return { authorization: "executed", request: "executed" };
  return { authorization: "partially_executed", request: "partially_executed" };
}

function postedByLine(authorization, excludedPostingId = "") {
  const map = new Map();
  for (const posting of authorization.postings || []) {
    if (
      posting.id === excludedPostingId ||
      posting.postingStatus !== "posted"
    )
      continue;
    for (const line of posting.lines || [])
      map.set(
        line.returnAuthorizationLineId,
        (map.get(line.returnAuthorizationLineId) || 0n) +
          decimalUnits(line.quantity),
      );
  }
  return map;
}

// A closed remainder is no longer executable, so it does not keep the
// authorization open (and a reversal reopens only what was really posted).
const totalAuthorized = (authorization) =>
  authorization.lines.reduce(
    (sum, line) => sum + executableAuthorizedUnits(line),
    0n,
  );

const locationKeyOf = (value) => text(value).toLowerCase();

// The receipt goes into the quarantine stock record for the item at the
// chosen warehouse and location. When none exists yet, the draft command
// creates it (V-C-01); nothing else in the product creates one.
async function quarantineTarget(prisma, tenantId, requestLine, submitted) {
  const warehouseId = text(submitted.warehouseId);
  const location = text(submitted.location);
  const locationKey = locationKeyOf(location);
  const existing = await prisma.quarantineInventoryBalance.findFirst({
    where: {
      tenantId,
      sku: requestLine.sku,
      warehouseKey: warehouseId,
      locationKey,
    },
  });
  if (existing) return { balance: existing };
  const [warehouse, item] = await Promise.all([
    prisma.warehouse.findFirst({
      where: { tenantId, id: warehouseId },
      select: { id: true, status: true },
    }),
    prisma.item.findFirst({
      where: { tenantId, id: requestLine.itemId },
      select: { id: true, status: true },
    }),
  ]);
  return {
    balance: null,
    create: {
      itemId: requestLine.itemId,
      sku: requestLine.sku,
      itemName: requestLine.itemName,
      unit: requestLine.unit || null,
      warehouseId,
      location: location || null,
      locationKey,
    },
    blocked:
      warehouse?.status !== "active" || item?.status !== "active",
  };
}
const totalPosted = (authorization, excluded = "") =>
  [...postedByLine(authorization, excluded).values()].reduce(
    (sum, value) => sum + value,
    0n,
  );

async function authorization(prisma, tenantId, authorizationId) {
  return prisma.returnAuthorization.findFirst({
    where: { id: text(authorizationId), tenantId },
    include: {
      returnRequest: { include: { lines: true } },
      lines: {
        include: { returnRequestLine: true },
        orderBy: { id: "asc" },
      },
      postings: { include: { lines: true }, orderBy: { id: "asc" } },
    },
  });
}

function validateAuthorization(row, issues, now) {
  if (!row) {
    issues.push(
      issue(
        "RETURN_AUTHORIZATION_NOT_FOUND",
        "Return authorization was not found.",
        404,
      ),
    );
    return;
  }
  if (row.returnRequest.returnType !== "customer_return")
    issues.push(
      issue(
        "RETURN_POSTING_TYPE_MISMATCH",
        "Customer return receipt requires a customer return authorization.",
        409,
      ),
    );
  if (!["approved", "partially_executed"].includes(row.workflowStatus))
    issues.push(
      issue(
        "RETURN_AUTHORIZATION_INVALID_STATE",
        "Only approved or partially executed authorizations can receive customer returns.",
        409,
      ),
    );
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime())
    issues.push(
      issue(
        "RETURN_AUTHORIZATION_EXPIRED",
        "The customer return authorization has expired.",
        409,
      ),
    );
}

export async function buildCustomerReturnDraftPlan({
  prisma,
  tenantId,
  authorizationId,
  lines = [],
  now = new Date(),
}) {
  const issues = [];
  const auth = await authorization(prisma, tenantId, authorizationId);
  validateAuthorization(auth, issues, now);
  if (!auth)
    return result(
      { authorizationId, postingType: "customer_return_receipt", lines: [] },
      issues,
    );
  if (!Array.isArray(lines) || !lines.length)
    issues.push(
      issue(
        "RETURN_POSTING_LINES_REQUIRED",
        "At least one customer return receipt line is required.",
      ),
    );
  const ids = lines.map((line) => text(line.returnAuthorizationLineId));
  const duplicates = ids.filter(
    (id, index) => id && ids.indexOf(id) !== index,
  );
  if (duplicates.length)
    issues.push(
      issue(
        "RETURN_POSTING_DUPLICATE_AUTHORIZATION_LINE",
        "An authorization line can appear only once in a receipt.",
        409,
      ),
    );
  const balanceIds = lines
    .map((line) => text(line.quarantineBalanceId))
    .filter(Boolean);
  const balances = balanceIds.length
    ? await prisma.quarantineInventoryBalance.findMany({
        where: { tenantId, id: { in: balanceIds } },
      })
    : [];
  const byBalance = new Map(balances.map((row) => [row.id, row]));
  const byLine = new Map(auth.lines.map((row) => [row.id, row]));
  const used = postedByLine(auth);
  const normalized = [];
  for (const submitted of lines) {
    const authorizationLineId = text(submitted.returnAuthorizationLineId);
    const authLine = byLine.get(authorizationLineId);
    const quantityUnits = positive(submitted.quantity, issues, {
      returnAuthorizationLineId: authorizationLineId,
    });
    if (!authLine) {
      issues.push(
        issue(
          "RETURN_AUTHORIZATION_LINE_NOT_FOUND",
          "The receipt line does not belong to the authorization.",
          409,
        ),
      );
      continue;
    }
    if (authLine.dispositionRoute !== "receive_to_quarantine")
      issues.push(
        issue(
          "RETURN_DISPOSITION_ROUTE_NOT_EXECUTABLE",
          "Customer returns can only be received to quarantine.",
          409,
        ),
      );
    const remaining =
      executableAuthorizedUnits(authLine) - (used.get(authLine.id) || 0n);
    if (quantityUnits > remaining)
      issues.push(
        issue(
          "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED",
          "Receipt quantity exceeds the remaining authorization.",
          409,
          {
            returnAuthorizationLineId: authLine.id,
            remainingQuantity: fixed(remaining),
          },
        ),
      );
    // Either an existing quarantine balance, or the warehouse (and optional
    // location) to receive into, never both.
    const selectedBalanceId = text(submitted.quarantineBalanceId);
    const selectedWarehouseId = text(submitted.warehouseId);
    if (
      Boolean(selectedBalanceId) === Boolean(selectedWarehouseId) ||
      text(submitted.inventoryBalanceId)
    )
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_SELECTION_INVALID",
          "Choose one quarantine balance, or the warehouse to receive into, for each customer return line.",
          422,
        ),
      );
    const requestLine = authLine.returnRequestLine;
    const target =
      selectedWarehouseId && !selectedBalanceId
        ? await quarantineTarget(prisma, tenantId, requestLine, submitted)
        : { balance: byBalance.get(selectedBalanceId) || null };
    const balance = target.balance;
    const quarantineBalanceId = balance?.id || "";
    if (target.create && target.blocked)
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_CREATE_BLOCKED",
          "A new quarantine stock record needs an active item and an active warehouse.",
          409,
        ),
      );
    if (!balance && !target.create && selectedBalanceId)
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_NOT_FOUND",
          "The selected quarantine balance was not found.",
          404,
        ),
      );
    else if (
      balance &&
      (balance.status !== "active" ||
        balance.itemId !== requestLine.itemId ||
        balance.sku !== requestLine.sku ||
        !same(balance.unit, requestLine.unit))
    )
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_IDENTITY_MISMATCH",
          "The quarantine balance does not match the authorized customer return line.",
          409,
        ),
      );
    normalized.push({
      returnAuthorizationLineId: authLine.id,
      returnRequestLineId: requestLine.id,
      itemId: requestLine.itemId,
      sku: requestLine.sku,
      itemName: requestLine.itemName,
      unit: requestLine.unit || null,
      quantity: fixed(quantityUnits),
      quantityUnits,
      dispositionRoute: authLine.dispositionRoute,
      balanceType: "quarantine",
      balanceId: quarantineBalanceId,
      inventoryBalanceId: null,
      quarantineBalanceId,
      warehouseId: balance?.warehouseId || target.create?.warehouseId || "",
      location: balance ? balance.location || null : target.create?.location || null,
      locationKey: balance?.locationKey || target.create?.locationKey || "",
      balance,
      // Set when the draft command has to create the quarantine stock record.
      createsQuarantineBalance: !balance && target.create ? target.create : null,
      remainingAuthorizedBefore: fixed(remaining),
      remainingAuthorizedAfter: fixed(remaining - quantityUnits),
    });
  }
  const warehouseIds = [
    ...new Set(normalized.map((line) => line.warehouseId).filter(Boolean)),
  ].sort();
  if (warehouseIds.length > 1)
    issues.push(
      issue(
        "RETURN_POSTING_MULTIPLE_WAREHOUSES_NOT_ALLOWED",
        "One customer return receipt must use a single warehouse.",
        409,
      ),
    );
  return result(
    {
      authorizationId: auth.id,
      returnRequestId: auth.returnRequestId,
      postingType: "customer_return_receipt",
      warehouseId: warehouseIds[0] || "",
      lines: normalized,
    },
    issues,
    { authorization: auth, warehouseIds },
  );
}

export async function buildCustomerReturnPostingPlan({
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
          returnRequest: true,
          lines: {
            include: { returnRequestLine: true },
            orderBy: { id: "asc" },
          },
          postings: { include: { lines: true } },
        },
      },
    },
  });
  if (!posting)
    return result(
      { postingId, postingType: "customer_return_receipt" },
      [issue("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404)],
    );
  const draft = await buildCustomerReturnDraftPlan({
    prisma,
    tenantId,
    authorizationId: posting.returnAuthorizationId,
    lines: posting.lines.map((line) => ({
      returnAuthorizationLineId: line.returnAuthorizationLineId,
      quantity: line.quantity,
      quarantineBalanceId: line.quarantineBalanceId,
      inventoryBalanceId: line.inventoryBalanceId,
    })),
    now,
  });
  const issues = [...draft.blockingIssues];
  if (
    posting.postingType !== "customer_return_receipt" ||
    !allowedWorkflowStatuses.includes(posting.workflowStatus) ||
    posting.postingStatus !== "unposted"
  )
    issues.push(
      issue(
        "RETURN_POSTING_INVALID_STATE",
        "The customer return receipt is not in a valid state for this action.",
        409,
      ),
    );
  const persisted = new Map(
    posting.lines.map((line) => [line.returnAuthorizationLineId, line]),
  );
  const quantityPlans = draft.normalizedPlan.lines.map((line) => {
    const row = persisted.get(line.returnAuthorizationLineId);
    if (
      !row ||
      row.itemId !== line.itemId ||
      row.sku !== line.sku ||
      row.itemName !== line.itemName ||
      !same(row.unit, line.unit) ||
      row.warehouseId !== line.warehouseId ||
      !same(row.locationKey, line.locationKey) ||
      !sameUnits(row.quantity, line.quantity) ||
      text(row.quarantineBalanceId) !== line.quarantineBalanceId ||
      row.inventoryBalanceId
    )
      issues.push(
        issue(
          "RETURN_POSTING_LINE_IDENTITY_MISMATCH",
          "Stored customer receipt facts no longer match the authorization and quarantine balance.",
          409,
        ),
      );
    return { ...line, id: row?.id, version: row?.version };
  });
  if (
    posting.warehouseId !== draft.normalizedPlan.warehouseId ||
    posting.warehouseId !== quantityPlans[0]?.warehouseId
  )
    issues.push(
      issue(
        "RETURN_POSTING_WAREHOUSE_IDENTITY_MISMATCH",
        "Customer return receipt warehouse no longer matches its lines.",
        409,
      ),
    );
  const grouped = new Map();
  for (const line of quantityPlans) {
    if (!line.balance) continue;
    const aggregate = grouped.get(line.balanceId) || {
      balance: line.balance,
      quantityUnits: 0n,
      postingLineIds: [],
    };
    aggregate.quantityUnits += line.quantityUnits;
    aggregate.postingLineIds.push(line.id);
    grouped.set(line.balanceId, aggregate);
  }
  const balanceImpacts = [...grouped.values()]
    .sort((a, b) => a.balance.id.localeCompare(b.balance.id))
    .map((aggregate) => {
      const before = decimalUnits(aggregate.balance.onHandQuantity);
      return {
        balanceType: "quarantine",
        balanceId: aggregate.balance.id,
        version: aggregate.balance.version,
        quantity: fixed(aggregate.quantityUnits),
        quantityUnits: aggregate.quantityUnits,
        onHandBefore: fixed(before),
        onHandAfter: fixed(before + aggregate.quantityUnits),
        postingLineIds: aggregate.postingLineIds.sort(),
      };
    });
  const auth = posting.returnAuthorization;
  const postedBefore = totalPosted(auth, posting.id);
  const current = quantityPlans.reduce(
    (sum, line) => sum + line.quantityUnits,
    0n,
  );
  const state = statuses(totalAuthorized(auth), postedBefore + current);
  return result(
    {
      postingId: posting.id,
      postingNumber: posting.postingNumber,
      postingType: posting.postingType,
      returnAuthorizationId: auth.id,
      returnRequestId: auth.returnRequestId,
      warehouseId: posting.warehouseId,
      lines: quantityPlans,
    },
    issues,
    {
      posting,
      authorization: auth,
      warehouseIds: draft.warehouseIds,
      balanceImpacts,
      movementFacts: quantityPlans.map((line) => ({
        postingLineId: line.id,
        returnAuthorizationLineId: line.returnAuthorizationLineId,
        movementType: "customer_return_quarantine_in",
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        unit: line.unit,
        warehouseId: line.warehouseId,
        location: line.location,
        locationKey: line.locationKey,
        quantity: line.quantity,
        quantityUnits: line.quantityUnits,
        balanceType: "quarantine",
        balanceId: line.balanceId,
      })),
      authorizationStatusAfter: state.authorization,
      requestStatusAfter: state.request,
    },
  );
}

export async function buildCustomerReturnReversalPlan({
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
          postings: { include: { lines: true } },
        },
      },
    },
  });
  if (!posting)
    return result(
      { postingId, postingType: "customer_return_receipt" },
      [issue("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404)],
    );
  const issues = [];
  if (
    posting.postingType !== "customer_return_receipt" ||
    posting.postingStatus !== "posted" ||
    posting.reversedAt ||
    !text(posting.metadata?.postingBatchId)
  )
    issues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "The customer return receipt is not safely reversible.",
        409,
      ),
    );
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      tenantId,
      sourceDocumentType: "ReturnPostingDocument",
      sourceDocumentId: posting.id,
      movementType: "customer_return_quarantine_in",
    },
  });
  const byLine = new Map(
    movements.map((movement) => [movement.sourceDocumentLineId, movement]),
  );
  const valid = (line, movement) =>
    movement &&
    movement.tenantId === tenantId &&
    movement.sourceDocumentId === posting.id &&
    movement.sourceDocumentLineId === line.id &&
    movement.itemId === line.itemId &&
    movement.sku === line.sku &&
    movement.warehouseId === line.warehouseId &&
    same(movement.locationKey, line.locationKey) &&
    same(movement.unit, line.unit) &&
    sameUnits(movement.quantityIn, line.quantity) &&
    sameUnits(movement.quantityOut, 0) &&
    movement.postingBatchId === posting.metadata?.postingBatchId &&
    movement.metadata?.balanceType === "quarantine" &&
    movement.metadata?.balanceId === line.quarantineBalanceId &&
    !movement.reversedByMovementId;
  if (
    movements.length !== posting.lines.length ||
    posting.lines.some((line) => !valid(line, byLine.get(line.id)))
  )
    issues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "Original customer return receipt movement identity does not match.",
        409,
      ),
    );
  const allocations = await activeTrackedConsumption({
    prisma,
    tenantId,
    sourceMovementIds: movements.map((movement) => movement.id),
  });
  if (allocations.length)
    issues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "Customer return receipt inventory has downstream quarantine consumption.",
        409,
        { allocationIds: allocations.map((row) => row.id) },
      ),
    );
  const balanceIds = posting.lines
    .map((line) => line.quarantineBalanceId)
    .filter(Boolean);
  const balances = await prisma.quarantineInventoryBalance.findMany({
    where: { tenantId, id: { in: balanceIds } },
  });
  const balanceMap = new Map(balances.map((row) => [row.id, row]));
  const grouped = new Map();
  const quantityPlans = posting.lines.map((line) => {
    const balance = balanceMap.get(line.quarantineBalanceId);
    if (
      !balance ||
      balance.itemId !== line.itemId ||
      balance.sku !== line.sku ||
      balance.warehouseId !== line.warehouseId ||
      !same(balance.locationKey, line.locationKey)
    )
      issues.push(
        issue(
          "RETURN_REVERSAL_NOT_SAFE",
          "Current quarantine balance identity no longer matches the receipt.",
          409,
        ),
      );
    const units = decimalUnits(line.quantity);
    if (balance) {
      const aggregate = grouped.get(balance.id) || {
        balance,
        quantityUnits: 0n,
      };
      aggregate.quantityUnits += units;
      grouped.set(balance.id, aggregate);
    }
    return {
      ...line,
      balance,
      quantityUnits: units,
      movement: byLine.get(line.id),
    };
  });
  const balanceImpacts = [...grouped.values()].map((aggregate) => {
    const before = decimalUnits(aggregate.balance.onHandQuantity);
    if (before < aggregate.quantityUnits)
      issues.push(
        issue(
          "RETURN_REVERSAL_NOT_SAFE",
          "Current quarantine quantity is insufficient to reverse the receipt.",
          409,
        ),
      );
    return {
      balanceType: "quarantine",
      balanceId: aggregate.balance.id,
      version: aggregate.balance.version,
      quantity: fixed(aggregate.quantityUnits),
      quantityUnits: aggregate.quantityUnits,
      onHandBefore: fixed(before),
      onHandAfter: fixed(before - aggregate.quantityUnits),
    };
  });
  const auth = posting.returnAuthorization;
  const state = statuses(totalAuthorized(auth), totalPosted(auth, posting.id));
  // Reversing reopens this receipt authorization. A request holds one active
  // authorization at a time, so an open release authorization has to be
  // cancelled first; say so instead of failing on the unique index (L8-27).
  if (["approved", "partially_executed"].includes(state.authorization)) {
    const otherActive = await prisma.returnAuthorization.findMany({
      where: {
        tenantId,
        returnRequestId: auth.returnRequestId,
        id: { not: auth.id },
        workflowStatus: { in: ["draft", "approved", "partially_executed"] },
      },
      select: { id: true, authorizationNumber: true },
    });
    if (otherActive.length)
      issues.push(
        issue(
          "RETURN_REVERSAL_BLOCKED_BY_ACTIVE_AUTHORIZATION",
          "Cancel the open release authorization of this return before reversing the receipt.",
          409,
          {
            authorizationNumbers: otherActive.map(
              (row) => row.authorizationNumber,
            ),
          },
        ),
      );
  }
  return result(
    {
      postingId: posting.id,
      postingNumber: posting.postingNumber,
      postingType: posting.postingType,
      returnAuthorizationId: auth.id,
      returnRequestId: auth.returnRequestId,
      warehouseId: posting.warehouseId,
      lines: quantityPlans,
    },
    issues,
    {
      posting,
      authorization: auth,
      warehouseIds: [posting.warehouseId],
      balanceImpacts,
      movementFacts: quantityPlans.map((line) => ({
        postingLineId: line.id,
        movementType: "customer_return_receipt_reversal",
        originalMovementId: line.movement?.id,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        unit: line.unit,
        warehouseId: line.warehouseId,
        location: line.location,
        locationKey: line.locationKey,
        quantity: fixed(line.quantityUnits),
        quantityUnits: line.quantityUnits,
        balanceType: "quarantine",
        balanceId: line.quarantineBalanceId,
      })),
      authorizationStatusAfter: state.authorization,
      requestStatusAfter: state.request,
    },
  );
}

export {
  decimalString as customerReturnDecimalString,
  decimalUnits as customerReturnDecimalUnits,
};
