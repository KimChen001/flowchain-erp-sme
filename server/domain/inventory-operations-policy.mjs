import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";

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

function routeKey(row) {
  return `${text(row.warehouseId)}|${text(row.locationKey)}`;
}

function aggregateBalanceImpacts(
  entries,
  blockingIssues,
  {
    insufficientCode,
    insufficientMessage,
    unsafeCode,
    unsafeMessage,
    rejectZeroCode,
    rejectZeroMessage,
  } = {},
) {
  const grouped = new Map();
  for (const entry of entries) {
    const current = grouped.get(entry.balance.id) || {
      balance: entry.balance,
      delta: 0n,
      totalIn: 0n,
      totalOut: 0n,
      roles: new Set(),
      lineIds: [],
      legIds: [],
    };
    current.delta += entry.delta;
    if (entry.delta > 0n) current.totalIn += entry.delta;
    if (entry.delta < 0n) current.totalOut += -entry.delta;
    if (entry.role) current.roles.add(entry.role);
    if (entry.lineId) current.lineIds.push(entry.lineId);
    if (entry.legId) current.legIds.push(entry.legId);
    grouped.set(entry.balance.id, current);
  }
  const impacts = [];
  for (const aggregate of [...grouped.values()].sort((a, b) =>
    a.balance.id.localeCompare(b.balance.id),
  )) {
    const onHand = decimalUnits(aggregate.balance.onHandQuantity);
    const reserved = decimalUnits(aggregate.balance.reservedQuantity);
    const available = decimalUnits(aggregate.balance.availableQuantity);
    const after = onHand + aggregate.delta;
    if (
      aggregate.totalOut > 0n &&
      (onHand < aggregate.totalOut || available < aggregate.totalOut)
    )
      blockingIssues.push(
        issue(insufficientCode, insufficientMessage(aggregate.balance), 409, {
          balanceId: aggregate.balance.id,
          totalOut: fixed(aggregate.totalOut),
        }),
      );
    if (after < 0n || after < reserved)
      blockingIssues.push(
        issue(unsafeCode, unsafeMessage(aggregate.balance), 409, {
          balanceId: aggregate.balance.id,
          onHandAfter: fixed(after),
          reserved: fixed(reserved),
        }),
      );
    if (aggregate.delta === 0n && rejectZeroCode) {
      blockingIssues.push(
        issue(rejectZeroCode, rejectZeroMessage(aggregate.balance), 422, {
          balanceId: aggregate.balance.id,
        }),
      );
      continue;
    }
    impacts.push({
      balanceId: aggregate.balance.id,
      roles: [...aggregate.roles].sort(),
      version: aggregate.balance.version,
      onHandBefore: fixed(onHand),
      onHandAfter: fixed(after),
      reservedBefore: fixed(reserved),
      reservedAfter: fixed(reserved),
      availableBefore: fixed(available),
      availableAfter: fixed(after - reserved),
      quantity: fixed(aggregate.delta),
      totalIn: fixed(aggregate.totalIn),
      totalOut: fixed(aggregate.totalOut),
      lineIds: [...new Set(aggregate.lineIds)].sort(),
      legIds: [...new Set(aggregate.legIds)].sort(),
    });
  }
  return impacts;
}

function sameUnits(actual, expected) {
  return (
    decimalUnits(actual || 0) ===
    (typeof expected === "bigint" ? expected : decimalUnits(expected || 0))
  );
}

function movementBalanceId(movement) {
  return text(movement?.metadata?.balanceId);
}

