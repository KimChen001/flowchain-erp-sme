// The assistant v2 evaluation cases on public demand data, with their
// expected answers. Every expected figure is worked out here from the same
// instance the workspace was seeded from (scripts/public-data-instance.mjs),
// with the formulas written out, not taken from the assistant's tools, so a
// tool that computes wrongly fails the case. The optimal orders come from the
// research solver runs (outputs/public-instance-m5.json: the SAA MILP solved
// by HiGHS to a gap of 0), given as `reference`.
import { PUBLIC_DATA_ASSUMPTIONS } from '../../../scripts/public-data-instance.mjs'

const { holdingRatePercent } = PUBLIC_DATA_ASSUMPTIONS
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places

// The textbook figures for one item: yearly demand, holding cost a unit a
// year, orders a year, the break-even cost per order between two quantities
// and the economic order quantity (never below the minimum order).
export function itemEconomics(item) {
  const annual = item.averageDailyDemand * 365
  const holding = (item.price * holdingRatePercent) / 100
  return {
    annual,
    holding,
    ordersPerYear: (quantity) => annual / quantity,
    breakEven: (smaller, larger) => (holding * smaller * larger) / (2 * annual),
    eoq: (costPerOrder) => Math.max(item.minimumOrderQuantity, Math.round(Math.sqrt((2 * annual * costPerOrder) / holding))),
    daysOfStock: item.onHand / item.averageDailyDemand,
  }
}

export function inventoryWorth(items) {
  const value = items.reduce((total, item) => total + item.onHand * item.price, 0)
  return { value: round(value), holdingPerYear: round((value * holdingRatePercent) / 100) }
}

// cases(instances, reference): instances by set name; reference the research
// optimal orders by set ({ budget, q, unbudgeted }), or null to leave those
// cases out.
export function buildCases(instances, reference = null) {
  const main = instances.m5_main
  const intermittent = instances.m5_intermittent
  if (!main || !intermittent) throw new Error('The v2 public evaluation needs the m5_main and m5_intermittent sets.')
  const item = (instance, sku) => instance.items.find((row) => row.sku === sku)
  const all = [...main.items, ...intermittent.items]
  const steady = item(main, 'FOODS_3_090')
  const slow = item(intermittent, 'HOUSEHOLD_1_272')
  const cases = [
    { id: 'avg-demand-en', kind: 'fact', language: 'en-US', turns: ['What is the average daily demand for FOODS_3_090?'],
      expect: { numbers: [{ label: 'average daily demand', value: round(steady.averageDailyDemand), tolerance: 0.6 }] } },
    { id: 'avg-demand-zh', kind: 'fact', language: 'zh-CN', turns: ['HOUSEHOLD_1_272 最近 90 天平均每天卖多少？'],
      expect: { numbers: [{ label: '平均日需求', value: round(slow.averageDailyDemand), tolerance: 0.06 }] } },
    { id: 'shipped-units', kind: 'fact', language: 'en-US', turns: ['How many units of HOUSEHOLD_1_272 did we ship in the last 90 days?'],
      expect: { numbers: [{ label: 'units shipped', value: slow.units, tolerance: 0 }] } },
    { id: 'days-of-stock', kind: 'fact', language: 'en-US', turns: ['How many days will our stock of FOODS_3_501 last at the current pace?'],
      expect: { numbers: [{ label: 'days of stock', value: round(itemEconomics(item(main, 'FOODS_3_501')).daysOfStock, 1), tolerance: 1 }] } },
    { id: 'below-reorder-point', kind: 'fact', language: 'en-US', turns: ['Which items are below their reorder point?'],
      expect: { skus: all.filter((row) => row.onHand < row.reorderPoint).map((row) => row.sku), skuShare: 0.9 } },
  ]
  // Cost reasoning (PR #269's tools): two quantities, the EOQ, what stock is worth.
  const tradeoff = itemEconomics(steady)
  cases.push(
    { id: 'quantity-tradeoff', kind: 'cost', language: 'en-US', turns: ['Is ordering 800 of FOODS_3_090 at a time cheaper overall than 400?'],
      expect: { numbers: [{ label: 'break-even cost per order', value: round(tradeoff.breakEven(400, 800)), tolerance: 0.05 }] } },
    { id: 'eoq', kind: 'cost', language: 'en-US', turns: ['What is the economic order quantity for FOODS_3_120 if placing an order costs us $50?'],
      expect: { numbers: [{ label: 'EOQ', value: itemEconomics(item(main, 'FOODS_3_120')).eoq(50), tolerance: 2 }] } },
  )
  const worth = inventoryWorth(all)
  cases.push(
    { id: 'inventory-worth-en', kind: 'cost', language: 'en-US', turns: ['What is my inventory worth, and what does holding it cost a year?'],
      expect: { numbers: [{ label: 'stock value', value: worth.value, tolerance: 1 }, { label: 'holding cost a year', value: worth.holdingPerYear, tolerance: 1 }] } },
    { id: 'inventory-worth-zh', kind: 'cost', language: 'zh-CN', turns: ['我现在的库存值多少钱？一年的持有成本大概多少？'],
      expect: { numbers: [{ label: '库存价值', value: worth.value, tolerance: 1 }, { label: '每年持有成本', value: worth.holdingPerYear, tolerance: 1 }] } },
  )
  // Decisions: the order the solver finds, against the research optimum.
  if (reference?.m5_main && reference?.m5_intermittent) {
    const quantities = (instance, q) => instance.items.map((row, index) => ({ sku: row.sku, quantity: q[index] }))
    cases.push(
      { id: 'plan-budget-steady', kind: 'decision', language: 'en-US', turns: [`I can spend $${reference.m5_main.budget.toLocaleString('en-US')} on the FOODS_3 items this cycle. What should I order?`],
        expect: { quantities: quantities(main, reference.m5_main.q), spendAtMost: reference.m5_main.budget } },
      { id: 'plan-budget-intermittent', kind: 'decision', language: 'en-US', turns: [`With a $${reference.m5_intermittent.budget} budget, what should I order for the HOUSEHOLD_1 items?`],
        expect: { quantities: quantities(intermittent, reference.m5_intermittent.q), spendAtMost: reference.m5_intermittent.budget } },
      { id: 'plan-unbudgeted-steady', kind: 'decision', language: 'en-US', turns: ['What is the best order for the FOODS_3 items right now, with no budget limit?'],
        expect: { quantities: quantities(main, reference.m5_main.unbudgeted) } },
    )
  }
  // A conversation: the reorder list, then a quantity the user types.
  cases.push(
    { id: 'reorder-then-quantity', kind: 'conversation', language: 'en-US', turns: ['What should I reorder this week?', 'ok, 400 of FOODS_3_090'],
      expect: { form: { sku: 'FOODS_3_090', quantity: 400 } } },
  )
  return cases
}

// The research optimal orders, from outputs/public-instance-m5.json.
export function readReference(json) {
  const instances = json?.instances || {}
  const pick = (row) => (row ? { budget: row.B, q: row.q_star, unbudgeted: row.unbudgeted?.q } : null)
  return { m5_main: pick(instances.m5_main), m5_intermittent: pick(instances.m5_intermittent) }
}
