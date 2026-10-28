import { defaultRoleTemplates } from '../../auth/permission-catalog.mjs'

// A compact copy of the walkthrough scenario for the workspace skill tests:
// the same kinds of records the local walkthrough seed writes, with dates as
// offsets from a seed day. It is served through stand-in read repositories (the
// shapes the database repositories return) and a read-only stand-in Prisma client
// that records every call and throws on any write.
//
// On the seed day at noon UTC:
//   open POs PO-001 (partially received, 4 days late), PO-002 (due in 4 days),
//   PO-008 (2 days late) and PO-009 (EUR); PO-003 fully received, PO-004 draft,
//   PO-005 cancelled, PO-006 pending approval and PO-007 rejected are not open.
//   Committed PO spend: USD 17,920 and EUR 500. Committed invoices: USD 7,381.50
//   (INV-003 is a draft). LDM-001 is short 7 against SO-001 and below its
//   safety stock; LDM-009 has no unit, preferred supplier or threshold.

export const AI_SKILL_TENANT = 'tenant-ai-skills'
export const AI_SKILL_OTHER_TENANT = 'tenant-ai-skills-other'
const DAY = 86_400_000

export function aiSkillSeedDay(seedDay) {
  const base = Date.parse(`${seedDay}T12:00:00Z`)
  return { now: new Date(base), day: (offset) => new Date(base + offset * DAY).toISOString().slice(0, 10), at: (offset) => new Date(base + offset * DAY).toISOString() }
}

export function aiSkillActor(roleKey = 'workspace-administrator', tenantId = AI_SKILL_TENANT) {
  return {
    complete: true, authenticated: true, tenantId, userId: `${roleKey}-user`, roleIds: [roleKey], inactiveRoleIds: [],
    permissionCodes: new Set(defaultRoleTemplates.find((template) => template.roleKey === roleKey)?.permissions || []),
    permissionSourceRoleIds: new Map(), readWarehouseIds: new Set(), operateWarehouseIds: new Set(), allWarehouses: false,
  }
}

const suppliers = { 'SUP-001': 'Acme Components', 'SUP-002': 'Summit Packaging' }

