import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const LOCAL_SCENARIO_COUNTS = Object.freeze({ purchaseRequests: 1, purchaseOrders: 2, receivingDocuments: 1, supplierInvoices: 1, inventoryBalances: 2, salesOrders: 1 })
const tenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local'
const metadata = { localDemo: true, localDemoScenarioVersion: 1 }

export async function seedLocalScenario(prisma, env = process.env) {
  assertLocalDevelopment(env, 'pilot:setup:scenario')
  if (!await prisma.item.findUnique({ where: { id: 'LOCAL-DEMO-ITEM-001' } })) throw new Error('Run pilot:setup:demo before pilot:setup:scenario.')
  return prisma.$transaction(async tx => {
    await tx.purchaseRequest.upsert({
      where: { id: 'LOCAL-DEMO-PR-001' },
      create: { id: 'LOCAL-DEMO-PR-001', tenantId, status: 'open', requester: 'Local Demo', priority: 'high', requiredDate: new Date('2030-01-15T00:00:00Z'), amount: 5000, source: 'local_demo_scenario', metadata, lines: { create: [{ id: 'LOCAL-DEMO-PRL-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: '本地演示控制器', quantity: 50, unit: 'pcs', unitPrice: 100, amount: 5000, metadata }] } },
      update: {},
    })
      for (const [id, status, itemId, sku, quantity, receivedQuantity, expectedDate] of [
        ['LOCAL-DEMO-PO-001', 'partially_received', 'LOCAL-DEMO-ITEM-001', 'LDM-001', 50, 20, '2030-01-12T00:00:00Z'],
        ['LOCAL-DEMO-PO-002', 'open', 'LOCAL-DEMO-ITEM-002', 'LDM-002', 40, 0, '2030-01-18T00:00:00Z'],
      ]) {
        const poMetadata = { ...metadata, transmissionStatus: 'sent', targetWarehouseId: 'LOCAL-DEMO-WH-001' }
        await tx.purchaseOrder.upsert({
          where: { id },
          create: { id, tenantId, status, supplierId: 'LOCAL-DEMO-SUP-001', supplierName: '本地演示供应商 A', sourceRequestId: 'LOCAL-DEMO-PR-001', expectedDate: new Date(expectedDate), amount: quantity * 100, currency: 'CNY', owner: 'Local Demo', priority: id.endsWith('002') ? 'high' : 'medium', metadata: poMetadata, lines: { create: [{ id: `${id}-LINE-001`, itemId, sku, itemName: sku === 'LDM-001' ? '本地演示控制器' : '本地演示传感器', orderedQuantity: quantity, receivedQuantity, unit: 'pcs', unitPrice: 100, amount: quantity * 100, metadata: { ...metadata, targetWarehouseId: 'LOCAL-DEMO-WH-001', requestedDate: '2030-01-15', promisedDate: expectedDate.slice(0, 10) } }] } },
          update: { status, expectedDate: new Date(expectedDate), metadata: poMetadata },
        })
      }
    await tx.receivingDocument.upsert({
      where: { id: 'LOCAL-DEMO-GRN-001' },
      create: { id: 'LOCAL-DEMO-GRN-001', tenantId, documentNumber: 'LOCAL-DEMO-GRN-001', poId: 'LOCAL-DEMO-PO-001', supplierId: 'LOCAL-DEMO-SUP-001', supplierName: '本地演示供应商 A', status: 'partial', workflowStatus: 'received', postingStatus: 'unposted', warehouseId: 'LOCAL-DEMO-WH-001', receiver: 'Local Demo', metadata, lines: { create: [{ id: 'LOCAL-DEMO-GRNL-001', purchaseOrderLineId: 'LOCAL-DEMO-PO-001-LINE-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: '本地演示控制器', acceptedQty: 20, rejectedQty: 0, unit: 'pcs', warehouseId: 'LOCAL-DEMO-WH-001', location: 'A-01', locationKey: 'a-01', metadata }] } },
      update: {},
    })
    await tx.supplierInvoice.upsert({
      where: { id: 'LOCAL-DEMO-INV-001' },
      create: { id: 'LOCAL-DEMO-INV-001', tenantId, invoiceNumber: 'LOCAL-DEMO-INV-001', supplierId: 'LOCAL-DEMO-SUP-001', supplierName: '本地演示供应商 A', relatedPoId: 'LOCAL-DEMO-PO-001', relatedGrnId: 'LOCAL-DEMO-GRN-001', subtotalAmount: 2200, enteredTaxAmount: 286, totalAmount: 2486, amount: 2486, currency: 'CNY', status: 'review', matchStatus: 'variance', varianceAmount: 486, metadata: { ...metadata, varianceType: '金额差异' } },
      update: { matchStatus: 'variance', varianceAmount: 486, metadata: { ...metadata, varianceType: '金额差异' } },
    })
    await tx.supplierInvoiceLine.upsert({
      where: { id: 'LOCAL-DEMO-INVL-001' },
      create: { id: 'LOCAL-DEMO-INVL-001', supplierInvoiceId: 'LOCAL-DEMO-INV-001', lineNumber: 1, purchaseOrderLineId: 'LOCAL-DEMO-PO-001-LINE-001', receivingLineId: 'LOCAL-DEMO-GRNL-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: '本地演示控制器', quantity: 20, unit: 'pcs', unitPrice: 110, lineAmount: 2200, enteredTaxAmount: 286, amount: 2486, metadata: { ...metadata, varianceType: '价格差异', varianceAmount: 486 } },
      update: {},
    })
    for (const [id, itemId, sku, itemName, onHandQuantity, safetyStock, riskLevel] of [
      ['LOCAL-DEMO-BAL-001', 'LOCAL-DEMO-ITEM-001', 'LDM-001', '本地演示控制器', 8, 20, 'shortage'],
      ['LOCAL-DEMO-BAL-002', 'LOCAL-DEMO-ITEM-002', 'LDM-002', '本地演示传感器', 60, 15, 'normal'],
    ]) {
      await tx.inventoryBalance.upsert({
        where: { id },
        create: {
          id, tenantId, itemId, sku, itemName, warehouseId: 'LOCAL-DEMO-WH-001',
          warehouseKey: 'LOCAL-DEMO-WH-001', location: 'A-01', locationKey: 'a-01',
          onHandQuantity, availableQuantity: onHandQuantity, reservedQuantity: 0,
          safetyStock, reorderPoint: safetyStock, unit: 'pcs', status: 'active',
          riskLevel, metadata,
        },
        update: {},
      })
    }
    await tx.salesOrder.upsert({
      where: { id: 'LOCAL-DEMO-SO-001' },
      create: { id: 'LOCAL-DEMO-SO-001', tenantId, orderNumber: 'LOCAL-DEMO-SO-001', customerId: 'LOCAL-DEMO-CUS-001', customerName: '本地演示客户 A', workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', promisedDate: new Date('2030-01-20T00:00:00Z'), currency: 'CNY', metadata, lines: { create: [{ id: 'LOCAL-DEMO-SOL-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: '本地演示控制器', orderedQuantity: 35, unit: 'pcs', unitPrice: 180, amount: 6300, metadata }] } },
      update: {},
    })
    return LOCAL_SCENARIO_COUNTS
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  assertLocalDevelopment(process.env, 'pilot:setup:scenario')
  const prisma = await getPrismaClient(process.env)
  try {
    const counts = await seedLocalScenario(prisma)
    console.log(`Local demo scenario v1 ready: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`)
  } finally {
    await disconnectPrismaClient()
  }
}
