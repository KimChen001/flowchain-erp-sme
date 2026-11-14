// Constraint cases on the UCI walkthrough workspace (2026-11-11, the owner's
// "先测再改": how often the assistant breaks a hard limit). Each question sets
// a limit the answer must keep:
//   minimum   a supplier's minimum order quantity (an order below it is
//             raised, or the minimum is said)
//   budget    the user's spending limit, at each item's price, together with
//             the minimums; when the cakestand's minimum order alone costs
//             more than a budget, the answer must say so (at #319's purchase
//             prices it fits £500 but not £300)
//   supplier  only one supplier's items
//   exclude   an item the user leaves out
//   arithmetic  a figure worked out from the minimum and the price
// A form's ticked lines are checked against the limits (formRules); the text
// is checked for the limit being said and for the tempting wrong figure (the
// quantity the budget buys below the minimum). Figures come from uciFacts.

// The minimum said beside its figure, in either order.
const minimumSaid = (quantity, words) => String.raw`(?:${words})[^.\n。]{0,60}\b${quantity}\b|\b${quantity}\b[^.\n。]{0,40}(?:${words})`
const MINIMUM_EN = String.raw`minimum|MOQ|at least`
const MINIMUM_ZH = String.raw`起订|最小|最低|至少`

export function buildUciConstraintCases(facts) {
  const cake = facts.item(facts.scene.reorder.sku)
  const acme = facts.item(facts.scene.hero.sku).supplier
  // An item nothing covers (no open order, not on the reorder list) with a
  // minimum of 100 or more, so a form ticks it: 85099B on the seeded plan.
  const plainSku = facts.skus.find((sku) => facts.minimums[sku] >= 100 && facts.item(sku).onOrder === 0 && !facts.reorder.some((row) => row.sku === sku)) || facts.scene.hero.sku
  const jumbo = facts.item(plainSku)
  const rules = (extra = {}) => ({ prices: facts.prices, minimums: facts.minimums, ...extra })
  const cost = (quantity, price) => Math.round(quantity * price * 100) / 100
  const minimumCost = cost(cake.minimumOrderQuantity, cake.price)
  // What a budget buys of the cakestand when the minimum is ignored.
  const ignoring = (budget) => Math.floor(budget / cake.price)
  // The checks that the minimum order does not fit a budget, only when it does
  // not (2026-11-14: at #319's prices the £500 case still asked for "does not
  // fit", and would have counted a valid order of 78 as one below the minimum).
  const unfit = (budget, checks) => (minimumCost > budget ? checks : {})
  const cases = []
  const add = (row) => cases.push({ kind: 'constraints', ...row })

  // Minimum order: a quantity below it.
  add({ id: 'minimum-below-en', language: 'en-US', turns: ['Order 30 cakestands'],
    expect: { ui: { has: ['pr_form'] }, formRules: rules(), matches: [{ label: `says the minimum is ${cake.minimumOrderQuantity}`, pattern: minimumSaid(cake.minimumOrderQuantity, MINIMUM_EN) }] } })
  add({ id: 'minimum-below-zh', language: 'zh-CN', turns: [`帮我订 20 个 ${jumbo.sku}`],
    expect: { ui: { has: ['pr_form'] }, formRules: rules(), matches: [{ label: `说起订量是 ${jumbo.minimumOrderQuantity}`, pattern: minimumSaid(jumbo.minimumOrderQuantity, MINIMUM_ZH) }] } })

  // Budget: the form within it; the minimum order said when it costs more.
  add({ id: 'budget-500-en', language: 'en-US', turns: ['I have £500 to spend on stock this week. What should I order?'],
    expect: {
      formRules: rules({ budget: 500 }),
      ...unfit(500, {
        matches: [{ label: `says the minimum order (${minimumCost}) does not fit`, pattern: String.raw`${minimumCost.toLocaleString('en-GB')}|${minimumCost}|${minimumSaid(cake.minimumOrderQuantity, MINIMUM_EN)}|over (?:your |the )?(?:£?500 )?budget|exceeds?|more than (?:your |the )?(?:£?500|budget)` }],
        notMatches: [{ label: `${ignoring(500)} cakestands, below the minimum`, pattern: String.raw`\b${ignoring(500)}\s*(?:cakestands?|units?|pcs|of\b)` }],
      }),
    } })
  add({ id: 'budget-300-zh', language: 'zh-CN', turns: ['预算只有 300 英镑，这周该补什么货？'],
    expect: {
      formRules: rules({ budget: 300 }),
      ...unfit(300, {
        matches: [{ label: `说起订量的金额（${minimumCost}）超出预算`, pattern: String.raw`${minimumCost}|${minimumSaid(cake.minimumOrderQuantity, MINIMUM_ZH)}|超出|超过|不够|不足` }],
        notMatches: [{ label: `${ignoring(300)} 个蛋糕架，低于起订量`, pattern: String.raw`\b${ignoring(300)}\s*(?:个|件|pcs)` }],
      }),
    } })
  // A quantity and a budget: the 100 asked for, or the most the budget buys
  // when it buys fewer (above the minimum), on the form as the user's item.
  add({ id: 'budget-quantity-en', language: 'en-US', turns: ['I want 100 cakestands but I can only spend £1,000'],
    expect: {
      formRules: rules({ budget: 1000 }),
      formLines: [{ sku: cake.sku, quantity: Math.min(100, ignoring(1000)), checked: true }],
      numbers: [{ label: 'cost of 100', value: cost(100, cake.price) }],
    } })

  // Supplier and exclusion.
  add({ id: 'supplier-only-en', language: 'en-US', turns: [`Reorder what we need from ${acme} only`],
    expect: { formRules: rules({ onlySkus: facts.suppliedBy(acme) }) } })
  add({ id: 'exclude-en', language: 'en-US', turns: ['What should I reorder this week? Leave out the cakestand.'],
    expect: { formRules: rules({ notSkus: [cake.sku] }) } })

  // Arithmetic on the minimum.
  add({ id: 'minimum-multiple-en', language: 'en-US', turns: ['What would three times the minimum order of the Regency Cakestand cost?'],
    expect: { numbers: [
      { label: 'three times the minimum', value: 3 * cake.minimumOrderQuantity },
      { label: 'its cost', value: cost(3 * cake.minimumOrderQuantity, cake.price) },
    ] } })
  return cases
}
