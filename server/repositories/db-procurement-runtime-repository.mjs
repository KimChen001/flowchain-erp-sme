import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { createDbProcurementCommandService } from "../domain/procurement-db-command-service.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "../domain/receiving-transaction-policy.mjs";
import { mapPurchaseRequest, mapRfq } from "./db-procurement-read-repository.mjs";
import { isPurchaseOrderReceivable } from "../domain/procurement-status-authority.mjs";
import { ALLOCATION_READ_LIMIT, findManyWithinLimit, requireTenantId } from "./repository-read-scope.mjs";
import { procurementDocumentNumber } from "../../shared/document-numbering.mjs";

const text = (value) => String(value ?? "").trim();
const decimal = (value) => value === null || value === undefined ? null : receivingDecimalString(receivingDecimalUnits(value));

const mapLine = (line = {}) => ({
  id: line.id,
  sku: line.sku,
  itemNameSnapshot: line.itemName,
  itemName: line.itemName,
  itemId: line.itemId,
  quantity: decimal(line.orderedQuantity),
  orderedQuantity: decimal(line.orderedQuantity),
  receivedQuantity: decimal(line.receivedQuantity),
  unitSnapshot: line.unit,
  unit: line.unit,
  unitPrice: decimal(line.unitPrice),
  amount: decimal(line.amount),
  promisedDate: line.metadata?.promisedDate || null,
  originalPromisedDate: line.originalPromisedDate?.toISOString?.().slice(0, 10) || null,
});

const mapPo = (row = {}) => ({
  id: row.id,
  number: procurementDocumentNumber(row),
  orderNumber: procurementDocumentNumber(row),
  supplierId: row.supplierId,
  supplierSnapshot: row.supplierId || row.supplierName ? { id: row.supplierId, supplierName: row.supplierName } : null,
  currency: row.currency,
  totalAmount: decimal(row.amount),
  status: row.status,
  sourcePrId: row.sourceRequestId,
  sourceRfqId: row.sourceRfqId,
  expectedDate: row.expectedDate?.toISOString?.() || row.expectedDate || null,
  issuedAt: row.issuedAt?.toISOString?.() || row.issuedAt || null,
  owner: row.owner || '',
  createdAt: row.createdAt?.toISOString?.() || row.createdAt || null,
  updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt || null,
  version: row.version,
  lines: (row.lines || []).map(mapLine),
  auditTrailIds: Array.isArray(row.metadata?.approvalTimeline) ? row.metadata.approvalTimeline : [],
  metadata: row.metadata || {},
});

const iso = value => value?.toISOString?.() || value || null;

// A receipt and a supplier invoice as snapshot() serves them. poNumberOf adds
// the purchase order number when the caller has the order.
const mapReceipt = (row, poNumberOf = () => ({})) => ({ id: row.id, documentNumber: row.documentNumber, poId: row.poId, ...poNumberOf(row.poId), supplierId: row.supplierId, supplierName: row.supplierName, status: row.status, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, warehouseId: row.warehouseId, currency: row.currency, arrivedAt: iso(row.arrivedAt), postedAt: iso(row.postedAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lines: row.lines.map(line => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, itemId: line.itemId, sku: line.sku, itemName: line.itemName, acceptedQty: decimal(line.acceptedQty), rejectedQty: decimal(line.rejectedQty), unit: line.unit })) });
const mapSupplierInvoice = (row, poNumberOf = () => ({})) => ({ id: row.id, invoiceNumber: row.invoiceNumber, supplierId: row.supplierId, supplierName: row.supplierName, poId: row.relatedPoId, ...poNumberOf(row.relatedPoId), receiptId: row.relatedGrnId, relatedPo: row.relatedPoId, relatedGrn: row.relatedGrnId, amount: decimal(row.amount), totalAmount: decimal(row.totalAmount), currency: row.currency, status: row.status, matchStatus: row.matchStatus, varianceAmount: decimal(row.varianceAmount), invoiceDate: iso(row.invoiceDate), dueDate: iso(row.dueDate), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lines: row.lines.map(line => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.receivingLineId, itemId: line.itemId, sku: line.sku, itemName: line.itemName, quantity: decimal(line.quantity), unitPrice: decimal(line.unitPrice), amount: decimal(line.amount), unit: line.unit })) });

