import { actionDraftSchema, buildActionDraftSuggestion } from '../action-draft-boundary.mjs'
import { buildPurchaseRequestDraftPreview } from '../purchase-request-draft-preview.mjs'
import {
  buildRfqDraftPreview,
  buildSupplierFollowupDraftPreview,
} from '../rfq-and-supplier-followup-draft-preview.mjs'
import {
  buildInventoryExceptions,
  buildInventoryItems,
  buildInventoryLots,
  buildInventoryMovements,
  buildInventorySerials,
  buildInventorySummary,
  filterInventoryRows,
  getInventoryItemBySku,
} from '../inventory-read.mjs'
import {
  findMasterItem,
  findMasterSupplier,
  listMasterItems,
  listMasterSuppliers,
  listMasterWarehouses,
  listPaymentTerms,
  listTaxCodes,
} from '../master-data.mjs'
import {
  buildProcurementDocumentLinks,
  buildProcurementDocuments,
  buildProcurementFollowups,
  buildProcurementSummary,
  filterProcurementRows,
  getProcurementDocument,
  isProcurementDocumentType,
  normalizeProcurementDocumentType,
} from '../procurement-read-model.mjs'

function rows(value) {
  return Array.isArray(value) ? value : []
}

export function createTestRepositoryRegistry(db = {}) {
  const previewDraft = (input) => {
    if (input?.type === 'purchase_request_draft') return buildPurchaseRequestDraftPreview(input, { db })
    if (input?.type === 'rfq_draft') return buildRfqDraftPreview(input, { db })
    if (input?.type === 'supplier_followup_draft') return buildSupplierFollowupDraftPreview(input, { db })
    return buildActionDraftSuggestion(input)
  }
  return {
    mode: 'test-postgresql-boundary',
    actionDrafts: {
      getSchema: () => actionDraftSchema(),
      previewDraft,
    },
    auditLog: {
      mode: 'database',
      adapter: 'db-audit-log-v1',
      listAuditEntries: async ({ entityType = '', entityId = '', limit = 100 } = {}) =>
        rows(db.auditLog)
          .filter((entry) => (!entityType || entry.entityType === entityType) && (!entityId || entry.entityId === entityId))
          .slice(0, limit),
      recordAuditEntry: async (entry) => {
        const record = { id: entry.id || `AUD-TEST-${rows(db.auditLog).length + 1}`, ...entry }
        db.auditLog = db.auditLog || []
        db.auditLog.unshift(record)
        return record
      },
    },
    inventoryRead: {
      listItems: async (filters = {}) => filterInventoryRows(buildInventoryItems(db), filters),
      getItem: async (id) => getInventoryItemBySku(db, id),
      listLots: async (filters = {}) => filterInventoryRows(buildInventoryLots(db), filters),
      listSerials: async (filters = {}) => filterInventoryRows(buildInventorySerials(db), filters),
      listMovements: async (filters = {}) => filterInventoryRows(buildInventoryMovements(db), filters),
      listExceptions: async (filters = {}) => filterInventoryRows(buildInventoryExceptions(db), filters),
      getSummary: async () => buildInventorySummary(db),
    },
    masterData: {
      listItems: async () => listMasterItems(db),
      listManagedItems: async () => listMasterItems(db),
      getItem: async (id) => findMasterItem(db, id),
      listSuppliers: async () => listMasterSuppliers(db),
      getSupplier: async (id) => findMasterSupplier(db, id),
      listCustomers: async () => rows(db.customers),
      getCustomer: async (id) => rows(db.customers).find((row) => row.id === id) || null,
      listWarehouses: async () => listMasterWarehouses(db),
      listPaymentTerms: async () => listPaymentTerms(db),
      listTaxCodes: async () => listTaxCodes(db),
      listAllItemSupplierRelationships: async () => rows(db.itemSupplierRelationships),
    },
    procurementRead: {
      normalizeDocumentType: normalizeProcurementDocumentType,
      isDocumentType: isProcurementDocumentType,
      listDocuments: async (filters = {}) => filterProcurementRows(buildProcurementDocuments(db), filters),
      getDocument: async (type, id) => getProcurementDocument(db, type, id),
      listLinks: async (filters = {}) => filterProcurementRows(buildProcurementDocumentLinks(db), filters),
      listFollowups: async (filters = {}) => filterProcurementRows(buildProcurementFollowups(db), filters),
      getSummary: async () => buildProcurementSummary(db),
    },
    inventoryRuntime: {
      adapter: 'test-inventory-runtime',
      listItems: async () => buildInventoryItems(db),
    },
    salesOrders: {
      adapter: 'test-sales-order-runtime',
      listOrders: async () => rows(db.salesOrders),
    },
    procurementRuntime: {
      adapter: 'test-procurement-runtime',
      snapshot: async () => ({
        purchaseRequests: rows(db.purchaseRequests).map((row) => ({ ...row, id: row.id || row.pr })),
        rfqs: rows(db.rfqs),
        purchaseOrders: rows(db.purchaseOrders).map((row) => ({ ...row, id: row.id || row.po })),
        receipts: rows(db.receivingDocs).map((row) => ({ ...row, id: row.id || row.grn })),
        supplierInvoices: rows(db.supplierInvoices).map((row) => ({ ...row, id: row.id || row.invoiceNumber })),
      }),
    },
  }
}
