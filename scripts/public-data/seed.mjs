// Writes a public data plan (scripts/public-data/plan.mjs) into one empty,
// provisioned local workspace. Local development only.
//
// Master data and documents up to posting are written as rows, the way the
// app's own commands leave them; everything that moves stock goes through the
// commands, in date order, so stock, movements, order status and the reorder
// list agree:
//   1. the workspace profile (name, currency, timezone), suppliers, customers
//      (UCI: on NET30 [assumed], with that payment term added when the
//      workspace lacks it), items with their [assumed] thresholds and empty
//      stock records;
//   2. the [public data] sales orders, confirmed; the [assumed] purchase
//      orders, issued, and for every one that has arrived an unposted receipt;
//   3. opening stock the day before the window (inventory adjustment commands);
//   4. receipts (receiving posting) and shipments (outbound commands) in time
//      order, each as of its own time;
//   5. the [assumed] supplier terms (item supplier command);
//   6. UCI only: a customer invoice for each shipment, issued on its day, due
//      30 days later and paid then [assumed], and its receivable;
//   7. the walkthrough scene's supplier tier, set by its buyer (scene.mjs);
//   8. the workspace note: what is public, what is assumed, the date shift.
import { assertLocalDevelopment } from '../../server/domain/local-development-contract.mjs'
import { allocateDocumentNumber } from '../../server/domain/document-numbering.mjs'
import { createInventoryOperationsCommandService } from '../../server/domain/inventory-operations-command-service.mjs'
import { createReceivingPostingCommandService } from '../../server/domain/receiving-posting-command-service.mjs'
import { saveItemSupplier } from '../../server/domain/master-data-commands.mjs'
import { applySupplierTierChange } from '../../server/domain/supplier-tier-command.mjs'
import { findPaymentTerm } from '../../server/domain/standard-payment-terms.mjs'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { HISTORY_PERMISSIONS, scenarioActor, scenarioCalendar, shipHistoryOrder } from '../seed-history.mjs'
import { publicDataPlanCounts } from './plan.mjs'

export const PUBLIC_DATA_NOTE_NAMESPACE = 'workspace.public-data'
export const PUBLIC_DATA_NOTE_KEY = 'note'

const RECEIPT_TIME = '07:00'
const OPENING_TIME = '07:30'
const CHUNK = 2000
const money = (value) => Math.round(value * 100) / 100
const safeId = (value) => String(value).replace(/[^A-Za-z0-9_]+/g, '-')
const chunks = (rows, size = CHUNK) => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size))

// A command that lost a serializable race (another writer on the same
// database) is run again with the same idempotency key, which makes the retry
// safe.
const CONFLICT = /P2034|40001|serializ|deadlock|write conflict|CONCURRENT_TRANSACTION_CONFLICT|changed in another transaction|changed during/i
async function retrying(work, attempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      if (attempt >= attempts || !CONFLICT.test(`${error?.code || ''} ${error?.message || ''}`)) throw error
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt * attempt + Math.floor(Math.random() * 60)))
    }
  }
}

