import {
  outboundDecimalString as decimalString,
  outboundDecimalUnits as decimalUnits,
} from "./outbound-transaction-policy.mjs";

export class QuarantineLineageError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.name = "QuarantineLineageError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value) => String(value ?? "").trim();
const fixed = (value) =>
  decimalString(typeof value === "bigint" ? value : decimalUnits(value || 0));

// Consumption of quarantine stock is recorded against the customer return
// receipt layers it used. A supplier return taken from quarantine uses
// untracked stock first, then the oldest layers. A quarantine release passes
// `sourceMovementIds`, the receipt layers of its own return line, and uses
// only those (L8-09): releasing one return must not use up the goods of
// another return in the same quarantine stock record.
export async function allocateTrackedQuarantineConsumption({
  tx,
  tenantId,
  quarantineBalance,
  consumerMovement,
  quantity,
  idFactory,
  sourceMovementIds,
}) {
  const quantityUnits = decimalUnits(quantity);
  const restricted = Array.isArray(sourceMovementIds);
  const sources = await tx.inventoryMovement.findMany({
    where: {
      tenantId,
      movementType: "customer_return_quarantine_in",
      reversedByMovementId: null,
      occurredAt: { lte: consumerMovement.occurredAt },
      metadata: { path: ["balanceId"], equals: quarantineBalance.id },
      ...(restricted ? { id: { in: sourceMovementIds.map(text) } } : {}),
    },
    include: {
      quarantineDispositionSources: {
        where: { status: "active" },
      },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const layers = sources.map((source) => {
    const consumed = source.quarantineDispositionSources.reduce(
      (sum, allocation) => sum + decimalUnits(allocation.quantity),
      0n,
    );
    return {
      source,
      remaining: decimalUnits(source.quantityIn) - consumed,
    };
  });
  const trackedRemaining = layers.reduce(
    (sum, layer) => sum + (layer.remaining > 0n ? layer.remaining : 0n),
    0n,
  );
  const onHand = decimalUnits(quarantineBalance.onHandQuantity);
  if (restricted) {
    if (trackedRemaining < quantityUnits || trackedRemaining > onHand)
      throw new QuarantineLineageError(
        "QUARANTINE_LINEAGE_INTEGRITY_FAILED",
        "This return no longer has enough of its own goods in quarantine.",
        409,
        {
          quarantineBalanceId: quarantineBalance.id,
          trackedRemaining: fixed(trackedRemaining),
          requestedQuantity: fixed(quantityUnits),
        },
      );
  } else if (trackedRemaining > onHand)
    throw new QuarantineLineageError(
      "QUARANTINE_LINEAGE_INTEGRITY_FAILED",
      "Tracked quarantine receipt layers exceed the current balance.",
      409,
      {
        quarantineBalanceId: quarantineBalance.id,
        trackedRemaining: fixed(trackedRemaining),
        onHand: fixed(onHand),
      },
    );
  let remainingToAllocate = restricted
    ? quantityUnits
    : quantityUnits -
      (onHand - trackedRemaining > quantityUnits
        ? quantityUnits
        : onHand - trackedRemaining);
  const allocations = [];
  for (const layer of layers) {
    if (remainingToAllocate <= 0n) break;
    if (layer.remaining <= 0n) continue;
    const allocated =
      layer.remaining < remainingToAllocate
        ? layer.remaining
        : remainingToAllocate;
    allocations.push(
      await tx.quarantineDispositionAllocation.create({
        data: {
          id: idFactory(),
          tenantId,
          quarantineBalanceId: quarantineBalance.id,
          sourceMovementId: layer.source.id,
          consumerMovementId: consumerMovement.id,
          quantity: fixed(allocated),
          status: "active",
          metadata: {
            allocationPolicy: restricted
              ? "own_return_layers_fifo_v1"
              : "untracked_first_then_fifo_v1",
            sourcePostingId: layer.source.sourceDocumentId,
            consumerPostingId: consumerMovement.sourceDocumentId,
          },
        },
      }),
    );
    remainingToAllocate -= allocated;
  }
  if (remainingToAllocate > 0n)
    throw new QuarantineLineageError(
      "QUARANTINE_LINEAGE_INTEGRITY_FAILED",
      "Quarantine consumption could not be reconciled to untracked and tracked inventory.",
      409,
      {
        quarantineBalanceId: quarantineBalance.id,
        unallocatedQuantity: fixed(remainingToAllocate),
      },
    );
  return allocations;
}

export async function reverseTrackedQuarantineConsumption({
  tx,
  tenantId,
  consumerMovementId,
  reversalMovementId,
  reversedAt,
}) {
  return tx.quarantineDispositionAllocation.updateMany({
    where: {
      tenantId,
      consumerMovementId: text(consumerMovementId),
      status: "active",
    },
    data: {
      status: "reversed",
      reversedAt,
      reversedByMovementId: reversalMovementId,
    },
  });
}

export async function activeTrackedConsumption({
  prisma,
  tenantId,
  sourceMovementIds,
}) {
  if (!sourceMovementIds.length) return [];
  return prisma.quarantineDispositionAllocation.findMany({
    where: {
      tenantId,
      sourceMovementId: { in: sourceMovementIds },
      status: "active",
    },
    orderBy: [{ sourceMovementId: "asc" }, { id: "asc" }],
  });
}

// The customer return receipt layers of each return request line that are
// still in quarantine: posted, unreversed receipts less every active
// consumption (a release, or a supplier return taken from quarantine). With
// `quarantineBalanceId`, only layers in that quarantine stock record (L8-09).
export async function returnLineQuarantineLayers({
  prisma,
  tenantId,
  returnRequestLineIds,
  quarantineBalanceId = "",
}) {
  const ids = [...new Set((returnRequestLineIds || []).map(text).filter(Boolean))];
  const result = new Map(
    ids.map((id) => [id, { sourceMovementIds: [], remainingUnits: 0n }]),
  );
  if (!ids.length) return result;
  const postingLines = await prisma.returnPostingLine.findMany({
    where: {
      returnAuthorizationLine: { returnRequestLineId: { in: ids } },
      returnPosting: {
        tenantId,
        postingType: "customer_return_receipt",
        postingStatus: "posted",
      },
    },
    select: {
      id: true,
      returnAuthorizationLine: { select: { returnRequestLineId: true } },
    },
  });
  if (!postingLines.length) return result;
  const requestLineByPostingLine = new Map(
    postingLines.map((row) => [
      row.id,
      row.returnAuthorizationLine.returnRequestLineId,
    ]),
  );
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      tenantId,
      movementType: "customer_return_quarantine_in",
      sourceDocumentType: "ReturnPostingDocument",
      sourceDocumentLineId: { in: [...requestLineByPostingLine.keys()] },
      reversedByMovementId: null,
    },
    include: {
      quarantineDispositionSources: { where: { status: "active" } },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const wantedBalance = text(quarantineBalanceId);
  for (const movement of movements) {
    if (wantedBalance && text(movement.metadata?.balanceId) !== wantedBalance)
      continue;
    const entry = result.get(
      requestLineByPostingLine.get(movement.sourceDocumentLineId),
    );
    if (!entry) continue;
    const consumed = movement.quarantineDispositionSources.reduce(
      (sum, allocation) => sum + decimalUnits(allocation.quantity),
      0n,
    );
    const remaining = decimalUnits(movement.quantityIn) - consumed;
    entry.sourceMovementIds.push(movement.id);
    if (remaining > 0n) entry.remainingUnits += remaining;
  }
  return result;
}