// snapshot()'s reads: every procurement document, newest change first, at most
// `limit` (500) of each kind, each kind that had more reported to onTruncated.
const snapshotQuery = (tenantId) => ({ where: { tenantId }, include: { lines: true }, orderBy: [{ updatedAt: "desc" }] });
const snapshotBounds = (filters) => {
  const limit = Math.min(500, Math.max(1, Number(filters.limit || 500)));
  return (subject) => ({ limit, subject, onTruncated: filters.onTruncated });
};

export function createDbProcurementRuntimeRepository({ prisma, env = process.env } = {}) {
  const client = async () => prisma || getPrismaClient(env);
  const authority = createDbProcurementCommandService({ prisma, env });
  const whereFor = (type, id, tenantId) => type === "po" ? { id: text(id), tenantId: text(tenantId) } : null;
  return {
    mode: "database",
    // Keep the established runtime adapter identity for read-model consumers;
    // all database-mode commands are delegated to the PostgreSQL authority.
    adapter: "durable-procurement-runtime-v2",
    authorityAdapter: "db-procurement-authority-v1",
    authority,
    async listForReport({ tenantId } = {}) {
      const scopedTenantId = requireTenantId({ tenantId });
      const dbClient = await client();
      const rows = await dbClient.purchaseOrder.findMany({ where: { tenantId: scopedTenantId }, include: { lines: true }, orderBy: [{ id: 'asc' }] });
      // Each order's supplier by its current name in Suppliers: the open
      // purchase orders report, Today and the assistant read these rows, so a
      // renamed supplier keeps its old orders under one name.
      const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter(Boolean))];
      const suppliers = supplierIds.length && typeof dbClient.supplier?.findMany === 'function'
        ? await dbClient.supplier.findMany({ where: { tenantId: scopedTenantId, OR: [{ id: { in: supplierIds } }, { code: { in: supplierIds } }] }, select: { id: true, code: true, name: true } })
        : [];
      const names = new Map(suppliers.map((row) => [row.id, row.name]));
      for (const row of suppliers) if (row.code && !names.has(row.code)) names.set(row.code, row.name);
      return rows.map((row) => ({ ...mapPo(row), currentSupplierName: names.get(row.supplierId) || null }));
    },
    async get(type, id, options = {}) {
      if (type !== "po") return null;
      return authority.readPurchaseOrder(id, options.context || options, options);
    },
    async list(type, options = {}) {
      if (type !== "po") return [];
      return authority.listPurchaseOrdersForApproval(options.context || options, options);
    },
    async snapshot(filters = {}) {
      const tenantId = requireTenantId(filters);
      const dbClient = await client();
      const query = snapshotQuery(tenantId);
      const bounded = snapshotBounds(filters);
      const [requestRows, rfqRows, rows, receivingRows, invoiceRows] = await Promise.all([
        findManyWithinLimit(dbClient.purchaseRequest, query, bounded("purchase_requests")),
        findManyWithinLimit(dbClient.rfq, query, bounded("rfqs")),
        findManyWithinLimit(dbClient.purchaseOrder, query, bounded("purchase_orders")),
        findManyWithinLimit(dbClient.receivingDocument, query, bounded("receipts")),
        findManyWithinLimit(dbClient.supplierInvoice, query, bounded("supplier_invoices")),
      ]);
      // A receipt's or bill's purchase order number, when the order is among
      // the loaded rows.
      const poNumbers = new Map(rows.map(row => [row.id, procurementDocumentNumber(row)]));
      const poNumberOf = id => (poNumbers.get(id) ? { poNumber: poNumbers.get(id) } : {});
      const receipts = receivingRows.map(row => mapReceipt(row, poNumberOf));
      const supplierInvoices = invoiceRows.map(row => mapSupplierInvoice(row, poNumberOf));
      // Each RFQ's invited suppliers and responses come from its participation
      // records and quotations (rfqSupplierCounts), not the header's counts.
      const rfqIds = rfqRows.map(row => row.id);
      const quotations = rfqRows.length ? await dbClient.supplierQuotation.findMany({ where: { tenantId, rfqId: { in: rfqIds } }, select: { rfqId: true, supplierId: true } }) : [];
      const participations = rfqRows.length && typeof dbClient.rfqSupplierParticipation?.findMany === "function" ? await dbClient.rfqSupplierParticipation.findMany({ where: { tenantId, rfqId: { in: rfqIds } }, select: { rfqId: true, supplierId: true, status: true } }) : [];
      // Purchase requests and RFQs carry their update day; the instant is kept
      // beside it, so the home page orders and dates them like other documents.
      const withInstant = (mapped, row) => ({ ...mapped, updatedAtInstant: iso(row.updatedAt) });
      return { purchaseRequests: requestRows.map(row => withInstant(mapPurchaseRequest(row), row)), rfqs: rfqRows.map(row => withInstant(mapRfq(row, quotations, participations), row)), supplierQuotations: [], purchaseOrders: rows.map(mapPo), receipts, receivingDocs: receipts, supplierInvoices, documentLinks: [], procurementFollowups: [] };
    },
    // The allocation model's incoming over every record (design audit
    // 2026-11-15, L15), where snapshot() reads the latest 500 orders: every
    // committed purchase order (approved, issued or partially received, as
    // isPurchaseOrderReceivable reads the stored status) with its lines, newest
    // change first as snapshot() lists them, so every open line counts
    // (#249). Also the key each line of any order is counted under (SKU, else
    // item id, else line id), in the order snapshot() lists them, as the model
    // lists a SKU on any order. More than ALLOCATION_READ_LIMIT orders or keys
    // is reported to onTruncated as purchase_orders.
    async listCommittedPurchaseOrders(filters = {}) {
      const tenantId = requireTenantId(filters);
      const dbClient = await client();
      const limit = ALLOCATION_READ_LIMIT;
      const bounded = { limit, subject: "purchase_orders", onTruncated: filters.onTruncated };
      const stored = await dbClient.$queryRaw`SELECT DISTINCT status FROM "PurchaseOrder" WHERE "tenantId" = ${tenantId}`;
      const statuses = stored.map((row) => row.status).filter(isPurchaseOrderReceivable);
      const [rows, keys] = await Promise.all([
        statuses.length ? findManyWithinLimit(dbClient.purchaseOrder, { where: { tenantId, status: { in: statuses } }, include: { lines: true }, orderBy: [{ updatedAt: "desc" }] }, bounded) : [],
        dbClient.$queryRaw`
          SELECT key FROM (
            SELECT trim(COALESCE(NULLIF(l.sku, ''), NULLIF(l."itemId", ''), l.id)) AS key,
              row_number() OVER (ORDER BY po."updatedAt" DESC, po.id ASC, l.id ASC) AS position
            FROM "PurchaseOrderLine" l
            JOIN "PurchaseOrder" po ON po.id = l."purchaseOrderId"
            WHERE po."tenantId" = ${tenantId}
          ) lines
          WHERE key <> ''
          GROUP BY key
          ORDER BY min(position)
          LIMIT ${limit + 1}`,
      ]);
      if (keys.length > limit && typeof filters.onTruncated === "function") filters.onTruncated({ subject: "purchase_orders", limit });
      return { purchaseOrders: rows.map(mapPo), lineKeys: keys.slice(0, limit).map((row) => text(row.key)) };
    },
    // snapshot()'s receipts and supplier invoices alone, read and bounded the
    // same way, for the supplier issue signals (ai-skill-readers.mjs
    // readAiSkillSupplierIssueFacts), which need no other document. Without
    // the purchase orders read beside them, they carry no poNumber.
    async listReceiptsAndInvoices(filters = {}) {
      const tenantId = requireTenantId(filters);
      const dbClient = await client();
      const query = snapshotQuery(tenantId);
      const bounded = snapshotBounds(filters);
      const [receivingRows, invoiceRows] = await Promise.all([
        findManyWithinLimit(dbClient.receivingDocument, query, bounded("receipts")),
        findManyWithinLimit(dbClient.supplierInvoice, query, bounded("supplier_invoices")),
      ]);
      return { receipts: receivingRows.map(row => mapReceipt(row)), supplierInvoices: invoiceRows.map(row => mapSupplierInvoice(row)) };
    },
    async transact() {
      throw Object.assign(new Error("Database Mode procurementRuntime is read-only; use the PostgreSQL command service."), { code: "PROCUREMENT_DATABASE_COMMAND_REQUIRED", status: 409 });
    },
    whereFor,
  };
}
