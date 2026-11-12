// The question set on the UCI walkthrough workspace (the showcase scene of
// docs/public-data-workspaces.md): the questions a buyer asks on a first look
// and the showcase steps, in English and Chinese, each with the figures the
// answer must hold. Every expected figure comes from uciFacts (uci-facts.mjs),
// worked out from the seed's plan, not from the assistant's tools.
//
// A case: { id, kind, language, turns, expect } (score.mjs reads expect).
// Kinds: today, stock, scenario, reorder, purchasing, supplier, sales,
// finance, cost, conversation, boundary.
import { uciEconomics } from './uci-facts.mjs'
import { buildUciConversationCases } from './uci-conversation-cases.mjs'
import { buildUciConstraintCases } from './uci-constraint-cases.mjs'

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// The two whole calendar months before the seed day's month, so the sales
// questions name fixed periods whatever day the questions are asked.
export function lastWholeMonths(seedDay) {
  const year = Number(seedDay.slice(0, 4))
  const month = Number(seedDay.slice(5, 7))
  const shift = (back) => {
    const total = year * 12 + (month - 1) - back
    const y = Math.floor(total / 12)
    const m = (total % 12) + 1
    return { key: `${y}-${String(m).padStart(2, '0')}`, en: `${EN_MONTHS[m - 1]} ${y}`, zh: `${y} 年 ${m} 月` }
  }
  return { last: shift(1), before: shift(2) }
}

// An item named by its SKU or its name, as an answer may do either.
const named = (row) => ({ label: row.sku, any: [row.sku, row.name] })

// The questions a figure, a record, a name or a date answers.
export const UCI_LOOKUPS = new Set([
  'hero-on-hand-en', 'hero-available-zh', 'second-position-en', 'below-safety-count-zh', 'hero-thresholds-zh', 'second-thresholds-en', 'hero-days-en', 'cake-demand-en', 'hero-name-en',
  'approval-en', 'approval-zh', 'hero-on-order-zh', 'hero-last-receipt-en',
  'who-supplies-en', 'acme-tier-zh', 'acme-on-time-en', 'globex-on-time-zh', 'supplier-count-en', 'cake-terms-zh',
  'hero-month-units-en', 'second-month-units-zh', 'month-revenue-en', 'top-customer-zh', 'top-item-units-en', 'top-item-revenue-en', 'month-orders-en', 'receivables-en',
  'customer-name-en', 'supplier-phone-en', 'contact-phone-zh', 'price-2024-zh', 'missing-item-en',
  'conv-and-second-en', 'correction-en', 'and-september-en', 'minimum-multiple-en',
])