function validTransferOriginal({ movement, transfer, line, leg }) {
  const source = leg.direction === "source";
  return Boolean(
    movement &&
    movement.tenantId === transfer.tenantId &&
    movement.sourceDocumentType === "StockTransferDocument" &&
    movement.sourceDocumentId === transfer.id &&
    movement.sourceDocumentLineId === leg.id &&
    movement.movementType ===
      (source ? "stock_transfer_out" : "stock_transfer_in") &&
    movement.itemId === line.itemId &&
    movement.sku === line.sku &&
    movement.warehouseId === leg.warehouseId &&
    text(movement.locationKey) === text(leg.locationKey) &&
    sameUnits(movement.quantityIn, source ? 0 : line.quantity) &&
    sameUnits(movement.quantityOut, source ? line.quantity : 0) &&
    sameUnits(movement.adjustmentQty, 0) &&
    text(movement.postingBatchId) &&
    text(movement.postingBatchId) === text(transfer.metadata?.postingBatchId) &&
    movementBalanceId(movement) &&
    !movement.reversedByMovementId,
  );
}

function validAdjustmentOriginal({ movement, adjustment, line }) {
  const delta = decimalUnits(line.adjustmentQuantity);
  return Boolean(
    movement &&
    movement.tenantId === adjustment.tenantId &&
    movement.sourceDocumentType === "InventoryAdjustmentDocument" &&
    movement.sourceDocumentId === adjustment.id &&
    movement.sourceDocumentLineId === line.id &&
    movement.movementType === "inventory_adjustment" &&
    movement.itemId === line.itemId &&
    movement.sku === line.sku &&
    movement.warehouseId === line.warehouseId &&
    text(movement.locationKey) === text(line.locationKey) &&
    sameUnits(movement.adjustmentQty, delta) &&
    sameUnits(movement.quantityIn, delta > 0n ? delta : 0) &&
    sameUnits(movement.quantityOut, delta < 0n ? -delta : 0) &&
    movementBalanceId(movement) === line.inventoryBalanceId &&
    text(movement.postingBatchId) &&
    text(movement.postingBatchId) ===
      text(adjustment.metadata?.postingBatchId) &&
    !movement.reversedByMovementId,
  );
}

