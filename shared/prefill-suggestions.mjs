// Prefilled form values: where each one came from, and what the user did with
// it before saving. The browser builds the trail when a prefilled form is
// saved; the server accepts it into that save's audit row. The trail carries
// codes and ids only, never a value the user typed or accepted
// (docs/ai-prefill-autocomplete-design.md, owner decisions of 2026-10-03).
//
//   record             a field of the record the suggestion is about
//   default            master data or a workspace default
//   template           a fixed sentence filled from the record
//   history            the actor's own earlier value (phase 2)
//   workspace_history  a value used in the workspace (phase 4)
//   model              model wording, facts through slots (phase 3)

export const PREFILL_SOURCES = Object.freeze(['record', 'default', 'template', 'history', 'workspace_history', 'model'])
export const PREFILL_OUTCOMES = Object.freeze(['accepted', 'edited', 'cleared'])
// Where a prefilled form was opened from.
export const PREFILL_ORIGINS = Object.freeze(['ai_assistant', 'today_cockpit', 'form'])

const MAX_FIELDS = 40
const FIELD_PATTERN = /^[a-z][A-Za-z0-9_.]{0,63}$/
const REF_PATTERN = /^[A-Za-z0-9_.:/-]{1,120}$/

const normalize = (value) => String(value ?? '').trim()

export function prefillOrigin(value) {
  const origin = normalize(value)
  if (origin === 'ai' || origin === 'ai_assistant') return 'ai_assistant'
  return PREFILL_ORIGINS.includes(origin) ? origin : 'form'
}

// What became of one prefilled value at save time.
export function prefillOutcome(prefilled, submitted) {
  const after = normalize(submitted)
  if (!after) return 'cleared'
  return after === normalize(prefilled) ? 'accepted' : 'edited'
}

// prefills: { field: { source, ref?, value } }; values: { field: submitted value }.
export function buildSuggestionTrail({ origin, prefills = {}, values = {} } = {}) {
  const fields = Object.entries(prefills)
    .filter(([, entry]) => entry && PREFILL_SOURCES.includes(entry.source))
    .map(([field, entry]) => ({
      field,
      source: entry.source,
      ...(entry.ref ? { ref: entry.ref } : {}),
      outcome: prefillOutcome(entry.value, values[field]),
    }))
  return fields.length ? { origin: prefillOrigin(origin), fields } : null
}

// The suggested fields of a draft or form: { field: { source, ref?, value } }.
// The value is kept so the review screen can tell whether a field still
// holds the suggestion; it never goes to an audit row.
const MAX_PREFILL_VALUE = 4000
export function sanitizePrefillMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [field, entry] of Object.entries(raw).slice(0, MAX_FIELDS)) {
    if (!FIELD_PATTERN.test(field) || !entry || typeof entry !== 'object') continue
    if (!PREFILL_SOURCES.includes(entry.source) || typeof entry.value !== 'string' || entry.value.length > MAX_PREFILL_VALUE) continue
    const ref = normalize(entry.ref)
    out[field] = { source: entry.source, ...(REF_PATTERN.test(ref) ? { ref } : {}), value: entry.value }
  }
  return Object.keys(out).length ? out : null
}

// The server's view of a posted trail: unknown codes, oversized or malformed
// entries and any other property are dropped, so no free text reaches the
// audit row. Returns null when nothing valid is left.
export function sanitizeSuggestionTrail(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) return null
  const seen = new Set()
  const fields = []
  for (const entry of raw.fields) {
    if (fields.length >= MAX_FIELDS) break
    if (!entry || typeof entry !== 'object') continue
    const field = normalize(entry.field)
    if (!FIELD_PATTERN.test(field) || seen.has(field)) continue
    if (!PREFILL_SOURCES.includes(entry.source) || !PREFILL_OUTCOMES.includes(entry.outcome)) continue
    const ref = normalize(entry.ref)
    seen.add(field)
    fields.push({ field, source: entry.source, ...(REF_PATTERN.test(ref) ? { ref } : {}), outcome: entry.outcome })
  }
  if (!fields.length) return null
  const count = (outcome) => fields.filter((entry) => entry.outcome === outcome).length
  return {
    origin: prefillOrigin(raw.origin),
    fields,
    counts: { prefilled: fields.length, accepted: count('accepted'), edited: count('edited'), cleared: count('cleared') },
  }
}
