import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const LOCAL_DEMO_VERSION = 1
export const LOCAL_DEMO_COUNTS = Object.freeze({ suppliers: 4, items: 6, customers: 3, warehouses: 1, locations: 3, paymentTerms: 2, taxCodes: 2 })
const tenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local'
const marker = { localDemo: true, localDemoVersion: LOCAL_DEMO_VERSION }
const suppliers = [
  ['LOCAL-DEMO-SUP-001', 'LDS-001', '本地演示供应商 A', '电子元件'],
  ['LOCAL-DEMO-SUP-002', 'LDS-002', '本地演示供应商 B', '包装材料'],
  ['LOCAL-DEMO-SUP-003', 'LDS-003', '本地演示供应商 C', '工业品'],
  ['LOCAL-DEMO-SUP-004', 'LDS-004', '本地演示供应商 D', '物流服务'],
]
const items = [
  ['LOCAL-DEMO-ITEM-001', 'LDM-001', '本地演示控制器', '电子元件', 'pcs', 'LOCAL-DEMO-SUP-001'],
  ['LOCAL-DEMO-ITEM-002', 'LDM-002', '本地演示传感器', '电子元件', 'pcs', 'LOCAL-DEMO-SUP-001'],
  ['LOCAL-DEMO-ITEM-003', 'LDM-003', '本地演示纸箱', '包装材料', 'box', 'LOCAL-DEMO-SUP-002'],
  ['LOCAL-DEMO-ITEM-004', 'LDM-004', '本地演示紧固件', '工业品', 'pcs', 'LOCAL-DEMO-SUP-003'],
  ['LOCAL-DEMO-ITEM-005', 'LDM-005', '本地演示电缆', '电子元件', 'm', 'LOCAL-DEMO-SUP-001'],
  ['LOCAL-DEMO-ITEM-006', 'LDM-006', '本地演示标签', '包装材料', 'roll', 'LOCAL-DEMO-SUP-002'],
]
const customers = [
  ['LOCAL-DEMO-CUS-001', 'LDC-001', '本地演示客户 A'],
  ['LOCAL-DEMO-CUS-002', 'LDC-002', '本地演示客户 B'],
  ['LOCAL-DEMO-CUS-003', 'LDC-003', '本地演示客户 C'],
]

export async function seedLocalDemo(prisma, env = process.env) {
  assertLocalDevelopment(env, 'pilot:setup:demo')
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error('Run pilot:setup before pilot:setup:demo.')
  return prisma.$transaction(async tx => {
    for (const [id, code, name, category] of suppliers) {
      const collision = await tx.supplier.findFirst({ where: { tenantId, code } })
      if (collision && collision.id !== id) throw new Error(`Refusing to overwrite non-demo supplier code ${code}.`)
      await tx.supplier.upsert({ where: { id }, create: { id, tenantId, code, name, category, riskLevel: 'low', metadata: { ...marker, defaultCurrency: 'CNY', paymentTermsId: 'LOCAL-DEMO-NET30' } }, update: {} })
    }
    for (const [id, sku, name, category, unit, preferredSupplierId] of items) {
      const collision = await tx.item.findFirst({ where: { tenantId, sku } })
      if (collision && collision.id !== id) throw new Error(`Refusing to overwrite non-demo item SKU ${sku}.`)
      await tx.item.upsert({ where: { id }, create: { id, tenantId, sku, name, category, unit, preferredSupplierId, safetyStock: 10, reorderPoint: 20, metadata: { ...marker, defaultWarehouseId: 'LOCAL-DEMO-WH-001' } }, update: {} })
    }
    for (const [id, recordKey, name] of customers) {
      await tx.runtimeRecord.upsert({
        where: { tenantId_namespace_recordKey: { tenantId, namespace: 'master-data.customers', recordKey } },
        create: { id, tenantId, namespace: 'master-data.customers', recordKey, payload: { id, code: recordKey, name, status: 'active', currency: 'CNY', ...marker } },
        update: {},
      })
    }
    await tx.warehouse.upsert({ where: { id: 'LOCAL-DEMO-WH-001' }, create: { id: 'LOCAL-DEMO-WH-001', tenantId, code: 'LOCAL-DEMO', name: '本地演示仓', metadata: marker }, update: {} })
    for (const code of ['A-01', 'A-02', 'QC-01']) {
      const id = `LOCAL-DEMO-LOC-${code.replace('-', '')}`
      await tx.warehouseLocation.upsert({ where: { id }, create: { id, tenantId, warehouseId: 'LOCAL-DEMO-WH-001', code, locationKey: code.toLowerCase(), name: `本地演示库位 ${code}` }, update: {} })
    }
    for (const [id, code, name, days] of [['LOCAL-DEMO-NET30', 'NET30', '30 天账期', 30], ['LOCAL-DEMO-COD', 'COD', '货到付款', 0]]) {
      await tx.paymentTerm.upsert({ where: { id }, create: { id, tenantId, code, name, days, metadata: marker }, update: {} })
    }
    for (const [id, code, name, rate] of [['LOCAL-DEMO-TAX13', 'VAT13', '增值税 13%', 0.13], ['LOCAL-DEMO-TAX0', 'VAT0', '零税率', 0]]) {
      await tx.taxCode.upsert({ where: { id }, create: { id, tenantId, code, name, rate, taxType: 'VAT', region: 'CN', metadata: marker }, update: {} })
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
