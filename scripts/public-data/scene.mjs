// The walkthrough scene in the UCI workspace: an [assumed] purchasing story on
// top of the public sales, for a buyer's first look at FlowChain. Everything
// here is purchasing (suppliers, purchase orders, receipts, stock); the sales
// stay exactly as in the data. Dates count back from the seed day (the as-of
// day, offset 0 = today); the last day of the data is offset -1.
//
//   suppliers   StockCode family 85 is "Acme Home Goods" and family 84
//               "Globex Party Supplies": fictional names on reserved
//               .example domains. Acme is Tier 1, set by the buyer with a
//               written reason. Every third Acme order before the last three
//               weeks arrived 2 days after its promised date.
//   hero        85123A White Hanging Heart T-Light Holder, Acme's best seller,
//               ends below its safety stock with two late open Acme orders
//               for it: one partly received, one with nothing received. They
//               cover its reorder point, so the reorder list does not suggest
//               it.
//   second      84879 Assorted Colour Bird Ornament has one late Globex order
//               with nothing received, so late orders span two suppliers.
//   reorder     22423 Regency Cakestand 3 Tier has no open order and ends just
//               under its reorder point: the reorder list suggests its
//               supplier's minimum order. Its weekly orders stop at the latest
//               review that still leaves it there, and the orders it would
//               have placed after that and not yet received are not placed.
//   approval    85152 Hand Over The Chocolate Sign has a purchase order
//               waiting for approval.
// The hero and the second item place no weekly orders in the last three
// weeks (the hero longer when it would not otherwise fall below its safety
// stock); the scene items' stock
// is cut back by the trim rule of simulatePurchasing (plan.mjs), never below
// what every public order needs.

export const UCI_SCENE = Object.freeze({
  freezeDays: 21,
  suppliers: Object.freeze({
    85: Object.freeze({ name: 'Acme Home Goods', code: 'ACME', email: 'orders@acme-homegoods.example', contactName: 'Acme order desk', tier: 1 }),
    84: Object.freeze({ name: 'Globex Party Supplies', code: 'GLOBEX', email: 'orders@globex-party.example', contactName: 'Globex order desk' }),
  }),
  lateDeliveries: Object.freeze({ supplierKey: '85', everyNth: 3, daysLate: 2 }),
  buyer: Object.freeze({ name: 'Daniel', email: 'daniel@example.com', jobTitle: 'Buyer' }),
  hero: Object.freeze({
    sku: '85123A',
    closing: 48,
    orders: Object.freeze([
      Object.freeze({ role: 'hero_partly_received', created: -20, time: '10:15', promised: -6, minimums: 2, receivedMinimums: 1 }),
      Object.freeze({ role: 'hero_nothing_received', created: -18, time: '14:40', promised: -4, minimums: 2, receivedMinimums: 0 }),
    ]),
  }),
  second: Object.freeze({ sku: '84879', order: Object.freeze({ role: 'second_supplier_late', created: -19, time: '11:05', promised: -5 }) }),
  reorder: Object.freeze({ sku: '22423', shortfall: 20 }),
  approval: Object.freeze({ sku: '85152', role: 'waiting_for_approval', created: -1, time: '16:20' }),
})

const SCENE_SKUS = [UCI_SCENE.hero.sku, UCI_SCENE.second.sku, UCI_SCENE.reorder.sku, UCI_SCENE.approval.sku]

export function sceneMissingSkus(items) {
  const skus = new Set(items.map((item) => item.sku))
  return SCENE_SKUS.filter((sku) => !skus.has(sku))
}

