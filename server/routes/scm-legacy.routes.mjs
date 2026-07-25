import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";
import { execFileSync } from "node:child_process";
import { loadEnv } from "../config/env.mjs";
import {
  createRepositoryRegistry,
  getPersistenceMode,
} from "../repositories/adapter-registry.mjs";
import { validateDatabasePersistenceConfig } from "../persistence/persistence-config.mjs";
import { contentTypeFor, readBody, send, sendText } from "../utils/http.mjs";
import { sendInternalServerError } from "../utils/safe-errors.mjs";
import {
  createLocalSession,
  createLocalSessionSecret,
  issueLocalSessionToken,
  resolveRequestIdentity,
} from "../domain/local-signed-session.mjs";
import {
  legacyMutationBlockedAuditEntry,
  recordDatabaseAuditBestEffort,
} from "../domain/audit-policy.mjs";
import {
  createEmptyDataset,
} from "../domain/data-mode.mjs";
import {
  isDatabaseModeWriteBlocked,
  sendDatabaseModeMutationBlocked,
} from "../domain/route-classification.mjs";
import { handlePurchaseOrdersRoute } from "./purchase-orders.routes.mjs";
import { handlePurchaseRequestsRoute } from "./purchase-requests.routes.mjs";
import { handleReceivingRoute } from "./receiving.routes.mjs";
import { handleOutboundRoute } from "./outbound.routes.mjs";
import { handleSalesOrderWorkbenchRoute } from "./sales-order-workbench.routes.mjs";
import { handlePilotWorkspaceRoute } from "./pilot-workspace.routes.mjs";
import { handlePilotImportRoute } from "./pilot-import.routes.mjs";
import { handlePilotOperationsRoute } from "./pilot-operations.routes.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { roleLabel } from "../../shared/roles.mjs";
import { handleRfqsRoute } from "./rfqs.routes.mjs";
import { handleInventoryRoute } from "./inventory.routes.mjs";
import { handleInventoryOperationsRoute } from "./inventory-operations.routes.mjs";
import { handleReturnsRoute } from "./returns.routes.mjs";
import { handleOperationalFinanceRoute } from "./operational-finance.routes.mjs";
import { handleBankReconciliationRoute } from "./bank-reconciliation.routes.mjs";
import { handleMobileSyncRoute } from "./mobile-sync.routes.mjs";
import { handleAttachmentRoute } from "./attachments.routes.mjs";
import { handleMobileOperationsRoute } from "./mobile-operations.routes.mjs";
import { handleInventoryMovementsRoute } from "./inventory-movements.routes.mjs";
import { handleProcurementReadRoute } from "./procurement-read.routes.mjs";
import { handleTodayCockpitRoute } from "./today-cockpit.routes.mjs";
import { handleSupplierPerformanceRoute } from "./supplier-performance.routes.mjs";
import { handleSupplierRecommendationsRoute } from "./supplier-recommendations.routes.mjs";
import { handleAuditLogRoute } from "./audit-log.routes.mjs";
import { handleContextRoute } from "./context.routes.mjs";
import { handleMasterDataRoute } from "./master-data.routes.mjs";
import { handleCapabilitiesRoute } from "./capabilities.routes.mjs";
import { handleBusinessReadContextRoute } from "./business-read-context.routes.mjs";
import { handleSearchRoute } from "./search.routes.mjs";
import { handleSalesDemandRoute } from "./sales-demand.routes.mjs";
import { handleEvidenceGraphRoute } from "./evidence-graph.routes.mjs";
import { handleDataAccessQualityRoute } from "./data-access-quality.routes.mjs";
import { handleReportsAnalyticsRoute } from "./reports-analytics.routes.mjs";
import { handleImportPersistenceRoute } from "./import-persistence.routes.mjs";
import { handleReportViewsRoute } from "./report-views.routes.mjs";
import { handleReviewFirstActionWorkflowRoute } from "./review-first-action-workflow.routes.mjs";
import { handleAiSuggestionsWorkbenchRoute } from "./ai-suggestions-workbench.routes.mjs";
import { handleCollaborationNotificationDraftsRoute } from "./collaboration-notification-drafts.routes.mjs";
import { handleWorkspaceSetupConfigRoute } from "./workspace-setup-config.routes.mjs";
import { handleSettingsRuntimeRoute } from "./settings-runtime.routes.mjs";
import { handleUserRolePermissionVisibilityRoute } from "./user-role-permission-visibility.routes.mjs";
import { handleAuthorizationRoute } from "./authorization.routes.mjs";
import { handleWorkspaceBoundaryVisibilityRoute } from "./workspace-boundary-visibility.routes.mjs";
import { handleAuditIntegrationHistoryRoute } from "./audit-integration-history.routes.mjs";
import { handlePilotReadinessGovernanceRoute } from "./pilot-readiness-governance.routes.mjs";
import { handleAiRuntimeGatewayRoute } from "./ai-runtime-gateway.routes.mjs";
import { handleAiRuntimeObservabilityRoute } from "./ai-runtime-observability.routes.mjs";
import { handleMrpRoute } from "./mrp.routes.mjs";
import { handleSopRoute } from "./sop.routes.mjs";
import { handleActionDraftsRoute } from "./action-drafts.routes.mjs";
import { handleUserConfirmedActionsRoute } from "./user-confirmed-actions.routes.mjs";
import { handleProcurementWorkflowRoute } from "./procurement-workflow.routes.mjs";
import { handleExceptionCasesRoute } from "./exception-cases.routes.mjs";
import { handleUserDataRoute } from "./user-data.routes.mjs";
import { handleMarketRoute } from "./market.routes.mjs";
import { handleAiRoute } from "./ai.routes.mjs";
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
const staticAssetPath = (pathname) =>
  pathname.startsWith("/assets/") ||
  /\.(?:js|css|map|json|png|jpe?g|svg|webp|ico|woff2?|ttf)$/i.test(pathname);

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
const webProxyUrl =
  process.env.WEB_PROXY_URL ||
  process.env.OPENAI_PROXY_URL ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  "http://127.0.0.1:15236";
