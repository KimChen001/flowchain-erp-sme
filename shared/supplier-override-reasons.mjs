// Why a person picked a supplier other than the item's preferred one, on a
// purchase request line (and carried onto the PO line made from it). Asked
// only when the item has a preferred supplier and the line names another;
// nothing else ever needs a reason, and a reason never blocks anything else.
// The approver sees it as "Not preferred (<preferred>). Reason: <reason>".
//
//   reasonCode  one of SUPPLIER_OVERRIDE_REASONS
//   note        required for "other" (3 to 500 characters); otherwise
//               optional and only kept to 500 characters

export const SUPPLIER_OVERRIDE_REASONS = Object.freeze(['price', 'lead_time', 'stock_now', 'quality', 'moq_fit', 'customer_specified', 'other'])
export const SUPPLIER_OVERRIDE_NOTE_LIMITS = Object.freeze({ min: 3, max: 500 })

const text = (value) => String(value ?? '').trim()

// True only when a preferred supplier exists and the chosen one is none of
// them. Master data can mark more than one approved source preferred (the
// item's default supplier and a link flagged preferred); choosing any of
// them needs no reason.
export function overrideNeeded({ supplierId, preferredId, preferredIds } = {}) {
  const preferred = [...(Array.isArray(preferredIds) ? preferredIds : []), preferredId].map(text).filter(Boolean)
  return preferred.length > 0 && !preferred.includes(text(supplierId))
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
  // Only Other needs a note; an optional note is never refused for being short.
  const noteFits = reasonCode === 'other'
    ? note.length >= SUPPLIER_OVERRIDE_NOTE_LIMITS.min && note.length <= SUPPLIER_OVERRIDE_NOTE_LIMITS.max
    : note.length <= SUPPLIER_OVERRIDE_NOTE_LIMITS.max
  if (!noteFits) issues.push({ field: 'note', code: 'NOTE_LENGTH' })
  return issues.length ? { value: null, issues } : { value: { reasonCode, note: note || null }, issues }
}