export async function buildStockTransferPostingPlan({
  prisma,
  tenantId,
  transferId,
}) {
  const transfer = await prisma.stockTransferDocument.findFirst({
    where: { id: text(transferId), tenantId },
    include: { lines: { include: { legs: true }, orderBy: { id: "asc" } } },
  });
  if (!transfer)
    return result({ transferId: text(transferId) }, [
      issue("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404),
    ]);
  const blockingIssues = [];
  if (
    transfer.workflowStatus !== "ready" ||
    transfer.postingStatus !== "unposted"
  )
    blockingIssues.push(
      issue(
        "INVENTORY_OPERATION_INVALID_STATE",
        "Only ready, unposted transfers can be posted.",
        409,
      ),
    );
  const keys = transfer.lines.flatMap((line) =>
    line.legs.map((leg) => ({
      sku: line.sku,
      warehouseId: leg.warehouseId,
      locationKey: leg.locationKey,
    })),
  );
  const balances = keys.length
    ? await prisma.inventoryBalance.findMany({
        where: {
          tenantId,
          OR: keys.map((key) => ({
            sku: key.sku,
            warehouseKey: key.warehouseId,
            locationKey: key.locationKey,
          })),
        },
      })
    : [];
  const balanceMap = new Map(
    balances.map((row) => [
      `${row.sku}|${row.warehouseKey}|${row.locationKey}`,
      row,
    ]),
  );
  const rawBalanceImpacts = [],
    movementFacts = [];
  for (const line of transfer.lines) {
    const source = line.legs.find((leg) => leg.direction === "source"),
      destination = line.legs.find((leg) => leg.direction === "destination");
    const quantity = decimalUnits(line.quantity);
    if (!source || !destination || routeKey(source) === routeKey(destination)) {
      blockingIssues.push(
        issue(
          "TRANSFER_INVALID_ROUTE",
          `Transfer line ${line.id} requires distinct source and destination routes.`,
        ),
      );
      continue;
    }
    const sourceBalance = balanceMap.get(
      `${line.sku}|${source.warehouseId}|${source.locationKey}`,
    );
    const destinationBalance = balanceMap.get(
      `${line.sku}|${destination.warehouseId}|${destination.locationKey}`,
    );
    if (!sourceBalance)
      blockingIssues.push(
        issue(
          "TRANSFER_SOURCE_BALANCE_NOT_FOUND",
          `Source balance for ${line.sku} was not found.`,
          409,
        ),
      );
    if (!destinationBalance)
      blockingIssues.push(
        issue(
          "TRANSFER_DESTINATION_BALANCE_NOT_FOUND",
          `Destination balance for ${line.sku} was not found.`,
          409,
        ),
      );
    if (!sourceBalance || !destinationBalance) continue;
    if (quantity <= 0n)
      blockingIssues.push(
        issue(
          "TRANSFER_INVALID_ROUTE",
          "Transfer quantity must be greater than zero.",
        ),
      );
    rawBalanceImpacts.push(
      {
        balance: sourceBalance,
        delta: -quantity,
        role: "source",
        lineId: line.id,
        legId: source.id,
      },
      {
        balance: destinationBalance,
        delta: quantity,
        role: "destination",
        lineId: line.id,
        legId: destination.id,
      },
    );
    movementFacts.push(
      {
        movementType: "stock_transfer_out",
        lineId: line.id,
        legId: source.id,
        balanceId: sourceBalance.id,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        warehouseId: source.warehouseId,
        location: source.location,
        locationKey: source.locationKey,
        quantityIn: "0.0000",
        quantityOut: fixed(quantity),
        adjustmentQty: "0.0000",
        unit: line.unit,
      },
      {
        movementType: "stock_transfer_in",
        lineId: line.id,
        legId: destination.id,
        balanceId: destinationBalance.id,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        warehouseId: destination.warehouseId,
        location: destination.location,
        locationKey: destination.locationKey,
        quantityIn: fixed(quantity),
        quantityOut: "0.0000",
        adjustmentQty: "0.0000",
        unit: line.unit,
      },
    );
  }
  const balanceImpacts = aggregateBalanceImpacts(
    rawBalanceImpacts,
    blockingIssues,
    {
      insufficientCode: "TRANSFER_INSUFFICIENT_AVAILABLE",
      insufficientMessage: (balance) =>
        `Source inventory is insufficient for ${balance.sku}.`,
      unsafeCode: "TRANSFER_INSUFFICIENT_AVAILABLE",
      unsafeMessage: (balance) =>
        `Transfer would reduce ${balance.sku} below reserved inventory.`,
    },
  );
  return result(
    { transferId: transfer.id, expectedVersion: transfer.version },
    blockingIssues,
    {
      transfer,
      balanceImpacts,
      movementFacts,
      documentImpacts: [{ id: transfer.id, postingStatus: "posted" }],
      reconciliationImpacts: [
        { rule: "transfer_net_inventory_change", expected: "0.0000" },
      ],
    },
  );
}

export async function buildStockTransferReversalPlan({
  prisma,
  tenantId,
  transferId,
}) {
  const transfer = await prisma.stockTransferDocument.findFirst({
    where: { id: text(transferId), tenantId },
    include: { lines: { include: { legs: true }, orderBy: { id: "asc" } } },
  });
  if (!transfer)
    return result({ transferId: text(transferId) }, [
      issue("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404),
    ]);
  const blockingIssues = [];
  if (transfer.postingStatus !== "posted")
    blockingIssues.push(
      issue(
        transfer.postingStatus === "reversed"
          ? "TRANSFER_ALREADY_REVERSED"
          : "TRANSFER_ALREADY_POSTED",
        "Only posted transfers can be reversed.",
        409,
      ),
    );
  const legIds = transfer.lines.flatMap((line) =>
    line.legs.map((leg) => leg.id),
  );
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      tenantId,
      sourceDocumentId: transfer.id,
      sourceDocumentLineId: { in: legIds },
    },
  });
  const movementGroups = new Map();
  for (const movement of movements) {
    const rows = movementGroups.get(movement.sourceDocumentLineId) || [];
    rows.push(movement);
    movementGroups.set(movement.sourceDocumentLineId, rows);
  }
  const balanceIds = movements
    .map((row) => row.metadata?.balanceId)
    .filter(Boolean);
  const balances = balanceIds.length
    ? await prisma.inventoryBalance.findMany({
        where: { tenantId, id: { in: balanceIds } },
      })
    : [];
  const balanceMap = new Map(balances.map((row) => [row.id, row]));
  const rawBalanceImpacts = [],
    movementFacts = [];
  for (const line of transfer.lines)
    for (const leg of line.legs) {
      const originals = movementGroups.get(leg.id) || [];
      const original = originals[0];
      if (
        originals.length !== 1 ||
        !validTransferOriginal({ movement: original, transfer, line, leg })
      ) {
        blockingIssues.push(
          issue(
            "TRANSFER_REVERSAL_NOT_SAFE",
            `Original transfer movement for leg ${leg.id} is incomplete or already reversed.`,
            409,
          ),
        );
        continue;
      }
      const balance = balanceMap.get(movementBalanceId(original));
      if (
        !balance ||
        balance.id !== movementBalanceId(original) ||
        balance.itemId !== line.itemId ||
        balance.sku !== line.sku ||
        balance.warehouseId !== leg.warehouseId ||
        text(balance.locationKey) !== text(leg.locationKey)
      ) {
        blockingIssues.push(
          issue(
            "TRANSFER_REVERSAL_NOT_SAFE",
            "Original transfer balance identity is unavailable.",
            409,
          ),
        );
        continue;
      }
      const quantity = decimalUnits(line.quantity);
      const source = leg.direction === "source",
        delta = source ? quantity : -quantity;
      rawBalanceImpacts.push({
        balance,
        delta,
        role: source ? "source" : "destination",
        lineId: line.id,
        legId: leg.id,
      });
      movementFacts.push({
        movementType: source
          ? "stock_transfer_reversal_in"
          : "stock_transfer_reversal_out",
        lineId: line.id,
        legId: leg.id,
        balanceId: balance.id,
        originalMovementId: original.id,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        warehouseId: leg.warehouseId,
        location: leg.location,
        locationKey: leg.locationKey,
        quantityIn: source ? fixed(quantity) : "0.0000",
        quantityOut: source ? "0.0000" : fixed(quantity),
        adjustmentQty: "0.0000",
        unit: line.unit,
      });
    }
  const balanceImpacts = aggregateBalanceImpacts(
    rawBalanceImpacts,
    blockingIssues,
    {
      insufficientCode: "TRANSFER_REVERSAL_NOT_SAFE",
      insufficientMessage: (balance) =>
        `Destination inventory is no longer sufficient to reverse ${balance.sku}.`,
      unsafeCode: "TRANSFER_REVERSAL_NOT_SAFE",
      unsafeMessage: (balance) =>
        `Current inventory for ${balance.sku} cannot safely absorb the reversal.`,
    },
  );
  return result(
    { transferId: transfer.id, expectedVersion: transfer.version },
    blockingIssues,
    {
      transfer,
      balanceImpacts,
      movementFacts,
      documentImpacts: [{ id: transfer.id, postingStatus: "reversed" }],
      reconciliationImpacts: [
        { rule: "transfer_effective_net_after_reversal", expected: "0.0000" },
      ],
    },
  );
}

