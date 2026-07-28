const clone = value => structuredClone(value)
const array = value => Array.isArray(value) ? value : []

async function call(repository, method, fallback = [], ...args) {
  if (!repository || typeof repository[method] !== 'function') return clone(fallback)
  return await repository[method](...args)
}

export function createBusinessReadContextService({ repositories = {}, dataMode = 'user' } = {}) {
  return {
    async read(options = {}) {
      const masterData = repositories.masterData
      const scope = { tenantId: options.tenantId }
      const itemMethod = typeof masterData?.listManagedItems === 'function' ? 'listManagedItems' : 'listItems'
      const [items, suppliers, customers, itemSupplierRelationships, inventoryItems, salesOrders, procurement] = await Promise.all([
        call(masterData, itemMethod, [], scope),
        call(masterData, 'listSuppliers', [], scope),
        call(masterData, 'listCustomers', [], scope),
        call(masterData, 'listAllItemSupplierRelationships', [], scope),
        call(repositories.inventoryRuntime, 'listItems', [], scope),
        call(repositories.salesOrders, 'listOrders', [], scope),
        call(repositories.procurementRuntime, 'snapshot', {}, scope),
      ])
      const dataLimitations = []
      if (!repositories.procurementRuntime) dataLimitations.push('procurement_runtime_unavailable')
      if (!repositories.inventoryRuntime) dataLimitations.push('inventory_runtime_unavailable')
      if (!repositories.salesOrders) dataLimitations.push('sales_runtime_unavailable')
      dataLimitations.push('warehouse_runtime_not_connected', 'bin_runtime_not_connected')
      if (array(procurement.receipts).length === 0) dataLimitations.push('receipt_runtime_has_no_records')
      if (array(procurement.supplierInvoices).length === 0) dataLimitations.push('invoice_runtime_has_no_records')

      return {
        dataMode,
        items: array(items),
        suppliers: array(suppliers),
        customers: array(customers),
        warehouses: [],
        bins: [],
        inventoryItems: array(inventoryItems),
        salesOrders: array(salesOrders),
        purchaseRequests: array(procurement.purchaseRequests),
        rfqs: array(procurement.rfqs),
        purchaseOrders: array(procurement.purchaseOrders),
        receipts: array(procurement.receipts),
        supplierInvoices: array(procurement.supplierInvoices),
        itemSupplierRelationships: array(itemSupplierRelationships),
        dataLimitations: [...new Set(dataLimitations)],
        runtimeAdapters: {
          items: masterData?.itemRuntime?.adapter || 'unavailable',
          suppliers: masterData?.supplierRuntime?.adapter || 'unavailable',
          customers: masterData?.customerRuntime?.adapter || 'unavailable',
          inventory: repositories.inventoryRuntime?.adapter || 'unavailable',
          salesOrders: repositories.salesOrders?.adapter || 'unavailable',
          procurement: repositories.procurementRuntime?.adapter || 'unavailable',
          warehouses: 'unavailable',
          bins: 'unavailable',
        },
        generatedAt: new Date().toISOString(),
      }
    },
  }
}

const updatedAt = record => String(record.updatedAt || record.createdAt || '')

export function buildHomeOverview(context) {
  const workItems = [
    ...context.purchaseRequests.filter(row => row.status === 'submitted').map(row => ({
      priority: '高', title: '采购申请待审批', id: row.id, description: `申请金额 ${row.totalAmount ?? '—'}`,
      canonicalRoute: `/app/procurement/requests/${encodeURIComponent(row.id)}`, entityType: 'purchase_request', updatedAt: updatedAt(row),
    })),
    ...context.purchaseRequests.filter(row => row.status === 'approved').map(row => ({
      priority: '中', title: '采购申请待转换', id: row.id, description: '审批已完成，等待生成 Draft PO',
      canonicalRoute: `/app/procurement/requests/${encodeURIComponent(row.id)}`, entityType: 'purchase_request', updatedAt: updatedAt(row),
    })),
    ...context.purchaseOrders.filter(row => row.status === 'draft').map(row => ({
      priority: '中', title: 'Draft PO 待复核', id: row.id, description: `供应商 ${row.supplierId || '—'} · ${row.transmissionStatus || '—'}`,
      canonicalRoute: `/app/procurement/orders/${encodeURIComponent(row.id)}`, entityType: 'purchase_order', updatedAt: updatedAt(row),
    })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10)

  const documents = [
    ...context.purchaseRequests.map(row => ({ type: '采购申请', entityType: 'purchase_request', id: row.id, status: row.status, supplier: row.lines?.[0]?.supplierSnapshot?.supplierName || row.lines?.[0]?.supplierId || '—', amount: row.totalAmount ?? null, updatedAt: updatedAt(row), canonicalRoute: `/app/procurement/requests/${encodeURIComponent(row.id)}` })),
    ...context.rfqs.map(row => ({ type: '询价', entityType: 'rfq', id: row.id, status: row.status, supplier: '—', amount: row.totalAmount ?? null, updatedAt: updatedAt(row), canonicalRoute: `/app/procurement/rfqs/${encodeURIComponent(row.id)}` })),
    ...context.purchaseOrders.map(row => ({ type: '采购订单', entityType: 'purchase_order', id: row.id, status: row.status, supplier: row.supplierSnapshot?.supplierName || row.supplierId || '—', amount: row.totalAmount ?? null, updatedAt: updatedAt(row), canonicalRoute: `/app/procurement/orders/${encodeURIComponent(row.id)}` })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const todayChanges = documents.filter(row => row.updatedAt.startsWith(today)).length
  const limitations = [...context.dataLimitations, 'unresolved_risk_metric_not_connected']
  return {
    workItems,
    unresolvedRisks: null,
    todayChanges,
    recentDocuments: documents,
    counts: { workItems: workItems.length, unresolvedRisks: null, todayChanges, recentDocuments: documents.length },
    limitations: [...new Set(limitations)],
    generatedAt: new Date().toISOString(),
  }
}
