import { createBusinessReadContextService } from './business-read-context-service.mjs'

export async function readBusinessContext(ctx) {
  // Direct domain route tests created before the runtime registry existed do not
  // provide repositories. Production server contexts always provide the registry.
  if (!ctx.repositories && ctx.db) return legacyRouteTestContext(ctx.db)
  return await createBusinessReadContextService({
    repositories: ctx.repositories || {},
    dataMode: ctx.dataMode || 'user',
  }).read({ tenantId: ctx.identity?.tenantId })
}

function legacyRouteTestContext(db) {
  return {
    dataMode: db.__dataMode || 'test',
    items: db.products || [], suppliers: db.suppliers || [], customers: db.customers || [],
    warehouses: db.warehouses || [], bins: db.bins || [], inventoryItems: db.inventoryItems || db.products || [],
    salesOrders: db.salesOrders || [], purchaseRequests: db.purchaseRequests || [], rfqs: db.rfqs || [],
    purchaseOrders: db.purchaseOrders || [], receipts: db.receivingDocs || [], supplierInvoices: db.supplierInvoices || [],
    itemSupplierRelationships: db.itemSupplierRelationships || [], dataLimitations: ['isolated_route_test_context'],
    runtimeAdapters: {}, generatedAt: new Date().toISOString(),
  }
}

export function businessContextToReadDb(context) {
  const productKeys = new Set([...context.items, ...context.inventoryItems].map(row => row.sku || row.itemId || row.id).filter(Boolean))
  const products = [...productKeys].map(key => {
    const master = context.items.find(row => [row.sku, row.itemId, row.id].includes(key)) || {}
    const inventory = context.inventoryItems.find(row => [row.sku, row.itemId, row.id].includes(key)) || {}
    return { ...master, ...inventory, sku: inventory.sku || master.sku || key, name: master.name || master.itemName || inventory.name || inventory.itemName, currentStock: inventory.onHandQuantity ?? inventory.onHand ?? inventory.currentStock, reservedQuantity: inventory.reservedQuantity ?? inventory.reservedQty, availableQuantity: inventory.availableQuantity }
  })
  return {
    __dataMode: context.dataMode,
    users: [],
    products,
    suppliers: context.suppliers.map(row => ({ ...row, id: row.id || row.supplierCode, name: row.name || row.supplierName })),
    customers: context.customers,
    warehouses: context.warehouses,
    bins: context.bins,
    inventoryItems: context.inventoryItems,
    salesOrders: context.salesOrders,
    purchaseRequests: context.purchaseRequests.map(row => ({ ...row, pr: row.pr || row.id, sourceSku: row.sourceSku || row.lines?.[0]?.sku || row.lines?.[0]?.itemId, sourceName: row.sourceName || row.lines?.[0]?.itemNameSnapshot, amount: row.amount ?? row.totalAmount, supplier: row.supplier || row.lines?.[0]?.supplierSnapshot?.supplierName || row.lines?.[0]?.supplierId })),
    rfqs: context.rfqs,
    purchaseOrders: context.purchaseOrders.map(row => ({ ...row, po: row.po || row.id, sourceRequest: row.sourceRequest || row.sourcePrId, supplier: row.supplier || row.supplierSnapshot?.supplierName || row.supplierId, amount: row.amount ?? row.totalAmount, sourceSku: row.sourceSku || row.lines?.[0]?.sku || row.lines?.[0]?.itemId })),
    receivingDocs: context.receipts.map(row => ({ ...row, grn: row.grn || row.id || row.receiptId, po: row.po || row.poId || row.sourcePoId })),
    supplierInvoices: context.supplierInvoices.map(row => ({ ...row, invoiceNumber: row.invoiceNumber || row.id || row.invoiceId, relatedPo: row.relatedPo || row.poId, relatedGrn: row.relatedGrn || row.receiptId })),
    itemSupplierRelationships: context.itemSupplierRelationships,
    inventoryMovements: [],
    inventoryExceptions: [],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    sopCycles: [],
    events: [],
    auditLog: [],
    actionDrafts: [],
    __businessReadContext: context,
  }
}