const webDispatcher = webProxyUrl ? new ProxyAgent(webProxyUrl) : undefined;
const aiMaxTokens = Number(process.env.AI_MAX_TOKENS || 520);

async function sendStatic(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method))
    return send(res, 404, { error: "Not found" });
  const decodedPath = decodeURIComponent(url.pathname);
  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, normalized);
  if (!filePath.startsWith(distDir)) return sendText(res, 403, "Forbidden");

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    if (staticAssetPath(decodedPath)) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(req.method === "HEAD" ? undefined : "Not found");
    }
    filePath = path.join(distDir, "index.html");
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") return res.end();
    return res.end(body);
  } catch {
    return sendText(res, 404, "Not found");
  }
}

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

const defaultRfqs = [
  {
    id: "RFQ-26-0042",
    title: "Q3 铝合金型材集采",
    category: "原材料",
    suppliers: 6,
    quoted: 5,
    bestPrice: 18.6,
    bestSupplier: "江苏铝合金集团",
    due: "2026-06-10",
    status: "比价中",
  },
  {
    id: "RFQ-26-0043",
    title: "标准紧固件年框",
    category: "通用件",
    suppliers: 8,
    quoted: 8,
    bestPrice: 0.42,
    bestSupplier: "佛山标准件",
    due: "2026-05-30",
    status: "已授标",
  },
  {
    id: "RFQ-26-0044",
    title: "PCB 板代工",
    category: "电子",
    suppliers: 4,
    quoted: 3,
    bestPrice: 86.4,
    bestSupplier: "深圳新元电气",
    due: "2026-06-15",
    status: "进行中",
  },
  {
    id: "RFQ-26-0045",
    title: "切削液 12 个月供货",
    category: "耗材",
    suppliers: 5,
    quoted: 4,
    bestPrice: 24.8,
    bestSupplier: "广州化工耗材",
    due: "2026-06-08",
    status: "比价中",
  },
  {
    id: "RFQ-26-0046",
    title: "高精度数控刀具",
    category: "工具",
    suppliers: 3,
    quoted: 2,
    bestPrice: 312,
    bestSupplier: "华东精工机械",
    due: "2026-06-22",
    status: "进行中",
  },
];

