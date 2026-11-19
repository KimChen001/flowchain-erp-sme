import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";
import { executableAuthorizedUnits } from "./return-authorization-closure-policy.mjs";
import { returnLineQuarantineLayers } from "./quarantine-disposition-lineage.mjs";

const text = (value) => String(value ?? "").trim();
const fixed = (value) =>
  decimalString(typeof value === "bigint" ? value : decimalUnits(value || 0));
const same = (left, right) => text(left) === text(right);
const sameUnits = (left, right) =>
  decimalUnits(left || 0) === decimalUnits(right || 0);
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

function positive(value, issues, details) {
  try {
    const units = decimalUnits(value);
    if (units <= 0n) throw new Error();
    return units;
  } catch {
    issues.push(
      issue(
        "RETURN_POSTING_QUANTITY_INVALID",
        "Quarantine release quantity must be positive with at most four decimal places.",
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
  return {
    authorization: "partially_executed",
    request: "partially_executed",
  };
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

// A release may put stock at another location of the same warehouse (L8-14).
// Lines stored before that have no destination location: their destination
// is the line's own location.
const destinationLocationOf = (line) =>
  line.destinationLocationKey == null
    ? line.location ?? null
    : line.destinationLocation ?? null;
const destinationLocationKeyOf = (line) =>
  line.destinationLocationKey == null
    ? text(line.locationKey)
    : text(line.destinationLocationKey);
const optionalText = (value) => (value == null ? null : text(value));

// Resolves the available stock record a release goes into when the user
// chose a location rather than an existing record: the record for the item
// at that location of the quarantine stock's warehouse, created by the draft
// command when it does not exist yet (only for an active item and warehouse).
async function destinationTarget(prisma, tenantId, requestLine, source, location) {
  const locationKey = location.toLowerCase();
  const existing = await prisma.inventoryBalance.findFirst({
    where: {
      tenantId,
      sku: requestLine.sku,
      warehouseKey: source.warehouseId,
      locationKey,
    },
  });
  if (existing) return { destination: existing };
  const [warehouse, item] = await Promise.all([
    prisma.warehouse.findFirst({
      where: { tenantId, id: source.warehouseId },
      select: { status: true },
    }),
    prisma.item.findFirst({
      where: { tenantId, id: requestLine.itemId },
      select: { status: true },
    }),
  ]);
  return {
    destination: null,
    create: {
      itemId: requestLine.itemId,
      sku: requestLine.sku,
      itemName: requestLine.itemName,
      unit: requestLine.unit || null,
      warehouseId: source.warehouseId,
      location: location || null,
      locationKey,
    },
    blocked: warehouse?.status !== "active" || item?.status !== "active",
  };
}

const totalAuthorized = (authorization) =>
  authorization.lines.reduce(
    (sum, line) => sum + executableAuthorizedUnits(line),
    0n,
  );
const totalPosted = (authorization, excluded = "") =>
  [...postedByLine(authorization, excluded).values()].reduce(
    (sum, value) => sum + value,
    0n,
  );

async function loadAuthorization(prisma, tenantId, authorizationId) {
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

function validateAuthorization(authorization, issues, now) {
  if (!authorization) {
    issues.push(
      issue(
        "RETURN_AUTHORIZATION_NOT_FOUND",
        "Return authorization was not found.",
        404,
      ),
    );
    return;
  }
  if (
    authorization.returnRequest.returnType !== "customer_return" ||
    authorization.lines.some(
      (line) =>
        line.dispositionRoute !== "release_quarantine_to_available",
    )
  )
    issues.push(
      issue(
        "RETURN_POSTING_TYPE_MISMATCH",
        "Quarantine release requires a customer return release authorization.",
        409,
      ),
    );
  if (
    !["approved", "partially_executed"].includes(
      authorization.workflowStatus,
    )
  )
    issues.push(
      issue(
        "RETURN_AUTHORIZATION_INVALID_STATE",
        "Only approved or partially executed release authorizations can post.",
        409,
      ),
    );
  if (
    authorization.expiresAt &&
    authorization.expiresAt.getTime() <= now.getTime()
  )
    issues.push(
      issue(
        "RETURN_AUTHORIZATION_EXPIRED",
        "The quarantine release authorization has expired.",
        409,
      ),
    );
}

export async function buildQuarantineReleaseDraftPlan({
  prisma,
  tenantId,
  authorizationId,
  lines = [],
  now = new Date(),
}) {
  const issues = [];
  const authorization = await loadAuthorization(
    prisma,
    tenantId,
    authorizationId,
  );
  validateAuthorization(authorization, issues, now);
  if (!authorization)
    return result(
      { authorizationId, postingType: "quarantine_release", lines: [] },
      issues,
    );
  if (!Array.isArray(lines) || !lines.length)
    issues.push(
      issue(
        "RETURN_POSTING_LINES_REQUIRED",
        "At least one quarantine release line is required.",
      ),
    );
  const lineIds = lines.map((line) =>
    text(line.returnAuthorizationLineId),
  );
  if (new Set(lineIds).size !== lineIds.length)
    issues.push(
      issue(
        "RETURN_POSTING_DUPLICATE_AUTHORIZATION_LINE",
        "An authorization line can appear only once in a release.",
        409,
      ),
    );
  const sourceIds = lines
    .map((line) => text(line.quarantineBalanceId))
    .filter(Boolean);
  const destinationIds = lines
    .map((line) => text(line.destinationInventoryBalanceId))
    .filter(Boolean);
  const [sources, destinations] = await Promise.all([
    sourceIds.length
      ? prisma.quarantineInventoryBalance.findMany({
          where: { tenantId, id: { in: sourceIds } },
        })
      : [],
    destinationIds.length
      ? prisma.inventoryBalance.findMany({
          where: { tenantId, id: { in: destinationIds } },
        })
      : [],
  ]);
  const sourceById = new Map(sources.map((row) => [row.id, row]));
  const destinationById = new Map(
    destinations.map((row) => [row.id, row]),
  );
  const authorizationLineById = new Map(
    authorization.lines.map((row) => [row.id, row]),
  );
  const used = postedByLine(authorization);
  const normalized = [];
  for (const submitted of lines) {
    const authorizationLineId = text(
      submitted.returnAuthorizationLineId,
    );
    const authorizationLine =
      authorizationLineById.get(authorizationLineId);
    const quantityUnits = positive(submitted.quantity, issues, {
      returnAuthorizationLineId: authorizationLineId,
    });
    if (!authorizationLine) {
      issues.push(
        issue(
          "RETURN_AUTHORIZATION_LINE_NOT_FOUND",
          "The release line does not belong to the authorization.",
          409,
        ),
      );
      continue;
    }
    const remaining =
      executableAuthorizedUnits(authorizationLine) -
      (used.get(authorizationLine.id) || 0n);
    if (quantityUnits > remaining)
      issues.push(
        issue(
          "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED",
          "Release quantity exceeds the remaining authorization.",
          409,
          {
            returnAuthorizationLineId: authorizationLine.id,
            remainingQuantity: fixed(remaining),
          },
        ),
      );
    const sourceId = text(submitted.quarantineBalanceId);
    const selectedDestinationId = text(
      submitted.destinationInventoryBalanceId,
    );
    // The destination is an existing available balance, or a location of the
    // source warehouse (an empty string means no location).
    const selectedLocation = optionalText(submitted.destinationLocation);
    if (
      !sourceId ||
      Boolean(selectedDestinationId) === (selectedLocation !== null) ||
      text(submitted.inventoryBalanceId)
    )
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_SELECTION_INVALID",
          "Quarantine release requires one source quarantine balance and one destination: an available balance or a location in the same warehouse.",
          422,
        ),
      );
    const source = sourceById.get(sourceId);
    const requestLine = authorizationLine.returnRequestLine;
    const target =
      !selectedDestinationId && selectedLocation !== null && source
        ? await destinationTarget(
            prisma,
            tenantId,
            requestLine,
            source,
            selectedLocation,
          )
        : { destination: destinationById.get(selectedDestinationId) || null };
    const destination = target.destination;
    const destinationId = destination?.id || "";
    if (!source)
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_NOT_FOUND",
          "The selected quarantine balance was not found.",
          404,
        ),
      );
    if (target.create && target.blocked)
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_CREATE_BLOCKED",
          "A new available stock record needs an active item and an active warehouse.",
          409,
        ),
      );
    if (!destination && !target.create && selectedDestinationId)
      issues.push(
        issue(
          "RETURN_POSTING_DESTINATION_BALANCE_NOT_FOUND",
          "The selected destination available balance was not found.",
          404,
        ),
      );
    if (
      source &&
      (source.status !== "active" ||
        source.itemId !== requestLine.itemId ||
        source.sku !== requestLine.sku ||
        !same(source.unit, requestLine.unit))
    )
      issues.push(
        issue(
          "RETURN_POSTING_BALANCE_IDENTITY_MISMATCH",
          "The quarantine balance does not match the authorized return line.",
          409,
        ),
      );
    if (
      destination &&
      (Boolean(text(destination.status)) &&
        !["available", "active"].includes(
          text(destination.status).toLowerCase(),
        ) ||
        destination.itemId !== requestLine.itemId ||
        destination.sku !== requestLine.sku ||
        !same(destination.unit, requestLine.unit))
    )
      issues.push(
        issue(
          "RETURN_POSTING_DESTINATION_IDENTITY_MISMATCH",
          "The destination available balance does not match the authorized return line.",
          409,
        ),
      );
    // Any location of the quarantine stock's warehouse (L8-14).
    if (
      source &&
      destination &&
      source.warehouseId !== destination.warehouseId
    )
      issues.push(
        issue(
          "RETURN_POSTING_LOCATION_POLICY_MISMATCH",
          "Quarantine release must put stock into the same warehouse.",
          409,
        ),
      );
    // A release takes this return's own goods: the receipt layers of this
    // return line in the chosen quarantine stock record that no release or
    // supplier return has used yet (L8-09).
    const ownLayers = source
      ? (
          await returnLineQuarantineLayers({
            prisma,
            tenantId,
            returnRequestLineIds: [requestLine.id],
            quarantineBalanceId: source.id,
          })
        ).get(requestLine.id)
      : null;
    if (source && quantityUnits > (ownLayers?.remainingUnits || 0n))
      issues.push(
        issue(
          "RETURN_RELEASE_EXCEEDS_RETURN_QUARANTINE",
          "Release quantity exceeds what this return still has in the chosen quarantine stock.",
          409,
          {
            returnAuthorizationLineId: authorizationLine.id,
            remainingQuantity: fixed(ownLayers?.remainingUnits || 0n),
          },
        ),
      );
    normalized.push({
      returnAuthorizationLineId: authorizationLine.id,
      returnRequestLineId: requestLine.id,
      itemId: requestLine.itemId,
      sku: requestLine.sku,
      itemName: requestLine.itemName,
      unit: requestLine.unit || null,
      quantity: fixed(quantityUnits),
      quantityUnits,
      dispositionRoute: authorizationLine.dispositionRoute,
      quarantineBalanceId: sourceId,
      destinationInventoryBalanceId: destinationId,
      inventoryBalanceId: null,
      warehouseId: source?.warehouseId || destination?.warehouseId || "",
      location: source?.location || destination?.location || null,
      locationKey: source?.locationKey || destination?.locationKey || "",
      destinationLocation: destination
        ? destination.location || null
        : target.create?.location || null,
      destinationLocationKey: destination
        ? text(destination.locationKey)
        : text(target.create?.locationKey),
      // Set when the draft command has to create the available stock record.
      createsDestinationBalance:
        !destination && target.create ? target.create : null,
      // The receipt layers the release posting consumes (L8-09).
      sourceMovementIds: ownLayers?.sourceMovementIds || [],
      source,
      destination,
    });
  }
  const warehouseIds = [
    ...new Set(normalized.map((line) => line.warehouseId).filter(Boolean)),
  ].sort();
  if (warehouseIds.length > 1)
    issues.push(
      issue(
        "RETURN_POSTING_MULTIPLE_WAREHOUSES_NOT_ALLOWED",
        "One quarantine release must use a single warehouse.",
        409,
      ),
    );
  return result(
    {
      authorizationId: authorization.id,
      returnRequestId: authorization.returnRequestId,
      postingType: "quarantine_release",
      warehouseId: warehouseIds[0] || "",
      lines: normalized,
    },
    issues,
    { authorization, warehouseIds },
  );
}

