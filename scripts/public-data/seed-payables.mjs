// Records the UCI plan's supplier invoices and their payments [assumed]
// (planSupplierInvoices in plan.mjs) through FlowChain's own commands, in date
// order, so the three-way matches, match exceptions, payables and payment
// records come from the app's rules, not from rows written here:
//
//   as_ordered, price_above_order  created from the posted receipt, submitted
//                                  and matched; a matched invoice is approved,
//                                  which records its payable
//   dated_before_receipt           recorded against the purchase order on its
//                                  own day and submitted, linked to the
//                                  receipt on the receipt day, then matched
//                                  and approved
//   short_delivery                 recorded against the purchase order for the
//                                  full ordered quantity and submitted, linked
//                                  to the short receipt and matched (a
//                                  quantity exception); the buyer closes the
//                                  rest of the order the same day
//
// An invoice with a difference stays at the match, unapproved, so it has no
// payable and is not paid. Then every paid invoice gets its payment on its due
// date. Last, each record is labelled assumed in its metadata and dated by the
// plan, as the documents before it are (the commands stamp the seed's own
// clock on createdAt).
import { createOperationalFinanceCommandService } from '../../server/domain/operational-finance-command-service.mjs'
import { createPaymentRecordCommandService } from '../../server/domain/payment-record-command-service.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'

export const PAYABLES_PERMISSIONS = [
  'finance.supplier_invoice.create', 'finance.supplier_invoice.revise', 'finance.supplier_invoice.submit', 'finance.three_way_match.execute',
  'finance.supplier_invoice.approve', 'finance.payable.record_payment', 'procurement.purchase_order.reject',
]

const money = (pence) => (pence / 100).toFixed(2)
const pad = (value) => String(value).padStart(3, '0')

