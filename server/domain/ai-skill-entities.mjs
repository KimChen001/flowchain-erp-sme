import { PROMPT_INJECTION } from './ai-semantic-query-planner.mjs'
import { aiSkillIsKnownWord } from './ai-skill-intent-text.mjs'

// Resolves the records a question names against the actor's own facts, and
// lets them shape the answer. Routing runs before any data is read, so the
// router only returns the id-shaped tokens it saw; this step classifies and
// looks them up.
//
// Each token gets one state:
//   resolved     the record is in the actor's facts;
//   ambiguous    several orders share the short number ("PO-012" for two
//                prefixes): the answer asks for the full number;
//   hidden       the actor may not read that kind of record: the answer says
//                so without looking it up, so it reads the same whether or
//                not the record exists;
//   truncated    the source was read only up to its row limit: "not among
//                the records read", never "does not exist";
//   absent       a purchase order or SKU number of this workspace's shape
//                that is not there;
//   unsupported  another document number (invoice, request, RFQ, receipt,
//                sales order) these skills do not look up;
//   ignored      not a record number at all ("top-10", "FY-2026").
// Only records the readers returned are candidates, so a record of another
// workspace is never matched.
//
// Names: a supplier or item name counts when it appears whole (or, for a
// supplier, its distinctive first word on its own: "Northstar"), when it has
// a word that is not a workspace or common word, and when neither the
// question nor the name looks like a prompt injection. Stored text never
// chooses the skill on its own: a name only narrows a question about orders,
// stock or approvals, or a general question.

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []
const upper = (value) => text(value).toUpperCase()
const lower = (value) => text(value).toLowerCase().replace(/\s+/g, ' ')
const CJK = /[㐀-鿿豈-﫿]/u
const DOCUMENT_CODE = /(^|-)(INV|PR|RFQ|GRN|SO|QT|RCV|DN|SI)$/
const PO_CODE = /(^|-)P\.?O$/
const GENERIC_NAME_WORDS = new Set(['components', 'component', 'packaging', 'supply', 'supplies', 'supplier', 'electronics', 'electronic', 'industrial', 'industries', 'logistics', 'services', 'service', 'labels', 'label', 'cable', 'wire', 'works', 'metals', 'metal', 'systems', 'solutions', 'group', 'company', 'co', 'corp', 'corporation', 'inc', 'ltd', 'llc', 'trading', 'manufacturing', 'international', 'global', 'precision', 'products', 'parts'])

function idParts(id) {
  const match = upper(id).match(/^(.*?)-(\d+)$/)
  return match ? { prefix: match[1], number: Number(match[2]) } : null
}

// Prefix "LOCAL-DEMO-PO" also answers for "DEMO-PO" and "PO".
function prefixTails(prefix) {
  const parts = prefix.split('-')
  return parts.map((_, index) => parts.slice(index).join('-'))
}

