import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'
import { PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS } from '../server/domain/procurement-status-authority.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const LOCAL_SCENARIO_COUNTS = Object.freeze({ purchaseRequests: 1, rfqs: 1, supplierQuotations: 2, purchaseOrders: 2, receivingDocuments: 1, supplierInvoices: 1, inventoryBalances: 2, salesOrders: 1 })
const tenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local'
const metadata = { localDemo: true, localDemoScenarioVersion: 3 }
const supplierName = 'Acme Components'
const customerName = 'Redwood Retail'
const itemNames = Object.freeze({ 'LDM-001': 'Flow Controller', 'LDM-002': 'Temperature Sensor' })

export async function seedLocalScenario(prisma, env = process.env) {
  assertLocalDevelopment(env, 'pilot:setup:scenario')
  if (!await prisma.item.findUnique({ where: { id: 'LOCAL-DEMO-ITEM-001' } })) throw new Error('Run pilot:setup:demo before pilot:setup:scenario.')
  return prisma.$transaction(async tx => {
    await tx.purchaseRequest.upsert({
      where: { id: 'LOCAL-DEMO-PR-001' },
      create: { id: 'LOCAL-DEMO-PR-001', tenantId, status: PURCHASE_REQUEST_STATUS.SUBMITTED, requester: 'US Demo', priority: 'high', requiredDate: new Date('2030-01-15T00:00:00Z'), amount: 5000, source: 'local_demo_scenario', metadata, lines: { create: [{ id: 'LOCAL-DEMO-PRL-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: itemNames['LDM-001'], quantity: 50, unit: 'pcs', unitPrice: 100, amount: 5000, metadata }] } },
      update: { requester: 'US Demo', metadata },
    })
    await tx.purchaseRequestLine.updateMany({ where: { id: 'LOCAL-DEMO-PRL-001' }, data: { itemName: itemNames['LDM-001'], metadata } })
    await tx.rfq.upsert({
      where: { id: 'LOCAL-DEMO-RFQ-AWARD-001' },
      create: {
        id: 'LOCAL-DEMO-RFQ-AWARD-001', tenantId, title: 'Flow Controller RFQ', category: 'Electronic components',
        status: 'collecting_quotes', supplierCount: 2, respondedSupplierCount: 2,
        dueDate: new Date('2030-01-10T00:00:00Z'), sourceRequestId: 'LOCAL-DEMO-PR-001', currency: 'USD', metadata,
      },
      update: { title: 'Flow Controller RFQ', category: 'Electronic components', status: 'collecting_quotes', supplierCount: 2, respondedSupplierCount: 2, dueDate: new Date('2030-01-10T00:00:00Z'), sourceRequestId: 'LOCAL-DEMO-PR-001', currency: 'USD', metadata },
    })
    await tx.rfqLine.upsert({
      where: { id: 'LOCAL-DEMO-RFQL-AWARD-001' },
      create: { id: 'LOCAL-DEMO-RFQL-AWARD-001', tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: itemNames['LDM-001'], quantity: 50, unit: 'pcs', metadata: { ...metadata, requiredDate: '2030-01-15', deliveryLocation: 'LOCAL-DEMO-WH-001' } },
      update: { itemName: itemNames['LDM-001'], quantity: 50, unit: 'pcs', metadata: { ...metadata, requiredDate: '2030-01-15', deliveryLocation: 'LOCAL-DEMO-WH-001' } },
    })
    for (const [suffix, supplierId, supplierName, amount, unitPrice, submittedAt, deliveryDate, paymentTerms] of [
      ['001', 'LOCAL-DEMO-SUP-001', 'Acme Components', 4900, 98, '2030-01-05T08:30:00Z', '2030-01-14T00:00:00Z', 'NET30'],
      ['002', 'LOCAL-DEMO-SUP-002', 'Summit Packaging', 4875, 97.5, '2030-01-06T08:30:00Z', '2030-01-16T00:00:00Z', 'NET45'],
    ]) {
      const quotationId = `LOCAL-DEMO-AWARD-QUOTE-${suffix}`
      const quotationLineId = `LOCAL-DEMO-AWARD-QUOTEL-${suffix}`
      const revisionId = `LOCAL-DEMO-AWARD-REV-${suffix}`
      await tx.rfqSupplierParticipation.upsert({
        where: { tenantId_rfqId_supplierId: { tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', supplierId } },
        create: { id: `LOCAL-DEMO-RFQSP-AWARD-${suffix}`, tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', supplierId, status: 'response_recorded', invitedAt: new Date('2030-01-02T00:00:00Z'), respondedAt: new Date(submittedAt), metadata },
        update: { status: 'response_recorded', invitedAt: new Date('2030-01-02T00:00:00Z'), respondedAt: new Date(submittedAt), metadata },
      })
      await tx.supplierQuotation.upsert({
        where: { id: quotationId },
        create: { id: quotationId, tenantId, rfqId: 'LOCAL-DEMO-RFQ-AWARD-001', supplierId, supplierName, status: 'submitted', quotedAmount: amount, currency: 'USD', submittedAt: new Date(submittedAt), metadata },
        update: { supplierName, status: 'submitted', quotedAmount: amount, currency: 'USD', submittedAt: new Date(submittedAt), metadata },
      })
      await tx.supplierQuotationLine.upsert({
        where: { id: quotationLineId },
        create: { id: quotationLineId, supplierQuotationId: quotationId, itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: itemNames['LDM-001'], quantity: 50, unit: 'pcs', unitPrice, amount, metadata },
        update: { itemName: itemNames['LDM-001'], quantity: 50, unit: 'pcs', unitPrice, amount, metadata },
      })
      if (!await tx.supplierQuotationRevision.findUnique({ where: { id: revisionId } })) {
        await tx.supplierQuotationRevision.create({
          data: {
            id: revisionId, tenantId, quotationId, revisionNumber: 1, status: 'submitted', currency: 'USD', quotedAmount: amount,
            submittedAt: new Date(submittedAt), validUntil: new Date('2030-03-31T00:00:00Z'), deliveryDate: new Date(deliveryDate), paymentTerms,
            source: 'local_demo_scenario', metadata,
            lines: { create: [{ id: `${revisionId}-LINE-001`, rfqLineId: 'LOCAL-DEMO-RFQL-AWARD-001', sourceQuotationLineId: quotationLineId, itemId: 'LOCAL-DEMO-ITEM-001', skuSnapshot: 'LDM-001', itemNameSnapshot: itemNames['LDM-001'], quantity: 50, unit: 'pcs', unitPrice, amount, deliveryDate: new Date(deliveryDate), metadata }] },
          },
        })
      }
    }
      for (const [id, status, itemId, sku, quantity, receivedQuantity, expectedDate] of [
        ['LOCAL-DEMO-PO-001', PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED, 'LOCAL-DEMO-ITEM-001', 'LDM-001', 50, 20, '2030-01-12T00:00:00Z'],
        ['LOCAL-DEMO-PO-002', PURCHASE_ORDER_STATUS.ISSUED, 'LOCAL-DEMO-ITEM-002', 'LDM-002', 40, 0, '2030-01-18T00:00:00Z'],
      ]) {
        const poMetadata = { ...metadata, transmissionStatus: 'sent', targetWarehouseId: 'LOCAL-DEMO-WH-001' }
        await tx.purchaseOrder.upsert({
          where: { id },
          create: { id, tenantId, status, supplierId: 'LOCAL-DEMO-SUP-001', supplierName, sourceRequestId: 'LOCAL-DEMO-PR-001', expectedDate: new Date(expectedDate), amount: quantity * 100, currency: 'USD', owner: 'US Demo', priority: id.endsWith('002') ? 'high' : 'medium', metadata: poMetadata, lines: { create: [{ id: `${id}-LINE-001`, itemId, sku, itemName: itemNames[sku], orderedQuantity: quantity, receivedQuantity, unit: 'pcs', unitPrice: 100, amount: quantity * 100, metadata: { ...metadata, targetWarehouseId: 'LOCAL-DEMO-WH-001', requestedDate: '2030-01-15', promisedDate: expectedDate.slice(0, 10) } }] } },
          update: { status, supplierName, expectedDate: new Date(expectedDate), currency: 'USD', owner: 'US Demo', metadata: poMetadata },
        })
        await tx.purchaseOrderLine.updateMany({ where: { id: `${id}-LINE-001` }, data: { itemName: itemNames[sku], metadata: { ...metadata, targetWarehouseId: 'LOCAL-DEMO-WH-001', requestedDate: '2030-01-15', promisedDate: expectedDate.slice(0, 10) } } })
      }
    await tx.receivingDocument.upsert({
      where: { id: 'LOCAL-DEMO-GRN-001' },
      create: { id: 'LOCAL-DEMO-GRN-001', tenantId, documentNumber: 'LOCAL-DEMO-GRN-001', poId: 'LOCAL-DEMO-PO-001', supplierId: 'LOCAL-DEMO-SUP-001', supplierName, status: 'partial', workflowStatus: 'received', postingStatus: 'unposted', warehouseId: 'LOCAL-DEMO-WH-001', receiver: 'US Demo', metadata, lines: { create: [{ id: 'LOCAL-DEMO-GRNL-001', purchaseOrderLineId: 'LOCAL-DEMO-PO-001-LINE-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: itemNames['LDM-001'], acceptedQty: 20, rejectedQty: 0, unit: 'pcs', warehouseId: 'LOCAL-DEMO-WH-001', location: 'A-01', locationKey: 'a-01', metadata }] } },
      update: { supplierName, receiver: 'US Demo', metadata },
    })
    await tx.receivingLine.updateMany({ where: { id: 'LOCAL-DEMO-GRNL-001' }, data: { itemName: itemNames['LDM-001'], metadata } })
    await tx.supplierInvoice.upsert({
      where: { id: 'LOCAL-DEMO-INV-001' },
      create: { id: 'LOCAL-DEMO-INV-001', tenantId, invoiceNumber: 'LOCAL-DEMO-INV-001', supplierId: 'LOCAL-DEMO-SUP-001', supplierName, relatedPoId: 'LOCAL-DEMO-PO-001', relatedGrnId: 'LOCAL-DEMO-GRN-001', subtotalAmount: 2200, enteredTaxAmount: 181.5, totalAmount: 2381.5, amount: 2381.5, currency: 'USD', status: 'review', matchStatus: 'variance', varianceAmount: 381.5, metadata: { ...metadata, varianceType: '金额差异' } },
      update: { supplierName, enteredTaxAmount: 181.5, totalAmount: 2381.5, amount: 2381.5, currency: 'USD', matchStatus: 'variance', varianceAmount: 381.5, metadata: { ...metadata, varianceType: '金额差异' } },
    })
    await tx.supplierInvoiceLine.upsert({
      where: { id: 'LOCAL-DEMO-INVL-001' },
      create: { id: 'LOCAL-DEMO-INVL-001', supplierInvoiceId: 'LOCAL-DEMO-INV-001', lineNumber: 1, purchaseOrderLineId: 'LOCAL-DEMO-PO-001-LINE-001', receivingLineId: 'LOCAL-DEMO-GRNL-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: itemNames['LDM-001'], quantity: 20, unit: 'pcs', unitPrice: 110, lineAmount: 2200, enteredTaxAmount: 181.5, amount: 2381.5, metadata: { ...metadata, varianceType: '价格差异', varianceAmount: 381.5 } },
      update: { itemName: itemNames['LDM-001'], enteredTaxAmount: 181.5, amount: 2381.5, metadata: { ...metadata, varianceType: '价格差异', varianceAmount: 381.5 } },
    })
    for (const [id, itemId, sku, itemName, onHandQuantity, safetyStock, riskLevel] of [
      ['LOCAL-DEMO-BAL-001', 'LOCAL-DEMO-ITEM-001', 'LDM-001', itemNames['LDM-001'], 8, 20, 'shortage'],
      ['LOCAL-DEMO-BAL-002', 'LOCAL-DEMO-ITEM-002', 'LDM-002', itemNames['LDM-002'], 60, 15, 'normal'],
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
        update: { itemName, metadata },
      })
    }
    await tx.salesOrder.upsert({
      where: { id: 'LOCAL-DEMO-SO-001' },
      create: { id: 'LOCAL-DEMO-SO-001', tenantId, orderNumber: 'LOCAL-DEMO-SO-001', customerId: 'LOCAL-DEMO-CUS-001', customerName, workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', promisedDate: new Date('2030-01-20T00:00:00Z'), currency: 'USD', metadata, lines: { create: [{ id: 'LOCAL-DEMO-SOL-001', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: itemNames['LDM-001'], orderedQuantity: 35, unit: 'pcs', unitPrice: 180, amount: 6300, metadata }] } },
      update: { customerName, currency: 'USD', metadata },
    })
    await tx.salesOrderLine.updateMany({ where: { id: 'LOCAL-DEMO-SOL-001' }, data: { itemName: itemNames['LDM-001'], metadata } })
    return LOCAL_SCENARIO_COUNTS
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  assertLocalDevelopment(process.env, 'pilot:setup:scenario')
  const prisma = await getPrismaClient(process.env)
  try {
    const counts = await seedLocalScenario(prisma)
    console.log(`Local demo scenario v3 ready: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`)
  } finally {
    await disconnectPrismaClient()
  }
}