// plan: a UCI plan with payables. purchaseOrderIds[position] is the id the
// seed gave plan.purchasing.orders[position]; supplierIdOf(key) a supplier's
// id. retrying(work) runs a command again after a serializable conflict.
export async function seedSupplierInvoices(prisma, { plan, env, identity, tenantId, calendar, purchaseOrderIds, supplierIdOf, metadata, retrying, log = () => {} }) {
  const { at, isoDay } = calendar
  const offset = plan.offsetOf
  const currency = plan.profile.currency
  const terms = `NET${plan.assumptions.paymentTermsDays}`
  let clock = new Date()
  const now = () => clock
  const finance = createOperationalFinanceCommandService({ prisma, env, now })
  const payments = createPaymentRecordCommandService({ prisma, env, now })
  const procurement = createDbProcurementCommandService({ prisma, env, now })
  const context = { identity }
  const itemOf = new Map(plan.items.map((item) => [item.key, item]))
  const recorded = []
  const started = Date.now()

  for (const [position, invoice] of plan.payables.invoices.entries()) {
    const order = plan.purchasing.orders[invoice.orderPosition]
    const poId = purchaseOrderIds[invoice.orderPosition]
    const receiptId = `${poId}-GRN${invoice.receiptIndex + 1}`
    const key = (step) => `public-data:uci:supplier-invoice:${step}:${invoice.number}`
    const times = {}
    const step = (name, day, time) => {
      clock = at(offset(day), time)
      times[name] = clock
    }
    const lines = invoice.lines.map((line) => ({
      purchaseOrderLineId: `${poId}-L${pad(line.orderLine + 1)}`,
      ...(invoice.recordedAgainstOrder ? {} : { receivingLineId: `${receiptId}-L${pad(line.receiptLine + 1)}` }),
      quantity: String(line.quantity),
      unitPrice: money(line.unitPricePence),
      lineAmount: money(line.amountPence),
      enteredTaxAmount: '0',
    }))
    step('created', invoice.day, '10:00')
    let result = await retrying(() => finance.createSupplierInvoice({
      idempotencyKey: key('create'), invoiceNumber: invoice.number, supplierId: supplierIdOf(invoice.supplierKey), currency,
      invoiceDate: isoDay(offset(invoice.day)), dueDate: isoDay(offset(invoice.due)), totalAmount: money(invoice.totalPence), lines,
    }, context))
    const id = result.invoice.id
    step('submitted', invoice.day, '10:05')
    result = await retrying(() => finance.submitSupplierInvoice(id, { idempotencyKey: key('submit'), expectedVersion: result.invoice.version }, context))
    // A bill recorded against the order is linked to the receipt on the
    // later of its own day and the receipt day (after the 07:00 posting).
    const linkDay = Math.max(invoice.day, invoice.receiptDay)
    if (invoice.recordedAgainstOrder) {
      step('linked', linkDay, '11:00')
      const version = result.invoice.version
      result = await retrying(() => finance.linkReceipt(id, { idempotencyKey: key('link'), expectedVersion: version, receivingDocumentId: receiptId }, context))
    }
    step('matched', linkDay, invoice.recordedAgainstOrder ? '11:05' : '10:10')
    const submittedVersion = result.invoice.version
    result = await retrying(() => finance.matchSupplierInvoice(id, { idempotencyKey: key('match'), expectedVersion: submittedVersion }, context))
    // The app's own match must agree with the rule that made the invoice.
    if (result.invoice.status !== invoice.match) throw new Error(`Supplier invoice ${invoice.number} (${invoice.rule}) matched as ${result.invoice.status}, not ${invoice.match}.`)
    let payable = null
    if (invoice.match === 'matched') {
      step('approved', linkDay, invoice.recordedAgainstOrder ? '11:10' : '10:15')
      payable = (await approve(finance, id, result.invoice.version, { prisma, key, context, retrying, receiptId, poId })).payable
    }
    if (invoice.rule === 'short_delivery') {
      step('closed', linkDay, '11:20')
      const { version } = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { version: true } })
      const sku = itemOf.get(order.closed.itemKey).sku
      await retrying(() => procurement.closePurchaseOrder(poId, {
        idempotencyKey: key('close-order'), expectedVersion: version,
        reason: `The supplier delivered ${order.closed.missing} fewer ${sku} than ordered and will not send the rest [assumed].`,
      }, context))
    }
    recorded.push({ invoice, id, payable, times })
    if ((position + 1) % 50 === 0) log(`uci: ${position + 1}/${plan.payables.invoices.length} supplier invoices recorded (${Math.round((Date.now() - started) / 1000)} s)`)
  }

  // Payments on the due date, in date order.
  let paid = 0
  for (const entry of [...recorded].filter((row) => row.invoice.payment === 'paid').sort((a, b) => a.invoice.paidDay - b.invoice.paidDay || a.invoice.number.localeCompare(b.invoice.number))) {
    const { invoice, payable } = entry
    clock = at(offset(invoice.paidDay), '12:00')
    entry.times.paid = clock
    const result = await retrying(() => payments.recordPayment('payable', payable.id, {
      idempotencyKey: `public-data:uci:supplier-payment:${invoice.number}`, expectedVersion: payable.version, paymentDate: isoDay(offset(invoice.paidDay)),
      amount: money(invoice.totalPence), currency, method: 'other', reference: `Bank transfer ${invoice.number}`, note: 'Paid on the due date [assumed].',
    }, context))
    entry.paymentId = result.payment.id
    paid += 1
  }

  // Labels and business times.
  for (const { invoice, id, payable, paymentId, times } of recorded) {
    const order = plan.purchasing.orders[invoice.orderPosition]
    const changed = invoice.changedLine === null ? null : invoice.lines[invoice.changedLine]
    const label = {
      ...metadata, assumed: true, paymentTermsAssumed: terms, invoiceRule: invoice.rule,
      ...(invoice.rule === 'price_above_order' ? { priceAboveOrder: { sku: itemOf.get(changed.itemKey).sku, orderPrice: money(changed.orderPricePence), invoicePrice: money(changed.unitPricePence), percentRule: invoice.percent } } : {}),
      ...(invoice.rule === 'short_delivery' ? { shortDelivery: { sku: itemOf.get(changed.itemKey).sku, ordered: changed.quantity, received: changed.received } } : {}),
      ...(invoice.rule === 'dated_before_receipt' ? { datedBeforeReceipt: { receiptDate: isoDay(offset(invoice.receiptDay)) } } : {}),
      ...(invoice.payment === 'overdue' ? { leftUnpaidAssumed: true } : {}),
    }
    await prisma.supplierInvoice.update({ where: { id }, data: { metadata: label, createdAt: times.created } })
    await prisma.threeWayMatch.updateMany({ where: { tenantId, invoiceId: id }, data: { createdAt: times.matched } })
    await prisma.financeMatchException.updateMany({ where: { tenantId, supplierInvoiceId: id }, data: { createdAt: times.matched } })
    const audits = [['supplier_invoice_created', times.created], ['supplier_invoice_submitted', times.submitted], ['supplier_invoice_receipt_linked', times.linked], ['supplier_invoice_matched', times.matched], ['supplier_invoice_approved', times.approved]]
    for (const [action, when] of audits) if (when) await prisma.auditLog.updateMany({ where: { tenantId, entityId: id, action }, data: { createdAt: when } })
    if (payable) await prisma.payableObligation.update({ where: { id: payable.id }, data: { createdAt: times.approved, metadata: { ...metadata, assumed: true, paymentTermsAssumed: terms } } })
    if (paymentId) {
      await prisma.paymentRecord.update({ where: { id: paymentId }, data: { createdAt: times.paid, metadata: { ...metadata, assumed: true, assumedPaidOn: isoDay(offset(invoice.paidDay)) } } })
      await prisma.auditLog.updateMany({ where: { tenantId, entityId: paymentId, action: 'payable_payment_recorded' }, data: { createdAt: times.paid } })
    }
    if (times.closed && order.closed) await prisma.auditLog.updateMany({ where: { tenantId, entityType: 'PurchaseOrder', entityId: purchaseOrderIds[invoice.orderPosition], action: 'purchase_order_close' }, data: { createdAt: times.closed } })
  }
  return { invoices: recorded.length, paid, seconds: Math.round((Date.now() - started) / 1000) }
}

// Approves a matched invoice. A same-amount bill from the same supplier within
// a week is flagged as a possible duplicate; here it is a separate delivery,
// so the flag is dismissed with that reason, as an approver would.
async function approve(finance, id, version, { prisma, key, context, retrying, receiptId, poId }) {
  try {
    return await retrying(() => finance.approveSupplierInvoice(id, { idempotencyKey: key('approve'), expectedVersion: version }, context))
  } catch (error) {
    if (error?.code !== 'DUPLICATE_REVIEW_REQUIRED') throw error
    const [receipt, order] = await Promise.all([
      prisma.receivingDocument.findUniqueOrThrow({ where: { id: receiptId }, select: { documentNumber: true } }),
      prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true } }),
    ])
    for (const flag of error.details?.flags || []) {
      await retrying(() => finance.dismissDuplicate(id, {
        idempotencyKey: key(`dismiss:${flag.otherInvoiceId}`), expectedVersion: version, otherInvoiceId: flag.otherInvoiceId, otherVersion: flag.otherInvoice?.version, kind: flag.kind,
        reason: `A separate delivery: receipt ${receipt.documentNumber} of purchase order ${order.number} [assumed].`,
      }, context))
    }
    return retrying(() => finance.approveSupplierInvoice(id, { idempotencyKey: key('approve'), expectedVersion: version }, context))
  }
}
