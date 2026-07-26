import { createAiUserScenarioDb } from './ai-user-scenario.mjs'

export function createProductReviewScenarioDb() {
  const db = createAiUserScenarioDb()
  const sku = 'SKU-00412'
  const supplierId = 'SUP-SZXY'
  const supplierName = '深圳新元电气'

  db.products[0] = {
    ...db.products[0],
    sku,
    name: '伺服驱动器组件',
    preferredSupplier: supplierId,
  }
  db.suppliers[0] = {
    ...db.suppliers[0],
    id: supplierId,
    code: supplierId,
    name: supplierName,
  }
  db.purchaseRequests[0] = {
    ...db.purchaseRequests[0],
    pr: 'PR-2026-2401',
    sourceSku: sku,
    sourceName: db.products[0].name,
    supplier: supplierName,
    linkedPo: 'PO-2026-1282',
  }
  db.rfqs[0] = {
    ...db.rfqs[0],
    id: 'RFQ-26-0046',
    title: `${sku} ${db.products[0].name}询价`,
    sourceRequest: db.purchaseRequests[0].pr,
    linkedPo: 'PO-2026-1282',
    bestSupplier: supplierName,
  }
  db.purchaseOrders[0] = {
    ...db.purchaseOrders[0],
    po: 'PO-2026-1282',
    supplier: supplierName,
    sourceRequest: db.purchaseRequests[0].pr,
    sourceRfq: db.rfqs[0].id,
    items: 9,
    received: 5,
    lines: db.purchaseOrders[0].lines.map((line) => ({
      ...line,
      sku,
      name: db.products[0].name,
      quantityOrdered: 9,
      quantity: 9,
      received: 5,
    })),
  }
  db.receivingDocs[0] = {
    ...db.receivingDocs[0],
    grn: 'GRN-202605-0419',
    po: db.purchaseOrders[0].po,
    supplier: supplierName,
    items: 5,
    passed: 4,
    failed: 1,
  }
  db.supplierInvoices[0] = {
    ...db.supplierInvoices[0],
    invoiceNumber: 'INV-SZ-260601',
    supplier: supplierName,
    relatedPo: db.purchaseOrders[0].po,
    relatedGrn: db.receivingDocs[0].grn,
  }
  db.inventoryMovements[0] = {
    ...db.inventoryMovements[0],
    sku,
    itemName: db.products[0].name,
    sourceDocument: db.receivingDocs[0].grn,
  }
  db.inventoryExceptions[0] = {
    ...db.inventoryExceptions[0],
    sku,
    itemName: db.products[0].name,
  }
  db.salesOrders = [
    {
      salesOrderId: 'SO-2026-0412-A',
      customerName: '华东精密制造',
      customerTier: '重点客户',
      sku,
      itemName: db.products[0].name,
      orderedQty: 12,
      reservedQty: 4,
      fulfilledQty: 0,
      requestedDate: '2026-07-09',
      promisedDate: '2026-07-12',
      status: 'shortage_risk',
      priority: '高',
      linkedPurchaseOrders: [db.purchaseOrders[0].po],
      linkedSuppliers: [supplierName],
    },
  ]
  db.products.push(
    { ...db.products[0], sku: 'SKU-TEST-002', name: '测试轴承组件', currentStock: 40, availableQuantity: 40, riskLevel: '低' },
    { ...db.products[0], sku: 'SKU-TEST-003', name: '测试传感器', currentStock: 12, availableQuantity: 12, riskLevel: '中' },
  )
  db.suppliers.push(
    { ...db.suppliers[0], id: 'SUP-TEST-002', code: 'SUP-TEST-002', name: '测试供应商二号', risk: '低', riskStatus: '低风险' },
    { ...db.suppliers[0], id: 'SUP-TEST-003', code: 'SUP-TEST-003', name: '测试供应商三号', risk: '中', riskStatus: '中风险' },
  )
  db.users = [
    { id: 'USR-ADMIN', name: 'Admin User', role: 'admin', status: 'active' },
    { id: 'USR-BUYER', name: 'Buyer User', role: 'buyer', status: 'active' },
    { id: 'USR-WAREHOUSE', name: 'Warehouse User', role: 'warehouse', status: 'active' },
    { id: 'USR-VIEWER', name: 'Viewer User', role: 'viewer', status: 'active' },
  ]
  db.salesForecasts = [
    { sku, itemName: db.products[0].name, forecastQuantity: 180, period: '2026-07' },
  ]
  db.marketSignals = [
    { id: 'SIGNAL-TEST-1', sku, type: 'demand_increase', severity: 'medium' },
  ]
  db.marketPrices = [
    { id: 'PRICE-TEST-1', sku, supplier: supplierName, unitPrice: 800, currency: 'CNY' },
  ]
  db.sopCycles = [
    { id: 'SOP-TEST-1', period: '2026-07', status: 'review', owner: 'Planning User' },
  ]
  db.events = [
    { id: 'EVENT-TEST-1', type: 'purchase_order_updated', entityId: db.purchaseOrders[0].po, createdAt: '2026-07-01T00:00:00.000Z' },
  ]

  return db
}
