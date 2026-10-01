// Resolves the records a question names against the actor's own facts, and
// lets them choose the skill. Routing runs before any data is read, so the
// router only returns the id-shaped tokens it saw; this step looks them up.
//
//   - A purchase order matches by id or order number, or by a unique suffix
//     ("PO-012" for LOCAL-DEMO-PO-012). Two orders sharing the suffix match
//     neither: the answer asks for the full number instead of guessing.
//   - A SKU matches its code, or its item name as a whole phrase.
//   - A supplier matches its code, or its name as a whole phrase. When one
//     matched name contains another ("Acme" in "Acme Components"), only the
//     longer one counts.
// Only records the readers returned are candidates, so a record of another
// workspace, or one the actor may not read, is never matched; its id is
// reported back as not found.

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []
const phrase = (value) => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const upper = (value) => text(value).toUpperCase()
const MIN_NAME = 3

function containsPhrase(haystack, needle) {
  return needle.length >= MIN_NAME && ` ${haystack} `.includes(` ${needle} `)
}

export function resolveAiSkillEntities(message, ids, facts) {
  const index = array(facts?.purchaseOrders?.index)
  const inventory = array(facts?.inventory?.rows)
  const suppliers = array(facts?.suppliers)
  const found = { purchaseOrders: [], skus: [], suppliers: [], unresolved: [] }
  const add = (list, row, key) => { if (!list.some((entry) => entry[key] === row[key])) list.push(row) }
  for (const id of array(ids).map(upper).filter(Boolean)) {
    const exact = index.filter((row) => upper(row.id) === id || upper(row.orderNumber) === id)
    const bySuffix = exact.length ? exact : index.filter((row) => upper(row.id).endsWith(`-${id}`) || upper(row.orderNumber).endsWith(`-${id}`))
    const sku = inventory.find((row) => upper(row.sku) === id)
    const supplier = suppliers.find((row) => upper(row.code) === id || upper(row.id) === id)
    if (bySuffix.length === 1) add(found.purchaseOrders, bySuffix[0], 'id')
    else if (sku) add(found.skus, sku, 'sku')
    else if (supplier) add(found.suppliers, supplier, 'id')
    else found.unresolved.push(id)
  }
  const said = phrase(message)
  for (const row of inventory) if (containsPhrase(said, phrase(row.itemName))) add(found.skus, row, 'sku')
  const named = suppliers.filter((row) => containsPhrase(said, phrase(row.name)))
  for (const row of named) {
    const longer = named.some((other) => other !== row && phrase(other.name).length > phrase(row.name).length && containsPhrase(phrase(other.name), phrase(row.name)))
    if (!longer) add(found.suppliers, row, 'id')
  }
  return found
}

const GENERIC_SKILLS = new Set(['workspace_metrics', 'today_priorities'])
// Skills that answer for one record when the page or the question names it.
const FOCUS_SKILLS = new Set(['today_priorities', 'highest_risk_items', 'records_needing_data', 'prepare_action_draft'])

function focusFrom(found) {
  if (found.purchaseOrders.length === 1) return { entityType: 'purchase_order', entityId: found.purchaseOrders[0].id }
  if (found.skus.length === 1) return { entityType: 'item', entityId: found.skus[0].itemId || found.skus[0].sku }
  return null
}

// The route after the named records are looked up. An explicit skill (a
// prompt chip or a follow-up's hint) is kept; a named record becomes its
// focus. A general question that names a record becomes a question about it.
export function refineAiSkillRoute(route, message, facts) {
  if (!route || route.capability || !facts) return route
  const found = resolveAiSkillEntities(message, route.ids, facts)
  const short = Boolean(route.signals?.short)
  const as = (skillId, mode) => ({ ...route, skillId, mode, entities: found })
  const skill = route.skillId
  if (route.explicit) {
    if (skill === 'inventory_availability') {
      const sku = found.skus[0] || (route.focus?.entityType === 'item' ? array(facts.inventory?.rows).find((row) => [row.itemId, row.sku].includes(route.focus.entityId)) : null)
      return sku ? { ...as(skill, 'single'), entities: { ...found, skus: [sku] } } : as(skill, short ? 'short' : 'overview')
    }
    if (skill === 'purchase_orders') return as(skill, found.purchaseOrders.length ? 'single' : found.suppliers.length ? 'supplier' : 'overdue')
    return FOCUS_SKILLS.has(skill) && !route.focus && focusFrom(found) ? { ...route, focus: focusFrom(found), entities: found } : { ...route, entities: found }
  }
  if (skill === 'inventory_availability') return as(skill, found.skus.length ? 'single' : found.unresolved.length ? 'not_found' : short ? 'short' : 'overview')
  if (skill === 'purchase_orders') return as(skill, found.purchaseOrders.length ? 'single' : found.suppliers.length ? 'supplier' : found.unresolved.length ? 'not_found' : 'overdue')
  if (!skill || GENERIC_SKILLS.has(skill)) {
    if (found.purchaseOrders.length) return as('purchase_orders', 'single')
    if (found.skus.length) return as('inventory_availability', 'single')
    if (found.suppliers.length) return as('purchase_orders', 'supplier')
    if (found.unresolved.length) return as(short ? 'inventory_availability' : 'purchase_orders', 'not_found')
    return skill ? { ...route, entities: found } : null
  }
  if (FOCUS_SKILLS.has(skill) && !route.focus && focusFrom(found)) return { ...route, focus: focusFrom(found), entities: found }
  return { ...route, entities: found }
}
