import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let modulePromise

async function loadMappingModule() {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'master-data-api-'))
    const outfile = path.join(dir, 'api.mjs')
    await build({
      entryPoints: ['src/modules/master-data/api.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['react', 'react-dom'],
      logLevel: 'silent',
    })
    const mod = await import(pathToFileURL(outfile).href)
    return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return modulePromise
}

test.after(async () => {
  if (!modulePromise) return
  const loaded = await modulePromise
  await loaded.cleanup()
})

const fallbackItems = [
  {
    sku: 'SKU-001',
    name: 'Fallback Motor',
    category: 'Fallback Category',
    specification: '750W fallback spec',
    unit: '件',
    defaultWarehouse: '上海总仓',
    defaultBin: 'A-01',
    safetyStock: 10,
    maxStock: 100,
    reorderPoint: 30,
    leadTimeDays: 5,
    batchManaged: true,
    serialManaged: true,
    qaRequired: true,
    defaultSupplier: 'Fallback Supplier',
    defaultTaxCode: 'VAT13-IN',
    status: '启用',
  },
]

const fallbackSuppliers = [
  {
    code: 'SUP-001',
    name: 'Resolved Supplier',
    category: 'Fallback Supplier Category',
    contact: '王经理',
    email: 'supplier@example.test',
    phone: '021-0000',
    paymentTerms: 'NET30',
    currency: 'CNY',
    taxId: 'TAX-ID',
    defaultTaxCode: 'VAT13-IN',
    rating: 4.2,
    onTimeRate: 91,
    qualityRate: 96,
    riskStatus: '中',
    certificationStatus: '待复核',
    status: '启用',
  },
]

const fallbackWarehouses = [
  {
    warehouseCode: 'WH-01',
    warehouseName: 'Fallback Warehouse',
    zone: 'A区',
    bin: 'A-01',
    capacity: 500,
    utilization: 0.42,
    temperatureRequirement: '常温',
    qaStatus: '可用',
    available: true,
    owner: '刘建华',
  },
]

const fallbackPaymentTerms = [
  {
    code: 'NET30',
    name: 'Net 30',
    netDays: 30,
    discountRule: '无现金折扣',
    dueDateRule: '发票日期后 30 天到期',
    status: '启用',
    description: 'Fallback payment term',
  },
]

const fallbackTaxCodes = [
  {
    code: 'VAT13-IN',
    name: '进项税 13%',
    rate: 0.13,
    type: '进项税',
    region: '中国大陆',
    isDefault: true,
    status: '启用',
    description: 'Fallback tax code',
  },
]

test('normalizeItemRows maps API item fields and preserves fallback-only fields', async () => {
  const { mod } = await loadMappingModule()
  const rows = mod.normalizeItemRows([
    {
      id: 'ITEM-001',
      sku: 'SKU-001',
      name: 'API Motor',
      category: 'API Category',
      baseUom: '台',
      defaultWarehouseId: 'WH-API',
      preferredSupplierId: 'SUP-001',
      leadTimeDays: 12,
      moq: 80,
      status: 'pending',
    },
  ], fallbackItems, fallbackSuppliers)

  assert.equal(rows[0].sku, 'SKU-001')
  assert.equal(rows[0].name, 'API Motor')
  assert.equal(rows[0].category, 'API Category')
  assert.equal(rows[0].unit, '台')
  assert.equal(rows[0].defaultWarehouse, 'WH-API')
  assert.equal(rows[0].defaultSupplier, 'Resolved Supplier')
  assert.equal(rows[0].leadTimeDays, 12)
  assert.equal(rows[0].reorderPoint, 80)
  assert.equal(rows[0].status, '待完善')
  assert.equal(rows[0].specification, '750W fallback spec')
  assert.equal(rows[0].safetyStock, 10)
  assert.equal(rows[0].batchManaged, true)
  assert.equal(rows[0].serialManaged, true)
  assert.equal(rows[0].qaRequired, true)
  assert.equal(rows[0].defaultTaxCode, 'VAT13-IN')
  assert.equal(mod.normalizeItemRows(undefined, fallbackItems, fallbackSuppliers), fallbackItems)
})