// Before the purchasing simulation: names and contacts for the two suppliers,
// the scene items' freeze, receipt and closing targets, and Acme's late
// deliveries (delayOf for simulatePurchasing).
export function prepareScene({ items, suppliers, days, reviewIndexes, simulate, scene = UCI_SCENE }) {
  const missing = sceneMissingSkus(items)
  if (missing.length) throw new Error(`The walkthrough scene needs UCI products ${missing.join(', ')}, which the extract does not have.`)
  const index = (offset) => days + offset
  const freezeFrom = days - scene.freezeDays
  const bySku = new Map(items.map((item) => [item.sku, item]))
  for (const supplier of suppliers) {
    const named = scene.suppliers[supplier.key]
    if (named) Object.assign(supplier, { code: named.code, name: named.name, email: named.email, contactName: named.contactName, tier: named.tier ?? null, scene: true })
  }
  const ordinal = new Map(reviewIndexes.map((review, position) => [review, position]))
  const { supplierKey, everyNth, daysLate } = scene.lateDeliveries
  const delayOf = (review, key) => (key === supplierKey && review < freezeFrom && ordinal.get(review) % everyNth === 1 ? daysLate : 0)
  // The hero stops its weekly orders three weeks back, or earlier when that
  // still leaves it at or above its safety stock; the trim then brings it
  // toward the scene's closing stock.
  const hero = bySku.get(scene.hero.sku)
  if (hero.supplierKey !== '85') throw new Error(`The scene's hero ${hero.sku} must come from Acme (family 85).`)
  hero.targetClosing = scene.hero.closing
  hero.extraArrivals = scene.hero.orders.filter((order) => order.receivedMinimums > 0).map((order) => ({ day: index(order.promised), quantity: order.receivedMinimums * hero.minimumOrderQuantity }))
  hero.freezeFrom = freezeFrom
  for (let from = freezeFrom; from >= freezeFrom - 42; from -= 1) {
    const closing = simulate([{ ...hero, freezeFrom: from }], delayOf).closing[hero.key]
    if (closing > 0 && closing < hero.safetyStock) {
      hero.freezeFrom = from
      break
    }
  }
  const second = bySku.get(scene.second.sku)
  if (second.supplierKey !== '84') throw new Error(`The scene's second item ${second.sku} must come from Globex (family 84).`)
  second.freezeFrom = freezeFrom
  // The latest freeze that still ends at or above the target; the trim
  // brings it down to the target.
  const reorder = bySku.get(scene.reorder.sku)
  const target = reorder.reorderPoint - scene.reorder.shortfall
  reorder.freezeFrom = freezeFrom
  for (let from = days; from >= freezeFrom - 14; from -= 1) {
    if (simulate([{ ...reorder, freezeFrom: from }], delayOf).closing[reorder.key] >= target) {
      reorder.freezeFrom = from
      break
    }
  }
  reorder.targetClosing = target
  return delayOf
}

