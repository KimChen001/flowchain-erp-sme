// Why a person picked a supplier other than the item's preferred one, on a
// purchase request line (and carried onto the PO line made from it). Asked
// only when the item has a preferred supplier and the line names another;
// nothing else ever needs a reason, and a reason never blocks anything else.
// The approver sees it as "Not preferred (<preferred>). Reason: <reason>".
//
//   reasonCode  one of SUPPLIER_OVERRIDE_REASONS
//   note        optional, 3 to 500 characters; required for "other"

export const SUPPLIER_OVERRIDE_REASONS = Object.freeze(['price', 'lead_time', 'stock_now', 'quality', 'moq_fit', 'customer_specified', 'other'])
export const SUPPLIER_OVERRIDE_NOTE_LIMITS = Object.freeze({ min: 3, max: 500 })

const text = (value) => String(value ?? '').trim()

// True only when a preferred supplier exists and the chosen one differs.
export function overrideNeeded({ supplierId, preferredId } = {}) {
  const preferred = text(preferredId)
  return Boolean(preferred) && text(supplierId) !== preferred
}

// { value: { reasonCode, note } | null, issues: [{ field, code }] }. When no
// reason is needed the value is null and anything sent is dropped.
export function validateSupplierOverride(raw, needed) {
  if (!needed) return { value: null, issues: [] }
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const reasonCode = text(input.reasonCode)
  const note = text(input.note)
  const issues = []
  if (!reasonCode) issues.push({ field: 'reasonCode', code: 'REASON_REQUIRED' })
  else if (!SUPPLIER_OVERRIDE_REASONS.includes(reasonCode)) issues.push({ field: 'reasonCode', code: 'REASON_UNKNOWN' })
  const noteFits = note.length >= SUPPLIER_OVERRIDE_NOTE_LIMITS.min && note.length <= SUPPLIER_OVERRIDE_NOTE_LIMITS.max
  if (reasonCode === 'other' ? !noteFits : note && !noteFits) issues.push({ field: 'note', code: 'NOTE_LENGTH' })
  return issues.length ? { value: null, issues } : { value: { reasonCode, note: note || null }, issues }
}