test('normalizeSupplierRows maps API supplier fields, risk values, and fallback details', async () => {
  const { mod } = await loadMappingModule()
  const rows = mod.normalizeSupplierRows([
    {
      id: 'SUP-001',
      name: 'API Supplier',
      status: 'inactive',
      risk: 'high',
      score: '4.8',
      defaultCurrency: 'USD',
      paymentTermsId: 'NET45',
      categories: ['电气元件'],
      preferred: true,
    },
    {
      id: 'SUP-002',
      name: 'Chinese Risk Supplier',
      risk: '低',
    },
  ], fallbackSuppliers)

  assert.equal(rows[0].code, 'SUP-001')
  assert.equal(rows[0].name, 'API Supplier')
  assert.equal(rows[0].category, '电气元件')
  assert.equal(rows[0].paymentTerms, 'NET45')
  assert.equal(rows[0].currency, 'USD')
  assert.equal(rows[0].rating, 4.8)
  assert.equal(rows[0].riskStatus, '高')
  assert.equal(rows[0].status, '停用')
  assert.equal(rows[0].contact, '王经理')
  assert.equal(rows[0].email, 'supplier@example.test')
  assert.equal(rows[0].phone, '021-0000')
  assert.equal(rows[0].taxId, 'TAX-ID')
  assert.equal(rows[0].defaultTaxCode, 'VAT13-IN')
  assert.equal(rows[0].onTimeRate, 91)
  assert.equal(rows[0].qualityRate, 96)
  assert.equal(rows[1].riskStatus, '低')
  assert.equal(mod.normalizeSupplierRows(undefined, fallbackSuppliers), fallbackSuppliers)
})

test('normalizeWarehouseRows maps API warehouse fields and lets blocked status override fallback availability', async () => {
  const { mod } = await loadMappingModule()
  const rows = mod.normalizeWarehouseRows([
    {
      id: 'WH-01',
      name: 'API Warehouse',
      type: 'warehouse',
      status: 'frozen',
      parentId: null,
    },
  ], fallbackWarehouses)

  assert.equal(rows[0].warehouseCode, 'WH-01')
  assert.equal(rows[0].warehouseName, 'API Warehouse')
  assert.equal(rows[0].zone, 'A区')
  assert.equal(rows[0].bin, 'A-01')
  assert.equal(rows[0].capacity, 500)
  assert.equal(rows[0].utilization, 0.42)
  assert.equal(rows[0].owner, '刘建华')
  assert.equal(rows[0].temperatureRequirement, '常温')
  assert.equal(rows[0].qaStatus, '冻结')
  assert.equal(rows[0].available, false)
  assert.equal(mod.normalizeWarehouseRows(undefined, fallbackWarehouses), fallbackWarehouses)
})

test('normalizePaymentTermRows maps API terms and preserves fallback presentation fields', async () => {
  const { mod } = await loadMappingModule()
  const rows = mod.normalizePaymentTermRows([
    {
      id: 'NET30',
      label: 'API Net 30',
      days: 45,
      status: 'review',
    },
  ], fallbackPaymentTerms)

  assert.equal(rows[0].code, 'NET30')
  assert.equal(rows[0].name, 'API Net 30')
  assert.equal(rows[0].netDays, 45)
  assert.equal(rows[0].status, '待复核')
  assert.equal(rows[0].discountRule, '无现金折扣')
  assert.equal(rows[0].dueDateRule, '发票日期后 30 天到期')
  assert.equal(rows[0].description, 'Fallback payment term')
  assert.equal(mod.normalizePaymentTermRows(undefined, fallbackPaymentTerms), fallbackPaymentTerms)
})

