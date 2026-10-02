import { can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { defaultRoleTemplates, legacyRoleTemplateMap } from '../auth/permission-catalog.mjs'

// What a reader may see in the reports, the home overview and the business
// read context. Each collection in the business read context needs the read
// permission of its own pages:
//
//   purchase requests, RFQs, purchase orders   procurement.purchase_order.read
//   receipts                                   receiving.read
//   supplier invoices                          finance.supplier_invoice.read
//   sales orders                               sales_order.read
//   inventory balances                         inventory.balance.read
//
// A collection the reader cannot read is empty and named in
// `restrictedSubjects`. Inside a readable collection, prices and amounts on
// procurement documents and reference prices need procurement.prices.read,
// amounts on supplier invoices need finance.amounts.read, and the supplier on
// an invoice needs finance.partner_snapshot.read. A hidden value is null,
// never 0, and the report marks a figure built from it as restricted.

const COLLECTION_PERMISSION = Object.freeze({
  purchaseRequests: 'procurement.purchase_order.read',
  rfqs: 'procurement.purchase_order.read',
  purchaseOrders: 'procurement.purchase_order.read',
  receipts: 'receiving.read',
  supplierInvoices: 'finance.supplier_invoice.read',
  salesOrders: 'sales_order.read',
  inventoryItems: 'inventory.balance.read',
})

// The report subject each collection feeds.
export const REPORT_SUBJECT_OF = Object.freeze({
  purchaseOrders: 'purchase_orders',
  receipts: 'receipts',
  supplierInvoices: 'supplier_invoices',
  salesOrders: 'sales_orders',
  inventoryItems: 'inventory_balances',
})

const MONEY_KEYS = new Set([
  'unitPrice', 'estimatedUnitPrice', 'amount', 'estimatedAmount', 'totalAmount', 'subtotal', 'subtotalAmount', 'taxAmount', 'enteredTaxAmount',
  'tax', 'total', 'lineAmount', 'lineSubtotal', 'lineTotal', 'bestPrice', 'varianceAmount', 'lineVarianceAmount', 'price', 'budget', 'budgetAmount',
  'invoiceAmount', 'poAmount', 'receivedAmount', 'matchedAmount', 'openAmount', 'invoiceTotal', 'poUnitPrice', 'invoiceUnitPrice', 'priceVariance',
  'amountVariance', 'referencePrice', 'purchasePrice',
])
const SUPPLIER_SENSITIVE_KEYS = ['creditCode', 'taxIdentificationNumber', 'bankAccountName', 'bankAccountNumber']

export function reportReadAccessFor(actor) {
  const allowed = (permission) => Boolean(actor?.tenantId) && can({ actor, permission, tenantId: actor.tenantId })
  return {
    collections: Object.fromEntries(Object.entries(COLLECTION_PERMISSION).map(([key, permission]) => [key, allowed(permission)])),
    prices: allowed('procurement.prices.read'),
    amounts: allowed('finance.amounts.read'),
    partner: allowed('finance.partner_snapshot.read'),
  }
}

// A test identity from the x-flowchain-user / x-flowchain-role headers, which
// only NODE_ENV=test or FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS accept and
// production refuses, reads with its role template's permissions.
function testHeaderActor(identity) {
  const roleKey = legacyRoleTemplateMap[String(identity.role || '').toLowerCase()] || 'read-only-viewer'
  return { authenticated: true, complete: true, tenantId: identity.tenantId, permissionCodes: new Set(defaultRoleTemplates.find(template => template.roleKey === roleKey)?.permissions || []) }
}

// The session identity when it already carries a resolved authorization
// context, else the provisioned workspace user.
export async function reportReadAccess(ctx) {
  if (ctx.reportReadAccess) return ctx.reportReadAccess
  const identity = ctx.identity
  if (identity?.authenticated && identity.source === 'explicit_test_headers') return reportReadAccessFor(testHeaderActor(identity))
  const actor = identity?.authenticated && identity.complete && identity.permissionCodes
    ? identity
    : await resolveProvisionedActor(await getPrismaClient(ctx.env || process.env), identity, { allowMissingTestActor: true })
  return reportReadAccessFor(actor)
}

// An actor that cannot be resolved (signed out, not provisioned, disabled)
// gets the identity error, not a 500.
export function sendReadAccessError(ctx, error) {
  if (error?.name !== 'PilotIdentityError' && error?.name !== 'AuthorizationError') throw error
  ctx.send(ctx.res, error.status || 403, { code: error.code, message: error.message })
}

// Every money field at any depth set to null.
function withoutMoney(value) {
  if (Array.isArray(value)) return value.map(withoutMoney)
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, MONEY_KEYS.has(key) ? null : withoutMoney(entry)]))
}

function withoutPartner(invoice) {
  return { ...invoice, supplierName: null, supplierSnapshot: null }
}

// The business read context as this reader may see it.
export function scopeBusinessContext(context, access) {
  if (!access) throw new Error('Report read access is required.')
  const scoped = { ...context }
  const restrictedSubjects = []
  for (const [key, readable] of Object.entries(access.collections)) {
    if (readable) continue
    scoped[key] = []
    restrictedSubjects.push(REPORT_SUBJECT_OF[key] || key)
  }
  if (!access.prices) for (const key of ['purchaseRequests', 'rfqs', 'purchaseOrders', 'receipts', 'itemSupplierRelationships']) scoped[key] = withoutMoney(scoped[key] || [])
  if (!access.amounts) scoped.supplierInvoices = withoutMoney(scoped.supplierInvoices || [])
  if (!access.partner) scoped.supplierInvoices = (scoped.supplierInvoices || []).map(withoutPartner)
  if (!access.partner) scoped.suppliers = (scoped.suppliers || []).map((supplier) => Object.fromEntries(Object.entries(supplier).filter(([key]) => !SUPPLIER_SENSITIVE_KEYS.includes(key))))
  return {
    ...scoped,
    restrictedSubjects: [...new Set(restrictedSubjects)],
    // Money on these report subjects is hidden from this reader.
    restrictedAmounts: { purchase_orders: !access.prices, receipts: !access.prices, supplier_invoices: !access.amounts, sales_orders: false },
  }
}