function records(seedDay) {
  const { day, at } = aiSkillSeedDay(seedDay)
  const po = (n, { status, supplier = 'SUP-001', sku, qty, received = 0, price, promised, created = -10, currency = 'USD' }) => ({
    id: `PO-${String(n).padStart(3, '0')}`, orderNumber: `PO-${String(n).padStart(3, '0')}`, supplierId: supplier,
    supplierSnapshot: { id: supplier, supplierName: suppliers[supplier] }, currency, totalAmount: String(qty * price), status,
    expectedDate: at(promised), owner: 'Kim', createdAt: at(created), updatedAt: at(created),
    lines: [{ id: `PO-${String(n).padStart(3, '0')}-L1`, sku, itemId: `ITEM-${sku.slice(-3)}`, itemName: sku, quantity: String(qty), orderedQuantity: String(qty), receivedQuantity: String(received), unit: 'pcs', unitPrice: String(price), amount: String(qty * price), promisedDate: day(promised) }],
    metadata: {},
  })
  const purchaseOrders = [
    po(1, { status: 'partially_received', sku: 'LDM-001', qty: 50, received: 20, price: 100, promised: -4, created: -21 }),
    po(2, { status: 'issued', sku: 'LDM-002', qty: 40, price: 100, promised: 4 }),
    po(3, { status: 'fully_received', supplier: 'SUP-002', sku: 'LDM-003', qty: 400, received: 400, price: 12.5, promised: -100, created: -120 }),
    po(4, { status: 'draft', sku: 'LDM-002', qty: 50, price: 64, promised: -10 }),
    po(5, { status: 'cancelled', supplier: 'SUP-002', sku: 'LDM-003', qty: 500, price: 12.9, promised: -12 }),
    po(6, { status: 'pending_approval', sku: 'LDM-001', qty: 120, price: 100, promised: 21 }),
    po(7, { status: 'rejected', sku: 'LDM-001', qty: 10, price: 100, promised: -5 }),
    po(8, { status: 'issued', sku: 'LDM-001', qty: 40, price: 98, promised: -2, created: -16 }),
    po(9, { status: 'approved', supplier: 'SUP-002', sku: 'LDM-002', qty: 10, price: 50, promised: 20, currency: 'EUR' }),
  ]
  const invoice = (id, { status, total, variance = 0, matchStatus = 'matched', poId }) => ({
    id, invoiceNumber: id, supplierId: 'SUP-001', supplierName: suppliers['SUP-001'], poId, receiptId: null, relatedPo: poId, relatedGrn: null,
    amount: String(total), totalAmount: String(total), currency: 'USD', status, matchStatus, varianceAmount: String(variance),
    invoiceDate: at(-5), dueDate: at(25), createdAt: at(-5), updatedAt: at(-5), lines: [],
  })
  return {
    purchaseOrders,
    supplierInvoices: [
      invoice('INV-001', { status: 'exception', total: 2381.5, variance: 200, matchStatus: 'variance', poId: 'PO-001' }),
      invoice('INV-002', { status: 'approved', total: 5000, poId: 'PO-003' }),
      invoice('INV-003', { status: 'draft', total: 999, poId: 'PO-002' }),
    ],
    purchaseRequests: [
      { id: 'PR-001', pr: 'PR-001', status: 'submitted', priority: 'high', requiredDate: at(14), totalAmount: 5000, currency: 'USD', lines: [{ id: 'PRL-001', sku: 'LDM-001', itemId: 'ITEM-001', quantity: 50, unit: 'pcs' }], createdAt: at(-23), updatedAt: at(-23) },
      { id: 'PR-002', pr: 'PR-002', status: 'draft', priority: 'medium', requiredDate: null, totalAmount: null, currency: 'USD', lines: [], createdAt: at(-1), updatedAt: at(-1) },
    ],
    rfqs: [
      { id: 'RFQ-001', title: 'Flow Controller RFQ', status: 'collecting_quotes', suppliers: 2, quoted: 0, bestSupplier: '', currency: 'USD', createdAt: at(-7), updatedAt: at(-7) },
      { id: 'RFQ-002', title: 'Awarded RFQ', status: 'collecting_quotes', suppliers: 1, quoted: 1, currency: 'USD', createdAt: at(-9), updatedAt: at(-9) },
    ],
    participations: [
      { tenantId: AI_SKILL_TENANT, rfqId: 'RFQ-001', status: 'response_recorded' },
      { tenantId: AI_SKILL_TENANT, rfqId: 'RFQ-001', status: 'response_recorded' },
      { tenantId: AI_SKILL_TENANT, rfqId: 'RFQ-002', status: 'response_recorded' },
    ],
    awards: [{ tenantId: AI_SKILL_TENANT, rfqId: 'RFQ-002' }],
    receipts: [
      { id: 'GRN-001', documentNumber: 'GRN-001', poId: 'PO-001', supplierId: 'SUP-001', supplierName: suppliers['SUP-001'], status: 'partial', postingStatus: 'posted', arrivedAt: at(-6), createdAt: at(-6), updatedAt: at(-6), lines: [{ id: 'GRNL-001', sku: 'LDM-001', acceptedQty: '20', rejectedQty: '0', unit: 'pcs' }] },
      { id: 'GRN-002', documentNumber: 'GRN-002', poId: 'PO-002', supplierId: 'SUP-001', supplierName: suppliers['SUP-001'], status: 'partial', postingStatus: 'unposted', arrivedAt: at(-1), createdAt: at(-1), updatedAt: at(-1), lines: [{ id: 'GRNL-002', sku: 'LDM-002', acceptedQty: '10', rejectedQty: '2', unit: 'pcs' }] },
      { id: 'GRN-003', documentNumber: 'GRN-003', poId: 'PO-003', supplierId: 'SUP-002', supplierName: suppliers['SUP-002'], status: 'received', postingStatus: 'posted', arrivedAt: at(-100), createdAt: at(-100), updatedAt: at(-100), lines: [{ id: 'GRNL-003', sku: 'LDM-003', acceptedQty: '400', rejectedQty: '5', unit: 'pcs' }] },
    ],
    items: [
      { id: 'ITEM-001', itemId: 'ITEM-001', sku: 'LDM-001', name: 'Flow Controller', itemName: 'Flow Controller', unit: 'pcs', preferredSupplierId: 'SUP-001', safetyStock: 30, reorderPoint: 40 },
      { id: 'ITEM-002', itemId: 'ITEM-002', sku: 'LDM-002', name: 'Temperature Sensor', itemName: 'Temperature Sensor', unit: 'pcs', preferredSupplierId: 'SUP-001', safetyStock: 15, reorderPoint: 15 },
      { id: 'ITEM-009', itemId: 'ITEM-009', sku: 'LDM-009', name: 'Spare Gasket', itemName: 'Spare Gasket', unit: null, preferredSupplierId: null, safetyStock: null, reorderPoint: null },
    ],
    balances: [
      { id: 'BAL-001', sku: 'LDM-001', itemId: 'ITEM-001', itemName: 'Flow Controller', onHandQuantity: 28, availableQuantity: 28, reservedQuantity: 0, safetyStock: 30, reorderPoint: 40, unit: 'pcs' },
      { id: 'BAL-002', sku: 'LDM-002', itemId: 'ITEM-002', itemName: 'Temperature Sensor', onHandQuantity: 150, availableQuantity: 150, reservedQuantity: 0, safetyStock: 15, reorderPoint: 15, unit: 'pcs' },
    ],
    salesOrders: [{ id: 'SO-001', salesOrderId: 'SO-001', workflowStatus: 'confirmed', status: 'confirmed', customerName: 'Redwood Retail', currency: 'USD', lines: [{ sku: 'LDM-001', orderedQuantity: 35, fulfilledQuantity: 0, reservedQuantity: 0 }] }],
    suppliers: Object.entries(suppliers).map(([id, name]) => ({ id, supplierCode: id, name, supplierName: name, status: 'active' })),
  }
}

const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', '$executeRaw', '$executeRawUnsafe', '$transaction'])