test('normalizeTaxCodeRows maps API tax codes and preserves fallback classification fields', async () => {
  const { mod } = await loadMappingModule()
  const rows = mod.normalizeTaxCodeRows([
    {
      id: 'VAT13-IN',
      label: 'API VAT 13%',
      rate: 0.09,
      status: 'disabled',
    },
    {
      id: 'VAT00-NEW',
      label: 'Zero Rated',
      rate: 0,
      status: 'active',
    },
  ], fallbackTaxCodes)

  assert.equal(rows[0].code, 'VAT13-IN')
  assert.equal(rows[0].name, 'API VAT 13%')
  assert.equal(rows[0].rate, 0.09)
  assert.equal(rows[0].type, '进项税')
  assert.equal(rows[0].region, '中国大陆')
  assert.equal(rows[0].isDefault, true)
  assert.equal(rows[0].status, '停用')
  assert.equal(rows[0].description, 'Fallback tax code')
  assert.equal(rows[1].type, '')
  assert.equal(rows[1].isDefault, false)
  assert.equal(mod.normalizeTaxCodeRows(undefined, fallbackTaxCodes), fallbackTaxCodes)
})

test('normalizers show only recorded facts and never assume a country, currency or tax regime', async () => {
  const { mod } = await loadMappingModule()
  const [tax] = mod.normalizeTaxCodeRows([{ id: 'SALES825', label: 'Sales tax 8.25%', rate: 0.0825, taxType: 'sales_tax', region: 'US', status: 'active' }], [])
  assert.deepEqual({ type: tax.type, region: tax.region, rate: tax.rate, isDefault: tax.isDefault }, { type: 'sales_tax', region: 'US', rate: 0.0825, isDefault: false })
  const [unknownTax] = mod.normalizeTaxCodeRows([{ id: 'NEW', label: 'New code', rate: 0.05 }], [])
  assert.deepEqual({ type: unknownTax.type, region: unknownTax.region }, { type: '', region: '' })

  const [term] = mod.normalizePaymentTermRows([{ id: 'NET30', label: 'Net 30', days: 30 }], [])
  assert.deepEqual({ discountRule: term.discountRule, dueDateRule: term.dueDateRule, netDays: term.netDays }, { discountRule: '', dueDateRule: '', netDays: 30 })

  const [warehouse] = mod.normalizeWarehouseRows([{ id: 'WH-1', name: 'Main Warehouse', type: 'warehouse', status: 'active' }], [])
  // The readable code is shown and the record id kept for links.
  const [coded] = mod.normalizeWarehouseRows([{ id: 'WH-63a144d0', code: 'MAIN', name: 'Main Warehouse', status: 'active' }], [])
  assert.deepEqual({ code: coded.warehouseCode, id: coded.warehouseId }, { code: 'MAIN', id: 'WH-63a144d0' })
  assert.deepEqual({ zone: warehouse.zone, bin: warehouse.bin, temperature: warehouse.temperatureRequirement }, { zone: '', bin: '', temperature: '' })

  const [supplier] = mod.normalizeSupplierRows([{ id: 'SUP-1', name: 'Northstar', preferred: true }], [])
  assert.deepEqual({ currency: supplier.currency, certification: supplier.certificationStatus, category: supplier.category }, { currency: '', certification: '', category: '' })

  const [item] = mod.normalizeItemRows([{ id: 'ITEM-1', sku: 'SKU-1', name: 'Widget' }], [], [])
  assert.deepEqual({ unit: item.unit, category: item.category }, { unit: '', category: '' })

  const customers = mod.normalizeCustomerRows([
    { code: 'LDC-001', name: 'Redwood Retail', status: 'active' },
    { code: 'LDC-002', name: 'Bluebird', status: 'inactive', creditStatus: 'restricted' },
  ])
  assert.deepEqual(customers.map((row) => [row.status, row.creditStatus]), [['启用', ''], ['停用', '受限']])

  const shown = JSON.stringify([tax, unknownTax, term, warehouse, supplier, item, customers])
  assert.doesNotMatch(shown, /中国大陆|进项税|常温|无现金折扣|CNY|未分类|件|已认证/)
})