export async function seedPublicData(prisma, env = process.env, { plan, log = () => {} } = {}) {
  assertLocalDevelopment(env, 'public data seed')
  const started = Date.now()
  const { profile, assumptions } = plan
  const tenantId = String(env.FLOWCHAIN_DEFAULT_TENANT_ID || profile.tenantId).trim()
  const P = plan.dataset.toUpperCase()
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error(`Provision workspace ${tenantId} (scripts/setup-pilot-workspace.mjs) before seeding public data.`)
  if (await prisma.item.findFirst({ where: { tenantId }, select: { id: true } })) throw new Error(`Workspace ${tenantId} already has items; seed public data into an empty workspace.`)
  await prisma.tenant.update({ where: { id: tenantId }, data: { name: profile.workspaceName, currency: profile.currency, timezone: profile.timezone, countryCode: profile.countryCode } })
  const calendar = scenarioCalendar(plan.seedDay, profile.timezone)
  const { at, isoDay } = calendar
  const offset = plan.offsetOf
  const dateOnly = (index) => new Date(`${isoDay(offset(index))}T12:00:00.000Z`)
  const historyEnv = { ...env, FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true', FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true', FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: 'true' }
  const metadata = { publicData: true, publicDataset: plan.dataset, scenarioAsOf: plan.seedDay }
  // The scene's buyer signs in like the other local users, with the same role
  // as the workspace's manager.
  const sceneBuyer = plan.scene?.buyer ? await createSceneBuyer(prisma, tenantId, plan.scene.buyer) : null
  const actor = await scenarioActor(prisma, tenantId, [...HISTORY_PERMISSIONS, 'receiving.post'], 'opening stock, receipts and shipments')
  const buyer = sceneBuyer || await prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, name: true } })
  const timing = {}
  const lap = (name, since) => { timing[name] = Math.round((Date.now() - since) / 1000) }

  // 1. Master data.
  let since = Date.now()
  const warehouse = await prisma.warehouse.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } })
  if (!warehouse) throw new Error(`Workspace ${tenantId} has no warehouse; run scripts/setup-pilot-workspace.mjs first.`)
  await prisma.warehouse.update({ where: { id: warehouse.id }, data: { name: profile.warehouseName } })
  for (const code of ['A-01', 'QC-01']) {
    await prisma.warehouseLocation.create({ data: { id: `${P}-LOC-${code.replace('-', '')}`, tenantId, warehouseId: warehouse.id, code, locationKey: code.toLowerCase(), name: code === 'A-01' ? 'Main stock' : 'Quality check' } })
  }
  const supplierId = (key) => `${P}-SUP-${safeId(key)}`
  await prisma.supplier.createMany({
    data: plan.suppliers.map((supplier) => ({
      id: supplierId(supplier.key), tenantId, code: supplier.code, name: supplier.name, category: supplier.category, riskLevel: 'low',
      metadata: { ...metadata, assumed: true, defaultCurrency: profile.currency, ...(supplier.email ? { email: supplier.email, contactName: supplier.contactName } : {}), ...(supplier.scene ? { walkthroughScene: true } : {}) },
    })),
  })
  const customerId = (key) => `${P}-CUS-${safeId(key)}`
  const customers = new Map(plan.customers.map((customer) => [customer.key, { ...customer, id: customerId(customer.key) }]))
  for (const part of chunks([...customers.values()])) {
    await prisma.runtimeRecord.createMany({
      data: part.map((customer) => ({
        id: customer.id, tenantId, namespace: 'master-data.customers', recordKey: customer.code,
        payload: { id: customer.id, code: customer.code, name: customer.name, status: 'active', currency: profile.currency, address: customer.country, ...(plan.dataset === 'uci' ? { paymentTerms: `NET${assumptions.paymentTermsDays}` } : {}), ...metadata, source: customer.source },
      })),
    })
  }
  // UCI customers are recorded on NET30 [assumed], and the invoice form fills
  // the due date only from a payment term of the workspace. A workspace made
  // by setup-pilot-workspace has none, so the term the customers name is added
  // here when it is missing; terms already in the workspace stay as they are.
  if (plan.dataset === 'uci') {
    const code = `NET${assumptions.paymentTermsDays}`
    const terms = await prisma.paymentTerm.findMany({ where: { tenantId }, select: { code: true, name: true } })
    if (!findPaymentTerm(terms, code)) {
      await prisma.paymentTerm.create({ data: { id: `${P}-PT-${code}`, tenantId, code, name: `Net ${assumptions.paymentTermsDays}`, days: assumptions.paymentTermsDays, metadata: { ...metadata, assumed: true } } })
    }
  }
  const items = new Map(plan.items.map((item) => [item.key, { ...item, id: `${P}-ITEM-${safeId(item.sku)}`, balanceId: `${P}-BAL-${safeId(item.sku)}` }]))
  await prisma.item.createMany({
    data: [...items.values()].map((item) => ({
      id: item.id, tenantId, sku: item.sku, name: item.name, category: item.category, unit: 'pcs', preferredSupplierId: supplierId(item.supplierKey),
      safetyStock: item.safetyStock, reorderPoint: item.reorderPoint,
      // The item's own purchasing fields (the item page shows them) agree
      // with its preferred supplier's terms below.
      metadata: {
        ...metadata, defaultWarehouseId: warehouse.id, safetyStock: item.safetyStock, reorderPoint: item.reorderPoint, source: item.source, thresholdsAssumed: true,
        minimumOrderQuantity: item.minimumOrderQuantity, moq: item.minimumOrderQuantity, purchaseLeadTimeDays: assumptions.leadTimeDays, leadTimeDays: assumptions.leadTimeDays,
      },
    })),
  })
  await prisma.inventoryBalance.createMany({
    data: [...items.values()].map((item) => ({
      id: item.balanceId, tenantId, itemId: item.id, sku: item.sku, warehouseId: warehouse.id, warehouseKey: warehouse.id, location: 'A-01', locationKey: 'a-01',
      onHandQuantity: 0, availableQuantity: 0, reservedQuantity: 0, unit: 'pcs', status: 'active', metadata, itemName: item.name, safetyStock: item.safetyStock, reorderPoint: item.reorderPoint, riskLevel: 'normal',
    })),
  })
  lap('masterData', since)

  // 2. Sales orders (confirmed) and purchase orders (issued, or waiting for
  // approval) with their receipts.
  since = Date.now()
  const orderRows = plan.salesOrders
    .map((order, sequence) => ({ ...order, id: `${P}-SO-${String(sequence + 1).padStart(5, '0')}` }))
    .sort((a, b) => a.index - b.index || a.orderedAt.localeCompare(b.orderedAt) || a.id.localeCompare(b.id))
  const shipments = []
  for (const part of chunks(orderRows, 500)) {
    await prisma.$transaction(async (tx) => {
      const orders = []
      const lines = []
      for (const order of part) {
        const createdAt = at(offset(order.index), order.orderedAt)
        const orderNumber = await allocateDocumentNumber(tx, { tenantId, documentType: 'sales_order', at: createdAt })
        const customer = customers.get(order.customerKey)
        if (!customer) throw new Error(`Sales order ${order.id} names an unknown customer ${order.customerKey}.`)
        orders.push({
          id: order.id, tenantId, orderNumber, customerId: customer.id, customerName: customer.name, workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled',
          promisedDate: dateOnly(order.index), currency: profile.currency, metadata: { ...metadata, source: order.source }, createdAt,
        })
        const shipmentLines = []
        order.lines.forEach((line, lineIndex) => {
          const item = items.get(line.itemKey)
          const id = `${order.id}-L${String(lineIndex + 1).padStart(3, '0')}`
          lines.push({ id, salesOrderId: order.id, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: line.quantity, unit: 'pcs', unitPrice: line.unitPrice, amount: money(line.quantity * line.unitPrice), metadata })
          shipmentLines.push({ id, quantity: line.quantity })
        })
        shipments.push({ id: order.id, index: order.index, offset: offset(order.index), shippedAt: order.shippedAt, lines: shipmentLines, customer, source: order.source })
      }
      await tx.salesOrder.createMany({ data: orders })
      for (const lineChunk of chunks(lines)) await tx.salesOrderLine.createMany({ data: lineChunk })
    }, { timeout: 600000 })
  }

  const receipts = []
  const sceneOrders = {}
  const purchaseOrders = plan.purchasing.orders.map((order, sequence) => ({ ...order, id: `${P}-PO-${String(sequence + 1).padStart(5, '0')}` }))
  for (const part of chunks(purchaseOrders, 200)) {
    await prisma.$transaction(async (tx) => {
      const orders = []
      const lines = []
      const documents = []
      const documentLines = []
      for (const order of part) {
        const supplier = plan.suppliers.find((row) => row.key === order.supplierKey)
        const createdAt = at(offset(order.created), order.createdTime || '09:30')
        const issued = order.status === 'issued'
        const issuedAt = issued ? new Date(createdAt.getTime() + 90 * 60000) : null
        const promised = isoDay(offset(order.promised))
        const number = await allocateDocumentNumber(tx, { tenantId, documentType: 'purchase_order', at: createdAt })
        if (order.scene) sceneOrders[order.scene] = number
        let amount = 0
        const poLines = order.lines.map((line, lineIndex) => {
          const item = items.get(line.itemKey)
          const unitPrice = plan.dataset === 'm5' ? item.prices[order.created] : item.price
          const lineAmount = money(line.quantity * unitPrice)
          amount += lineAmount
          return {
            id: `${order.id}-L${String(lineIndex + 1).padStart(3, '0')}`, purchaseOrderId: order.id, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: line.quantity, receivedQuantity: 0,
            unit: 'pcs', unitPrice, amount: lineAmount, originalPromisedDate: issued ? new Date(`${promised}T12:00:00Z`) : null,
            metadata: { ...metadata, assumed: true, targetWarehouseId: warehouse.id, requestedDate: promised, promisedDate: promised, ...(line.raisedBy ? { raisedForDemandSpike: line.raisedBy } : {}) },
          }
        })
        orders.push({
          id: order.id, tenantId, number, status: order.status, supplierId: supplierId(order.supplierKey), supplierName: supplier.name, expectedDate: new Date(`${promised}T12:00:00Z`), amount: money(amount), currency: profile.currency,
          owner: buyer?.name || null, priority: 'medium', issuedAt, createdAt,
          metadata: {
            ...metadata, assumed: true, targetWarehouseId: warehouse.id, transmissionStatus: issued ? 'sent' : 'not_sent', ...(issuedAt ? { issuedAt: issuedAt.toISOString() } : {}),
            purchasingRule: order.scene ? 'walkthrough_scene' : 'weekly_review_base_stock', ...(order.scene ? { walkthroughScene: order.scene } : {}),
          },
        })
        lines.push(...poLines)
        const ordered = order.lines.reduce((total, line) => total + line.quantity, 0)
        let cumulative = 0
        order.receipts.forEach((receipt, receiptIndex) => {
          const arrivedAt = at(offset(receipt.index), RECEIPT_TIME)
          const id = `${order.id}-GRN${receiptIndex + 1}`
          cumulative += receipt.lines.reduce((total, line) => total + line.quantity, 0)
          documents.push({ id, arrivedAt, poId: order.id, supplierId: supplierId(order.supplierKey), supplierName: supplier.name, status: cumulative >= ordered ? 'received' : 'partial' })
          receipt.lines.forEach((received, lineIndex) => {
            const line = poLines.find((row) => row.itemId === items.get(received.itemKey).id)
            documentLines.push({ id: `${id}-L${String(lineIndex + 1).padStart(3, '0')}`, receivingDocumentId: id, purchaseOrderLineId: line.id, itemId: line.itemId, sku: line.sku, itemName: line.itemName, acceptedQty: received.quantity, rejectedQty: 0, unit: 'pcs', warehouseId: warehouse.id, location: 'A-01', locationKey: 'a-01', metadata })
          })
          receipts.push({ id, arrivedAt, index: receipt.index })
        })
      }
      await tx.purchaseOrder.createMany({ data: orders })
      for (const lineChunk of chunks(lines)) await tx.purchaseOrderLine.createMany({ data: lineChunk })
      // Receipts are numbered in the order they arrive.
      const numbered = []
      for (const document of [...documents].sort((a, b) => a.arrivedAt - b.arrivedAt || a.id.localeCompare(b.id))) {
        const documentNumber = await allocateDocumentNumber(tx, { tenantId, documentType: 'receiving_document', at: document.arrivedAt })
        numbered.push({ ...document, tenantId, documentNumber, workflowStatus: 'received', postingStatus: 'unposted', warehouseId: warehouse.id, receiver: buyer?.name || null, currency: profile.currency, metadata, createdAt: document.arrivedAt })
      }
      if (numbered.length) await tx.receivingDocument.createMany({ data: numbered })
      for (const lineChunk of chunks(documentLines)) await tx.receivingLine.createMany({ data: lineChunk })
    }, { timeout: 600000 })
  }
  lap('documents', since)

  // 3. Opening stock the day before the window.
  since = Date.now()
  const stock = createInventoryOperationsCommandService({ prisma, env: historyEnv, now: () => at(offset(-1), OPENING_TIME) })
  const openingKey = `public-data:${plan.dataset}:opening-stock`
  const openingLines = [...items.values()].map((item) => ({ inventoryBalanceId: item.balanceId, adjustmentQuantity: String(plan.purchasing.opening[item.key]) }))
  let adjustment = (await retrying(() => stock.createAdjustment({ idempotencyKey: `${openingKey}:create`, reasonCode: 'opening_balance', notes: 'Opening stock before the public data window [assumed].', lines: openingLines }, { identity: actor }))).adjustment
  adjustment = (await retrying(() => stock.readyAdjustment(adjustment.id, { idempotencyKey: `${openingKey}:ready`, expectedAdjustmentVersion: adjustment.version }, { identity: actor }))).adjustment
  await retrying(() => stock.postAdjustment(adjustment.id, { idempotencyKey: `${openingKey}:post`, expectedAdjustmentVersion: adjustment.version }, { identity: actor }))
  lap('openingStock', since)

  // 4. Receipts and shipments in time order.
  since = Date.now()
  const timeline = [
    ...receipts.map((receipt) => ({ at: receipt.arrivedAt.getTime(), receipt })),
    ...shipments.map((order) => ({ at: at(order.offset, order.shippedAt).getTime(), order })),
  ].sort((a, b) => a.at - b.at || (a.receipt ? -1 : 1) || String(a.receipt?.id || a.order?.id).localeCompare(String(b.receipt?.id || b.order?.id)))
  let posted = 0
  let shipped = 0
  for (const [position, event] of timeline.entries()) {
    if (event.order) {
      if (await retrying(() => shipHistoryOrder(prisma, event.order, { tenantId, calendar, identity: actor, env: historyEnv, warehouseId: warehouse.id, keyPrefix: `public-data:${plan.dataset}` }))) shipped += 1
    } else {
      const service = createReceivingPostingCommandService({ prisma, env: historyEnv, now: () => event.receipt.arrivedAt })
      await retrying(() => service.postReceiving({ receivingDocumentId: event.receipt.id, idempotencyKey: `public-data:${plan.dataset}:post:${event.receipt.id}`, expectedVersion: 0 }, { identity: actor }))
      posted += 1
    }
    if ((position + 1) % 250 === 0) log(`${plan.dataset}: ${position + 1}/${timeline.length} receipts and shipments posted (${Math.round((Date.now() - since) / 1000)} s)`)
  }
  lap('postings', since)

  // 5. Supplier terms [assumed].
  since = Date.now()
  for (const item of items.values()) {
    await retrying(() => saveItemSupplier(prisma, item.id, null, { supplierId: supplierId(item.supplierKey), preferred: true, leadTimeDays: assumptions.leadTimeDays, minimumOrderQuantity: item.minimumOrderQuantity, referencePrice: item.price, currency: profile.currency }, actor.userId, { tenantId }))
  }
  lap('supplierTerms', since)

  // 6. UCI: customer invoices, issued on the shipment day, and receivables.
  since = Date.now()
  let invoices = 0
  if (plan.dataset === 'uci') {
    const shipmentRows = await prisma.shipmentDocument.findMany({ where: { tenantId, postingStatus: 'posted' }, select: { id: true, salesOrderId: true, postedAt: true, lines: { select: { id: true, salesOrderLineId: true, itemId: true, sku: true, postedQuantity: true, unit: true } } } })
    const shipmentOf = new Map(shipmentRows.map((row) => [row.salesOrderId, row]))
    const orderLines = new Map((await prisma.salesOrderLine.findMany({ where: { salesOrder: { tenantId } }, select: { id: true, unitPrice: true, itemName: true } })).map((row) => [row.id, row]))
    const seedDayValue = new Date(`${plan.seedDay}T12:00:00.000Z`)
    for (const part of chunks(shipments, 500)) {
      await prisma.$transaction(async (tx) => {
        const headers = []
        const lines = []
        const receivables = []
        for (const order of part) {
          const shipment = shipmentOf.get(order.id)
          if (!shipment) throw new Error(`Sales order ${order.id} has no posted shipment to invoice.`)
          const issuedAt = new Date(shipment.postedAt.getTime() + 5 * 60000)
          const invoiceNumber = await allocateDocumentNumber(tx, { tenantId, documentType: 'customer_invoice', at: issuedAt })
          const id = `${P}-CI-${order.id.slice(P.length + 4)}`
          let subtotal = 0
          shipment.lines.forEach((line, lineIndex) => {
            const quantity = Number(line.postedQuantity)
            const orderLine = orderLines.get(line.salesOrderLineId)
            const unitPrice = Number(orderLine.unitPrice)
            const lineAmount = money(quantity * unitPrice)
            subtotal += lineAmount
            lines.push({ id: `${id}-L${String(lineIndex + 1).padStart(3, '0')}`, customerInvoiceId: id, lineNumber: lineIndex + 1, shipmentLineId: line.id, salesOrderLineId: line.salesOrderLineId, itemId: line.itemId, sku: line.sku, itemName: orderLine.itemName, quantity, unit: line.unit, unitPrice, lineAmount, enteredTaxAmount: 0, totalAmount: lineAmount, metadata })
          })
          subtotal = money(subtotal)
          const invoiceDate = dateOnly(order.index)
          const dueDate = dateOnly(order.index + assumptions.paymentTermsDays)
          const paid = dueDate < seedDayValue
          headers.push({
            id, tenantId, invoiceNumber, salesOrderId: order.id, shipmentId: shipment.id, customerId: order.customer.id, customerNameSnapshot: order.customer.name, invoiceDate, dueDate,
            subtotalAmount: subtotal, enteredTaxAmount: 0, totalAmount: subtotal, currency: profile.currency, status: 'issued',
            submittedAt: issuedAt, submittedById: actor.userId, approvedAt: issuedAt, approvedById: actor.userId, issuedAt, issuedById: actor.userId, version: 3,
            metadata: { ...metadata, source: order.source, paymentTermsAssumed: `NET${assumptions.paymentTermsDays}` },
          })
          receivables.push({
            id: `${id}-AR`, tenantId, customerInvoiceId: id, obligationNumber: `AR-${invoiceNumber}`, originalAmount: subtotal, outstandingAmount: paid ? 0 : subtotal, currency: profile.currency, dueDate,
            status: paid ? 'settled' : 'open', metadata: { ...metadata, ...(paid ? { assumedPaidOn: dueDate.toISOString().slice(0, 10) } : {}) },
          })
        }
        await tx.customerInvoice.createMany({ data: headers })
        for (const lineChunk of chunks(lines)) await tx.customerInvoiceLine.createMany({ data: lineChunk })
        await tx.receivableObligation.createMany({ data: receivables })
        invoices += headers.length
      }, { timeout: 600000 })
    }
  }
  lap('customerInvoices', since)

  // 7. The scene's supplier tier, set by its buyer with a written reason from
  // the purchase orders: the supplier's share of purchase spend over the
  // last 12 months.
  let tiers = []
  if (plan.scene) {
    const spend = await prisma.purchaseOrder.groupBy({ by: ['supplierId'], where: { tenantId, createdAt: { gte: at(offset(plan.days - 365), '00:00') } }, _sum: { amount: true } })
    const total = spend.reduce((sum, row) => sum + Number(row._sum.amount || 0), 0)
    for (const supplier of plan.suppliers.filter((row) => row.tier)) {
      const share = total ? Math.round((100 * Number(spend.find((row) => row.supplierId === supplierId(supplier.key))?._sum.amount || 0)) / total) : 0
      // The hero's rank among all products by sales value over the window.
      const hero = plan.scene.hero
      const value = new Map()
      for (const order of plan.salesOrders) for (const line of order.lines) value.set(line.itemKey, (value.get(line.itemKey) || 0) + line.quantity * line.unitPrice)
      const rank = [...value.entries()].sort((a, b) => b[1] - a[1]).findIndex(([key]) => key === hero.sku) + 1
      const reason = `Tier ${supplier.tier}: sole source of our ${hero.name} (No. ${rank} of ${plan.items.length} products by sales value over the last 12 months) and of ${plan.items.filter((item) => item.supplierKey === supplier.key).length - 1} other ${supplier.key}xxx lines; ${share}% of purchase spend over the last 12 months.`
      await prisma.$transaction(async (tx) => {
        const row = await tx.supplier.findUniqueOrThrow({ where: { id: supplierId(supplier.key) } })
        const setAt = at(-40, '10:30')
        await applySupplierTierChange(tx, row, { tier: supplier.tier, reason, actorId: buyer.id, source: 'supplier-master', now: setAt })
        // The tier's history row carries the day the tier was set, not the seed's.
        await tx.auditLog.updateMany({ where: { tenantId, entityType: 'supplier', entityId: row.id, action: 'tier_change' }, data: { createdAt: setAt } })
        await tx.supplier.update({ where: { id: row.id }, data: { businessOwnerId: buyer.id } })
      })
      tiers.push({ supplier: supplier.name, tier: supplier.tier, reason, share, setBy: buyer.name })
    }
  }

  // 8. The workspace note.
  const counts = { ...publicDataPlanCounts(plan), postedReceipts: posted, shippedOrders: shipped, customerInvoices: invoices }
  const note = {
    dataset: plan.dataset,
    sourceWindow: plan.sourceWindow,
    window: plan.window,
    shiftDays: plan.shiftDays,
    seedDay: plan.seedDay,
    counts,
    source: plan.sources,
    rules: plan.rules,
    assumptions: { ...assumptions },
    ...(plan.scene ? { scene: { suppliers: plan.suppliers.filter((row) => row.scene).map((row) => row.name) } } : {}),
  }
  await prisma.runtimeRecord.create({ data: { id: `${P}-PUBLIC-DATA-NOTE`, tenantId, namespace: PUBLIC_DATA_NOTE_NAMESPACE, recordKey: PUBLIC_DATA_NOTE_KEY, payload: note } })
  const scene = plan.scene ? { ...plan.scene, purchaseOrders: sceneOrders, tiers, suppliers: plan.suppliers.filter((row) => row.scene).map(({ name, code, email, contactName }) => ({ name, code, email, contactName })) } : null
  return { tenantId, seedDay: plan.seedDay, counts, seconds: Math.round((Date.now() - started) / 1000), timing, scene }
}