function ensureRfqs(db) {
  if (!Array.isArray(db.rfqs)) db.rfqs = defaultRfqs;
  return db.rfqs;
}

function publicUser(user) {
  if (!user) return null;
  const { token, ...safeUser } = user;
  return safeUser;
}

function normalizeLogin(body) {
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const name = String(body.name || "").trim();
  const company = String(body.company || "").trim();
  if (!email || !name || !company) {
    throw new Error("company, name and email are required");
  }
  return { email, name, company };
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
  const purchaseOrders = normalizePurchaseOrders(db);
  const receivingDocs = db.receivingDocs || [];
  const suppliers = new Map();

  for (const item of db.suppliers || []) {
    suppliers.set(item.name, {
      name: item.name,
      category: item.category || "未分类",
      onTime: Number(item.onTimeRate || 0),
      quality: Number(item.qualityRate || 0),
      risk: item.risk || "中",
      po: 0,
      spend: 0,
      received: 0,
      passed: 0,
      failed: 0,
      exceptions: 0,
      lastIssue: "",
    });
  }

  for (const po of purchaseOrders) {
    if (!po.supplier) continue;
    if (!suppliers.has(po.supplier)) {
      suppliers.set(po.supplier, {
        name: po.supplier,
        category: "采购供应商",
        onTime: 90,
        quality: 96,
        risk: "中",
        po: 0,
        spend: 0,
        received: 0,
        passed: 0,
        failed: 0,
        exceptions: 0,
        lastIssue: "",
      });
    }
    const row = suppliers.get(po.supplier);
    row.po += 1;
    row.spend += Number(po.amount || 0);
  }

  for (const grn of receivingDocs) {
    if (!grn.supplier) continue;
    if (!suppliers.has(grn.supplier)) {
      suppliers.set(grn.supplier, {
        name: grn.supplier,
        category: "收货供应商",
        onTime: 90,
        quality: 96,
        risk: "中",
        po: 0,
        spend: 0,
        received: 0,
        passed: 0,
        failed: 0,
        exceptions: 0,
        lastIssue: "",
      });
    }
    const row = suppliers.get(grn.supplier);
    const po = purchaseOrders.find((item) => item.po === grn.po);
    const lines = po
      ? normalizeGrnLines(grn, po, {
          assumeApplied: postedReceivingStatuses.has(grn.status),
        })
      : [];
    const passed = lines.length
      ? lines.reduce((sum, line) => sum + Number(line.acceptedQty || 0), 0)
      : Number(grn.passed || 0);
    const failed = lines.length
      ? lines.reduce((sum, line) => sum + Number(line.rejectedQty || 0), 0)
      : Number(grn.failed || 0);
    row.received += passed + failed;
    row.passed += passed;
    row.failed += failed;
    if (failed > 0 || grn.status === "异常处理") {
      row.exceptions += 1;
      row.lastIssue = `${grn.grn} ${failed > 0 ? `不合格 ${failed}` : "异常处理"}`;
    }
  }

  return Array.from(suppliers.values())
    .map((row) => {
      const inspectionQuality =
        row.received > 0 ? (row.passed / row.received) * 100 : row.quality;
      const blendedQuality =
        row.received > 0
          ? row.quality * 0.45 + inspectionQuality * 0.55
          : row.quality;
      const rejectRate =
        row.received > 0 ? (row.failed / row.received) * 100 : 0;
      const riskPenalty = row.risk === "高" ? 8 : row.risk === "中" ? 3 : 0;
      const exceptionPenalty = Math.min(
        14,
        row.exceptions * 3 + rejectRate * 0.35,
      );
      const score = Math.max(
        0,
        Math.round(
          row.onTime * 0.34 +
            blendedQuality * 0.46 +
            Math.min(100, row.po * 2 + 70) * 0.2 -
            riskPenalty -
            exceptionPenalty,
        ),
      );
      const rating = Math.max(1, Math.min(5, Number((score / 20).toFixed(1))));
      return {
        ...row,
        onTime: Number(row.onTime.toFixed(1)),
        quality: Number(blendedQuality.toFixed(1)),
        rejectRate: Number(rejectRate.toFixed(1)),
        score,
        rating,
        flag: supplierFlag(score, rejectRate),
      };
    })
    .sort((a, b) => b.score - a.score);
}