export async function buildStockTransferCancellationPlan({
  prisma,
  tenantId,
  transferId,
  reason,
}) {
  const transfer = await prisma.stockTransferDocument.findFirst({
    where: { id: text(transferId), tenantId },
  });
  const blockingIssues = [];
  if (!transfer)
    blockingIssues.push(
      issue("TRANSFER_NOT_FOUND", "Stock transfer was not found.", 404),
    );
  else if (
    !["draft", "ready"].includes(transfer.workflowStatus) ||
    transfer.postingStatus !== "unposted"
  )
    blockingIssues.push(
      issue(
        "INVENTORY_OPERATION_INVALID_STATE",
        "Only unposted draft or ready transfers can be cancelled.",
        409,
      ),
    );
  if (!text(reason))
    blockingIssues.push(
      issue(
        "INVENTORY_OPERATION_INVALID_STATE",
        "A cancellation reason is required.",
      ),
    );
  return result(
    { transferId: text(transferId), reason: text(reason) },
    blockingIssues,
    { transfer },
  );
}

// Cancelling a count changes no stock: any count that is not posted or
// already cancelled can be cancelled, with a reason, whatever its review
// state. The plan carries the session version the command checks.
export async function buildCycleCountCancellationPlan({
  prisma,
  tenantId,
  countSessionId,
  reason,
}) {
  const session = await prisma.cycleCountSession.findFirst({
    where: { id: text(countSessionId), tenantId },
  });
  const blockingIssues = [];
  if (!session)
    blockingIssues.push(issue("COUNT_NOT_FOUND", "Cycle count was not found.", 404));
  else if (["posted", "cancelled"].includes(session.workflowStatus))
    blockingIssues.push(
      issue(
        "COUNT_INVALID_STATE",
        "Posted or cancelled counts cannot be cancelled.",
        409,
      ),
    );
  if (!text(reason))
    blockingIssues.push(
      issue("COUNT_INVALID_STATE", "A cancellation reason is required."),
    );
  return result(
    {
      countSessionId: text(countSessionId),
      reason: text(reason),
      expectedSessionVersion: session?.version ?? null,
    },
    blockingIssues,
    { session },
  );
}

