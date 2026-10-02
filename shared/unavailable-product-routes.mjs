// Product surfaces the owner has taken out of the product. Their code stays,
// but nothing may link to them: not navigation, search, the assistant or
// in-page links. A direct URL shows the "Capability unavailable" page.
//
//   frozen        internal settlement, cashbook and the settlement workflow
//                 (including its mobile settlement task);
//   unavailable   forecast / MRP planning and the legacy imports pages.
export const FROZEN_PRODUCT_ROUTE_IDS = Object.freeze([
  'finance:settlement',
  'finance:settlement-detail',
  'finance:reconciliation',
  'finance:reconciliation-detail',
  'mobile-operations:settlement-detail',
])

const UNAVAILABLE_ROUTE_ID = /^(forecast|imports)(:|$)/
const UNAVAILABLE_PATH = /^\/app\/(finance\/settlement|finance\/reconciliation|mobile\/settlements|forecast|imports)(\/|\?|#|$)/

// True for a route id ("forecast:mrp") or an app path ("/app/imports/failed")
// that belongs to a frozen or unavailable product surface.
export function isUnavailableProductRoute(target) {
  const value = String(target ?? '').trim()
  if (!value) return false
  if (value.startsWith('/')) return UNAVAILABLE_PATH.test(value)
  return FROZEN_PRODUCT_ROUTE_IDS.includes(value) || UNAVAILABLE_ROUTE_ID.test(value)
}

const LINK_KEYS = ['moduleId', 'target', 'targetModule', 'route', 'routeId', 'deepLink', 'href', 'path']
// Lists whose entries are links or actions: an entry into an unavailable
// surface is dropped. Anywhere else (evidence, cards) only the link is removed
// and the text stays.
const LINK_LISTS = new Set(['links', 'navigationLinks', 'navigation', 'actions', 'recommendedActions', 'reviewCards', 'suggestedActions'])
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const linksToUnavailableRoute = (entry) => isRecord(entry) &&
  LINK_KEYS.some((key) => typeof entry[key] === 'string' && isUnavailableProductRoute(entry[key]))

function unlinked(entry) {
  const next = { ...entry }
  for (const key of LINK_KEYS) if (typeof next[key] === 'string' && isUnavailableProductRoute(next[key])) delete next[key]
  return next
}

// A copy of an assistant response without any link or action that points at a
// frozen or unavailable surface.
export function withoutUnavailableProductLinks(value, listKey = '') {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !(LINK_LISTS.has(listKey) && linksToUnavailableRoute(entry)))
      .map((entry) => withoutUnavailableProductLinks(entry))
  }
  if (isRecord(value)) {
    const own = linksToUnavailableRoute(value) ? unlinked(value) : value
    return Object.fromEntries(Object.entries(own).map(([key, entry]) => [key,
      isRecord(entry) && linksToUnavailableRoute(entry) && key === 'linkTarget' ? null : withoutUnavailableProductLinks(entry, key)]))
  }
  return value
}
