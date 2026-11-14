// The prepared next step for a supplier invoice the three-way match held
// (owner 2026-11-13: the invoice exception agent, after "P2P 本体论" and
// SAP's dispute-resolution agent). For each difference the match recorded
// (FinanceMatchException, with its ThreeWayMatchLine), it says what differs,
// the facts, and the likely cause the records show; then one step for the
// invoice. Everything comes from records already on the server; nothing here
// calls a model or writes.
//
// Causes, by what the match compared (operational-finance-policy.mjs,
// buildSupplierMatchPlan):
//   price      price_changed     another order from this supplier already
//                                carries the invoice's unit price for the SKU,
//                                so the supplier's price likely moved and this
//                                order kept the old one;
//              invoice_price     no order shows the invoice's price: the
//                                invoice is likely priced wrong;
//   quantity   over_ordered      the invoices on the line come to more than
//                                was ordered;
//              already_invoiced  part of what was received was invoiced
//                                before, so this invoice repeats it;
//              not_yet_received  the invoice bills goods not received (or not
//                                yet posted as received);
//   amount     line_amount       the line amount is not quantity times the
//                                order price, and the price itself matches
//                                (an amount difference beside a price
//                                difference on the same line follows from it
//                                and is not listed again).
//
// Steps: ask_supplier (a message asking for a corrected invoice or a credit
// note), review_price (the price likely moved: accept it on the invoice page,
// or ask), wait_receipt (every difference is goods not yet received: check
// the receipt, then match again).

export const INVOICE_DIFFERENCE_CAUSES = Object.freeze(['price_changed', 'invoice_price', 'over_ordered', 'already_invoiced', 'not_yet_received', 'line_amount'])
export const INVOICE_EXCEPTION_STEPS = Object.freeze(['ask_supplier', 'review_price', 'wait_receipt'])

const array = (value) => (Array.isArray(value) ? value : [])
const text = (value) => String(value ?? '').trim()
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.00005

// orderPrices: this supplier's order lines [{ sku, unitPrice, orderId, orderNumber }].
function priceCause({ sku, invoicePrice, orderId, orderPrices }) {
  const other = array(orderPrices).find((entry) => text(entry.sku) === sku && text(entry.orderId) !== orderId && same(num(entry.unitPrice), invoicePrice))
  return other ? { cause: 'price_changed', evidenceOrder: text(other.orderNumber) || text(other.orderId) } : { cause: 'invoice_price', evidenceOrder: null }
}

function quantityCause({ ordered, received, previouslyInvoiced, invoiced }) {
  if (ordered !== null && invoiced !== null && invoiced + (previouslyInvoiced || 0) > ordered) return 'over_ordered'
  if ((previouslyInvoiced || 0) > 0 && invoiced !== null && received !== null && invoiced <= received) return 'already_invoiced'
  return 'not_yet_received'
}

// invoice: { id, invoiceNumber, orderId, orderNumber, currency, supplierId, supplierName }
// exceptions: the invoice's blocking exceptions (open or rejected)
// lines: the match lines by id
// supplier: the supplier record ({ contactName, email }) or null
// amountsVisible: whether the reader may see prices and amounts; without it
//   a price difference is named but not valued, and its cause is not read.
export function invoiceExceptionDraft({ invoice = {}, exceptions = [], lines = {}, orderPrices = [], supplier = null, amountsVisible = true } = {}) {
  const lineOf = (id) => (lines instanceof Map ? lines.get(text(id)) : lines?.[text(id)]) || null
  const blocking = array(exceptions).filter((row) => ['open', 'rejected'].includes(text(row.status) || 'open'))
  if (!blocking.length) return null
  const priceLines = new Set(blocking.filter((row) => row.exceptionType === 'price').map((row) => text(row.matchLineId)))
  const differences = []
  for (const row of blocking) {
    const kind = text(row.exceptionType)
    const line = lineOf(row.matchLineId) || {}
    const base = { exceptionId: text(row.id), kind, sku: text(line.sku) || null, unit: text(line.unit) || null }
    if (kind === 'price') {
      const invoicePrice = num(line.invoiceUnitPrice ?? row.actualValue)
      const orderPrice = num(line.poUnitPrice ?? row.expectedValue)
      if (!amountsVisible) { differences.push({ ...base, cause: null, expected: null, actual: null, variance: null, evidenceOrder: null }); continue }
      const { cause, evidenceOrder } = priceCause({ sku: base.sku, invoicePrice, orderId: text(invoice.orderId), orderPrices })
      differences.push({ ...base, cause, expected: orderPrice, actual: invoicePrice, variance: invoicePrice !== null && orderPrice !== null ? Number((invoicePrice - orderPrice).toFixed(4)) : null, percent: invoicePrice !== null && orderPrice ? Number((((invoicePrice - orderPrice) / orderPrice) * 100).toFixed(1)) : null, evidenceOrder })
    } else if (kind === 'quantity') {
      const facts = { ordered: num(line.orderedQuantity), received: num(line.receivedQuantity), previouslyInvoiced: num(line.previouslyInvoicedQuantity) || 0, invoiced: num(line.invoiceQuantity ?? row.actualValue) }
      const cause = quantityCause(facts)
      const missing = cause === 'not_yet_received' && facts.invoiced !== null && facts.received !== null ? Math.max(0, facts.invoiced + facts.previouslyInvoiced - facts.received) : null
      differences.push({ ...base, cause, ...facts, expected: num(row.expectedValue), actual: facts.invoiced, variance: num(row.varianceValue), missing })
    } else if (kind === 'amount') {
      if (priceLines.has(text(row.matchLineId))) continue
      differences.push({ ...base, cause: 'line_amount', expected: amountsVisible ? num(row.expectedValue) : null, actual: amountsVisible ? num(row.actualValue) : null, variance: amountsVisible ? num(row.varianceValue) : null })
    }
  }
  if (!differences.length) return null
  const causes = new Set(differences.map((row) => row.cause))
  const step = [...causes].every((cause) => cause === 'not_yet_received') ? 'wait_receipt'
    : [...causes].every((cause) => cause === 'price_changed') ? 'review_price'
      : 'ask_supplier'
  return {
    type: 'invoice_exception',
    invoiceId: text(invoice.id),
    invoiceNumber: text(invoice.invoiceNumber) || text(invoice.id),
    orderId: text(invoice.orderId) || null,
    orderNumber: text(invoice.orderNumber) || null,
    currency: text(invoice.currency) || null,
    amountsVisible: Boolean(amountsVisible),
    supplier: {
      id: text(invoice.supplierId) || null,
      name: text(invoice.supplierName) || text(supplier?.name) || null,
      contactName: text(supplier?.contactName) || null,
      email: text(supplier?.email) || null,
    },
    step,
    differences: differences.slice(0, 20),
    moreDifferences: Math.max(0, differences.length - 20),
  }
}
