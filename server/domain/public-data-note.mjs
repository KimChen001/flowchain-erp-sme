// The note of a local workspace seeded from public data
// (docs/public-data-workspaces.md): which dataset, its original window, how
// many days its dates moved, what it holds and which purchasing figures are
// assumed. The app shows it as a notice in the user's language; only these
// fields leave the server, and nothing else from the record.
const DATASETS = new Set(['m5', 'uci'])
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const COUNT_KEYS = ['items', 'suppliers', 'customers', 'salesOrders', 'salesOrderLines', 'purchaseOrders', 'openPurchaseOrders', 'customerInvoices', 'cancellations']
const ASSUMPTION_KEYS = ['leadTimeDays', 'reviewDays', 'holdingRatePercent', 'shortageToHolding', 'paymentTermsDays']

const day = (value) => (ISO_DAY.test(String(value || '')) ? String(value) : null)
const whole = (value) => (Number.isInteger(value) ? value : null)
const text = (value, limit = 400) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null)

export function publicDataNoteSummary(payload) {
  if (!payload || typeof payload !== 'object' || !DATASETS.has(payload.dataset)) return null
  const sourceFirst = day(payload.sourceWindow?.first)
  const sourceLast = day(payload.sourceWindow?.last)
  const first = day(payload.window?.first)
  const last = day(payload.window?.last)
  if (!sourceFirst || !sourceLast || !first || !last || whole(payload.shiftDays) === null) return null
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, whole(payload.counts?.[key])]).filter(([, value]) => value !== null))
  const assumptions = Object.fromEntries(ASSUMPTION_KEYS.map((key) => [key, whole(payload.assumptions?.[key])]).filter(([, value]) => value !== null))
  return {
    dataset: payload.dataset,
    sourceWindow: { first: sourceFirst, last: sourceLast },
    window: { first, last },
    shiftDays: payload.shiftDays,
    counts,
    assumptions,
    citation: text(payload.source?.citation),
    licence: text(payload.source?.licence, 80),
    url: /^https:\/\//.test(String(payload.source?.url || '')) ? text(payload.source.url, 200) : null,
    // The walkthrough scene's fictional suppliers (scripts/public-data/scene.mjs).
    sceneSuppliers: Array.isArray(payload.scene?.suppliers) ? payload.scene.suppliers.map((name) => text(name, 80)).filter(Boolean).slice(0, 5) : [],
  }
}
