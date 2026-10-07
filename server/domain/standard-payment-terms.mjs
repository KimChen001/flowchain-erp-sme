import { randomUUID } from 'node:crypto'

// The payment terms a new workspace starts with (owner decision D2,
// 2026-10-07), so a supplier file that says NET30 imports on the first day.
// The migration 20261007010000_standard_payment_terms adds the same rows to
// workspaces created before this.
export const STANDARD_PAYMENT_TERMS = Object.freeze([
  Object.freeze({ code: 'DUE', name: 'Due on receipt', days: 0 }),
  Object.freeze({ code: 'NET15', name: 'Net 15', days: 15 }),
  Object.freeze({ code: 'NET30', name: 'Net 30', days: 30 }),
  Object.freeze({ code: 'NET45', name: 'Net 45', days: 45 }),
  Object.freeze({ code: 'NET60', name: 'Net 60', days: 60 }),
])

// Adds the standard terms to a workspace that has no payment terms at all. A
// workspace that already has some keeps exactly those. Returns how many rows
// were created.
export async function ensureStandardPaymentTerms(tx, tenantId) {
  if (await tx.paymentTerm.count({ where: { tenantId } })) return 0
  const { count } = await tx.paymentTerm.createMany({
    data: STANDARD_PAYMENT_TERMS.map(({ code, name, days }) => ({ id: `PT-${randomUUID()}`, tenantId, code, name, days })),
    skipDuplicates: true,
  })
  return count
}

// "Net 30", "net-30" and "NET30" are the same term; so are "Due on receipt"
// and the code DUE.
export const paymentTermKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function findPaymentTerm(terms, value) {
  const key = paymentTermKey(value)
  if (!key) return null
  return terms.find((term) => paymentTermKey(term.code) === key)
    || terms.find((term) => paymentTermKey(term.name) === key)
    || null
}
