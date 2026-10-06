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
//   absent       a purchase order, SKU or supplier code of this workspace's
//                shape that is not there;
//   unsupported  another document number (invoice, request, RFQ, receipt,
//                sales order) these skills do not look up;
//   ignored      not a record number at all ("top-10", "FY-2026").
// Only records the readers returned are candidates, so a record of another
// workspace is never matched. A SKU the question writes in full (TSH-001-BLK,
// WID-RED) is matched as written, before the shorter id-shaped tokens.
//
// Names: a supplier or item name counts when it appears whole, compared
// without punctuation ("Global Tech Ltd" for "Global Tech, Ltd."), when it has
// a word that is not a workspace or common word, and when neither the
// question nor the name looks like a prompt injection. A one-word Latin name,
// or a supplier's first word on its own ("Northstar"), counts only when the
// question writes it as a name: capitalized inside the sentence, or opening a
// Chinese question ("Summit 有哪些…"). A Chinese name counts when the question
// does not run on into a longer word ("螺丝" is not named by "螺丝刀"). The
// longest name wins over a shorter one it contains. Stored text never chooses
// the skill on its own, and a prompt chip or follow-up takes a focus only from
// a record number or the page, never from a name.

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []
const upper = (value) => text(value).toUpperCase()
// Lower case with punctuation and spacing folded to single spaces.
const phrase = (value) => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const CJK = /[㐀-鿿豈-﫿]/u
const DOCUMENT_CODE = /(^|-)(INV|PR|RFQ|GRN|SO|QT|RCV|DN|SI)$/
const PO_CODE = /(^|-)P\.?O$/
const GENERIC_NAME_WORDS = new Set(['components', 'component', 'packaging', 'supply', 'supplies', 'supplier', 'electronics', 'electronic', 'industrial', 'industries', 'logistics', 'services', 'service', 'labels', 'label', 'cable', 'wire', 'works', 'metals', 'metal', 'systems', 'solutions', 'group', 'company', 'co', 'corp', 'corporation', 'inc', 'ltd', 'llc', 'trading', 'manufacturing', 'international', 'global', 'precision', 'products', 'parts'])
const LATIN_WORD_CHAR = /[a-z0-9]/i
// Characters that may follow a Chinese name in a question: a particle or the
// first character of a usual predicate ("华东电子的订单", "华东电子有…").
const CJK_NAME_FOLLOWER = /[的有还是在和与及吗呢了现目共等库订采发供可多哪几这那最需要会能缺逾到已未待]/u

function idParts(id) {
  const match = upper(id).match(/^(.*?)-(\d+)$/)
  return match ? { prefix: match[1], number: Number(match[2]) } : null
}

// Prefix "LOCAL-EAST-PO" also answers for "EAST-PO" and "PO".
function prefixTails(prefix) {
  const parts = prefix.split('-')
  return parts.map((_, index) => parts.slice(index).join('-'))
}

function nameWords(name) {
  return phrase(name).split(' ').filter(Boolean)
}

function distinctive(name) {
  if (CJK.test(name)) return text(name).length >= 2
  return nameWords(name).some((word) => word.length >= 3 && !aiSkillIsKnownWord(word) && !GENERIC_NAME_WORDS.has(word))
}

// The name as a whole phrase of the question (both without punctuation).
function mentions(said, name) {
  const needle = phrase(name)
  if (!needle) return false
  for (let index = said.indexOf(needle); index >= 0; index = said.indexOf(needle, index + 1)) {
    const before = said[index - 1]
    const after = said[index + needle.length]
    if (CJK.test(needle)) {
      if (needle.length >= 2 && (!after || !CJK.test(after) || CJK_NAME_FOLLOWER.test(after))) return true
      continue
    }
    if ((!before || !LATIN_WORD_CHAR.test(before)) && (!after || !LATIN_WORD_CHAR.test(after))) return true
  }
  return false
}