const supplierQuotes = {
  "SKU-00412": [
    {
      supplier: "深圳新元电气",
      unitPrice: 2980,
      currency: "CNY",
      leadTimeDays: 7,
      responseScore: 92,
      capacity: 800,
      risk: "中",
      contractId: "BPA-26-ELEC",
    },
    {
      supplier: "上海仪表科技",
      unitPrice: 450,
      currency: "USD",
      leadTimeDays: 10,
      responseScore: 84,
      capacity: 260,
      risk: "低",
      contractId: "BPA-26-METER",
    },
    {
      supplier: "华东精工机械",
      unitPrice: 3380,
      currency: "CNY",
      leadTimeDays: 12,
      responseScore: 78,
      capacity: 180,
      risk: "中",
    },
  ],
  "SKU-00623": [
    {
      supplier: "深圳新元电气",
      unitPrice: 12400,
      currency: "CNY",
      leadTimeDays: 9,
      responseScore: 92,
      capacity: 420,
      risk: "中",
      contractId: "BPA-26-ELEC",
    },
    {
      supplier: "上海仪表科技",
      unitPrice: 1830,
      currency: "USD",
      leadTimeDays: 11,
      responseScore: 86,
      capacity: 160,
      risk: "低",
      contractId: "BPA-26-METER",
    },
  ],
  "SKU-00287": [
    {
      supplier: "江苏铝合金集团",
      unitPrice: 142,
      currency: "CNY",
      leadTimeDays: 12,
      responseScore: 88,
      capacity: 3200,
      risk: "低",
      contractId: "BPA-26-ALU",
    },
    {
      supplier: "华东精工机械",
      unitPrice: 151,
      currency: "CNY",
      leadTimeDays: 14,
      responseScore: 82,
      capacity: 900,
      risk: "中",
    },
  ],
  "SKU-00142": [
    {
      supplier: "华东精工机械",
      unitPrice: 86,
      currency: "CNY",
      leadTimeDays: 9,
      responseScore: 82,
      capacity: 5000,
      risk: "低",
    },
    {
      supplier: "佛山标准件",
      unitPrice: 89,
      currency: "CNY",
      leadTimeDays: 7,
      responseScore: 90,
      capacity: 4200,
      risk: "中",
      contractId: "BPA-26-FASTENER",
    },
  ],
  "SKU-00815": [
    {
      supplier: "华东精工机械",
      unitPrice: 4600,
      currency: "CNY",
      leadTimeDays: 14,
      responseScore: 82,
      capacity: 220,
      risk: "低",
    },
    {
      supplier: "上海仪表科技",
      unitPrice: 675,
      currency: "USD",
      leadTimeDays: 16,
      responseScore: 84,
      capacity: 120,
      risk: "低",
      contractId: "BPA-26-METER",
    },
  ],
  "SKU-00744": [
    {
      supplier: "广州化工耗材",
      unitPrice: 320,
      currency: "CNY",
      leadTimeDays: 8,
      responseScore: 76,
      capacity: 2000,
      risk: "高",
      contractId: "BPA-25-CHEM",
    },
    {
      supplier: "佛山标准件",
      unitPrice: 356,
      currency: "CNY",
      leadTimeDays: 10,
      responseScore: 90,
      capacity: 900,
      risk: "中",
    },
  ],
};

const exchangeRatesToCny = { CNY: 1, USD: 7.18, EUR: 7.78 };