// The scene's buyer: a workspace user with the manager's role, a warehouse
// scope like the others, and role assignments from the authorization backfill.
async function createSceneBuyer(prisma, tenantId, { name, email, jobTitle }) {
  const existing = await prisma.user.findFirst({ where: { tenantId, email } })
  if (existing) return existing
  const manager = await prisma.user.findFirst({ where: { tenantId, role: 'manager', status: 'active' }, orderBy: { email: 'asc' } })
  const user = await prisma.user.create({ data: { id: `USR-${tenantId}-${email.split('@')[0]}`, tenantId, email, name, role: 'manager', jobTitle, status: 'active', defaultWarehouseId: manager?.defaultWarehouseId || null } })
  const scopes = await prisma.userWarehouseScope.findMany({ where: { tenantId, userId: manager?.id || '' } })
  for (const scope of scopes) {
    await prisma.userWarehouseScope.create({ data: { id: `${user.id}-${scope.warehouseId}`, tenantId, userId: user.id, warehouseId: scope.warehouseId, accessLevel: scope.accessLevel } })
  }
  const admin = await prisma.user.findFirst({ where: { tenantId, role: 'admin', status: 'active' } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: admin?.id || user.id })
  return user
}

// The note a workspace was seeded with, or null.
export async function readPublicDataNote(prisma, tenantId) {
  const row = await prisma.runtimeRecord.findUnique({ where: { tenantId_namespace_recordKey: { tenantId, namespace: PUBLIC_DATA_NOTE_NAMESPACE, recordKey: PUBLIC_DATA_NOTE_KEY } } })
  return row?.payload || null
}
