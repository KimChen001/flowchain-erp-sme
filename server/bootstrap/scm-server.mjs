import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";
import { execFileSync } from "node:child_process";
import { loadEnv } from "../config/env.mjs";
import { validateProductionRuntimeConfig } from "../config/production-runtime-config.mjs";
import { validateDatabasePersistenceConfig } from "../persistence/persistence-config.mjs";
import { createHttpRequestHandler } from "./http-request-handler.mjs";
import { withServerErrorBoundary } from "./server-error-boundary.mjs";
import {
  createLocalSessionSecret,
} from "../domain/local-signed-session.mjs";
import { checkRuntimeReadiness } from "../domain/runtime-readiness.mjs";
import { createServerLifecycle, registerShutdownSignals } from "./server-lifecycle.mjs";
import {
  actorFromBody,
  applyWorkflowTransition,
  createAuditLogEntry,
  postedReceivingStatuses,
  priorities,
  purchaseOrderStatuses,
  purchaseRequestStatuses,
  recordValidationBlocked,
  recordWorkflowCreation,
  systemRequestSources,
  workflowDefinitions,
  workflowError,
} from "../domain/workflow.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..", "..");
const port = Number(process.env.SCM_API_PORT || 8787);
const distDir = path.join(root, "dist");

function gitValue(args, fallback = "unknown") {
  try {
    return (
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || fallback
    );
  } catch {
    return fallback;
  }
}
const buildIdentity = Object.freeze({
  commitSha:
    process.env.FLOWCHAIN_COMMIT_SHA || gitValue(["rev-parse", "HEAD"]),
  branch:
    process.env.FLOWCHAIN_BRANCH ||
    gitValue(["branch", "--show-current"], "detached"),
  runtimeMode:
    process.env.NODE_ENV === "production" ? "production" : "local-dev",
});

await loadEnv(root);

const openaiProxyUrl =
  process.env.OPENAI_PROXY_URL ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  "http://127.0.0.1:15236";
const openaiDispatcher = openaiProxyUrl
  ? new ProxyAgent(openaiProxyUrl)
  : undefined;
const arkProxyUrl =
  process.env.ARK_PROXY_URL || process.env.DOUBAO_PROXY_URL || "";
const arkDispatcher = arkProxyUrl ? new ProxyAgent(arkProxyUrl) : undefined;
const aiMaxTokens = Number(process.env.AI_MAX_TOKENS || 520);