// A Prisma client that answers the skill reads for one tenant and throws on
// any write. calls records [model, method, args] for every read.
export function readOnlyPrisma(data, calls = [], tenant = { locale: 'en-US', currency: 'USD', timezone: 'America/New_York' }) {
  const answers = {
    tenant: { findUnique: ({ where }) => where.id === AI_SKILL_TENANT ? tenant : null },
    item: { findMany: ({ where, take }) => data.items.filter(() => where.tenantId === AI_SKILL_TENANT).slice(0, take) },
    inventoryBalance: { findMany: ({ where, take }) => data.balances.filter(() => where.tenantId === AI_SKILL_TENANT).slice(0, take) },
    rfqSupplierParticipation: { findMany: ({ where }) => data.participations.filter((row) => row.tenantId === where.tenantId && where.rfqId.in.includes(row.rfqId)) },
    rfqAwardDecision: { findMany: ({ where }) => data.awards.filter((row) => row.tenantId === where.tenantId && where.rfqId.in.includes(row.rfqId)) },
    // The supplier scorecard's reads (supplier-scorecard.mjs), by supplier and
    // status as it asks; the fixture lines record no original promise.
    purchaseOrder: { findMany: ({ where }) => where.tenantId !== AI_SKILL_TENANT ? [] : data.purchaseOrders.filter((row) => !where.status?.notIn?.includes(row.status) && (typeof where.supplierId === 'string' ? row.supplierId === where.supplierId : Boolean(row.supplierId))) },
    receivingDocument: { findMany: ({ where }) => where.tenantId !== AI_SKILL_TENANT ? [] : data.receipts.filter((row) => where.poId.in.includes(row.poId) && (!where.postingStatus || row.postingStatus === where.postingStatus)) },
    supplierInvoice: { findMany: ({ where }) => where.tenantId !== AI_SKILL_TENANT ? [] : data.supplierInvoices.filter((row) => typeof where.supplierId === 'string' ? row.supplierId === where.supplierId : true).map((row) => ({ ...row, lines: row.lines || [], matchRuns: [] })) },
    supplier: { findMany: ({ where }) => where.tenantId !== AI_SKILL_TENANT ? [] : data.suppliers.filter((row) => !where.id || row.id === where.id).map((row) => ({ id: row.id, name: row.name })) },
  }
  return new Proxy({}, {
    get(_target, model) {
      if (typeof model !== 'string') return undefined
      if (WRITE_METHODS.has(model)) return () => { throw new Error(`write attempted: ${model}`) }
      return new Proxy({}, {
        get(_inner, method) {
          if (typeof method !== 'string') return undefined
          if (WRITE_METHODS.has(method)) return () => { throw new Error(`write attempted: ${model}.${method}`) }
          const answer = answers[model]?.[method]
          if (!answer) return undefined
          return async (args = {}) => { calls.push([model, method, structuredClone(args)]); return structuredClone(answer(args)) }
        },
      })
    },
  })
}

// Read repositories in the shapes the database repositories return. Every call
// is recorded with its scope; a read without the fixture tenant returns nothing.
export function aiSkillRepositories(data, calls = [], { truncated = [] } = {}) {
  const scoped = (name, rows) => async (scope = {}) => {
    calls.push([name, scope.tenantId])
    if (scope.tenantId !== AI_SKILL_TENANT) return Array.isArray(rows) ? [] : {}
    for (const entry of truncated) scope.onTruncated?.(entry)
    return structuredClone(rows)
  }
  return {
    mode: 'database',
    masterData: { listManagedItems: scoped('masterData.listManagedItems', data.items), listSuppliers: scoped('masterData.listSuppliers', data.suppliers), listCustomers: scoped('masterData.listCustomers', []), listAllItemSupplierRelationships: scoped('masterData.listAllItemSupplierRelationships', []) },
    inventoryRuntime: { listItems: scoped('inventoryRuntime.listItems', data.balances) },
    salesOrders: { listOrders: scoped('salesOrders.listOrders', data.salesOrders) },
    procurementRuntime: {
      snapshot: scoped('procurementRuntime.snapshot', { purchaseRequests: data.purchaseRequests, rfqs: data.rfqs, purchaseOrders: data.purchaseOrders, receipts: data.receipts, receivingDocs: data.receipts, supplierInvoices: data.supplierInvoices }),
      listForReport: scoped('procurementRuntime.listForReport', data.purchaseOrders),
    },
  }
}

export function aiSkillScenario({ seedDay = '2026-09-29', roleKey = 'workspace-administrator', truncated = [], tenant } = {}) {
  const data = records(seedDay)
  const calls = { prisma: [], repositories: [] }
  const actor = aiSkillActor(roleKey)
  const ctx = {
    identity: { authenticated: true, tenantId: AI_SKILL_TENANT, userId: actor.userId, role: 'admin' },
    repositories: aiSkillRepositories(data, calls.repositories, { truncated }),
    aiSkillPrisma: readOnlyPrisma(data, calls.prisma, tenant),
    aiSkillActor: actor,
    aiSkillNow: aiSkillSeedDay(seedDay).now,
  }
  return { data, calls, actor, ctx }
}
