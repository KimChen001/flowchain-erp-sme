import { randomUUID } from 'node:crypto'
import { shouldSkipDbTests, withTestDatabase } from '../persistence/test-db-harness.mjs'
import { disconnectPrismaClient } from '../persistence/prisma-client.mjs'

export async function withLiveReceivingDatabase(t, callback) {
  const availability = shouldSkipDbTests(process.env)
  if (availability.skip) {
    if (process.env.FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS === 'true') {
      throw new Error(`Real PostgreSQL tests are required: ${availability.reason}`)
    }
    t.skip(availability.reason)
    return
  }
  try {
    await withTestDatabase(process.env, callback)
  } finally {
    await disconnectPrismaClient()
  }
}

export function identity(tenantId, suffix = randomUUID()) {
  return {
    authenticated: true,
    tenantId,
    userId: `actor-${suffix}`,
    name: 'Receiving Test Manager',
    email: '',
    role: 'manager',
    source: 'test',
  }
}

export async function seedReceivingScenario(prisma, {
  ordered = ['10'],
  accepted = ['4'],
  rejected = ordered.map(() => '0'),
  poStatus = 'issued',
  workflowStatus = 'approved',
} = {}) {
  const suffix = randomUUID()
  const tenantId = `tenant-${suffix}`
  const warehouseId = `warehouse-${suffix}`
  const poId = `po-${suffix}`
  const receivingDocumentId = `grn-${suffix}`
  await prisma.tenant.create({ data: { id: tenantId, name: `Tenant ${suffix}` } })
  await prisma.warehouse.create({ data: { id: warehouseId, tenantId, code: `WH-${suffix}`, name: 'Receiving Warehouse', status: 'active' } })
  const items = []
  const poLines = []
  const receivingLines = []
  for (let index = 0; index < ordered.length; index += 1) {
    const itemId = `item-${index}-${suffix}`
    const sku = `SKU-${index}-${suffix}`
    const poLineId = `po-line-${index}-${suffix}`
    const receivingLineId = `grn-line-${index}-${suffix}`
    await prisma.item.create({ data: { id: itemId, tenantId, sku, name: `Item ${index}`, unit: 'EA' } })
    items.push({ itemId, sku })
    poLines.push({ id: poLineId, itemId, sku, itemName: `Item ${index}`, orderedQuantity: ordered[index], receivedQuantity: '0', unit: 'EA' })
    receivingLines.push({
      id: receivingLineId,
      purchaseOrderLineId: poLineId,
      itemId,
      sku,
      itemName: `Item ${index}`,
      acceptedQty: accepted[index],
      rejectedQty: rejected[index] || '0',
      unit: 'EA',
      warehouseId,
      location: 'A-01',
      locationKey: 'a-01',
    })
  }
  await prisma.purchaseOrder.create({ data: { id: poId, tenantId, status: poStatus, currency: 'CNY', lines: { create: poLines } } })
  await prisma.receivingDocument.create({
    data: {
      id: receivingDocumentId,
      tenantId,
      documentNumber: `GRN-${suffix}`,
      poId,
      status: 'receiving',
      workflowStatus,
      postingStatus: 'unposted',
      warehouseId,
      currency: 'CNY',
      lines: { create: receivingLines },
    },
  })
  return { tenantId, warehouseId, poId, receivingDocumentId, items, poLines, receivingLines, actor: identity(tenantId, suffix) }
}

export async function cleanupReceivingScenario(prisma, scenario) {
  if (!scenario?.tenantId) return
  const tenantId = scenario.tenantId
  await prisma.auditLog.deleteMany({ where: { tenantId } })
  await prisma.businessCommandExecution.deleteMany({ where: { tenantId } })
  await prisma.inventoryMovement.deleteMany({ where: { tenantId } })
  await prisma.inventoryBalance.deleteMany({ where: { tenantId } })
  await prisma.receivingLine.deleteMany({ where: { receivingDocument: { tenantId } } })
  await prisma.receivingDocument.deleteMany({ where: { tenantId } })
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { tenantId } } })
  await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
  await prisma.importIssue.deleteMany({ where: { tenantId } })
  await prisma.importBatch.deleteMany({ where: { tenantId } })
  await prisma.workspaceInvitation.deleteMany({ where: { tenantId } })
  await prisma.userWarehouseScope.deleteMany({ where: { tenantId } })
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.item.deleteMany({ where: { tenantId } })
  await prisma.supplier.deleteMany({ where: { tenantId } })
  await prisma.warehouseLocation.deleteMany({ where: { tenantId } })
  await prisma.warehouse.deleteMany({ where: { tenantId } })
  // Documents created through the commands advanced the workspace's number
  // sequences (document-numbering.mjs), which hold on to the tenant.
  await prisma.documentNumberSequence.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
}

export async function expectCommandError(promise, code) {
  try {
    await promise
  } catch (error) {
    if (error?.code === code) return error
    throw error
  }
  throw new Error(`Expected command error ${code}`)
}
