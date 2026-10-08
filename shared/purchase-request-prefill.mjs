// The purchase request form opened from a handoff (the assistant's purchase
// request draft): one line filled from the handoff query and the item's
// master data, each value with its source
// (docs/ai-prefill-autocomplete-design.md, journey J3). The same inputs always
// give the same line; nothing here saves anything.
import { prefillOrigin } from './prefill-suggestions.mjs'

const text = (value) => String(value ?? '').trim()
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
const positive = (value) => {
  if (value === null || value === undefined || text(value) === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function addCalendarDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// Values a handoff computed carry a reference to it: the assistant's, or the
// reorder list's. Values from elsewhere stay generic.
const HANDOFF_REF_PREFIX = Object.freeze({ ai_assistant: 'assistant', reorder_list: 'reorder_list' })

// The approved sources of an item for a person to choose from, when none is
// preferred: by the day of the last issued PO for this item with that
// supplier, most recent first; suppliers never ordered from last; ties by
// name (A-Z, the same in either interface language), then id. lastOrders
// maps a supplier id to { purchaseOrderId, orderNumber, day, dateSource }
// (a Map or a plain object); null when the dates could not be read, and the
// list is then A-Z with no date at all, never "no PO yet".
const byName = (left, right) =>
  text(left.name || left.supplierName || left.id).localeCompare(text(right.name || right.supplierName || right.id), 'en', { sensitivity: 'base' }) ||
  (text(left.id) < text(right.id) ? -1 : text(left.id) > text(right.id) ? 1 : 0)

export function orderSupplierChoices(suppliers = [], lastOrders = null) {
  const known = lastOrders !== null && lastOrders !== undefined && typeof lastOrders === 'object'
  const lookup = (id) => {
    if (!known) return undefined
    const entry = lastOrders instanceof Map ? lastOrders.get(id) : lastOrders[id]
    return entry && isDay(text(entry.day))
      ? { purchaseOrderId: text(entry.purchaseOrderId), orderNumber: text(entry.orderNumber) || text(entry.purchaseOrderId), day: text(entry.day), dateSource: text(entry.dateSource) || 'issue_date' }
      : null
  }
  const choices = suppliers.map((row) => ({ id: text(row.id), name: text(row.name || row.supplierName || row.id), ...(known ? { lastOrder: lookup(text(row.id)) } : {}) }))
  return choices.sort((left, right) => {
    if (known) {
      const a = left.lastOrder?.day || ''
      const b = right.lastOrder?.day || ''
      if (a !== b) return a ? (b ? (a < b ? 1 : -1) : -1) : 1
    }
    return byName(left, right)
  })
}

// query: itemId, sku, quantity, reason, due, suppliers, origin, intent.
// suppliers: the item's approved sources, preferred first, as the item
// supplier API returns them (prices already masked for the reader).
// lastOrders: see orderSupplierChoices.
//
// The supplier: one the handoff names (the assistant or the reorder list),
// if it is approved; else the item's preferred supplier, a choice a person
// recorded; else the only approved source. With several approved sources and
// none preferred the supplier stays empty and the sources are listed for a
// person to choose; no price, lead time or minimum order quantity of a
// supplier nobody chose is filled. Master data can mark more than one source
// preferred (the item's default supplier and a link flagged preferred); then
// none is picked over the other: the supplier stays empty and only the
// preferred sources are listed, the same way.
export function planPurchaseRequestPrefill({ query = {}, item = {}, suppliers = [], today, defaultDate, lastOrders = null } = {}) {
  const origin = prefillOrigin(query.origin)
  const prefix = HANDOFF_REF_PREFIX[origin]
  const tag = (ref) => (prefix ? { ref: `${prefix}:${ref}` } : {})
  const itemId = text(item.itemId || item.id)
  const fields = { itemId: { source: 'record', ...tag('item'), value: itemId } }

  const wanted = text(query.suppliers).split(',')[0]?.trim() || ''
  const named = wanted ? suppliers.find((row) => [row.id, row.supplierCode, row.name, row.supplierName].map(text).includes(wanted)) : undefined
  const preferredRows = suppliers.filter((row) => row.preferred)
  const preferred = preferredRows.length === 1 ? preferredRows[0] : undefined
  const only = suppliers.length === 1 ? suppliers[0] : undefined
  const chosen = named || preferred || only
  let supplierChoices = []
  if (named) fields.supplierId = { source: 'record', ...tag('supplier'), value: chosen.id }
  else if (preferred) fields.supplierId = { source: 'default', ref: 'item_supplier:preferred', value: chosen.id }
  else if (only) fields.supplierId = { source: 'default', ref: 'item_supplier:only_approved', value: chosen.id }
  else if (preferredRows.length > 1) {
    fields.supplierId = { source: 'template', ref: 'item_supplier:choose_preferred', value: '' }
    supplierChoices = orderSupplierChoices(preferredRows, lastOrders)
  } else if (suppliers.length > 1) {
    fields.supplierId = { source: 'template', ref: 'item_supplier:choose', value: '' }
    supplierChoices = orderSupplierChoices(suppliers, lastOrders)
  }

  // The shortfall the handoff computed, raised to the supplier's minimum
  // order quantity. Without a quantity the line starts at 1, unlabelled;
  // a reorder list row without a shortfall (above its reorder point, or a
  // purchase unit other than the stock unit) leaves it empty and says so.
  const asked = positive(query.quantity)
  const moq = positive(chosen?.minimumOrderQuantity)
  let quantity
  if (asked === null && origin === 'reorder_list') {
    quantity = ''
    fields.quantity = { source: 'template', ref: 'reorder_list:enter_quantity', value: quantity }
  } else {
    const gap = asked ?? 1
    quantity = String(moq && moq > gap ? moq : gap)
    if (moq && moq > gap) fields.quantity = { source: 'default', ref: 'item_supplier:moq', value: quantity }
    else if (asked) fields.quantity = { source: 'record', ...tag('gap'), value: quantity }
  }

  // Prices come only from master data, never from history (owner decision 6).
  const price = chosen?.referencePrice ? String(chosen.referencePrice) : ''
  if (price) fields.estimatedUnitPrice = { source: 'default', ref: 'item_supplier:reference_price', value: price }

  const warehouse = text(item.defaultWarehouseId)
  if (warehouse) fields.targetWarehouseId = { source: 'default', ref: 'item:default_warehouse', value: warehouse }

  // A date the handoff names; otherwise today plus the supplier's lead time.
  const due = text(query.due)
  const leadTime = Number(chosen?.leadTimeDays)
  const leadDate = chosen?.leadTimeDays !== null && chosen?.leadTimeDays !== undefined && Number.isInteger(leadTime) && leadTime >= 0 && isDay(text(today))
    ? addCalendarDays(text(today), leadTime)
    : null
  const needByDate = isDay(due) ? due : leadDate || text(defaultDate)
  if (isDay(due)) fields.needByDate = { source: 'record', ...tag('due'), value: needByDate }
  else if (leadDate) fields.needByDate = { source: 'default', ref: 'item_supplier:lead_time', value: needByDate }

  const reason = text(query.reason).slice(0, 500)
  if (reason) fields.internalLineComment = { source: 'template', ...tag('reason'), value: reason }

  return {
    origin,
    intent: text(query.intent) === 'rfq' ? 'rfq' : null,
    values: {
      itemId,
      supplierId: chosen?.id || '',
      quantity,
      estimatedUnitPrice: price,
      currency: text(chosen?.currency),
      targetWarehouseId: warehouse,
      needByDate,
      internalLineComment: reason,
    },
    fields,
    supplierChoices,
  }
}
