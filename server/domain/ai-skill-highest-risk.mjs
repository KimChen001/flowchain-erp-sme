import { buildAiSkillSignals, compareSignalsByPrintedDate, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'
import { matchesAiSkillFocus } from './ai-skill-today-priorities.mjs'

const TOP = 5
// The open problems this list names: late orders, stock below its levels,
// invoice variances and rejected receipts. Ordered by the date each line
// prints, the oldest first (compareSignalsByPrintedDate): a late order by its
// promised date, an invoice variance by its invoice date, a rejected receipt
// by its arrival day; the undated stock problems last. Never by a score, an
// amount or the kind of problem, so a late order does not jump ahead of an
// older invoice variance.
const EXPOSURE_TYPES = new Set(['po_overdue', 'stock_shortage', 'stock_below_safety', 'stock_below_reorder', 'invoice_variance', 'grn_rejected_qty'])
const SUPPLIER_TYPES = new Set(['po_overdue', 'invoice_variance', 'grn_rejected_qty'])

// A supplier with two or more exposure signals (late POs, invoice variances,
// rejected receipts) is its own entry, dated by its oldest signal.
function supplierExposure(signals) {
  const bySupplier = new Map()
  for (const item of signals.filter((entry) => SUPPLIER_TYPES.has(entry.type) && entry.supplierId)) {
    bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) || []), item])
  }
  return [...bySupplier.entries()].filter(([, items]) => items.length > 1).map(([supplierId, items]) => {
    const first = [...items].sort(compareSignalsByPrintedDate)[0]
    return {
      id: `supplier_exposure:${supplierId}`, type: 'supplier_exposure', severity: first.severity, entityType: 'supplier', entityId: supplierId,
      label: first.supplier || supplierId, area: 'purchasing', supplierId, supplier: first.supplier, money: null, when: first.when,
      data: { count: items.length, types: [...new Set(items.map((entry) => entry.type))], ids: items.map((entry) => entry.entityId) },
    }
  })
}

// `top` as for runTodayPriorities.
export function runHighestRisk(facts, { focus = null, top = TOP } = {}) {
  const signals = buildAiSkillSignals(facts)
  const exposure = signals.filter((item) => EXPOSURE_TYPES.has(item.type))
  const ranked = [...rankAiSkillItemsByDate(exposure), ...supplierExposure(exposure)]
    .filter((item) => matchesAiSkillFocus(item, focus))
    .sort(compareSignalsByPrintedDate)
    .map((item, index) => ({ ...item, also: item.also || [], rank: index + 1 }))
  return { skillId: 'highest_risk_items', focus, total: ranked.length, items: ranked.slice(0, top) }
}
