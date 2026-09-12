import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const LOCAL_DEMO_VERSION = 4
export const LOCAL_DEMO_COUNTS = Object.freeze({ suppliers: 10, items: 6, customers: 3, warehouses: 1, locations: 3, paymentTerms: 2, taxCodes: 2, knowledgeDocuments: 2 })
const tenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local'
const marker = { localDemo: true, localDemoVersion: LOCAL_DEMO_VERSION }
export const LOCAL_DEMO_SUPPLIERS = [
  ['LOCAL-DEMO-SUP-001', 'LDS-001', 'Acme Components', 'Electronic components'],
  ['LOCAL-DEMO-SUP-002', 'LDS-002', 'Summit Packaging', 'Packaging materials'],
  ['LOCAL-DEMO-SUP-003', 'LDS-003', 'Atlas Industrial Supply', 'Industrial supplies'],
  ['LOCAL-DEMO-SUP-004', 'LDS-004', 'Horizon Logistics', 'Logistics services'],
  ['LOCAL-DEMO-SUP-005', 'LDS-005', 'Northstar Electronics', 'Electronic components', { contactName: 'Alex Morgan', email: 'sales@northstar.example.com', address: 'Austin, TX, USA', deliveryCycleDays: 7, businessType: 'Distributor' }],
  ['LOCAL-DEMO-SUP-006', 'LDS-006', 'Evergreen Packaging', 'Packaging materials', { contactName: 'Jordan Lee', email: 'sales@evergreen.example.com', address: 'Portland, OR, USA', deliveryCycleDays: 5, businessType: 'Manufacturer' }],
  ['LOCAL-DEMO-SUP-007', 'LDS-007', 'Precision Fastener Works', 'Industrial supplies', { contactName: 'Taylor Brooks', email: 'sales@precision.example.com', address: 'Cleveland, OH, USA', deliveryCycleDays: 10, businessType: 'Manufacturer' }],
  ['LOCAL-DEMO-SUP-008', 'LDS-008', 'Meridian Freight Services', 'Logistics services', { contactName: 'Casey Reed', email: 'sales@meridian.example.com', address: 'Chicago, IL, USA', deliveryCycleDays: 3, businessType: 'Service provider' }],
  ['LOCAL-DEMO-SUP-009', 'LDS-009', 'BluePeak Cable & Wire', 'Electronic components', { contactName: 'Sam Parker', email: 'sales@bluepeak.example.com', address: 'Raleigh, NC, USA', deliveryCycleDays: 14, businessType: 'Manufacturer' }],
  ['LOCAL-DEMO-SUP-010', 'LDS-010', 'ClearMark Labels', 'Packaging materials', { contactName: 'Robin Hayes', email: 'sales@clearmark.example.com', address: 'Denver, CO, USA', deliveryCycleDays: 4, businessType: 'Manufacturer' }],
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
const knowledgeDocuments = [
  {
    id: 'LOCAL-DEMO-KNOWLEDGE-PRODUCTS',
    title: 'US Demo Product Catalog',
    content: `FlowChain US demo product catalog.

LDM-001 Flow Controller is supplied by Acme Components. It is an electronic component ordered and counted in pieces. The demo inventory policy uses a safety stock of 10 pieces and a reorder point of 20 pieces. Inspect the model, quantity, connector condition, and visible shipping damage during receiving. Accepted stock is stored in location A-01.

LDM-002 Temperature Sensor is supplied by Acme Components. It is an electronic component counted in pieces. Verify the model and calibration label during receiving, and quarantine damaged or unidentified units in QC-01.

LDM-003 Shipping Carton is supplied by Summit Packaging and ordered by the box. LDM-004 Stainless Steel Fastener is supplied by Atlas Industrial Supply and counted in pieces. LDM-005 Shielded Control Cable is supplied by Acme Components and measured in feet. LDM-006 Product Label Roll is supplied by Summit Packaging and ordered by the roll.

These records are fictional demonstration data for FlowChain and must not be treated as manufacturer specifications.`,
  },
  {
    id: 'LOCAL-DEMO-KNOWLEDGE-POLICY',
    title: 'Procurement and Inventory Operating Policy',
    content: `FlowChain US demo procurement and inventory policy.

Purchase requests require human review before a purchase order is issued. Buyers should confirm the supplier, item, quantity, price, currency, required date, and approval evidence. Supplier selection should consider price, lead time, quality, delivery performance, and risk rather than price alone.

Receiving staff must match the delivery to the purchase order, record accepted and rejected quantities, and preserve evidence for discrepancies. Damaged, unidentified, or nonconforming goods must be placed in QC-01 and must not be posted as available inventory until reviewed.

Invoice review uses purchase order, receipt, and invoice evidence. Quantity, price, tax, or currency differences require human review. Payment, bank execution, tax filing, and general-ledger posting are outside the local demo boundary.

The AI assistant may retrieve evidence, explain risks, and prepare drafts. It must not approve orders, send supplier communications, post inventory, change master data, or execute financial transactions without an authorized human action.`,
  },
]

export async function seedLocalDemo(prisma, env = process.env) {
  assertLocalDevelopment(env, 'pilot:setup:demo')
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error('Run pilot:setup before pilot:setup:demo.')
  return prisma.$transaction(async tx => {
    for (const [id, code, name, category, profile = {}] of LOCAL_DEMO_SUPPLIERS) {
      const collision = await tx.supplier.findFirst({ where: { tenantId, code } })
      if (collision && collision.id !== id) throw new Error(`Refusing to overwrite non-demo supplier code ${code}.`)
      const data = { name, category, riskLevel: 'low', metadata: { ...marker, defaultCurrency: 'USD', paymentTermsId: 'LOCAL-DEMO-NET30', ...profile } }
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
    if (!localUsers.length) throw new Error('The local demo requires at least one active user.')
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
    for (const document of knowledgeDocuments) {
      await tx.aiKnowledgeDocument.upsert({
        where: { id: document.id },
        create: { id: document.id, tenantId, title: document.title, language: 'en-US', createdById: localUsers[0].id },
        update: { title: document.title, language: 'en-US', status: 'active', createdById: localUsers[0].id },
      })
      await tx.aiKnowledgeChunk.deleteMany({ where: { documentId: document.id } })
      await tx.aiKnowledgeChunk.create({ data: { id: `${document.id}-CHUNK-001`, documentId: document.id, position: 0, content: document.content, contentHash: createHash('sha256').update(document.content).digest('hex') } })
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
