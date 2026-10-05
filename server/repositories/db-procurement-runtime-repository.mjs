import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { createDbProcurementCommandService } from "../domain/procurement-db-command-service.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "../domain/receiving-transaction-policy.mjs";
import { mapPurchaseRequest, mapRfq } from "./db-procurement-read-repository.mjs";
import { findManyWithinLimit, requireTenantId } from "./repository-read-scope.mjs";

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
  orderNumber: row.metadata?.orderNumber || row.id,
  supplierId: row.supplierId,
  supplierSnapshot: row.supplierId || row.supplierName ? { id: row.supplierId, supplierName: row.supplierName } : null,
  currency: row.currency,
  totalAmount: decimal(row.amount),
  status: row.status,
  sourcePrId: row.sourceRequestId,
  sourceRfqId: row.sourceRfqId,
  expectedDate: row.expectedDate?.toISOString?.() || row.expectedDate || null,
  owner: row.owner || '',
  createdAt: row.createdAt?.toISOString?.() || row.createdAt || null,
  updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt || null,
  version: row.version,
  lines: (row.lines || []).map(mapLine),
  auditTrailIds: Array.isArray(row.metadata?.approvalTimeline) ? row.metadata.approvalTimeline : [],
  metadata: row.metadata || {},
});

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
      return rows.map(mapPo);
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
      const query = { where: { tenantId }, include: { lines: true }, orderBy: [{ updatedAt: "desc" }] };
      const limit = Math.min(500, Math.max(1, Number(filters.limit || 500)));
      const bounded = (subject) => ({ limit, subject, onTruncated: filters.onTruncated });
      const [requestRows, rfqRows, rows, receivingRows, invoiceRows] = await Promise.all([
        findManyWithinLimit(dbClient.purchaseRequest, query, bounded("purchase_requests")),
        findManyWithinLimit(dbClient.rfq, query, bounded("rfqs")),
        findManyWithinLimit(dbClient.purchaseOrder, query, bounded("purchase_orders")),
        findManyWithinLimit(dbClient.receivingDocument, query, bounded("receipts")),
        findManyWithinLimit(dbClient.supplierInvoice, query, bounded("supplier_invoices")),
      ]);
      const iso = value => value?.toISOString?.() || value || null;
      const receipts = receivingRows.map(row => ({ id: row.id, documentNumber: row.documentNumber, poId: row.poId, supplierId: row.supplierId, supplierName: row.supplierName, status: row.status, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, warehouseId: row.warehouseId, currency: row.currency, arrivedAt: iso(row.arrivedAt), postedAt: iso(row.postedAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lines: row.lines.map(line => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, itemId: line.itemId, sku: line.sku, itemName: line.itemName, acceptedQty: decimal(line.acceptedQty), rejectedQty: decimal(line.rejectedQty), unit: line.unit })) }));
      const supplierInvoices = invoiceRows.map(row => ({ id: row.id, invoiceNumber: row.invoiceNumber, supplierId: row.supplierId, supplierName: row.supplierName, poId: row.relatedPoId, receiptId: row.relatedGrnId, relatedPo: row.relatedPoId, relatedGrn: row.relatedGrnId, amount: decimal(row.amount), totalAmount: decimal(row.totalAmount), currency: row.currency, status: row.status, matchStatus: row.matchStatus, varianceAmount: decimal(row.varianceAmount), invoiceDate: iso(row.invoiceDate), dueDate: iso(row.dueDate), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lines: row.lines.map(line => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.receivingLineId, itemId: line.itemId, sku: line.sku, itemName: line.itemName, quantity: decimal(line.quantity), unitPrice: decimal(line.unitPrice), amount: decimal(line.amount), unit: line.unit })) }));
      // Quotation counts back the RFQ response figures when the RFQ row has none.
      const quotations = rfqRows.length ? await dbClient.supplierQuotation.findMany({ where: { tenantId, rfqId: { in: rfqRows.map(row => row.id) } }, select: { rfqId: true } }) : [];
      return { purchaseRequests: requestRows.map(mapPurchaseRequest), rfqs: rfqRows.map(row => mapRfq(row, quotations)), supplierQuotations: [], purchaseOrders: rows.map(mapPo), receipts, receivingDocs: receipts, supplierInvoices, documentLinks: [], procurementFollowups: [] };
    },
    async transact() {
      throw Object.assign(new Error("Database Mode procurementRuntime is read-only; use the PostgreSQL command service."), { code: "PROCUREMENT_DATABASE_COMMAND_REQUIRED", status: 409 });
    },
    whereFor,
  };
}