const contractPriceRules = {
  "BPA-26-ELEC": {
    label: "电子件年框",
    tiers: [
      { minQty: 0, discount: 0.06 },
      { minQty: 200, discount: 0.1 },
      { minQty: 500, discount: 0.14 },
    ],
  },
  "BPA-26-METER": {
    label: "仪表进口框架",
    tiers: [
      { minQty: 0, discount: 0.04 },
      { minQty: 100, discount: 0.08 },
      { minQty: 300, discount: 0.12 },
    ],
  },
  "BPA-26-ALU": {
    label: "铝型材阶梯价",
    tiers: [
      { minQty: 0, discount: 0.03 },
      { minQty: 1000, discount: 0.08 },
      { minQty: 2500, discount: 0.12 },
    ],
  },
  "BPA-26-FASTENER": {
    label: "紧固件年框",
    tiers: [
      { minQty: 0, discount: 0.08 },
      { minQty: 2000, discount: 0.16 },
      { minQty: 5000, discount: 0.22 },
    ],
  },
  "BPA-25-CHEM": {
    label: "化工耗材临期合同",
    tiers: [
      { minQty: 0, discount: 0.02 },
      { minQty: 1000, discount: 0.05 },
    ],
  },
};

const supplierCapacityCalendar = {
  深圳新元电气: {
    nextWindow: "2026-W25",
    available: 620,
    committed: 280,
    reliability: 0.94,
  },
  上海仪表科技: {
    nextWindow: "2026-W25",
    available: 180,
    committed: 90,
    reliability: 0.9,
  },
  华东精工机械: {
    nextWindow: "2026-W25",
    available: 720,
    committed: 410,
    reliability: 0.86,
  },
  江苏铝合金集团: {
    nextWindow: "2026-W26",
    available: 2800,
    committed: 1300,
    reliability: 0.92,
  },
  佛山标准件: {
    nextWindow: "2026-W25",
    available: 3600,
    committed: 1800,
    reliability: 0.88,
  },
  广州化工耗材: {
    nextWindow: "2026-W25",
    available: 1200,
    committed: 900,
    reliability: 0.72,
  },
};

function applyContractAndCurrency(quote, qty) {
  const currency = quote.currency || "CNY";
  const fxRate = exchangeRatesToCny[currency] || 1;
  const listPriceCny = Number(quote.unitPrice || 0) * fxRate;
  const contract = quote.contractId
    ? contractPriceRules[quote.contractId]
    : null;
  const tier =
    contract?.tiers
      ?.filter((item) => qty >= Number(item.minQty || 0))
      .sort((a, b) => Number(b.minQty || 0) - Number(a.minQty || 0))[0] || null;
  const discount = Number(tier?.discount || 0);
  const unitPriceCny = Number((listPriceCny * (1 - discount)).toFixed(2));
  return {
    currency,
    fxRate,
    listPriceCny: Number(listPriceCny.toFixed(2)),
    unitPriceCny,
    contractId: quote.contractId || "",
    contractLabel: contract?.label || "",
    contractDiscount: discount,
    contractTierMinQty: Number(tier?.minQty || 0),
  };
}