// After the simulation: the scene's own purchase orders, then a check that
// the story holds on this data. Returns the scene's facts.
export function finishScene({ items, purchasing, days, scene = UCI_SCENE }) {
  const index = (offset) => days + offset
  const bySku = new Map(items.map((item) => [item.sku, item]))
  const hero = bySku.get(scene.hero.sku)
  const second = bySku.get(scene.second.sku)
  const reorder = bySku.get(scene.reorder.sku)
  const approval = bySku.get(scene.approval.sku)
  const roundUp = (value, step) => Math.ceil(value / step) * step
  // The reorder item's weekly orders not yet received were never placed.
  for (const row of purchasing.orders) if (!row.receipts.length) row.lines = row.lines.filter((line) => line.itemKey !== reorder.key)
  purchasing.orders = purchasing.orders.filter((row) => row.lines.length)
  const order = ({ role, item, created, time, promised, quantity, received = 0, status = 'issued' }) => ({
    review: index(created), created: index(created), createdTime: time, promised: index(promised), arrival: index(promised), supplierKey: item.supplierKey, status, scene: role,
    lines: [{ itemKey: item.key, quantity, raisedBy: 0 }],
    receipts: received ? [{ index: index(promised), lines: [{ itemKey: item.key, quantity: received }] }] : [],
  })
  const heroOrders = scene.hero.orders.map((spec) => order({ role: spec.role, item: hero, created: spec.created, time: spec.time, promised: spec.promised, quantity: spec.minimums * hero.minimumOrderQuantity, received: spec.receivedMinimums * hero.minimumOrderQuantity }))
  const secondClosing = purchasing.closing[second.key]
  const secondQuantity = Math.max(2 * second.minimumOrderQuantity, roundUp(second.reorderPoint - secondClosing + 1, second.minimumOrderQuantity))
  const secondOrder = order({ role: scene.second.order.role, item: second, created: scene.second.order.created, time: scene.second.order.time, promised: scene.second.order.promised, quantity: secondQuantity })
  const approvalOrder = order({ role: scene.approval.role, item: approval, created: scene.approval.created, time: scene.approval.time, promised: scene.approval.created + 14, quantity: approval.minimumOrderQuantity, status: 'pending_approval' })
  purchasing.orders.push(...heroOrders, secondOrder, approvalOrder)
  purchasing.orders.sort((a, b) => a.created - b.created || (a.createdTime || '09:30').localeCompare(b.createdTime || '09:30') || a.supplierKey.localeCompare(b.supplierKey))

  // The story must hold on this data, or the seed stops here.
  const remaining = (row) => row.lines.reduce((total, line) => total + line.quantity, 0) - row.receipts.reduce((total, receipt) => total + receipt.lines.reduce((sum, line) => sum + line.quantity, 0), 0)
  const openFor = (item) => purchasing.orders.filter((row) => row.status === 'issued' && row.lines.some((line) => line.itemKey === item.key) && remaining(row) > 0)
  const heroClosing = purchasing.closing[hero.key]
  const heroIncoming = heroOrders.reduce((total, row) => total + remaining(row), 0)
  const problems = []
  if (!(heroClosing > 0 && heroClosing < hero.safetyStock)) problems.push(`hero ${hero.sku} ends with ${heroClosing}, not between 0 and its safety stock ${hero.safetyStock}`)
  if (openFor(hero).length !== heroOrders.length) problems.push(`hero ${hero.sku} has open orders other than the scene's`)
  if (!(heroClosing + heroIncoming > hero.reorderPoint)) problems.push(`hero ${hero.sku} position ${heroClosing + heroIncoming} does not cover its reorder point ${hero.reorderPoint}`)
  if (openFor(second).length !== 1) problems.push(`${second.sku} should have only the late Globex order open`)
  const reorderClosing = purchasing.closing[reorder.key]
  const shortfall = reorder.reorderPoint - reorderClosing
  if (openFor(reorder).length) problems.push(`${reorder.sku} has an open purchase order`)
  if (!(shortfall > 0 && shortfall < reorder.minimumOrderQuantity)) problems.push(`${reorder.sku} shortfall ${shortfall} is not between 0 and its minimum order ${reorder.minimumOrderQuantity}`)
  if (problems.length) throw new Error(`The walkthrough scene does not hold on this data: ${problems.join('; ')}.`)

  const brief = (item) => ({ sku: item.sku, name: item.name, safetyStock: item.safetyStock, reorderPoint: item.reorderPoint, minimumOrderQuantity: item.minimumOrderQuantity, averageDailyDemand: Math.round(item.meanDaily * 100) / 100, unitPrice: item.price })
  return {
    buyer: scene.buyer,
    hero: { ...brief(hero), onHand: heroClosing, incoming: heroIncoming, position: heroClosing + heroIncoming, orders: heroOrders.map((row) => ({ role: row.scene, ordered: row.lines[0].quantity, received: row.receipts.reduce((total, receipt) => total + receipt.lines[0].quantity, 0), created: row.created - days, promised: row.promised - days })) },
    second: { ...brief(second), onHand: secondClosing, position: secondClosing + secondQuantity, order: { role: secondOrder.scene, ordered: secondQuantity, created: secondOrder.created - days, promised: secondOrder.promised - days } },
    reorder: { ...brief(reorder), onHand: reorderClosing, position: reorderClosing, shortfall, suggested: Math.max(shortfall, reorder.minimumOrderQuantity) },
    approval: { ...brief(approval), ordered: approval.minimumOrderQuantity, created: scene.approval.created },
  }
}