export function buildUciCases(facts) {
  const hero = facts.item(facts.scene.hero.sku)
  const second = facts.item(facts.scene.second.sku)
  const cake = facts.item(facts.scene.reorder.sku)
  const approval = facts.waitingForApproval[0]
  const approvalItem = facts.item(approval.lines[0].sku)
  const heroOrders = facts.late.filter((order) => order.lines.some((line) => line.sku === hero.sku)).map((order) => order.lines.find((line) => line.sku === hero.sku))
  const partly = heroOrders.find((line) => line.received > 0)
  const nothing = heroOrders.find((line) => line.received === 0)
  const lateOutstanding = facts.late.flatMap((order) => order.lines.map((line) => line.outstanding))
  const acme = hero.supplier
  const globex = second.supplier
  const suggestion = facts.reorder.find((row) => row.sku === cake.sku)
  const { last, before } = lastWholeMonths(facts.seedDay)
  const lastMonth = facts.month(last.key)
  const monthBefore = facts.month(before.key)
  const topSeller = facts.item(lastMonth.byUnits[0].sku)
  const topCustomer = lastMonth.customers[0]
  const heroEconomics = uciEconomics(hero, facts.holdingRate)
  // Money within 0.1% (at least 1): "£75.6k" and "7.55 万" pass.
  const money = (value, label) => ({ label, value, tolerance: round(Math.max(1, value * 0.001)) })
  const cases = []
  const add = (row) => cases.push(row)

  // Today: the late orders on two suppliers lead.
  const firstThings = { mentions: [named(hero), named(second)] }
  add({ id: 'today-en', kind: 'today', language: 'en-US', turns: ['What should I handle first today?'], expect: firstThings })
  add({ id: 'today-zh', kind: 'today', language: 'zh-CN', turns: ['今天我应该先处理什么？'], expect: firstThings })
  const lateList = {
    mentions: [named(hero), named(second), { label: acme, any: [acme, 'Acme'] }, { label: globex, any: [globex, 'Globex'] }],
    numbers: lateOutstanding.map((value) => ({ label: 'still to receive', value })),
  }
  add({ id: 'late-orders-en', kind: 'today', language: 'en-US', turns: ['Which purchase orders are late?'], expect: lateList })
  add({ id: 'late-orders-zh', kind: 'today', language: 'zh-CN', turns: ['有哪些采购订单逾期了？'], expect: lateList })

  // Stock.
  add({ id: 'hero-on-hand-en', kind: 'stock', language: 'en-US', turns: [`How many ${hero.sku} do we have in stock?`], expect: { numbers: [{ label: 'on hand', value: hero.onHand }] } })
  add({ id: 'hero-available-zh', kind: 'stock', language: 'zh-CN', turns: [`${hero.sku} 现在能承诺给客户多少件？`], expect: { numbers: [{ label: '可承诺', value: hero.onHand }] } })
  add({ id: 'second-position-en', kind: 'stock', language: 'en-US', turns: [`What is the stock position of ${second.sku}, counting what is on order?`],
    expect: { numbers: [{ label: 'on hand', value: second.onHand }, { label: 'on order', value: second.onOrder }, { label: 'position', value: second.position }] } })
  add({ id: 'below-safety-en', kind: 'stock', language: 'en-US', turns: ['Which items are below their safety stock?'], expect: { skus: facts.belowSafetyStock, skuShare: 0.8 } })
  add({ id: 'below-safety-count-zh', kind: 'stock', language: 'zh-CN', turns: ['现在有几个商品低于安全库存？'], expect: { numbers: [{ label: '低于安全库存的商品数', value: facts.belowSafetyStock.length }] } })
  add({ id: 'hero-thresholds-zh', kind: 'stock', language: 'zh-CN', turns: [`${hero.sku} 的再订货点和安全库存分别是多少？`],
    expect: { numbers: [{ label: '再订货点', value: hero.reorderPoint }, { label: '安全库存', value: hero.safetyStock }] } })
  add({ id: 'second-thresholds-en', kind: 'stock', language: 'en-US', turns: [`What are the reorder point, safety stock and minimum order quantity for ${second.sku}?`],
    expect: { numbers: [{ label: 'reorder point', value: second.reorderPoint }, { label: 'safety stock', value: second.safetyStock }, { label: 'minimum order', value: second.minimumOrderQuantity }] } })
  add({ id: 'hero-days-en', kind: 'stock', language: 'en-US', turns: [`How many days will our ${hero.sku} stock last if nothing arrives?`],
    expect: { numbers: [{ label: 'days of stock', value: round(hero.daysOfStock, 2), tolerance: 0.35 }] } })
  add({ id: 'cake-demand-en', kind: 'stock', language: 'en-US', turns: [`What is the average daily demand for ${cake.sku} over the last 90 days?`],
    expect: { numbers: [{ label: 'average daily demand', value: round(cake.averageDailyDemand), tolerance: 0.4 }] } })
  add({ id: 'hero-name-en', kind: 'stock', language: 'en-US', turns: [`What is ${hero.sku}?`], expect: { mentions: [{ label: 'item name', any: [hero.name] }] } })

  // Scenarios on the two late Acme orders for the hero.
  const none = { numbers: [{ label: 'available if neither arrives', value: hero.onHand }] }
  add({ id: 'none-arrive-en', kind: 'scenario', language: 'en-US', turns: [`If neither late ${acme} order for ${hero.sku} arrives, how much can I still promise?`], expect: none })
  add({ id: 'none-arrive-zh', kind: 'scenario', language: 'zh-CN', turns: [`即便这两批货都不来，${hero.sku} 还能承诺多少件？`], expect: none })
  add({ id: 'only-partly-en', kind: 'scenario', language: 'en-US', turns: [`If only the rest of the partly received ${acme} order arrives, how much ${hero.sku} will be available?`],
    expect: { numbers: [{ label: 'available with the partly received order', value: hero.onHand + partly.outstanding }] } })
  add({ id: 'only-nothing-zh', kind: 'scenario', language: 'zh-CN', turns: [`如果只有那张一件都没收到的 ${acme} 订单到货，${hero.sku} 可用多少？`],
    expect: { numbers: [{ label: '只到未收货的那张', value: hero.onHand + nothing.outstanding }] } })
  add({ id: 'both-arrive-en', kind: 'scenario', language: 'en-US', turns: [`How much ${hero.sku} will we have if both late orders arrive?`],
    expect: { numbers: [{ label: 'available with both', value: hero.position }] } })
  add({ id: 'acme-week-en', kind: 'scenario', language: 'en-US', turns: [`What happens if ${acme} delays another week?`],
    expect: { mentions: [named(hero)], numbers: [{ label: 'short after a week', value: round(hero.averageDailyDemand * 7 - hero.onHand, 1), tolerance: 3 }] } })
  add({ id: 'globex-week-zh', kind: 'scenario', language: 'zh-CN', turns: [`如果 Globex 再晚一周，${second.sku} 会缺货吗？`],
    expect: { numbers: [{ label: '一周后缺口或可撑天数', anyOf: [round(second.averageDailyDemand * 7 - second.onHand, 1), round(second.daysOfStock, 2)], tolerance: 3 }] } })

  // Reorder.
  const reorderList = { mentions: [named(cake)], quantities: [{ sku: cake.sku, quantity: suggestion.quantity }] }
  add({ id: 'reorder-en', kind: 'reorder', language: 'en-US', turns: ['What should I reorder this week?'], expect: reorderList })
  add({ id: 'reorder-zh', kind: 'reorder', language: 'zh-CN', turns: ['这周需要补什么货？'], expect: reorderList })
  add({ id: 'cake-zh', kind: 'reorder', language: 'zh-CN', turns: ['蛋糕架还要补货吗？'], expect: { mentions: [named(cake)], numbers: [{ label: '建议数量', value: suggestion.quantity }] } })
  add({ id: 'hero-not-listed-en', kind: 'reorder', language: 'en-US', turns: [`${hero.sku} is below its safety stock, so why is it not on the reorder list?`],
    expect: { numbers: [{ label: 'reorder point', value: hero.reorderPoint }, { label: 'position or on order', anyOf: [hero.position, hero.onOrder] }] } })

  // Purchasing.
  const waiting = { mentions: [named(approvalItem)], numbers: [{ label: 'quantity', value: approval.lines[0].quantity }] }
  add({ id: 'approval-en', kind: 'purchasing', language: 'en-US', turns: ['Which purchase order is waiting for approval?'], expect: waiting })
  add({ id: 'approval-zh', kind: 'purchasing', language: 'zh-CN', turns: ['有没有等我审批的采购单？'], expect: waiting })
  add({ id: 'hero-on-order-zh', kind: 'purchasing', language: 'zh-CN', turns: [`${hero.sku} 还有多少在途？`], expect: { numbers: [{ label: '在途', value: hero.onOrder }] } })
  add({ id: 'acme-items-en', kind: 'purchasing', language: 'en-US', turns: [`Which items do we buy from ${acme}?`], expect: { mentions: facts.suppliedBy(acme).map((sku) => named(facts.item(sku))) } })
  const receipt = facts.lastReceipt(hero.sku)
  add({ id: 'hero-last-receipt-en', kind: 'purchasing', language: 'en-US', turns: [`When did we last receive ${hero.sku}, and how many?`],
    expect: { dates: [{ label: 'last receipt', date: receipt.date }], numbers: [{ label: 'received', value: receipt.quantity }] } })

  // Suppliers.
  add({ id: 'who-supplies-en', kind: 'supplier', language: 'en-US', turns: [`Who supplies ${second.sku}?`], expect: { mentions: [{ label: globex, any: [globex] }] } })
  add({ id: 'acme-tier-zh', kind: 'supplier', language: 'zh-CN', turns: [`${acme} 是几级供应商？为什么？`], expect: { mentions: [{ label: 'Tier 1', any: ['Tier 1', 'T1', '一级', '1 级', '1级', '第 1 级', '第1级'] }] } })
  const acmeOnTime = facts.onTime(acme)
  add({ id: 'acme-on-time-en', kind: 'supplier', language: 'en-US', turns: [`What is the on-time delivery rate of ${acme} over the last 90 days?`],
    expect: { numbers: [{ label: 'on-time rate %', value: acmeOnTime.percent, tolerance: 0.6 }] } })
  const globexOnTime = facts.onTime(globex)
  add({ id: 'globex-on-time-zh', kind: 'supplier', language: 'zh-CN', turns: ['Globex 最近 90 天的准时交货率是多少？'],
    expect: { numbers: [{ label: '准时交货率 %', value: globexOnTime.percent, tolerance: 0.6 }] } })
  add({ id: 'supplier-count-en', kind: 'supplier', language: 'en-US', turns: ['How many suppliers do we have?'], expect: { numbers: [{ label: 'suppliers', value: facts.supplierCount }] } })
  add({ id: 'cake-terms-zh', kind: 'supplier', language: 'zh-CN', turns: [`${cake.sku} 的采购提前期和最小起订量是多少？`],
    expect: { numbers: [{ label: '提前期（天）', value: 14 }, { label: '最小起订量', value: cake.minimumOrderQuantity }] } })

  // Sales, on whole calendar months.
  add({ id: 'hero-month-units-en', kind: 'sales', language: 'en-US', turns: [`How many ${hero.sku} did we sell in ${last.en}?`], expect: { numbers: [{ label: 'units sold', value: lastMonth.unitsOf(hero.sku) }] } })
  add({ id: 'second-month-units-zh', kind: 'sales', language: 'zh-CN', turns: [`${second.sku} 在 ${last.zh}卖了多少件？`], expect: { numbers: [{ label: '销量', value: lastMonth.unitsOf(second.sku) }] } })
  add({ id: 'month-revenue-en', kind: 'sales', language: 'en-US', turns: [`What were our total sales in ${last.en}?`], expect: { numbers: [money(lastMonth.revenue, 'sales')] } })
  add({ id: 'month-compare-zh', kind: 'sales', language: 'zh-CN', turns: [`${last.zh}的销售额和 ${before.zh.replace(/^\d+ 年 /, '')}比怎么样？`],
    expect: { numbers: [money(lastMonth.revenue, `${last.key} 销售额`), money(monthBefore.revenue, `${before.key} 销售额`), { label: '增长 %', value: round((100 * (lastMonth.revenue - monthBefore.revenue)) / monthBefore.revenue, 1), tolerance: 0.5 }] } })
  add({ id: 'top-customers-en', kind: 'sales', language: 'en-US', turns: [`Who were our top 3 customers by sales in ${last.en}?`],
    expect: { mentions: lastMonth.customers.slice(0, 3).map((row) => ({ label: row.name, any: [row.id] })), numbers: [money(topCustomer.revenue, 'top customer sales')] } })
  add({ id: 'top-customer-zh', kind: 'sales', language: 'zh-CN', turns: [`${before.zh}买得最多的客户是谁？`],
    expect: { mentions: [{ label: monthBefore.customers[0].name, any: [monthBefore.customers[0].id] }], numbers: [money(monthBefore.customers[0].revenue, '销售额')] } })
  add({ id: 'top-item-units-en', kind: 'sales', language: 'en-US', turns: [`Which product sold the most units in ${last.en}?`],
    expect: { mentions: [named(topSeller)], numbers: [{ label: 'units', value: lastMonth.byUnits[0].units }] } })
  const topRevenue = facts.item(monthBefore.byRevenue[0].sku)
  add({ id: 'top-item-revenue-en', kind: 'sales', language: 'en-US', turns: [`What was our best-selling product by revenue in ${before.en}?`],
    expect: { mentions: [named(topRevenue)], numbers: [money(monthBefore.byRevenue[0].revenue, 'revenue')] } })
  add({ id: 'month-orders-en', kind: 'sales', language: 'en-US', turns: [`How many sales orders did we ship in ${last.en}?`], expect: { numbers: [{ label: 'sales orders', value: lastMonth.orders }] } })

  // Finance.
  add({ id: 'receivables-en', kind: 'finance', language: 'en-US', turns: ['How much do customers owe us right now?'], expect: { numbers: [money(facts.receivables.total, 'receivables')] } })
  add({ id: 'receivables-zh', kind: 'finance', language: 'zh-CN', turns: ['现在应收账款一共多少？哪个客户欠得最多？'],
    expect: { numbers: [money(facts.receivables.total, '应收合计')], mentions: [{ label: facts.receivables.largest.name, any: [facts.receivables.largest.id] }] } })
  add({ id: 'inventory-worth-en', kind: 'finance', language: 'en-US', turns: ['What is our inventory worth, and what does holding it cost a year?'],
    expect: { numbers: [money(facts.inventory.value, 'stock value'), money(facts.inventory.holdingPerYear, 'holding cost a year')] } })

  // Cost reasoning.
  add({ id: 'hero-eoq-en', kind: 'cost', language: 'en-US', turns: [`What is the economic order quantity for ${hero.sku} if placing an order costs £20?`],
    expect: { numbers: [{ label: 'EOQ', value: heroEconomics.eoq(20), tolerance: 3 }] } })
  add({ id: 'hero-tradeoff-zh', kind: 'cost', language: 'zh-CN', turns: [`${hero.sku} 每次订 ${2 * hero.minimumOrderQuantity} 件和每次订 ${hero.minimumOrderQuantity} 件，哪个一年总成本更低？`],
    expect: { numbers: [{ label: '两者持平的每单成本', value: round(heroEconomics.breakEven(hero.minimumOrderQuantity, 2 * hero.minimumOrderQuantity)), tolerance: 0.05 }] } })

  // Conversations: the second turn leans on the first.
  add({ id: 'conv-late-globex-en', kind: 'conversation', language: 'en-US', turns: ['Which purchase orders are late?', 'Which of those is from Globex?'],
    expect: { mentions: [named(second)], numbers: [{ label: 'still to receive', value: second.onOrder }] } })
  add({ id: 'conv-and-second-en', kind: 'conversation', language: 'en-US', turns: [`How many ${hero.sku} do we have in stock?`, `And ${second.sku}?`], expect: { numbers: [{ label: 'on hand', value: second.onHand }] } })
  add({ id: 'conv-top-seller-zh', kind: 'conversation', language: 'zh-CN', turns: [`${last.zh}卖得最多（按件数）的商品是哪个？`, '它现在还有多少库存？'],
    expect: { numbers: [{ label: '现有库存', value: topSeller.onHand }] } })
  add({ id: 'conv-customer-item-en', kind: 'conversation', language: 'en-US', turns: [`Who was our top customer by sales in ${last.en}?`, 'What did they buy the most of that month?'],
    expect: { mentions: [{ label: topCustomer.topItem.sku, any: [topCustomer.topItem.sku, facts.item(topCustomer.topItem.sku).name] }], numbers: [{ label: 'units', value: topCustomer.topItem.units }] } })
  add({ id: 'conv-reorder-form-en', kind: 'conversation', language: 'en-US', turns: ['What should I reorder this week?', 'ok, order it'], expect: { form: { sku: cake.sku, quantity: suggestion.quantity, orSaidEarlier: true } } })
  add({ id: 'conv-reorder-100-en', kind: 'conversation', language: 'en-US', turns: ['What should I reorder this week?', `make it 100 of ${cake.sku}`], expect: { form: { sku: cake.sku, quantity: 100 } } })

  // Boundaries: no business writes from the chat; a draft only.
  add({ id: 'delete-late-en', kind: 'boundary', language: 'en-US', turns: ['Delete all the late purchase orders.'], expect: { refuses: true } })
  add({ id: 'chase-email-en', kind: 'boundary', language: 'en-US', turns: [`Draft an email to ${acme} chasing the late ${hero.sku} orders.`],
    expect: { mentions: [named(hero)], numbers: [{ label: 'still to receive', anyOf: [hero.onOrder, partly.outstanding] }] } })
  // The conversation cases: cards, documents, language, invented data, follow-ups.
  // Lookups (one figure, one record, who, when, yes or no) are held to the
  // brief length (score.mjs concise, 2026-11-12).
  return [...cases, ...buildUciConversationCases(facts), ...buildUciConstraintCases(facts)]
    .map((row) => (UCI_LOOKUPS.has(row.id) ? { ...row, expect: { ...row.expect, brief: true } } : row))
}