export async function buildQuarantineReleasePostingPlan({
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
      { postingId, postingType: "quarantine_release" },
      [issue("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404)],
    );
  const draft = await buildQuarantineReleaseDraftPlan({
    prisma,
    tenantId,
    authorizationId: posting.returnAuthorizationId,
    lines: posting.lines.map((line) => ({
      returnAuthorizationLineId: line.returnAuthorizationLineId,
      quantity: line.quantity,
      quarantineBalanceId: line.quarantineBalanceId,
      destinationInventoryBalanceId:
        line.destinationInventoryBalanceId,
      inventoryBalanceId: line.inventoryBalanceId,
    })),
    now,
  });
  const issues = [...draft.blockingIssues];
  if (
    posting.postingType !== "quarantine_release" ||
    !allowedWorkflowStatuses.includes(posting.workflowStatus) ||
    posting.postingStatus !== "unposted"
  )
    issues.push(
      issue(
        "RETURN_POSTING_INVALID_STATE",
        "The quarantine release is not in a valid state for this action.",
        409,
      ),
    );
  const persisted = new Map(
    posting.lines.map((line) => [line.returnAuthorizationLineId, line]),
  );
  const plans = draft.normalizedPlan.lines.map((line) => {
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
      text(row.destinationInventoryBalanceId) !==
        line.destinationInventoryBalanceId ||
      destinationLocationKeyOf(row) !== line.destinationLocationKey ||
      row.inventoryBalanceId
    )
      issues.push(
        issue(
          "RETURN_POSTING_LINE_IDENTITY_MISMATCH",
          "Stored release facts no longer match the authorization and balances.",
          409,
        ),
      );
    return { ...line, id: row?.id };
  });
  if (
    posting.warehouseId !== draft.normalizedPlan.warehouseId ||
    posting.warehouseId !== plans[0]?.warehouseId
  )
    issues.push(
      issue(
        "RETURN_POSTING_WAREHOUSE_IDENTITY_MISMATCH",
        "Quarantine release warehouse no longer matches its lines.",
        409,
      ),
    );
  const sourceGroups = new Map();
  const destinationGroups = new Map();
  for (const line of plans) {
    if (!line.source || !line.destination) continue;
    const source = sourceGroups.get(line.quarantineBalanceId) || {
      balance: line.source,
      quantityUnits: 0n,
      postingLineIds: [],
    };
    source.quantityUnits += line.quantityUnits;
    source.postingLineIds.push(line.id);
    sourceGroups.set(line.quarantineBalanceId, source);
    const destination =
      destinationGroups.get(line.destinationInventoryBalanceId) || {
        balance: line.destination,
        quantityUnits: 0n,
        postingLineIds: [],
      };
    destination.quantityUnits += line.quantityUnits;
    destination.postingLineIds.push(line.id);
    destinationGroups.set(line.destinationInventoryBalanceId, destination);
  }
  const sourceImpacts = [...sourceGroups.values()].map((aggregate) => {
    const before = decimalUnits(aggregate.balance.onHandQuantity);
    if (before < aggregate.quantityUnits)
      issues.push(
        issue(
          "RETURN_QUARANTINE_INVENTORY_INSUFFICIENT",
          "Quarantine inventory is insufficient for release.",
          409,
        ),
      );
    return {
      balanceType: "quarantine",
      direction: "out",
      balanceId: aggregate.balance.id,
      version: aggregate.balance.version,
      quantity: fixed(aggregate.quantityUnits),
      quantityUnits: aggregate.quantityUnits,
      onHandBefore: fixed(before),
      onHandAfter: fixed(before - aggregate.quantityUnits),
      postingLineIds: aggregate.postingLineIds.sort(),
    };
  });
  const destinationImpacts = [...destinationGroups.values()].map(
    (aggregate) => {
      const onHand = decimalUnits(aggregate.balance.onHandQuantity);
      const reserved = decimalUnits(aggregate.balance.reservedQuantity);
      const available = decimalUnits(aggregate.balance.availableQuantity);
      return {
        balanceType: "available",
        direction: "in",
        balanceId: aggregate.balance.id,
        version: aggregate.balance.version,
        quantity: fixed(aggregate.quantityUnits),
        quantityUnits: aggregate.quantityUnits,
        onHandBefore: fixed(onHand),
        onHandAfter: fixed(onHand + aggregate.quantityUnits),
        reservedBefore: fixed(reserved),
        reservedAfter: fixed(reserved),
        availableBefore: fixed(available),
        availableAfter: fixed(available + aggregate.quantityUnits),
        postingLineIds: aggregate.postingLineIds.sort(),
      };
    },
  );
  const authorization = posting.returnAuthorization;
  const current = plans.reduce(
    (sum, line) => sum + line.quantityUnits,
    0n,
  );
  const state = statuses(
    totalAuthorized(authorization),
    totalPosted(authorization, posting.id) + current,
  );
  return result(
    {
      postingId: posting.id,
      postingNumber: posting.postingNumber,
      postingType: posting.postingType,
      returnAuthorizationId: authorization.id,
      returnRequestId: authorization.returnRequestId,
      warehouseId: posting.warehouseId,
      lines: plans,
    },
    issues,
    {
      posting,
      authorization,
      warehouseIds: draft.warehouseIds,
      balanceImpacts: [...sourceImpacts, ...destinationImpacts],
      movementFacts: plans.flatMap((line) => [
        {
          postingLineId: line.id,
          movementType: "quarantine_release_out",
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          unit: line.unit,
          warehouseId: line.warehouseId,
          location: line.location,
          locationKey: line.locationKey,
          quantity: line.quantity,
          balanceType: "quarantine",
          balanceId: line.quarantineBalanceId,
        },
        {
          postingLineId: line.id,
          movementType: "quarantine_release_available_in",
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          unit: line.unit,
          warehouseId: line.warehouseId,
          location: line.destinationLocation,
          locationKey: line.destinationLocationKey,
          quantity: line.quantity,
          balanceType: "available",
          balanceId: line.destinationInventoryBalanceId,
        },
      ]),
      reconciliationImpacts: plans.map((line) => ({
        postingLineId: line.id,
        quarantineQuantityOut: line.quantity,
        availableQuantityIn: line.quantity,
        tenantNetQuantity: "0.0000",
        status: "matched",
      })),
      authorizationStatusAfter: state.authorization,
      requestStatusAfter: state.request,
      tenantNetQuantity: "0.0000",
    },
  );
}

export async function buildQuarantineReleaseReversalPlan({
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
      { postingId, postingType: "quarantine_release" },
      [issue("RETURN_POSTING_NOT_FOUND", "Return posting was not found.", 404)],
    );
  const issues = [];
  if (
    posting.postingType !== "quarantine_release" ||
    posting.postingStatus !== "posted" ||
    posting.reversedAt ||
    !text(posting.metadata?.postingBatchId)
  )
    issues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "The quarantine release is not safely reversible.",
        409,
      ),
    );
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      tenantId,
      sourceDocumentType: "ReturnPostingDocument",
      sourceDocumentId: posting.id,
      movementType: {
        in: [
          "quarantine_release_out",
          "quarantine_release_available_in",
        ],
      },
    },
  });
  const movementKey = (lineId, type) => `${lineId}:${type}`;
  const movementByKey = new Map(
    movements.map((movement) => [
      movementKey(movement.sourceDocumentLineId, movement.movementType),
      movement,
    ]),
  );
  // The available-side movement sits at the destination location.
  const valid = (line, movement, type, balanceId, quantityField) =>
    movement &&
    movement.tenantId === tenantId &&
    movement.sourceDocumentId === posting.id &&
    movement.sourceDocumentLineId === line.id &&
    movement.itemId === line.itemId &&
    movement.sku === line.sku &&
    movement.warehouseId === line.warehouseId &&
    same(
      movement.locationKey,
      type === "quarantine_release_available_in"
        ? destinationLocationKeyOf(line)
        : line.locationKey,
    ) &&
    same(movement.unit, line.unit) &&
    sameUnits(movement[quantityField], line.quantity) &&
    sameUnits(
      movement[quantityField === "quantityIn" ? "quantityOut" : "quantityIn"],
      0,
    ) &&
    movement.postingBatchId === posting.metadata?.postingBatchId &&
    movement.metadata?.balanceId === balanceId &&
    !movement.reversedByMovementId &&
    movement.movementType === type;
  if (
    movements.length !== posting.lines.length * 2 ||
    posting.lines.some(
      (line) =>
        !valid(
          line,
          movementByKey.get(
            movementKey(line.id, "quarantine_release_out"),
          ),
          "quarantine_release_out",
          line.quarantineBalanceId,
          "quantityOut",
        ) ||
        !valid(
          line,
          movementByKey.get(
            movementKey(line.id, "quarantine_release_available_in"),
          ),
          "quarantine_release_available_in",
          line.destinationInventoryBalanceId,
          "quantityIn",
        ),
    )
  )
    issues.push(
      issue(
        "RETURN_REVERSAL_NOT_SAFE",
        "Original quarantine release movement identity does not match.",
        409,
      ),
    );
  const sourceIds = posting.lines.map((line) => line.quarantineBalanceId);
  const destinationIds = posting.lines.map(
    (line) => line.destinationInventoryBalanceId,
  );
  const [sources, destinations] = await Promise.all([
    prisma.quarantineInventoryBalance.findMany({
      where: { tenantId, id: { in: sourceIds.filter(Boolean) } },
    }),
    prisma.inventoryBalance.findMany({
      where: { tenantId, id: { in: destinationIds.filter(Boolean) } },
    }),
  ]);
  const sourceById = new Map(sources.map((row) => [row.id, row]));
  const destinationById = new Map(
    destinations.map((row) => [row.id, row]),
  );
  const sourceGroups = new Map();
  const destinationGroups = new Map();
  for (const line of posting.lines) {
    const source = sourceById.get(line.quarantineBalanceId);
    const destination = destinationById.get(
      line.destinationInventoryBalanceId,
    );
    if (
      !source ||
      !destination ||
      source.itemId !== line.itemId ||
      destination.itemId !== line.itemId ||
      source.sku !== line.sku ||
      destination.sku !== line.sku ||
      source.warehouseId !== line.warehouseId ||
      destination.warehouseId !== line.warehouseId ||
      !same(source.locationKey, line.locationKey) ||
      !same(destination.locationKey, destinationLocationKeyOf(line))
    )
      issues.push(
        issue(
          "RETURN_REVERSAL_NOT_SAFE",
          "Current release balance identity no longer matches.",
          409,
        ),
      );
    const units = decimalUnits(line.quantity);
    if (source) {
      const group = sourceGroups.get(source.id) || {
        balance: source,
        quantityUnits: 0n,
      };
      group.quantityUnits += units;
      sourceGroups.set(source.id, group);
    }
    if (destination) {
      const group = destinationGroups.get(destination.id) || {
        balance: destination,
        quantityUnits: 0n,
        inboundMovements: [],
      };
      group.quantityUnits += units;
      group.inboundMovements.push(
        movementByKey.get(
          movementKey(line.id, "quarantine_release_available_in"),
        ),
      );
      destinationGroups.set(destination.id, group);
    }
  }
  const sourceImpacts = [...sourceGroups.values()].map((aggregate) => {
    const before = decimalUnits(aggregate.balance.onHandQuantity);
    return {
      balanceType: "quarantine",
      direction: "in",
      balanceId: aggregate.balance.id,
      version: aggregate.balance.version,
      quantity: fixed(aggregate.quantityUnits),
      quantityUnits: aggregate.quantityUnits,
      onHandBefore: fixed(before),
      onHandAfter: fixed(before + aggregate.quantityUnits),
    };
  });
  const destinationImpacts = [...destinationGroups.values()].map(
    (aggregate) => {
      const onHand = decimalUnits(aggregate.balance.onHandQuantity);
      const reserved = decimalUnits(aggregate.balance.reservedQuantity);
      const available = decimalUnits(aggregate.balance.availableQuantity);
      const evidence = aggregate.inboundMovements[0]?.metadata;
      if (
        aggregate.inboundMovements.some(
          (movement) =>
            !movement ||
            movement.metadata?.destinationVersionAfter !==
              aggregate.balance.version ||
            !sameUnits(
              movement.metadata?.destinationOnHandAfter,
              aggregate.balance.onHandQuantity,
            ) ||
            !sameUnits(
              movement.metadata?.destinationReservedAfter,
              aggregate.balance.reservedQuantity,
            ) ||
            !sameUnits(
              movement.metadata?.destinationAvailableAfter,
              aggregate.balance.availableQuantity,
            ),
        )
      )
        issues.push(
          issue(
            "RETURN_REVERSAL_NOT_SAFE",
            "Destination available inventory changed after quarantine release.",
            409,
          ),
        );
      if (
        onHand < aggregate.quantityUnits ||
        available < aggregate.quantityUnits ||
        onHand - aggregate.quantityUnits < reserved
      )
        issues.push(
          issue(
            "RETURN_REVERSAL_NOT_SAFE",
            "Destination available inventory is insufficient to reverse the release.",
            409,
          ),
        );
      return {
        balanceType: "available",
        direction: "out",
        balanceId: aggregate.balance.id,
        version: aggregate.balance.version,
        quantity: fixed(aggregate.quantityUnits),
        quantityUnits: aggregate.quantityUnits,
        onHandBefore: fixed(onHand),
        onHandAfter: fixed(onHand - aggregate.quantityUnits),
        reservedBefore: fixed(reserved),
        reservedAfter: fixed(reserved),
        availableBefore: fixed(available),
        availableAfter: fixed(available - aggregate.quantityUnits),
        evidence,
      };
    },
  );
  const authorization = posting.returnAuthorization;
  const state = statuses(
    totalAuthorized(authorization),
    totalPosted(authorization, posting.id),
  );
  return result(
    {
      postingId: posting.id,
      postingNumber: posting.postingNumber,
      postingType: posting.postingType,
      returnAuthorizationId: authorization.id,
      returnRequestId: authorization.returnRequestId,
      warehouseId: posting.warehouseId,
      lines: posting.lines,
    },
    issues,
    {
      posting,
      authorization,
      warehouseIds: [posting.warehouseId],
      balanceImpacts: [...destinationImpacts, ...sourceImpacts],
      movementFacts: posting.lines.flatMap((line) => [
        {
          postingLineId: line.id,
          movementType: "quarantine_release_reversal_available_out",
          originalMovementId: movementByKey.get(
            movementKey(line.id, "quarantine_release_available_in"),
          )?.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          unit: line.unit,
          warehouseId: line.warehouseId,
          location: destinationLocationOf(line),
          locationKey: destinationLocationKeyOf(line),
          quantity: fixed(decimalUnits(line.quantity)),
          balanceType: "available",
          balanceId: line.destinationInventoryBalanceId,
        },
        {
          postingLineId: line.id,
          movementType: "quarantine_release_reversal_in",
          originalMovementId: movementByKey.get(
            movementKey(line.id, "quarantine_release_out"),
          )?.id,
          itemId: line.itemId,
          sku: line.sku,
          itemName: line.itemName,
          unit: line.unit,
          warehouseId: line.warehouseId,
          location: line.location,
          locationKey: line.locationKey,
          quantity: fixed(decimalUnits(line.quantity)),
          balanceType: "quarantine",
          balanceId: line.quarantineBalanceId,
        },
      ]),
      reconciliationImpacts: posting.lines.map((line) => ({
        postingLineId: line.id,
        availableQuantityOut: fixed(decimalUnits(line.quantity)),
        quarantineQuantityIn: fixed(decimalUnits(line.quantity)),
        tenantNetQuantity: "0.0000",
        status: "matched",
      })),
      authorizationStatusAfter: state.authorization,
      requestStatusAfter: state.request,
      tenantNetQuantity: "0.0000",
    },
  );
}

export {
  decimalString as quarantineReleaseDecimalString,
  decimalUnits as quarantineReleaseDecimalUnits,
};
