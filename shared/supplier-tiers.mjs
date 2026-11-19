// Supplier tiers: the one place that says what each tier means, read by the
// tier command, the supplier pages and the assistant's tools (design audit
// L9-26). A tier is the supplier's importance to the business, set by a
// person with a reason; FlowChain never suggests one (owner decision
// 2026-10-09). What makes a supplier Tier 1 differs per company, so these are
// the default meanings shown where a tier is chosen.
export const SUPPLIER_TIER_DEFINITIONS = Object.freeze([
  Object.freeze({ tier: 1, name: 'Strategic', meaning: 'Losing this supplier would stop sales or operations soon. Needs a named owner and regular review.' }),
  Object.freeze({ tier: 2, name: 'Core', meaning: 'A regular, approved source, with alternatives or limited impact.' }),
  Object.freeze({ tier: 3, name: 'Transactional', meaning: 'Occasional or low-impact purchases.' }),
])

export const SUPPLIER_TIERS = Object.freeze(SUPPLIER_TIER_DEFINITIONS.map((definition) => definition.tier))

// "1 strategic, 2 core, 3 transactional", as the assistant's tools say it.
export const SUPPLIER_TIER_NAMES = SUPPLIER_TIER_DEFINITIONS.map((definition) => `${definition.tier} ${definition.name.toLowerCase()}`).join(', ')