function supplierRecommendations(
  db,
  { sku = "", quantity = 0, currentSupplier = "" } = {},
) {
  const performance = supplierPerformance(db);
  const perfByName = new Map(performance.map((item) => [item.name, item]));
  const quotes = supplierQuotes[sku] || [];
  const qty = Math.max(0, Number(quantity || 0));
  const enrichedQuotes = quotes.map((quote) => ({
    ...quote,
    pricing: applyContractAndCurrency(quote, qty),
  }));
  const minPrice = Math.min(
    ...enrichedQuotes
      .map((item) => Number(item.pricing.unitPriceCny || 0))
      .filter(Boolean),
    Infinity,
  );
  const candidates = enrichedQuotes
    .map((quote) => {
      const perf = perfByName.get(quote.supplier) || {};
      const capacityCalendar = supplierCapacityCalendar[quote.supplier] || {
        nextWindow: "待排产",
        available: Number(quote.capacity || 0),
        committed: 0,
        reliability: 0.8,
      };
      const availableCapacity = Math.min(
        Number(quote.capacity || 0),
        Number(capacityCalendar.available || 0),
      );
      const priceIndex =
        Number.isFinite(minPrice) && quote.pricing.unitPriceCny > 0
          ? Math.min(100, (minPrice / quote.pricing.unitPriceCny) * 100)
          : 70;
      const deliveryIndex = Math.max(
        40,
        100 - Number(quote.leadTimeDays || 0) * 2,
      );
      const capacityIndex =
        qty > 0 ? Math.min(100, (availableCapacity / qty) * 100) : 100;
      const calendarIndex = Math.round(
        capacityIndex * 0.65 +
          Number(capacityCalendar.reliability || 0.8) * 100 * 0.35,
      );
      const riskPenalty =
        quote.risk === "高" || perf.flag === "整改"
          ? 14
          : quote.risk === "中"
            ? 5
            : 0;
      const qualityPenalty = Number(perf.rejectRate || 0) > 10 ? 8 : 0;
      const score = Math.round(
        Number(perf.score || 70) * 0.32 +
          priceIndex * 0.24 +
          deliveryIndex * 0.16 +
          Number(quote.responseScore || 70) * 0.14 +
          calendarIndex * 0.14 -
          riskPenalty -
          qualityPenalty,
      );
      return {
        supplier: quote.supplier,
        unitPrice: quote.pricing.unitPriceCny,
        listPrice: quote.unitPrice,
        listPriceCny: quote.pricing.listPriceCny,
        currency: quote.pricing.currency,
        fxRate: quote.pricing.fxRate,
        contractId: quote.pricing.contractId,
        contractLabel: quote.pricing.contractLabel,
        contractDiscount: quote.pricing.contractDiscount,
        contractTierMinQty: quote.pricing.contractTierMinQty,
        leadTimeDays: quote.leadTimeDays,
        responseScore: quote.responseScore,
        capacity: quote.capacity,
        availableCapacity,
        capacityWindow: capacityCalendar.nextWindow,
        capacityReliability: Number(capacityCalendar.reliability || 0),
        capacityStatus:
          qty > availableCapacity
            ? "不足"
            : qty > availableCapacity * 0.85
              ? "紧张"
              : "可承诺",
        risk: quote.risk,
        performanceScore: Number(perf.score || 0),
        quality: Number(perf.quality || 0),
        rejectRate: Number(perf.rejectRate || 0),
        flag: perf.flag || "待评估",
        score: Math.max(0, score),
        amount: qty * Number(quote.pricing.unitPriceCny || 0),
        isCurrent: quote.supplier === currentSupplier,
        note: `折算价 ${quote.pricing.unitPriceCny} CNY，${quote.pricing.contractId ? `${quote.pricing.contractLabel} 折扣 ${(quote.pricing.contractDiscount * 100).toFixed(0)}%，` : ""}产能 ${availableCapacity}/${qty || 0}，窗口 ${capacityCalendar.nextWindow}，绩效 ${Number(perf.score || 0)}。`,
      };
    })
    .sort((a, b) => b.score - a.score);

  const primary = candidates[0] || null;
  const backup =
    candidates.find((item) => item.supplier !== primary?.supplier) || null;
  const shouldSplit = Boolean(
    primary &&
    backup &&
    qty > Number(primary.availableCapacity || primary.capacity || 0) * 0.85,
  );
  const split =
    shouldSplit && primary && backup
      ? [
          {
            supplier: primary.supplier,
            quantity: Math.min(
              qty,
              primary.availableCapacity || primary.capacity,
            ),
            unitPrice: primary.unitPrice,
          },
          {
            supplier: backup.supplier,
            quantity: Math.max(
              0,
              qty -
                Math.min(qty, primary.availableCapacity || primary.capacity),
            ),
            unitPrice: backup.unitPrice,
          },
        ].filter((item) => item.quantity > 0)
      : [];
  const needsRfq =
    candidates.length < 2 ||
    candidates.some((item) => item.flag === "整改" && item.score < 74) ||
    (primary?.score || 0) < 78 ||
    candidates.some((item) => item.capacityStatus === "不足");

  return {
    sku,
    quantity: qty,
    currentSupplier,
    primary,
    backup,
    candidates,
    split,
    needsRfq,
    rfqReason: needsRfq
      ? "候选不足、绩效整改、产能不可承诺或综合评分低于阈值，建议发起 RFQ 或补充备选供应商。"
      : "候选供应商评分、合同价格和产能窗口满足自动推荐阈值。",
  };
}

