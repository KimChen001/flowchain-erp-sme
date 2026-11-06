const referenceCatalog = {
  departments: [
    { id: 'operations', code: 'OPERATIONS', label: '运营部', status: 'active' },
    { id: 'procurement', code: 'PROCUREMENT', label: '采购部', status: 'active' },
    { id: 'finance', code: 'FINANCE', label: '财务部', status: 'active' },
    { id: 'sales', code: 'SALES', label: '销售部', status: 'active' },
  ],
  currencies: ['CNY', 'USD', 'EUR'].map(code => ({ id: code, code, label: code, status: 'active' })),
  units: [
    { id: 'EA', code: 'EA', label: '件', status: 'active' },
    { id: 'SET', code: 'SET', label: '套', status: 'active' },
    { id: 'KG', code: 'KG', label: '千克', status: 'active' },
    { id: 'HOUR', code: 'HOUR', label: '小时', status: 'active' },
  ],
}

const active = rows => rows.filter(row => !['inactive', 'disabled'].includes(String(row.status || '').toLowerCase()))
const option = (row, fallbacks = {}) => ({
  id: String(row.id || fallbacks.id || row.code || ''),
  code: String(row.code || fallbacks.code || row.id || ''),
  label: String(row.label || row.name || fallbacks.label || row.code || row.id || ''),
  ...(fallbacks.metadata ? { metadata: fallbacks.metadata(row) } : {}),
})

export async function selectMasterData(repository, selector) {
  if (referenceCatalog[selector]) return active(referenceCatalog[selector]).map(row => option(row))
  if (selector === 'commodities') {
    const items = await repository.listManagedItems()
    return [...new Set(active(items).map(row => String(row.category || '').trim()).filter(Boolean))]
      .sort().map(code => ({ id: code, code, label: code }))
  }
  if (selector === 'warehouses') {
    return active(await repository.listWarehouses()).map(row => option(row, {
      id: row.warehouseCode,
      code: row.warehouseCode,
      label: row.warehouseName || row.name,
      metadata: value => ({ bin: value.bin || null }),
    }))
  }
  if (selector === 'payment-terms') return active(await repository.listPaymentTerms()).map(row => option(row, {
    metadata: value => ({ recordId: value.recordId ?? null }),
  }))
  if (selector === 'tax-codes') return active(await repository.listTaxCodes()).map(row => option(row, {
    metadata: value => ({ rate: value.rate ?? value.taxRate ?? null }),
  }))
  return null
}