// The word written as a name: capitalized, not at the start of the
// question, or at the start when a Chinese question or a possessive follows.
function writtenAsName(message, word) {
  const proper = word[0].toUpperCase() + word.slice(1)
  for (const match of String(message).matchAll(new RegExp(`(?<![A-Za-z0-9])${proper}(?![A-Za-z0-9])`, 'g'))) {
    if (match.index > 0) return true
    const rest = String(message).slice(match[0].length)
    if (/^\s*(?:[㐀-鿿豈-﫿]|'s\b|’s\b|[:：,，])/u.test(rest)) return true
  }
  return false
}

function oneLatinWord(name) {
  return !CJK.test(name) && nameWords(name).length === 1
}

// A name the question names: whole, and written as a name when it is one
// Latin word.
function namedBy(message, said, name) {
  if (!name || !distinctive(name) || PROMPT_INJECTION.test(name) || !mentions(said, name)) return false
  return !oneLatinWord(name) || writtenAsName(message, nameWords(name)[0])
}

// Drops a match whose name is contained in a longer matched name.
function longestOnly(rows, nameOf) {
  return rows.filter((row) => !rows.some((other) => other !== row && phrase(nameOf(other)).length > phrase(nameOf(row)).length && phrase(nameOf(other)).includes(phrase(nameOf(row)))))
}

function truncatedSource(facts, source) {
  return array(facts?.limitations).some((row) => row.code === 'truncated' && row.source === source)
}

export function resolveAiSkillEntities(message, ids, facts) {
  const visible = facts?.visibility?.sources || {}
  const index = array(facts?.purchaseOrders?.index)
  const items = [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)]
  const suppliers = array(facts?.suppliers)
  // viaName: SKUs found only by their item name, which a prompt chip ignores.
  const found = { purchaseOrders: [], skus: [], suppliers: [], ambiguous: [], hidden: [], truncated: [], absent: [], unsupported: [], viaName: [] }
  const add = (list, row, key) => { if (!list.some((entry) => entry[key] === row[key])) list.push(row) }
  const poPrefixes = new Set(index.flatMap((row) => [row.id, row.orderNumber].map(idParts).filter(Boolean).flatMap((parts) => prefixTails(parts.prefix))))
  const skuPrefixes = new Set(items.map((row) => idParts(row.sku)?.prefix).filter(Boolean))
  const supplierPrefixes = new Set(suppliers.map((row) => idParts(row.code)?.prefix).filter(Boolean))
  // SKUs written in full, as whole tokens ("-" is part of a SKU token).
  const asked = upper(message)
  const written = items.filter((row) => {
    const sku = upper(row.sku)
    if (!sku) return false
    for (let at = asked.indexOf(sku); at >= 0; at = asked.indexOf(sku, at + 1)) {
      const before = asked[at - 1]
      const after = asked[at + sku.length]
      if ((!before || !/[A-Z0-9-]/.test(before)) && (!after || !/[A-Z0-9-]/.test(after))) return true
    }
    return false
  })
  for (const row of longestOnly(written, (entry) => entry.sku)) add(found.skus, row, 'sku')
  for (const token of array(ids).map(upper).filter(Boolean)) {
    const parts = idParts(token)
    if (!parts) continue
    // "TSH-001" inside "TSH-001-BLK" is not a second SKU.
    if (found.skus.some((row) => upper(row.sku) !== token && upper(row.sku).startsWith(`${token}-`))) continue
    const sku = items.find((row) => upper(row.sku) === token)
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
    if (supplierPrefixes.has(parts.prefix)) {
      if (truncatedSource(facts, 'suppliers')) found.truncated.push({ id: token, source: 'suppliers' })
      else found.absent.push({ id: token, source: 'suppliers' })
      continue
    }
    if (DOCUMENT_CODE.test(parts.prefix)) found.unsupported.push({ id: token })
    // Anything else is not a record number.
  }
  if (PROMPT_INJECTION.test(message)) return found
  const said = phrase(message)
  for (const row of longestOnly(items.filter((entry) => namedBy(message, said, entry.itemName)), (entry) => entry.itemName)) {
    if (!found.skus.some((entry) => entry.sku === row.sku)) { found.skus.push(row); found.viaName.push(row.sku) }
  }
  const named = longestOnly(suppliers.filter((row) => namedBy(message, said, row.name)), (row) => row.name)
  for (const row of named) add(found.suppliers, row, 'id')
  // "Northstar" for Northstar Electronics: a distinctive first word of four
  // or more letters that only one supplier starts with, written as a name.
  const firstWords = new Map()
  for (const row of suppliers) {
    if (!row.name || CJK.test(row.name) || PROMPT_INJECTION.test(row.name) || oneLatinWord(row.name)) continue
    const [first] = nameWords(row.name)
    if (first && first.length >= 4 && !aiSkillIsKnownWord(first) && !GENERIC_NAME_WORDS.has(first)) firstWords.set(first, [...(firstWords.get(first) || []), row])
  }
  for (const [word, rows] of firstWords) {
    if (rows.length === 1 && mentions(said, word) && writtenAsName(message, word)) add(found.suppliers, rows[0], 'id')
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

const missing = (found, source) => [...found.truncated, ...found.absent].some((entry) => entry.source === source)

// The purchase orders answer for what was found: a named order, an order
// number that needs care (hidden, ambiguous, not read, absent), a SKU or a
// supplier (a named SKU or supplier code that is not there is "not found",
// never every order), or the given default.
function orderMode(found, fallback, { bySku = false } = {}) {
  if (found.purchaseOrders.length) return 'single'
  if (found.hidden.some((entry) => entry.source === 'purchase_orders')) return 'hidden'
  if (found.ambiguous.length) return 'ambiguous'
  if (missing(found, 'purchase_orders') || missing(found, 'suppliers')) return 'not_found'
  if (bySku && found.skus.length) return 'sku'
  if (bySku && missing(found, 'inventory')) return 'not_found'
  if (found.suppliers.length) return 'supplier'
  return fallback
}

function stockMode(found, fallback) {
  if (found.skus.length) return 'single'
  if (found.hidden.some((entry) => entry.source === 'inventory')) return 'hidden'
  if (missing(found, 'inventory')) return 'not_found'
  return fallback
}

// A focus on a record of a source the actor cannot read is dropped, so the
// answer is the same for a real and a made-up id.
function visibleFocus(focus, facts) {
  if (focus?.entityType === 'purchase_order' && !facts.purchaseOrders) return null
  if (focus?.entityType === 'item' && !facts.inventory) return null
  return focus || null
}

// The page's record as a record the question names, for the skills that are
// narrowed by named records rather than by a focus. The router sets a page
// focus only when the question points at the page's record and names none.
function withPageRecord(found, focus, facts) {
  const id = focus?.entityId
  if (focus?.entityType === 'purchase_order' && !found.purchaseOrders.length) {
    const row = array(facts.purchaseOrders?.index).find((entry) => [entry.id, entry.orderNumber].includes(id))
    return row ? { ...found, purchaseOrders: [row] } : found
  }
  if (focus?.entityType === 'item' && !found.skus.length) {
    const row = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((entry) => [entry.itemId, entry.sku].includes(id))
    return row ? { ...found, skus: [row] } : found
  }
  if (focus?.entityType === 'supplier' && !found.suppliers.length) {
    const row = array(facts.suppliers).find((entry) => [entry.id, entry.code].includes(id))
    return row ? { ...found, suppliers: [row] } : found
  }
  return found
}

// The suppliers of the tier a question filters by, among the reader's own
// (supplierIds null when the reader cannot see suppliers, so the answer says
// it could not filter). The tier filters and labels; it never changes the
// order (docs/supplier-tiers-design.md §6, decision 8).
export const AI_SKILL_TIER_SKILLS = new Set(['purchase_orders', 'supplier_attention', 'prepare_action_draft'])
const TIER_SKILLS = AI_SKILL_TIER_SKILLS
function tierFilter(tier, facts) {
  if (!tier) return null
  if (!Array.isArray(facts.suppliers)) return { tier, supplierIds: null }
  return { tier, supplierIds: facts.suppliers.filter((row) => (tier === 'none' ? !row.tier : row.tier === tier)).map((row) => row.id) }
}

// The route after the named records are looked up. A prompt chip or a
// follow-up's hint keeps its skill and takes a focus only from the page or a
// record number. A question about orders, stock or approvals is narrowed by
// the records it names, or by the page's record when it points at it ("is
// this PO late?"). A general question that names a record becomes a question
// about that record.
export function refineAiSkillRoute(route, message, facts) {
  if (!route || route.capability || !facts) return route
  route = { ...route, focus: visibleFocus(route.focus, facts) }
  const named = resolveAiSkillEntities(message, route.ids, facts)
  const found = FOCUS_SKILLS.has(route.skillId) ? named : withPageRecord(named, route.focus, facts)
  const short = Boolean(route.signals?.short)
  const orders = Boolean(route.signals?.orders)
  // Chips and follow-up hints carry no tier.
  const tier = route.explicit ? null : tierFilter(route.signals?.tier, facts)
  const as = (skillId, mode, entities = found) => ({ ...route, skillId, mode, entities, ...(tier && TIER_SKILLS.has(skillId) ? { tier } : {}) })
  const skill = route.skillId
  if (route.explicit) {
    const idsOnly = { ...found, suppliers: [], skus: found.skus.filter((row) => !found.viaName.includes(row.sku)), viaName: [] }
    if (skill === 'inventory_availability') {
      const pageItem = route.focus?.entityType === 'item' ? [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((row) => [row.itemId, row.sku].includes(route.focus.entityId)) : null
      const sku = idsOnly.skus[0] || pageItem
      if (sku) return as(skill, 'single', { ...idsOnly, skus: [sku] })
      return as(skill, stockMode(idsOnly, short ? 'short' : 'overview'), idsOnly)
    }
    if (skill === 'purchase_orders') return as(skill, orderMode(idsOnly, 'overdue'), idsOnly)
    if (skill === 'pending_approvals') return as(skill, missing(idsOnly, 'purchase_orders') || missing(idsOnly, 'inventory') || missing(idsOnly, 'suppliers') ? 'not_found' : 'all', idsOnly)
    const focus = !route.focus && FOCUS_SKILLS.has(skill) ? focusFromIds(idsOnly) : null
    return focus ? { ...route, focus, entities: idsOnly } : { ...route, entities: idsOnly }
  }
  if (skill === 'inventory_availability') return as(skill, stockMode(found, short ? 'short' : 'overview'))
  if (skill === 'purchase_orders') return as(skill, orderMode(found, 'overdue', { bySku: true }))
  // A supplier the question names (or the page's, when it points at it) narrows the list to it.
  if (skill === 'supplier_attention') return as(skill, found.suppliers.length ? 'supplier' : 'all')
  if (skill === 'pending_approvals') {
    const narrowed = found.suppliers.length || found.skus.length
    return as(skill, !narrowed && (missing(found, 'inventory') || missing(found, 'suppliers') || missing(found, 'purchase_orders')) ? 'not_found' : 'all')
  }
  if (!skill || GENERIC_SKILLS.has(skill)) {
    // A question about orders from a role that cannot read them gets the
    // same hidden answer in either language.
    if (orders && !facts.purchaseOrders && (!skill || (skill === 'workspace_metrics' && !short))) return as('purchase_orders', 'hidden')
    const mode = orderMode(found, null, { bySku: orders })
    if (mode) return as('purchase_orders', mode)
    if (found.skus.length || found.hidden.some((entry) => entry.source === 'inventory') || missing(found, 'inventory')) return as('inventory_availability', stockMode(found, 'overview'))
    // "What's the status of INV-001?": say these numbers are not looked up.
    if (!skill && found.unsupported.length) return { capability: true, skillId: 'capability_overview', unsupportedIds: found.unsupported.map((entry) => entry.id), entities: found }
    return skill ? { ...route, entities: found } : null
  }
  const tiered = tier && TIER_SKILLS.has(skill) ? { tier } : {}
  if (FOCUS_SKILLS.has(skill) && !route.focus && focusFromIds(found)) return { ...route, focus: focusFromIds(found), entities: found, ...tiered }
  return { ...route, entities: found, ...tiered }
}
