import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { createDbProcurementCommandService } from "../domain/procurement-db-command-service.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "../domain/receiving-transaction-policy.mjs";

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
    async get(type, id, options = {}) {
      if (type !== "po") return null;
      return authority.readPurchaseOrder(id, options.context || options, options);
    },
    async list(type, options = {}) {
      if (type !== "po") return [];
      return authority.listPurchaseOrdersForApproval(options.context || options, options);
    },
    async snapshot(filters = {}) {
      const dbClient = await client();
      const tenantId = text(filters.tenantId || env.FLOWCHAIN_DEFAULT_TENANT_ID || "tenant-flowchain-sme");
      const rows = await dbClient.purchaseOrder.findMany({ where: { tenantId }, include: { lines: true }, orderBy: [{ updatedAt: "desc" }], take: Math.min(500, Math.max(1, Number(filters.limit || 500))) });
      return { purchaseRequests: [], rfqs: [], supplierQuotations: [], purchaseOrders: rows.map(mapPo), receivingDocs: [], supplierInvoices: [], documentLinks: [], procurementFollowups: [] };
    },
    async transact() {
      throw Object.assign(new Error("Database Mode procurementRuntime is read-only; use the PostgreSQL command service."), { code: "PROCUREMENT_DATABASE_COMMAND_REQUIRED", status: 409 });
    },
    whereFor,
  };
}