export async function buildCycleCountSubmissionPlan({
  prisma,
  tenantId,
  countSessionId,
}) {
  const session = await prisma.cycleCountSession.findFirst({
    where: { id: text(countSessionId), tenantId },
    include: { lines: true },
  });
  const blockingIssues = [];
  if (!session)
    blockingIssues.push(
      issue("COUNT_NOT_FOUND", "Cycle count was not found.", 404),
    );
  else {
    if (!["draft", "in_progress"].includes(session.workflowStatus))
      blockingIssues.push(
        issue(
          "COUNT_INVALID_STATE",
          "Only an active count can be submitted.",
          409,
        ),
      );
    if (session.lines.some((line) => line.countedQuantity === null))
      blockingIssues.push(
        issue(
          "COUNT_LINE_INCOMPLETE",
          "Every count line requires a counted quantity.",
          409,
        ),
      );
  }
  return result({ countSessionId: text(countSessionId) }, blockingIssues, {
    session,
  });
}

export async function buildCycleCountReviewPlan({
  prisma,
  tenantId,
  countSessionId,
}) {
  const session = await prisma.cycleCountSession.findFirst({
    where: { id: text(countSessionId), tenantId },
    include: { lines: true },
  });
  const blockingIssues = [];
  if (!session)
    blockingIssues.push(
      issue("COUNT_NOT_FOUND", "Cycle count was not found.", 404),
    );
  else if (session.workflowStatus !== "submitted")
    blockingIssues.push(
      issue(
        "COUNT_INVALID_STATE",
        "Only submitted counts can be reviewed.",
        409,
      ),
    );
  return result({ countSessionId: text(countSessionId) }, blockingIssues, {
    session,
  });
}

