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

// query: itemId, sku, quantity, reason, due, suppliers, origin, intent.
// suppliers: the item's approved sources, preferred first, as the item
// supplier API returns them (prices already masked for the reader).
export function planPurchaseRequestPrefill({ query = {}, item = {}, suppliers = [], today, defaultDate } = {}) {
  const origin = prefillOrigin(query.origin)
  const prefix = HANDOFF_REF_PREFIX[origin]
  const tag = (ref) => (prefix ? { ref: `${prefix}:${ref}` } : {})
  const itemId = text(item.itemId || item.id)
  const fields = { itemId: { source: 'record', ...tag('item'), value: itemId } }

  const wanted = text(query.suppliers).split(',')[0]?.trim() || ''
  const named = wanted ? suppliers.find((row) => [row.id, row.supplierCode, row.name, row.supplierName].map(text).includes(wanted)) : undefined
  const preferred = suppliers.find((row) => row.preferred)
  const chosen = named || preferred || suppliers[0]
  if (chosen) {
    fields.supplierId = named
      ? { source: 'record', ...tag('supplier'), value: chosen.id }
      : { source: 'default', ref: chosen === preferred ? 'item_supplier:preferred' : 'item_supplier:first_approved', value: chosen.id }
  }

  // The shortfall the handoff computed, raised to the supplier's minimum
  // order quantity. Without a quantity the line starts at 1, unlabelled.
  const asked = positive(query.quantity)
  const moq = positive(chosen?.minimumOrderQuantity)
  const gap = asked ?? 1
  const quantity = String(moq && moq > gap ? moq : gap)
  if (moq && moq > gap) fields.quantity = { source: 'default', ref: 'item_supplier:moq', value: quantity }
  else if (asked) fields.quantity = { source: 'record', ...tag('gap'), value: quantity }

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
  }
}
