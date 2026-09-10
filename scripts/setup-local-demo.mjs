import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const LOCAL_DEMO_VERSION = 2
export const LOCAL_DEMO_COUNTS = Object.freeze({ suppliers: 4, items: 6, customers: 3, warehouses: 1, locations: 3, paymentTerms: 2, taxCodes: 2 })
const tenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local'
const marker = { localDemo: true, localDemoVersion: LOCAL_DEMO_VERSION }
const suppliers = [
  ['LOCAL-DEMO-SUP-001', 'LDS-001', 'Acme Components', 'Electronic components'],
  ['LOCAL-DEMO-SUP-002', 'LDS-002', 'Summit Packaging', 'Packaging materials'],
  ['LOCAL-DEMO-SUP-003', 'LDS-003', 'Atlas Industrial Supply', 'Industrial supplies'],
  ['LOCAL-DEMO-SUP-004', 'LDS-004', 'Horizon Logistics', 'Logistics services'],
]
const items = [
  ['LOCAL-DEMO-ITEM-001', 'LDM-001', 'Flow Controller', 'Electronic components', 'pcs', 'LOCAL-DEMO-SUP-001'],
  ['LOCAL-DEMO-ITEM-002', 'LDM-002', 'Temperature Sensor', 'Electronic components', 'pcs', 'LOCAL-DEMO-SUP-001'],
  ['LOCAL-DEMO-ITEM-003', 'LDM-003', 'Shipping Carton', 'Packaging materials', 'box', 'LOCAL-DEMO-SUP-002'],
  ['LOCAL-DEMO-ITEM-004', 'LDM-004', 'Stainless Steel Fastener', 'Industrial supplies', 'pcs', 'LOCAL-DEMO-SUP-003'],
  ['LOCAL-DEMO-ITEM-005', 'LDM-005', 'Shielded Control Cable', 'Electronic components', 'ft', 'LOCAL-DEMO-SUP-001'],
  ['LOCAL-DEMO-ITEM-006', 'LDM-006', 'Product Label Roll', 'Packaging materials', 'roll', 'LOCAL-DEMO-SUP-002'],
]
const customers = [
  ['LOCAL-DEMO-CUS-001', 'LDC-001', 'Redwood Retail'],
  ['LOCAL-DEMO-CUS-002', 'LDC-002', 'Bluebird Distribution'],
  ['LOCAL-DEMO-CUS-003', 'LDC-003', 'Metro Service Group'],
]

export async function seedLocalDemo(prisma, env = process.env) {
  assertLocalDevelopment(env, 'pilot:setup:demo')
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error('Run pilot:setup before pilot:setup:demo.')
  return prisma.$transaction(async tx => {
    for (const [id, code, name, category] of suppliers) {
      const collision = await tx.supplier.findFirst({ where: { tenantId, code } })
      if (collision && collision.id !== id) throw new Error(`Refusing to overwrite non-demo supplier code ${code}.`)
      const data = { name, category, riskLevel: 'low', metadata: { ...marker, defaultCurrency: 'USD', paymentTermsId: 'LOCAL-DEMO-NET30' } }
      await tx.supplier.upsert({ where: { id }, create: { id, tenantId, code, ...data }, update: data })
    }
    for (const [id, sku, name, category, unit, preferredSupplierId] of items) {
      const collision = await tx.item.findFirst({ where: { tenantId, sku } })
      if (collision && collision.id !== id) throw new Error(`Refusing to overwrite non-demo item SKU ${sku}.`)
      const data = { name, category, unit, preferredSupplierId, safetyStock: 10, reorderPoint: 20, metadata: { ...marker, defaultWarehouseId: 'LOCAL-DEMO-WH-001' } }
      await tx.item.upsert({ where: { id }, create: { id, tenantId, sku, ...data }, update: data })
    }
    for (const [id, recordKey, name] of customers) {
      await tx.runtimeRecord.upsert({
        where: { tenantId_namespace_recordKey: { tenantId, namespace: 'master-data.customers', recordKey } },
        create: { id, tenantId, namespace: 'master-data.customers', recordKey, payload: { id, code: recordKey, name, status: 'active', currency: 'USD', ...marker } },
        update: { payload: { id, code: recordKey, name, status: 'active', currency: 'USD', ...marker } },
      })
    }
    await tx.warehouse.upsert({ where: { id: 'LOCAL-DEMO-WH-001' }, create: { id: 'LOCAL-DEMO-WH-001', tenantId, code: 'US-DEMO', name: 'US Demo Warehouse', metadata: marker }, update: { code: 'US-DEMO', name: 'US Demo Warehouse', metadata: marker } })
    const localUsers = await tx.user.findMany({ where: { tenantId, status: 'active' }, select: { id: true } })
    for (const user of localUsers) {
      await tx.userWarehouseScope.upsert({
        where: { tenantId_userId_warehouseId: { tenantId, userId: user.id, warehouseId: 'LOCAL-DEMO-WH-001' } },
        create: { id: `LOCAL-DEMO-SCOPE-${user.id}`, tenantId, userId: user.id, warehouseId: 'LOCAL-DEMO-WH-001', accessLevel: 'operate' },
        update: { accessLevel: 'operate' },
      })
    }
    for (const code of ['A-01', 'A-02', 'QC-01']) {
      const id = `LOCAL-DEMO-LOC-${code.replace('-', '')}`
      const name = `US Demo Location ${code}`
      await tx.warehouseLocation.upsert({ where: { id }, create: { id, tenantId, warehouseId: 'LOCAL-DEMO-WH-001', code, locationKey: code.toLowerCase(), name }, update: { name } })
    }
    for (const [id, code, name, days] of [['LOCAL-DEMO-NET30', 'NET30', 'Net 30', 30], ['LOCAL-DEMO-COD', 'DUE', 'Due on receipt', 0]]) {
      await tx.paymentTerm.upsert({ where: { id }, create: { id, tenantId, code, name, days, metadata: marker }, update: { code, name, days, metadata: marker } })
    }
    for (const [id, code, name, rate] of [['LOCAL-DEMO-TAX13', 'SALES825', 'Sales tax 8.25%', 0.0825], ['LOCAL-DEMO-TAX0', 'TAXEXEMPT', 'Tax exempt', 0]]) {
      await tx.taxCode.upsert({ where: { id }, create: { id, tenantId, code, name, rate, taxType: 'sales_tax', region: 'US', metadata: marker }, update: { code, name, rate, taxType: 'sales_tax', region: 'US', metadata: marker } })
    }
    return LOCAL_DEMO_COUNTS
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  assertLocalDevelopment(process.env, 'pilot:setup:demo')
  const prisma = await getPrismaClient(process.env)
  try {
    const counts = await seedLocalDemo(prisma)
    console.log(`Local demo v${LOCAL_DEMO_VERSION} ready: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`)
  } finally {
    await disconnectPrismaClient()
  }
}