function nameWords(name) {
  return lower(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function distinctive(name) {
  if (CJK.test(name)) return text(name).length >= 2
  return nameWords(name).some((word) => word.length >= 3 && !aiSkillIsKnownWord(word) && !GENERIC_NAME_WORDS.has(word))
}

// The name as a whole phrase of the question: a substring for a Chinese
// name, a phrase bounded by anything but a Latin letter or digit for a Latin
// one ("Acme Components的订单" names Acme Components; "acmeish" does not).
const LATIN_WORD_CHAR = /[a-z0-9]/i
function mentions(said, name) {
  const needle = lower(name)
  if (!needle) return false
  if (CJK.test(needle)) return needle.length >= 2 && said.includes(needle)
  for (let index = said.indexOf(needle); index >= 0; index = said.indexOf(needle, index + 1)) {
    const before = said[index - 1]
    const after = said[index + needle.length]
    if ((!before || !LATIN_WORD_CHAR.test(before)) && (!after || !LATIN_WORD_CHAR.test(after))) return true
  }
  return false
}

// The word written with a capital first letter, other letters lower case,
// and not at the start of the question.
function capitalizedName(message, word) {
  const proper = word[0].toUpperCase() + word.slice(1)
  return [...String(message).matchAll(new RegExp(`(?<![A-Za-z0-9])${proper}(?![A-Za-z0-9])`, 'g'))].some((match) => match.index > 0)
}

function truncatedSource(facts, source) {
  return array(facts?.limitations).some((row) => row.code === 'truncated' && row.source === source)
}

export function resolveAiSkillEntities(message, ids, facts) {
  const visible = facts?.visibility?.sources || {}
  const index = array(facts?.purchaseOrders?.index)
  const inventory = array(facts?.inventory?.rows)
  const suppliers = array(facts?.suppliers)
  const found = { purchaseOrders: [], skus: [], suppliers: [], ambiguous: [], hidden: [], truncated: [], absent: [], unsupported: [] }
  const add = (list, row, key) => { if (!list.some((entry) => entry[key] === row[key])) list.push(row) }
  const poPrefixes = new Set(index.flatMap((row) => [row.id, row.orderNumber].map(idParts).filter(Boolean).flatMap((parts) => prefixTails(parts.prefix))))
  const skuPrefixes = new Set(inventory.map((row) => idParts(row.sku)?.prefix).filter(Boolean))
  for (const token of array(ids).map(upper).filter(Boolean)) {
    const parts = idParts(token)
    if (!parts) continue
    const sku = inventory.find((row) => upper(row.sku) === token)
    const supplier = suppliers.find((row) => upper(row.code) === token || upper(row.id) === token)
    if (sku) { add(found.skus, sku, 'sku'); continue }
    if (supplier) { add(found.suppliers, supplier, 'id'); continue }
    const looksLikeOrder = PO_CODE.test(parts.prefix) || poPrefixes.has(parts.prefix)
    if (looksLikeOrder) {
      if (!visible.purchase_orders || !facts?.purchaseOrders) { found.hidden.push({ id: token, source: 'purchase_orders' }); continue }
      const exact = index.filter((row) => upper(row.id) === token || upper(row.orderNumber) === token)
      const matches = exact.length ? exact : index.filter((row) => [row.id, row.orderNumber].some((value) => {
        const own = idParts(value)
        return own && own.number === parts.number && prefixTails(own.prefix).includes(parts.prefix)
      }))
      const unique = [...new Map(matches.map((row) => [row.id, row])).values()]
      if (unique.length === 1) add(found.purchaseOrders, unique[0], 'id')
      else if (unique.length > 1) found.ambiguous.push({ id: token, candidates: unique.map((row) => row.orderNumber || row.id) })
      else if (truncatedSource(facts, 'purchase_orders')) found.truncated.push({ id: token, source: 'purchase_orders' })
      else found.absent.push({ id: token, source: 'purchase_orders' })
      continue
    }
    if (skuPrefixes.has(parts.prefix)) {
      if (!visible.inventory || !facts?.inventory) found.hidden.push({ id: token, source: 'inventory' })
      else if (truncatedSource(facts, 'inventory')) found.truncated.push({ id: token, source: 'inventory' })
      else found.absent.push({ id: token, source: 'inventory' })
      continue
    }
    if (DOCUMENT_CODE.test(parts.prefix)) found.unsupported.push({ id: token })
    // Anything else is not a record number.
  }
  if (PROMPT_INJECTION.test(message)) return found
  const said = lower(message)
  for (const row of inventory) if (row.itemName && distinctive(row.itemName) && mentions(said, row.itemName)) add(found.skus, row, 'sku')
  const eligible = suppliers.filter((row) => row.name && !PROMPT_INJECTION.test(row.name) && distinctive(row.name))
  const named = eligible.filter((row) => mentions(said, row.name))
  for (const row of named) {
    const longer = named.some((other) => other !== row && lower(other.name).length > lower(row.name).length && lower(other.name).includes(lower(row.name)))
    if (!longer) add(found.suppliers, row, 'id')
  }
  // "Northstar" for Northstar Electronics: a distinctive first word of five
  // or more letters that only one supplier starts with, or of four letters
  // when the question writes it capitalized as a name ("Acme").
  if (!named.length) {
    const firstWords = new Map()
    for (const row of eligible) {
      const [first] = nameWords(row.name)
      if (first && first.length >= 4 && !CJK.test(first) && !aiSkillIsKnownWord(first) && !GENERIC_NAME_WORDS.has(first)) firstWords.set(first, [...(firstWords.get(first) || []), row])
    }
    for (const [word, rows] of firstWords) {
      if (rows.length !== 1 || !mentions(said, word)) continue
      if (word.length >= 5 || capitalizedName(message, word)) add(found.suppliers, rows[0], 'id')
    }
  }
  return found
}

const GENERIC_SKILLS = new Set(['workspace_metrics', 'today_priorities'])
// Skills that answer for one record when the page or the question names it.
const FOCUS_SKILLS = new Set(['today_priorities', 'highest_risk_items', 'records_needing_data', 'prepare_action_draft'])

function focusFromIds(found) {
  if (found.purchaseOrders.length === 1) return { entityType: 'purchase_order', entityId: found.purchaseOrders[0].id }
  if (found.skus.length === 1) return { entityType: 'item', entityId: found.skus[0].itemId || found.skus[0].sku }
  return null
}

// The purchase orders answer for what was found: a named order, an order
// number that needs care (hidden, ambiguous, not read, absent), a SKU, a
// supplier, or the given default.
function orderMode(found, fallback, { bySku = false } = {}) {
  if (found.purchaseOrders.length) return 'single'
  if (found.hidden.some((entry) => entry.source === 'purchase_orders')) return 'hidden'
  if (found.ambiguous.length) return 'ambiguous'
  if (found.truncated.some((entry) => entry.source === 'purchase_orders')) return 'not_found'
  if (found.absent.some((entry) => entry.source === 'purchase_orders')) return 'not_found'
  if (bySku && found.skus.length) return 'sku'
  if (found.suppliers.length) return 'supplier'
  return fallback
}

function stockMode(found, fallback) {
  if (found.skus.length) return 'single'
  if (found.hidden.some((entry) => entry.source === 'inventory')) return 'hidden'
  if (found.truncated.some((entry) => entry.source === 'inventory') || found.absent.some((entry) => entry.source === 'inventory')) return 'not_found'
  return fallback
}

// The route after the named records are looked up. A prompt chip or a
// follow-up's hint keeps its skill and takes a focus only from the page or a
// record number. A question about orders, stock or approvals is narrowed by
// the records it names. A general question that names a record becomes a
// question about that record.
export function refineAiSkillRoute(route, message, facts) {
  if (!route || route.capability || !facts) return route
  const found = resolveAiSkillEntities(message, route.ids, facts)
  const short = Boolean(route.signals?.short)
  const orders = Boolean(route.signals?.orders)
  const as = (skillId, mode) => ({ ...route, skillId, mode, entities: found })
  const skill = route.skillId
  // A stock question from a role that cannot read inventory: the record
  // numbers it names are reported as hidden, never looked up.
  if (skill === 'inventory_availability' && !facts.inventory) {
    const known = new Set([...found.purchaseOrders.flatMap((row) => [row.id, row.orderNumber]), ...found.suppliers.flatMap((row) => [row.id, row.code]), ...[...found.ambiguous, ...found.hidden, ...found.truncated, ...found.absent, ...found.unsupported].map((entry) => entry.id)].filter(Boolean).map(upper))
    for (const id of array(route.ids).map(upper)) if (idParts(id) && !known.has(id) && !found.hidden.some((entry) => entry.id === id)) found.hidden.push({ id, source: 'inventory' })
  }
  if (route.explicit) {
    const idsOnly = { ...found, suppliers: [] }
    if (skill === 'inventory_availability') {
      const sku = found.skus[0] || (route.focus?.entityType === 'item' ? array(facts.inventory?.rows).find((row) => [row.itemId, row.sku].includes(route.focus.entityId)) : null)
      return sku ? { ...as(skill, 'single'), entities: { ...idsOnly, skus: [sku] } } : { ...as(skill, short ? 'short' : 'overview'), entities: idsOnly }
    }
    if (skill === 'purchase_orders') return { ...as(skill, orderMode(idsOnly, 'overdue')), entities: idsOnly }
    const focus = !route.focus && FOCUS_SKILLS.has(skill) ? focusFromIds(found) : null
    return focus ? { ...route, focus, entities: idsOnly } : { ...route, entities: idsOnly }
  }
  if (skill === 'inventory_availability') return as(skill, stockMode(found, short ? 'short' : 'overview'))
  if (skill === 'purchase_orders') return as(skill, orderMode(found, 'overdue', { bySku: true }))
  if (skill === 'pending_approvals') return as(skill, 'all')
  if (!skill || GENERIC_SKILLS.has(skill)) {
    const mode = orderMode(found, null, { bySku: orders })
    if (mode) return as('purchase_orders', mode)
    if (found.skus.length || found.hidden.some((entry) => entry.source === 'inventory') || found.absent.some((entry) => entry.source === 'inventory')) return as('inventory_availability', stockMode(found, 'overview'))
    // "What's the status of INV-001?": say these numbers are not looked up.
    if (!skill && found.unsupported.length) return { capability: true, skillId: 'capability_overview', unsupportedIds: found.unsupported.map((entry) => entry.id), entities: found }
    return skill ? { ...route, entities: found } : null
  }
  if (FOCUS_SKILLS.has(skill) && !route.focus && focusFromIds(found)) return { ...route, focus: focusFromIds(found), entities: found }
  return { ...route, entities: found }
}