function todayLabel() {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

function ensureEvents(db) {
  if (!Array.isArray(db.events)) db.events = [];
  return db.events;
}

function ensureAuditLog(db) {
  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  return db.auditLog;
}

function event(db, type, message, ref) {
  const events = ensureEvents(db);
  events.unshift({
    id: `EVT-${Date.now()}`,
    type,
    message,
    ref,
    at: new Date().toISOString(),
  });
  db.events = events.slice(0, 50);
}

function ensureUsers(db) {
  if (!Array.isArray(db.users)) db.users = [];
  return db.users;
}

function ensurePurchaseRequests(db) {
  if (!Array.isArray(db.purchaseRequests)) db.purchaseRequests = [];
  return db.purchaseRequests;
}

function ensureInventoryMovements(db) {
  if (!Array.isArray(db.inventoryMovements)) db.inventoryMovements = [];
  return db.inventoryMovements;
}

function ensureSopCycles(db) {
  if (!Array.isArray(db.sopCycles)) db.sopCycles = [];
  return db.sopCycles;
}

function ensureRfqs(db) {
  return Array.isArray(db.rfqs) ? db.rfqs : [];
}

function nextSequenceId(items, field, prefix, start) {
  const max = items.reduce((highest, item) => {
    const match = String(item?.[field] || "").match(/(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, start - 1);
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function recordInventoryMovement(db, movement) {
  const movements = ensureInventoryMovements(db);
  const id = movement.id || nextSequenceId(movements, "id", "MV-2026-", 1);
  const timestamp = movement.timestamp || new Date().toISOString();
  const record = {
    id,
    movementId: movement.movementId || id,
    ts: timestamp,
    timestamp,
    ...movement,
    id,
    movementId: movement.movementId || id,
  };
  movements.unshift(record);
  db.inventoryMovements = movements.slice(0, 200);
  return record;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function supplierIdFor(name = "") {
  return (
    String(name || "unknown-supplier")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w\u4e00-\u9fa5-]/g, "") || "unknown-supplier"
  );
}

function warehouseIdFor(value = "") {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "";
  return raw.replace(/\s+/g, "-");
}

function makePoLineId(poId, index = 0) {
  return `${poId}-L${String(index + 1).padStart(3, "0")}`;
}

function lineStatusFromQuantities(line) {
  const ordered = Math.max(0, toNumber(line.quantityOrdered));
  const received = Math.max(0, toNumber(line.quantityReceived));
  const accepted = Math.max(0, toNumber(line.quantityAccepted));
  const rejected = Math.max(0, toNumber(line.quantityRejected));
  if (ordered <= 0) return "closed";
  if (received <= 0) return "open";
  if (received < ordered) return "partially_received";
  return rejected > 0 ? "closed" : "received";
}

function normalizePoLine(line, po, index = 0) {
  const poId = po.po || po.poId || line.poId || "";
  const quantityOrdered = Math.max(
    0,
    toNumber(
      line.quantityOrdered ??
        line.quantity ??
        line.qty ??
        po.recommendedQty ??
        po.items ??
        1,
      1,
    ),
  );
  const quantityReceived = Math.max(
    0,
    toNumber(line.quantityReceived ?? line.receivedQty ?? line.received ?? 0),
  );
  const quantityAccepted = Math.max(
    0,
    toNumber(line.quantityAccepted ?? line.acceptedQty ?? line.accepted ?? 0),
  );
  const quantityRejected = Math.max(
    0,
    toNumber(line.quantityRejected ?? line.rejectedQty ?? line.rejected ?? 0),
  );
  const normalized = {
    poLineId: line.poLineId || makePoLineId(poId, index),
    poId,
    sku: line.sku || po.sourceSku || "",
    itemName:
      line.itemName ||
      line.name ||
      po.sourceName ||
      po.reason ||
      `采购明细 ${index + 1}`,
    quantityOrdered,
    quantityReceived,
    quantityAccepted,
    quantityRejected,
    unit: line.unit || po.unit || "",
    unitPrice: toNumber(line.unitPrice ?? po.unitPrice ?? 0),
    currency: line.currency || po.currency || "CNY",
    supplierId: line.supplierId || po.supplierId || supplierIdFor(po.supplier),
    warehouseId:
      line.warehouseId || po.warehouseId || warehouseIdFor(po.warehouse),
    requiredDate: line.requiredDate || po.requiredDate || po.eta || "",
    promisedDate: line.promisedDate || po.promisedDate || po.eta || "",
    status: line.status || "",
  };
  normalized.status = lineStatusFromQuantities(normalized);
  return normalized;
}

function ensurePoLines(po) {
  const rawLines =
    Array.isArray(po.lines) && po.lines.length > 0
      ? po.lines
      : [
          {
            poLineId: makePoLineId(po.po || po.poId || "", 0),
            sku: po.sourceSku || "",
            itemName: po.sourceName || po.reason || `${po.po || "PO"} 汇总行`,
            quantityOrdered: toNumber(po.recommendedQty || po.items || 1, 1),
            quantityReceived: toNumber(po.received || 0),
            quantityAccepted: toNumber(po.accepted || po.received || 0),
            quantityRejected: toNumber(po.rejected || 0),
            unit: po.unit || "",
            unitPrice: toNumber(
              po.unitPrice ||
                (toNumber(po.amount) && toNumber(po.recommendedQty)
                  ? toNumber(po.amount) / toNumber(po.recommendedQty)
                  : 0),
            ),
            currency: po.currency || "CNY",
          },
        ];
  po.lines = rawLines.map((line, index) => normalizePoLine(line, po, index));
  return po.lines;
}

function calculatePoHeaderFromLines(po) {
  const lines = ensurePoLines(po);
  const quantityOrdered = lines.reduce(
    (sum, line) => sum + toNumber(line.quantityOrdered),
    0,
  );
  const quantityReceived = lines.reduce(
    (sum, line) => sum + toNumber(line.quantityReceived),
    0,
  );
  const quantityAccepted = lines.reduce(
    (sum, line) => sum + toNumber(line.quantityAccepted),
    0,
  );
  const quantityRejected = lines.reduce(
    (sum, line) => sum + toNumber(line.quantityRejected),
    0,
  );
  const amount = lines.reduce(
    (sum, line) =>
      sum + toNumber(line.quantityOrdered) * toNumber(line.unitPrice),
    0,
  );
  po.lineCount = lines.length;
  po.totalOrderedQty = quantityOrdered;
  po.totalReceivedQty = quantityReceived;
  po.totalAcceptedQty = quantityAccepted;
  po.totalRejectedQty = quantityRejected;
  po.totalAmount = amount;
  po.itemsMeaning = "totalOrderedQty";
  po.items = quantityOrdered;
  po.received = quantityReceived;
  po.amount = amount;
  po.sourceSku = po.sourceSku || lines.find((line) => line.sku)?.sku || "";
  po.sourceName =
    po.sourceName || lines.find((line) => line.itemName)?.itemName || "";
  po.recommendedQty = po.recommendedQty || quantityOrdered;
  po.unit = po.unit || lines.find((line) => line.unit)?.unit || "";
  po.unitPrice = po.unitPrice || toNumber(lines[0]?.unitPrice || 0);
  return po;
}

function headerStatusFromLines(po) {
  const lines = ensurePoLines(po);
  if (lines.length === 0)
    return { status: po.status || "待审批", erpStatus: "open" };
  const anyReceived = lines.some((line) => toNumber(line.quantityReceived) > 0);
  const allCompleted = lines.every((line) =>
    ["received", "closed"].includes(line.status),
  );
  const anyRejected = lines.some((line) => toNumber(line.quantityRejected) > 0);
  if (allCompleted)
    return { status: "已完成", erpStatus: anyRejected ? "closed" : "received" };
  if (anyReceived)
    return { status: "部分到货", erpStatus: "partially_received" };
  return { status: po.status || "待审批", erpStatus: po.erpStatus || "open" };
}

function normalizePurchaseOrder(po) {
  if (!po || typeof po !== "object") return po;
  ensurePoLines(po);
  calculatePoHeaderFromLines(po);
  if (!po.erpStatus) po.erpStatus = headerStatusFromLines(po).erpStatus;
  return po;
}

function normalizePurchaseOrders(db) {
  if (!Array.isArray(db.purchaseOrders)) db.purchaseOrders = [];
  db.purchaseOrders = db.purchaseOrders.map((po) => normalizePurchaseOrder(po));
  return db.purchaseOrders;
}

function createPoLineFromRequest(request, poId, index = 0) {
  return normalizePoLine(
    {
      poLineId: makePoLineId(poId, index),
      poId,
      sku: request.sourceSku || request.sku || "",
      itemName: request.sourceName || request.itemName || request.name || "",
      quantityOrdered: toNumber(
        request.quantity || request.recommendedQty || 0,
      ),
      quantityReceived: 0,
      quantityAccepted: 0,
      quantityRejected: 0,
      unit: request.unit || "",
      unitPrice: toNumber(request.unitPrice || 0),
      currency: request.currency || "CNY",
      supplierId: request.supplierId || supplierIdFor(request.supplier),
      warehouseId: request.warehouseId || "",
      requiredDate: request.requiredDate || request.eta || "",
      promisedDate:
        request.promisedDate || request.requiredDate || request.eta || "",
      status: "open",
    },
    { po: poId, supplier: request.supplier },
    index,
  );
}

function createPoLineFromRfq(rfq, request, poId, index = 0) {
  const quantity = toNumber(rfq.quantity || request?.quantity || 1, 1);
  const unitPrice = toNumber(rfq.bestPrice || request?.unitPrice || 0);
  return normalizePoLine(
    {
      poLineId: makePoLineId(poId, index),
      poId,
      sku: rfq.sourceSku || request?.sourceSku || "",
      itemName: rfq.sourceName || request?.sourceName || rfq.title || "",
      quantityOrdered: quantity,
      quantityReceived: 0,
      quantityAccepted: 0,
      quantityRejected: 0,
      unit: rfq.unit || request?.unit || "",
      unitPrice,
      currency: rfq.currency || request?.currency || "CNY",
      supplierId: supplierIdFor(rfq.bestSupplier || request?.supplier || ""),
      warehouseId: rfq.warehouseId || request?.warehouseId || "",
      requiredDate: request?.requiredDate || rfq.due || "",
      promisedDate: rfq.promisedDate || rfq.due || request?.requiredDate || "",
      status: "open",
    },
    { po: poId, supplier: rfq.bestSupplier || request?.supplier || "" },
    index,
  );
}

function normalizeGrnLine(line, grn, po, index = 0, options = {}) {
  const poLines = ensurePoLines(po);
  const fallbackBySku = line.sku
    ? poLines.find((poLine) => poLine.sku && poLine.sku === line.sku)
    : null;
  const fallbackLine =
    poLines.find((poLine) => poLine.poLineId === line.poLineId) ||
    fallbackBySku ||
    poLines[index] ||
    poLines[0] ||
    {};
  const acceptedQty = toNumber(
    line.acceptedQty ?? line.passed ?? line.accepted ?? 0,
  );
  const rejectedQty = toNumber(
    line.rejectedQty ?? line.failed ?? line.rejected ?? 0,
  );
  const explicitReceived =
    line.receivedQty ?? line.items ?? line.quantityReceived;
  const receivedQty = toNumber(
    explicitReceived ??
      (acceptedQty + rejectedQty ||
        grn.items ||
        fallbackLine.quantityOrdered ||
        0),
  );
  const terminal = postedReceivingStatuses.has(grn.status);
  const assumeApplied = Boolean(options.assumeApplied && terminal);
  return {
    grnLineId:
      line.grnLineId || `${grn.grn}-L${String(index + 1).padStart(3, "0")}`,
    grnId: grn.grn,
    poId: grn.po,
    poLineId: line.poLineId || fallbackLine.poLineId || "",
    sku: line.sku || fallbackLine.sku || "",
    itemName: line.itemName || line.name || fallbackLine.itemName || "",
    receivedQty,
    acceptedQty,
    rejectedQty,
    unit: line.unit || fallbackLine.unit || "",
    warehouseId:
      line.warehouseId ||
      warehouseIdFor(
        line.warehouse || grn.warehouse || fallbackLine.warehouseId || "",
      ),
    qualityStatus:
      line.qualityStatus ||
      (rejectedQty > 0 ? "rejected" : acceptedQty > 0 ? "accepted" : "pending"),
    inspectionResult: line.inspectionResult || line.reason || "",
    appliedReceivedQty: toNumber(
      line.appliedReceivedQty ?? (assumeApplied ? receivedQty : 0),
    ),
    appliedAcceptedQty: toNumber(
      line.appliedAcceptedQty ?? (assumeApplied ? acceptedQty : 0),
    ),
    appliedRejectedQty: toNumber(
      line.appliedRejectedQty ?? (assumeApplied ? rejectedQty : 0),
    ),
  };
}

function normalizeGrnLines(grn, po, options = {}) {
  const rawLines =
    Array.isArray(grn.lines) && grn.lines.length > 0
      ? grn.lines
      : [
          {
            poLineId: grn.poLineId || "",
            sku: grn.sku || po?.sourceSku || "",
            itemName: grn.sourceName || po?.sourceName || "",
            receivedQty:
              postedReceivingStatuses.has(grn.status) &&
              toNumber(grn.passed || 0) + toNumber(grn.failed || 0) > 0
                ? toNumber(grn.passed || 0) + toNumber(grn.failed || 0)
                : toNumber(grn.items || po?.items || 0),
            acceptedQty: toNumber(grn.passed || 0),
            rejectedQty: toNumber(grn.failed || 0),
            unit: grn.unit || po?.unit || "",
            warehouseId: warehouseIdFor(grn.warehouse || po?.warehouseId || ""),
          },
        ];
  grn.lines = rawLines.map((line, index) =>
    normalizeGrnLine(line, grn, po, index, options),
  );
  grn.items = grn.lines.reduce(
    (sum, line) => sum + toNumber(line.receivedQty),
    0,
  );
  grn.passed = grn.lines.reduce(
    (sum, line) => sum + toNumber(line.acceptedQty),
    0,
  );
  grn.failed = grn.lines.reduce(
    (sum, line) => sum + toNumber(line.rejectedQty),
    0,
  );
  return grn.lines;
}

function validateReceivingAgainstPoLines(grnLines, poLines, options = {}) {
  const errors = [];
  const warnings = [];
  const allowOverReceipt = Boolean(options.allowOverReceipt);
  for (const line of grnLines) {
    const receivedQty = toNumber(line.receivedQty);
    const acceptedQty = toNumber(line.acceptedQty);
    const rejectedQty = toNumber(line.rejectedQty);
    if (receivedQty < 0 || acceptedQty < 0 || rejectedQty < 0)
      errors.push(`${line.grnLineId} has negative quantity`);
    if (acceptedQty > receivedQty)
      errors.push(`${line.grnLineId} acceptedQty cannot exceed receivedQty`);
    if (rejectedQty > receivedQty)
      errors.push(`${line.grnLineId} rejectedQty cannot exceed receivedQty`);
    if (acceptedQty + rejectedQty !== receivedQty)
      errors.push(
        `${line.grnLineId} acceptedQty + rejectedQty must equal receivedQty`,
      );
    const poLine = poLines.find((item) => item.poLineId === line.poLineId);
    if (!poLine) {
      errors.push(`${line.grnLineId} does not match a PO line`);
      continue;
    }
    const deltaReceived = receivedQty - toNumber(line.appliedReceivedQty);
    const cumulativeReceived =
      toNumber(poLine.quantityReceived) + deltaReceived;
    if (cumulativeReceived > toNumber(poLine.quantityOrdered)) {
      const message = `${line.grnLineId} would over-receive ${poLine.poLineId}: ${cumulativeReceived}/${poLine.quantityOrdered}`;
      if (allowOverReceipt) warnings.push(message);
      else errors.push(message);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function postedGrnProtectedChangeError(grn, body, po) {
  if (!postedReceivingStatuses.has(grn.status)) return "";
  if (body.status !== undefined && body.status !== grn.status) {
    return `GRN ${grn.grn} is already posted; status cannot be changed without a reversal`;
  }
  normalizeGrnLines(grn, po, { assumeApplied: true });
  const protectedHeaderFields = [
    "passed",
    "failed",
    "items",
    "sku",
    "poLineId",
    "warehouse",
    "warehouseId",
  ];
  for (const field of protectedHeaderFields) {
    if (body[field] !== undefined) {
      const currentValue =
        field === "warehouseId"
          ? warehouseIdFor(grn.warehouse || grn.warehouseId || "")
          : grn[field];
      const nextValue =
        field === "warehouseId"
          ? warehouseIdFor(body[field] || "")
          : body[field];
      if (String(currentValue ?? "") !== String(nextValue ?? "")) {
        return `GRN ${grn.grn} is already posted; ${field} cannot be changed without a reversal`;
      }
    }
  }
  if (!Array.isArray(body.lines)) return "";
  if (body.lines.length !== grn.lines.length) {
    return `GRN ${grn.grn} is already posted; receiving lines cannot be added or removed without a reversal`;
  }
  const incoming = body.lines.map((line, index) =>
    normalizeGrnLine(line, grn, po, index, { assumeApplied: true }),
  );
  const protectedLineFields = [
    "poLineId",
    "sku",
    "receivedQty",
    "acceptedQty",
    "rejectedQty",
    "warehouseId",
  ];
  for (let index = 0; index < incoming.length; index += 1) {
    const current = grn.lines[index];
    const next = incoming[index];
    for (const field of protectedLineFields) {
      if (String(current?.[field] ?? "") !== String(next?.[field] ?? "")) {
        return `GRN ${grn.grn} is already posted; ${field} cannot be changed without a reversal`;
      }
    }
  }
  return "";
}

function applyReceivingToPoAndInventory(db, grn, po, options = {}) {
  normalizePurchaseOrder(po);
  normalizeGrnLines(grn, po, { assumeApplied: false });
  if (!postedReceivingStatuses.has(grn.status)) return { warnings: [] };
  if (grn.inventoryApplied) {
    grn.inventoryMovementIds = Array.isArray(grn.inventoryMovementIds)
      ? grn.inventoryMovementIds
      : [];
    return { warnings: grn.warnings || [] };
  }

  const validation = validateReceivingAgainstPoLines(
    grn.lines,
    po.lines,
    options,
  );
  if (!validation.ok) {
    const error = new Error(validation.errors.join("; "));
    error.status = 400;
    throw error;
  }

  grn.inventoryMovementIds = Array.isArray(grn.inventoryMovementIds)
    ? grn.inventoryMovementIds
    : [];
  for (const grnLine of grn.lines) {
    const poLine = po.lines.find((line) => line.poLineId === grnLine.poLineId);
    if (!poLine) continue;
    const receivedDelta =
      toNumber(grnLine.receivedQty) - toNumber(grnLine.appliedReceivedQty);
    const acceptedDelta =
      toNumber(grnLine.acceptedQty) - toNumber(grnLine.appliedAcceptedQty);
    const rejectedDelta =
      toNumber(grnLine.rejectedQty) - toNumber(grnLine.appliedRejectedQty);
    poLine.quantityReceived = Math.max(
      0,
      toNumber(poLine.quantityReceived) + receivedDelta,
    );
    poLine.quantityAccepted = Math.max(
      0,
      toNumber(poLine.quantityAccepted) + acceptedDelta,
    );
    poLine.quantityRejected = Math.max(
      0,
      toNumber(poLine.quantityRejected) + rejectedDelta,
    );
    poLine.status = lineStatusFromQuantities(poLine);
    if (!poLine.warehouseId && grnLine.warehouseId)
      poLine.warehouseId = grnLine.warehouseId;

    if (acceptedDelta !== 0 && grnLine.sku) {
      const product = (db.products || []).find(
        (item) => item.sku === grnLine.sku,
      );
      if (product)
        product.currentStock = Math.max(
          0,
          toNumber(product.currentStock) + acceptedDelta,
        );
      const movement = recordInventoryMovement(db, {
        type: acceptedDelta >= 0 ? "入库" : "库存调整",
        sourceType: "GRN",
        sourceId: grn.grn,
        grnId: grn.grn,
        poId: po.po,
        poLineId: poLine.poLineId,
        sku: grnLine.sku,
        name: grnLine.itemName || poLine.itemName,
        quantity: acceptedDelta,
        qty: acceptedDelta,
        ref: grn.grn,
        po: po.po,
        from: grn.supplier,
        to: grnLine.warehouseId || grn.warehouse || "—",
        warehouseId: grnLine.warehouseId || warehouseIdFor(grn.warehouse || ""),
        operator: grn.receiver || "刘建华",
        reason: grnLine.rejectedQty > 0 ? "质检部分合格入库" : "质检合格入库",
        status: grn.status,
      });
      grn.inventoryMovementIds.push(movement.movementId);
    }

    grnLine.appliedReceivedQty = grnLine.receivedQty;
    grnLine.appliedAcceptedQty = grnLine.acceptedQty;
    grnLine.appliedRejectedQty = grnLine.rejectedQty;
  }

  calculatePoHeaderFromLines(po);
  const header = headerStatusFromLines(po);
  if (po.status !== header.status) {
    applyWorkflowTransition(db, "purchaseOrder", po, header.status, {
      action: "purchase_order_receiving_status",
      actor: options.postedBy || grn.receiver || "system",
      source: "receiving",
      reason: `GRN ${grn.grn} posted receiving quantities`,
      metadata: {
        grnId: grn.grn,
        poId: po.po,
        acceptedQty: grn.lines.reduce(
          (sum, line) => sum + toNumber(line.acceptedQty),
          0,
        ),
        rejectedQty: grn.lines.reduce(
          (sum, line) => sum + toNumber(line.rejectedQty),
          0,
        ),
      },
    });
  }
  po.erpStatus = header.erpStatus;
  grn.postedAt = grn.postedAt || new Date().toISOString();
  grn.postedBy = grn.postedBy || options.postedBy || grn.receiver || "system";
  grn.inventoryApplied = true;
  grn.warnings = validation.warnings;
  const inventoryAudit = createAuditLogEntry(db, {
    entityType: "receivingDoc",
    entityId: grn.grn,
    fromStatus: grn.status,
    toStatus: grn.status,
    action: "inventory_posted",
    actor: grn.postedBy,
    source: "system",
    reason: `Accepted quantity posted to inventory for ${grn.grn}`,
    metadata: {
      poId: po.po,
      movementIds: grn.inventoryMovementIds,
      acceptedQty: grn.lines.reduce(
        (sum, line) => sum + toNumber(line.acceptedQty),
        0,
      ),
      rejectedQty: grn.lines.reduce(
        (sum, line) => sum + toNumber(line.rejectedQty),
        0,
      ),
    },
  });
  appendEntityAudit(grn, inventoryAudit);
  return { warnings: validation.warnings };
}

function supplierFlag(score, rejectRate) {
  if (score >= 92 && rejectRate <= 2) return "战略";
  if (score >= 84 && rejectRate <= 5) return "核心";
  if (score >= 74 && rejectRate <= 12) return "备选";
  return "整改";
}

function supplierPerformance(db) {
  return Array.isArray(db.suppliers) ? db.suppliers : [];
}

function supplierRecommendations() {
  return null;
}
export function createScmServer({ readinessCheck = checkRuntimeReadiness } = {}) {
  validateProductionRuntimeConfig(process.env);
  validateDatabasePersistenceConfig(process.env);
  const localSessions = new Map();
  const localSessionSecret = createLocalSessionSecret(process.env);
  const handleRequest = createHttpRequestHandler({
    port,
    distDir,
    buildIdentity,
    readinessCheck,
    localSessions,
    localSessionSecret,
    domain: {
      event,
      todayLabel,
      ensurePurchaseRequests,
      systemRequestSources,
      nextSequenceId,
      purchaseRequestStatuses,
      priorities,
      recordWorkflowCreation,
      actorFromBody,
      applyWorkflowTransition,
      recordValidationBlocked,
      createPoLineFromRequest,
      normalizePurchaseOrder,
      normalizePurchaseOrders,
      normalizePoLine,
      calculatePoHeaderFromLines,
      ensureRfqs,
      workflowDefinitions,
      createPoLineFromRfq,
      postedReceivingStatuses,
      normalizeGrnLines,
      applyReceivingToPoAndInventory,
      postedGrnProtectedChangeError,
      warehouseIdFor,
      toNumber,
      ensureInventoryMovements,
      ensureSopCycles,
      supplierPerformance,
      supplierRecommendations,
      ensureEvents,
      ensureAuditLog,
    },
    runtime: {
      openaiDispatcher,
      arkDispatcher,
      aiMaxTokens,
      supplierQuoteCount: 0,
    },
    env: process.env,
  });
  return http.createServer(withServerErrorBoundary(handleRequest));
}

export function startScmServer(listenPort = port, options = {}) {
  const logger = options.logger || console;
  const server = createScmServer({
    readinessCheck: options.readinessCheck || checkRuntimeReadiness,
  });
  const lifecycle = createServerLifecycle({
    server,
    logger,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  const unregisterSignals = registerShutdownSignals({ lifecycle, logger });
  server.lifecycle = lifecycle;
  server.shutdown = async (reason = "manual") => {
    try {
      await lifecycle.shutdown(reason);
    } finally {
      unregisterSignals();
    }
  };
  server.listen(listenPort, () => {
    logger.info?.(`FlowChain listening on http://127.0.0.1:${listenPort}`);
  });
  return server;
}