export function createScmServer() {
  validateDatabasePersistenceConfig(process.env);
  const localSessions = new Map();
  const localSessionSecret = createLocalSessionSecret(process.env);
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});

      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const db = createEmptyDataset({ mode: "user" });
      const persistenceMode = getPersistenceMode(process.env);
      const dataMode = { mode: "user", readsDemoData: false };
      const repositories = createRepositoryRegistry({ db, env: process.env });
      const identity = resolveRequestIdentity(
        req,
        localSessions,
        localSessionSecret,
        process.env,
      );

      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, {
          ok: true,
          service: "flowchain-scm-api",
          ...buildIdentity,
          dataMode: dataMode.mode,
          readsDemoData: dataMode.readsDemoData,
          persistenceMode,
          authority: "postgresql",
          timestamp: new Date().toISOString(),
        });
      }

      if (
        isDatabaseModeWriteBlocked({
          persistenceMode,
          method: req.method,
          pathname: url.pathname,
        })
      ) {
        await recordDatabaseAuditBestEffort(
          { repositories },
          legacyMutationBlockedAuditEntry({
            method: req.method,
            pathname: url.pathname,
          }),
        );
        return sendDatabaseModeMutationBlocked(res, send);
      }

      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readBody(req);
        let profile;
        try {
          profile = normalizeLogin(body);
        } catch (error) {
          return send(res, 400, { error: error.message });
        }
        const tenantId = String(
          process.env.FLOWCHAIN_DEFAULT_TENANT_ID || "",
        ).trim();
        if (!tenantId)
          return send(res, 403, {
            code: "TENANT_CONTEXT_REQUIRED",
            message: "Pilot workspace tenant is not configured.",
          });
        const prisma = await getPrismaClient(process.env);
        const provisioned = await prisma.user.findFirst({
          where: {
            tenantId,
            email: String(profile.email || "")
              .trim()
              .toLowerCase(),
          },
          include: { tenant: true },
        });
        if (!provisioned)
          return send(res, 403, {
            code: "USER_NOT_PROVISIONED",
            message: "This email is not provisioned for the Pilot workspace.",
          });
        if (provisioned.status !== "active")
          return send(res, 403, {
            code: "USER_DISABLED",
            message: "This workspace user is disabled.",
          });
        profile = {
          id: provisioned.id,
          tenantId,
          name: provisioned.name,
          email: provisioned.email,
          company: provisioned.tenant.name,
          role: provisioned.role,
          version: provisioned.version,
        };
        const session = createLocalSession(profile, {
          env: process.env,
          authoritativeRole: true,
        });
        localSessions.set(session.sessionId, session);
        const token = issueLocalSessionToken(session, localSessionSecret);
        return send(res, 200, {
          token,
          expiresAt: new Date(session.expiresAt).toISOString(),
          user: {
            id: session.userId,
            name: session.name,
            email: session.email,
            company: session.company,
            role: session.role,
            roleLabel: roleLabel(session.role),
            tenantId: session.tenantId,
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        if (
          !identity.authenticated ||
          identity.source !== "local_signed_session"
        )
          return send(res, 401, {
            code: "INVALID_SESSION",
            error: "invalid or expired workspace session token",
          });
        return send(res, 200, {
          id: identity.userId,
          name: identity.name,
          email: identity.email,
          role: identity.role,
          tenantId: identity.tenantId,
          expiresAt: identity.expiresAt,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/forecast-plans") {
        return send(res, 200, db.forecastPlans || []);
      }

      const routeContext = {
        req,
        res,
        url,
        db,
        send,
        readBody,
        event,
        todayLabel,
        repositories,
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
        openaiDispatcher,
        arkDispatcher,
        aiMaxTokens,
        dataMode: dataMode.mode,
        env: process.env,
        identity,
        localSessions,
        supplierQuoteCount: Object.keys(supplierQuotes).length,
      };

      if (await handleMrpRoute(routeContext)) return;
      if (await handleSopRoute(routeContext)) return;
      if (await handleContextRoute(routeContext)) return;
      if (await handleBusinessReadContextRoute(routeContext)) return;
      if (await handleSearchRoute(routeContext)) return;
      if (await handleSalesDemandRoute(routeContext)) return;
      if (await handleEvidenceGraphRoute(routeContext)) return;
      if (await handleDataAccessQualityRoute(routeContext)) return;
      if (await handleReportsAnalyticsRoute(routeContext)) return;
      if (await handlePilotImportRoute(routeContext)) return;
      if (await handlePilotOperationsRoute(routeContext)) return;
      if (await handleImportPersistenceRoute(routeContext)) return;
      if (await handleReportViewsRoute(routeContext)) return;
      if (await handleReviewFirstActionWorkflowRoute(routeContext)) return;
      if (await handleAiSuggestionsWorkbenchRoute(routeContext)) return;
      if (await handleCollaborationNotificationDraftsRoute(routeContext))
        return;
      if (await handleWorkspaceSetupConfigRoute(routeContext)) return;
      if (await handlePilotWorkspaceRoute(routeContext)) return;
      if (await handleAuthorizationRoute(routeContext)) return;
      if (await handleSettingsRuntimeRoute(routeContext)) return;
      if (await handleUserRolePermissionVisibilityRoute(routeContext)) return;
      if (await handleWorkspaceBoundaryVisibilityRoute(routeContext)) return;
      if (await handleAuditIntegrationHistoryRoute(routeContext)) return;
      if (await handlePilotReadinessGovernanceRoute(routeContext)) return;
      if (await handleAiRuntimeGatewayRoute(routeContext)) return;
      if (await handleAiRuntimeObservabilityRoute(routeContext)) return;
      if (await handleTodayCockpitRoute(routeContext)) return;
      if (await handleReturnsRoute(routeContext)) return;
      if (await handleAttachmentRoute(routeContext)) return;
      if (await handleBankReconciliationRoute(routeContext)) return;
      if (await handleOperationalFinanceRoute(routeContext)) return;
      if (await handleMobileSyncRoute(routeContext)) return;
      if (await handleMobileOperationsRoute(routeContext)) return;
      if (await handleInventoryOperationsRoute(routeContext)) return;
      if (await handleInventoryRoute(routeContext)) return;
      if (await handleProcurementReadRoute(routeContext)) return;
      if (await handleCapabilitiesRoute(routeContext)) return;
      if (await handleMasterDataRoute(routeContext)) return;
      if (await handleActionDraftsRoute(routeContext)) return;
      if (await handleUserConfirmedActionsRoute(routeContext)) return;
      if (await handleProcurementWorkflowRoute(routeContext)) return;
      if (await handleExceptionCasesRoute(routeContext)) return;
      if (await handleUserDataRoute(routeContext)) return;
      if (await handleMarketRoute(routeContext)) return;
      if (await handleAiRoute(routeContext)) return;
      if (await handleRfqsRoute(routeContext)) return;
      if (await handlePurchaseRequestsRoute(routeContext)) return;
      if (await handlePurchaseOrdersRoute(routeContext)) return;
      if (await handleSalesOrderWorkbenchRoute(routeContext)) return;
      if (await handleOutboundRoute(routeContext)) return;
      if (await handleReceivingRoute(routeContext)) return;
      if (await handleInventoryMovementsRoute(routeContext)) return;
      if (await handleSupplierPerformanceRoute(routeContext)) return;
      if (await handleSupplierRecommendationsRoute(routeContext)) return;
      if (await handleAuditLogRoute(routeContext)) return;

      if (!url.pathname.startsWith("/api/")) return sendStatic(req, res, url);
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      return sendInternalServerError(res, send, error);
    }
  });
}

export function startScmServer(listenPort = port) {
  const server = createScmServer();
  server.listen(listenPort, () => {
    console.log(`FlowChain listening on http://127.0.0.1:${listenPort}`);
  });
  return server;
}