export async function buildCycleCountPostingPlan({
  prisma,
  tenantId,
  countSessionId,
}) {
  const session = await prisma.cycleCountSession.findFirst({
    where: { id: text(countSessionId), tenantId },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!session)
    return result({ countSessionId: text(countSessionId) }, [
      issue("COUNT_NOT_FOUND", "Cycle count was not found.", 404),
    ]);
  const blockingIssues = [];
  if (session.workflowStatus !== "reviewed")
    blockingIssues.push(
      issue(
        "COUNT_REVIEW_REQUIRED",
        "Cycle count review is required before posting.",
        409,
      ),
    );
  const balances = await prisma.inventoryBalance.findMany({
    where: {
      tenantId,
      id: { in: session.lines.map((line) => line.inventoryBalanceId) },
    },
  });
  const balanceMap = new Map(balances.map((row) => [row.id, row])),
    balanceImpacts = [],
    movementFacts = [];
  for (const line of session.lines) {
    const balance = balanceMap.get(line.inventoryBalanceId);
    if (
      !balance ||
      balance.version !== line.recordedBalanceVersion ||
      decimalUnits(balance.onHandQuantity) !==
        decimalUnits(line.recordedOnHandQuantity) ||
      decimalUnits(balance.reservedQuantity) !==
        decimalUnits(line.recordedReservedQuantity) ||
      decimalUnits(balance.availableQuantity) !==
        decimalUnits(line.recordedAvailableQuantity)
    ) {
      blockingIssues.push(
        issue(
          "COUNT_BALANCE_CHANGED",
          `Balance ${line.inventoryBalanceId} changed after the count snapshot.`,
          409,
          balance
            ? {
                currentVersion: balance.version,
                recordedVersion: line.recordedBalanceVersion,
                currentOnHand: fixed(balance.onHandQuantity),
                recordedOnHand: fixed(line.recordedOnHandQuantity),
                currentReserved: fixed(balance.reservedQuantity),
                recordedReserved: fixed(line.recordedReservedQuantity),
                currentAvailable: fixed(balance.availableQuantity),
                recordedAvailable: fixed(line.recordedAvailableQuantity),
              }
            : { missing: true },
        ),
      );
      continue;
    }
    if (line.countedQuantity === null) {
      blockingIssues.push(
        issue(
          "COUNT_LINE_INCOMPLETE",
          "Every count line requires a counted quantity.",
          409,
        ),
      );
      continue;
    }
    const counted = decimalUnits(line.countedQuantity),
      recorded = decimalUnits(line.recordedOnHandQuantity),
      reserved = decimalUnits(balance.reservedQuantity),
      variance = counted - recorded;
    if (counted < reserved)
      blockingIssues.push(
        issue(
          "COUNT_BELOW_RESERVED_NOT_SAFE",
          `Counted inventory for ${line.sku} cannot be below reserved inventory.`,
          409,
        ),
      );
    balanceImpacts.push({
      balanceId: balance.id,
      version: balance.version,
      onHandBefore: fixed(recorded),
      onHandAfter: fixed(counted),
      reservedBefore: fixed(reserved),
      reservedAfter: fixed(reserved),
      availableBefore: fixed(recorded - reserved),
      availableAfter: fixed(counted - reserved),
      quantity: fixed(variance),
      lineId: line.id,
    });
    if (variance !== 0n)
      movementFacts.push({
        movementType: "cycle_count_adjustment",
        lineId: line.id,
        balanceId: balance.id,
        itemId: line.itemId,
        sku: line.sku,
        itemName: line.itemName,
        warehouseId: line.warehouseId,
        location: line.location,
        locationKey: line.locationKey,
        quantityIn: variance > 0n ? fixed(variance) : "0.0000",
        quantityOut: variance < 0n ? fixed(-variance) : "0.0000",
        adjustmentQty: fixed(variance),
        unit: line.unit,
      });
  }
  return result(
    { countSessionId: session.id, expectedVersion: session.version },
    blockingIssues,
    {
      session,
      balanceImpacts,
      movementFacts,
      reconciliationImpacts: [
        { rule: "counted_minus_recorded_equals_variance" },
      ],
    },
  );
}

export async function buildInventoryAdjustmentPostingPlan({
  prisma,
  tenantId,
  adjustmentId,
}) {
  const adjustment = await prisma.inventoryAdjustmentDocument.findFirst({
    where: { id: text(adjustmentId), tenantId },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!adjustment)
    return result({ adjustmentId: text(adjustmentId) }, [
      issue("ADJUSTMENT_NOT_FOUND", "Inventory adjustment was not found.", 404),
    ]);
  const blockingIssues = [];
  if (
    adjustment.workflowStatus !== "ready" ||
    adjustment.postingStatus !== "unposted"
  )
    blockingIssues.push(
      issue(
        "ADJUSTMENT_INVALID_STATE",
        "Only ready, unposted adjustments can be posted.",
        409,
      ),
    );
  const balances = await prisma.inventoryBalance.findMany({
    where: {
      tenantId,
      id: { in: adjustment.lines.map((line) => line.inventoryBalanceId) },
    },
  });
  const balanceMap = new Map(balances.map((row) => [row.id, row])),
    rawBalanceImpacts = [],
    movementFacts = [];
  for (const line of adjustment.lines) {
    const balance = balanceMap.get(line.inventoryBalanceId);
    if (!balance) {
      blockingIssues.push(
        issue(
          "ADJUSTMENT_NOT_FOUND",
          `Balance ${line.inventoryBalanceId} was not found.`,
          404,
        ),
      );
      continue;
    }
    const delta = decimalUnits(line.adjustmentQuantity);
    rawBalanceImpacts.push({
      balance,
      delta,
      lineId: line.id,
    });
    movementFacts.push({
      movementType: "inventory_adjustment",
      lineId: line.id,
      balanceId: balance.id,
      itemId: line.itemId,
      sku: line.sku,
      itemName: line.itemName,
      warehouseId: line.warehouseId,
      location: line.location,
      locationKey: line.locationKey,
      quantityIn: delta > 0n ? fixed(delta) : "0.0000",
      quantityOut: delta < 0n ? fixed(-delta) : "0.0000",
      adjustmentQty: fixed(delta),
      unit: line.unit,
    });
  }
  const balanceImpacts = aggregateBalanceImpacts(
    rawBalanceImpacts,
    blockingIssues,
    {
      insufficientCode: "ADJUSTMENT_BELOW_RESERVED_NOT_SAFE",
      insufficientMessage: (balance) =>
        `Adjustment would reduce ${balance.sku} below available inventory.`,
      unsafeCode: "ADJUSTMENT_BELOW_RESERVED_NOT_SAFE",
      unsafeMessage: (balance) =>
        `Adjustment would reduce ${balance.sku} below reserved inventory.`,
      rejectZeroCode: "ADJUSTMENT_NET_ZERO_NOT_ALLOWED",
      rejectZeroMessage: (balance) =>
        `Adjustment lines for ${balance.sku} cancel to zero.`,
    },
  );
  return result(
    { adjustmentId: adjustment.id, expectedVersion: adjustment.version },
    blockingIssues,
    {
      adjustment,
      balanceImpacts,
      movementFacts,
      reconciliationImpacts: [
        { rule: "balance_delta_equals_adjustment_delta" },
      ],
    },
  );
}

export async function buildInventoryAdjustmentReversalPlan({
  prisma,
  tenantId,
  adjustmentId,
}) {
  const adjustment = await prisma.inventoryAdjustmentDocument.findFirst({
    where: { id: text(adjustmentId), tenantId },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!adjustment)
    return result({ adjustmentId: text(adjustmentId) }, [
      issue("ADJUSTMENT_NOT_FOUND", "Inventory adjustment was not found.", 404),
    ]);
  const blockingIssues = [];
  if (adjustment.postingStatus !== "posted")
    blockingIssues.push(
      issue(
        adjustment.postingStatus === "reversed"
          ? "ADJUSTMENT_ALREADY_REVERSED"
          : "ADJUSTMENT_ALREADY_POSTED",
        "Only posted adjustments can be reversed.",
        409,
      ),
    );
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      tenantId,
      sourceDocumentId: adjustment.id,
    },
  });
  const movementGroups = new Map();
  for (const movement of movements) {
    const rows = movementGroups.get(movement.sourceDocumentLineId) || [];
    rows.push(movement);
    movementGroups.set(movement.sourceDocumentLineId, rows);
  }
  const balances = await prisma.inventoryBalance.findMany({
    where: {
      tenantId,
      id: { in: adjustment.lines.map((line) => line.inventoryBalanceId) },
    },
  });
  const balanceMap = new Map(balances.map((row) => [row.id, row])),
    rawBalanceImpacts = [],
    movementFacts = [];
  for (const line of adjustment.lines) {
    const originals = movementGroups.get(line.id) || [],
      original = originals[0],
      balance = balanceMap.get(line.inventoryBalanceId);
    if (
      originals.length !== 1 ||
      !validAdjustmentOriginal({ movement: original, adjustment, line }) ||
      !balance ||
      balance.itemId !== line.itemId ||
      balance.sku !== line.sku ||
      balance.warehouseId !== line.warehouseId ||
      text(balance.locationKey) !== text(line.locationKey)
    ) {
      blockingIssues.push(
        issue(
          "ADJUSTMENT_REVERSAL_NOT_SAFE",
          `Original adjustment facts for ${line.id} are incomplete or already reversed.`,
          409,
        ),
      );
      continue;
    }
    const reverseDelta = -decimalUnits(line.adjustmentQuantity);
    rawBalanceImpacts.push({
      balance,
      delta: reverseDelta,
      lineId: line.id,
    });
    movementFacts.push({
      movementType: "inventory_adjustment_reversal",
      lineId: line.id,
      balanceId: balance.id,
      originalMovementId: original.id,
      itemId: line.itemId,
      sku: line.sku,
      itemName: line.itemName,
      warehouseId: line.warehouseId,
      location: line.location,
      locationKey: line.locationKey,
      quantityIn: reverseDelta > 0n ? fixed(reverseDelta) : "0.0000",
      quantityOut: reverseDelta < 0n ? fixed(-reverseDelta) : "0.0000",
      adjustmentQty: fixed(reverseDelta),
      unit: line.unit,
    });
  }
  const balanceImpacts = aggregateBalanceImpacts(
    rawBalanceImpacts,
    blockingIssues,
    {
      insufficientCode: "ADJUSTMENT_REVERSAL_NOT_SAFE",
      insufficientMessage: (balance) =>
        `Current inventory for ${balance.sku} cannot safely absorb the reversal.`,
      unsafeCode: "ADJUSTMENT_REVERSAL_NOT_SAFE",
      unsafeMessage: (balance) =>
        `Current inventory for ${balance.sku} cannot safely absorb the reversal.`,
      rejectZeroCode: "ADJUSTMENT_REVERSAL_NOT_SAFE",
      rejectZeroMessage: (balance) =>
        `Adjustment reversal for ${balance.sku} has no effective balance impact.`,
    },
  );
  return result(
    { adjustmentId: adjustment.id, expectedVersion: adjustment.version },
    blockingIssues,
    {
      adjustment,
      balanceImpacts,
      movementFacts,
      reconciliationImpacts: [
        { rule: "adjustment_effective_net_after_reversal", expected: "0.0000" },
      ],
    },
  );
}

export async function buildInventoryAdjustmentCancellationPlan({
  prisma,
  tenantId,
  adjustmentId,
  reason,
}) {
  const adjustment = await prisma.inventoryAdjustmentDocument.findFirst({
    where: { id: text(adjustmentId), tenantId },
  });
  const blockingIssues = [];
  if (!adjustment)
    blockingIssues.push(
      issue("ADJUSTMENT_NOT_FOUND", "Inventory adjustment was not found.", 404),
    );
  else if (
    !["draft", "ready"].includes(adjustment.workflowStatus) ||
    adjustment.postingStatus !== "unposted"
  )
    blockingIssues.push(
      issue(
        "ADJUSTMENT_INVALID_STATE",
        "Only unposted draft or ready adjustments can be cancelled.",
        409,
      ),
    );
  if (!text(reason))
    blockingIssues.push(
      issue("ADJUSTMENT_REASON_REQUIRED", "A cancellation reason is required."),
    );
  return result(
    { adjustmentId: text(adjustmentId), reason: text(reason) },
    blockingIssues,
    { adjustment },
  );
}

export {
  decimalString as inventoryOperationDecimalString,
  decimalUnits as inventoryOperationDecimalUnits,
};
