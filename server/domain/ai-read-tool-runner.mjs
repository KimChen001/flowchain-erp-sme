import { validateAiToolArgs } from './ai-read-tool-contract.mjs'
import { AI_READ_TOOLS } from './ai-read-tools.mjs'
import { AI_ASSISTANT_V2_TOOLS } from './ai-assistant-v2-data-tools.mjs'

// The data tools the assistant offers (docs/ai-assistant-v2-design.md §3.6):
// only those the asking user's facts can serve, described in the provider's
// format, and run through one door that checks the arguments and the user's
// access again. The loop hands every result back to the model and keeps the
// refs for the grounding check and the record links.
//
// `context` is the request's loadAiSkillContext result (the actor, the
// database and the route context). Without it, only the tools over the facts
// are offered; the tools that read services need it.
//
// The read tools (ai-read-tools.mjs) and the assistant's own tools
// (ai-assistant-v2-data-tools.mjs) make one registry. An assistant tool with
// the name of a read tool takes its place wherever the facts serve it
// (list_purchase_requests in every open status); on facts read without the
// open requests the read tool stays, so the assistant is never left without
// one.
const REGISTRY = Object.freeze([...AI_READ_TOOLS, ...AI_ASSISTANT_V2_TOOLS])

function toolsFor(facts, context) {
  if (!facts) return []
  const own = new Set(AI_ASSISTANT_V2_TOOLS.filter((tool) => tool.available(facts, context)).map((tool) => tool.name))
  return REGISTRY.filter((tool) => (tool.assistantV2Only ? own.has(tool.name) : !own.has(tool.name) && tool.available(facts, context)))
}

// The columns of every data tool's result, for the UI tools that render a
// result by reference (show_table, show_records, show_kpis; design §3.6): per
// tool, the path of each list of rows in the result ('' for the result
// itself) and the keys a row holds there ('a.b' for a nested value). A UI tool
// may name only these.
export const AI_READ_TOOL_COLUMNS = Object.freeze({
  workspace_summary: { '': ['purchaseOrders.open', 'purchaseOrders.overdue', 'purchaseOrders.waitingForApproval', 'purchaseRequestsWaitingForApproval', 'inventory.skus', 'inventory.atRisk', 'supplierInvoices.committedCount', 'rfqs.open', 'rfqs.readyToAward', 'receipts.rejected', 'receipts.unposted', 'recordsMissingData'] },
  list_purchase_orders: { rows: ['orderNumber', 'supplier', 'status', 'skus', 'itemNames', 'dueDate', 'overdueDays', 'ordered', 'received', 'remaining', 'unit', 'amount', 'currency', 'open'], bySupplier: ['supplier', 'orders'] },
  get_purchase_order: { openLines: ['sku', 'itemName', 'ordered', 'received', 'remaining', 'unit', 'unitPrice', 'promisedDate', 'originalPromisedDate'], receipts: ['documentNumber', 'arrived', 'postingStatus', 'rejected', 'unit'], invoiceDifferences: ['invoiceNumber', 'matchStatus', 'variance', 'currency'] },
  stock_position: { rows: ['sku', 'itemName', 'unit', 'onHand', 'reserved', 'available', 'openSalesDemand', 'incomingOnPurchaseOrders', 'availableToPromise', 'shortage', 'safetyStock', 'reorderPoint', 'status'] },
  stock_projection: { weeks: ['from', 'to', 'incoming', 'demand', 'endAvailable', 'belowSafetyStock', 'short'], atRecordedRate: ['from', 'to', 'incoming', 'demand', 'endAvailable', 'belowSafetyStock', 'short'] },
  list_sales_orders: { rows: ['orderNumber', 'customer', 'promisedDate'] },
  list_receipts: { rows: ['documentNumber', 'supplier', 'arrived', 'purchaseOrder', 'postingStatus', 'rejected', 'unit'] },
  list_supplier_invoices: { rows: ['invoiceNumber', 'supplier', 'invoiceDate', 'purchaseOrder', 'matchStatus', 'difference', 'currency'] },
  list_purchase_requests: { rows: ['request', 'status', 'priority', 'requiredDate', 'skus', 'lineCount', 'quantity', 'unit'] },
  list_rfqs: { rows: ['rfq', 'title', 'invited', 'quotes', 'due', 'readyToAward'] },
  sales_summary: { rows: ['customer', 'sku', 'itemName', 'month', 'invoices', 'quantity', 'unit', 'amount', 'sharePercent'] },
  list_suppliers: { rows: ['name', 'code', 'tier'] },
  spend_analysis: { suppliers: ['name', 'amount', 'sharePercent', 'rank', 'spendClass'], months: ['month', 'value', 'orders'], items: ['name', 'amount'] },
  supplier_performance: { suppliers: ['name', 'deliveries', 'onTime.percent', 'inFull.percent', 'onTimeInFull.percent', 'rejection.percent', 'averageDelayDays', 'lateDeliveries', 'undeliveredPastOriginalPromiseInPeriod'] },
  late_order_impact: { orders: ['orderNumber', 'overdueDays'], skus: ['sku', 'unit', 'stillToReceive', 'availableToPromise', 'withoutTheseLines', 'additionalShortfall'] },
  calculate: { '': ['result', 'unit'] },
  search_records: { rows: ['type', 'number', 'name', 'status'] },
  reorder_list: { rows: ['sku', 'itemName', 'unit', 'orderByDate', 'orderNow', 'daysUntilOrderBy', 'onHand', 'reserved', 'incoming', 'position', 'reorderPoint', 'shortfall', 'averageDailyDemand', 'supplier', 'leadTimeDays', 'minimumOrderQuantity', 'moqUnit', 'requestQuantity', 'raisedToMinimum', 'suggestedReorderPoint'] },
  list_receivables: { rows: ['obligationNumber', 'customerInvoiceNumber', 'customerName', 'outstandingAmount', 'paidAmount', 'originalAmount', 'currency', 'dueDate', 'status', 'disputeStatus'], aging: ['currency', 'current', '1_30', '31_60', '61_90', '90_plus', 'total', 'count'] },
  list_contracts: { rows: ['number', 'title', 'externalReference', 'type', 'state', 'startDate', 'endDate', 'signedOn', 'noticeDays', 'totalValue', 'currency', 'supplier'] },
  price_history: { earlier: ['unitPrice', 'currency', 'unit', 'orderedQuantity', 'date', 'orderNumber', 'supplierName'], lastOrderBySupplier: ['supplier', 'orderNumber', 'day'] },
  supplier_risks: { rows: ['supplier', 'type', 'record', 'when'], suppliers: ['supplier', 'code', 'issues'] },
  search_documents: { passages: ['document', 'section', 'excerpt'] },
  // A row's details are columns too: the model reads them and names them
  // (2026-11-05: the first table of attention items failed 5 times of 6).
  attention_list: { rows: ['rank', 'type', 'severity', 'label', 'whenKind', 'days', 'date', 'supplier', 'details.sku', 'details.remaining', 'details.unit', 'details.available', 'details.demand', 'details.shortage', 'details.incoming', 'details.safety', 'details.reorder', 'details.pendingRequests', 'details.covered', 'details.variance', 'details.currency', 'details.rejected', 'details.quantity', 'details.priority', 'details.requiredDate', 'details.responses', 'details.title', 'details.count'] },
  records_missing_data: { rows: ['type', 'label', 'source', 'missing'] },
  suggest_purchase_lines: { rows: ['item.sku', 'item.name', 'item.unit', 'onHand', 'safetyStock', 'reorderPoint', 'suggestedQuantity.value', 'suggestedQuantity.source', 'supplier.name', 'needByDate.value', 'estimatedUnitPrice.value', 'estimatedUnitPrice.currency'] },
  setup_status: { steps: ['id', 'done', 'count'] },
  item_suppliers: { suppliers: ['name', 'preferred', 'leadTimeDays', 'minimumOrderQuantity', 'referencePrice', 'currency'] },
  rfq_quotes: { rows: ['rfq', 'supplier', 'sku', 'quantity', 'unitPrice', 'currency', 'deliveryDate', 'validUntil'], rfqs: ['rfq', 'title', 'due', 'quotes'] },
  order_quantity_costs: { options: ['quantity', 'orderValue', 'daysOfDemand', 'ordersPerYear', 'averageCycleStock', 'holdingCostPerYear', 'orderingCostPerYear', 'totalCostPerYear', 'belowSupplierMinimum'], comparisons: ['smaller', 'larger', 'ordersSavedPerYear', 'extraHoldingCostPerYear', 'breakEvenCostPerOrder', 'cheaperAtUserCostPerOrder', 'largerSavesPerYear'] },
  inventory_value: { rows: ['sku', 'itemName', 'onHand', 'unit', 'unitPrice', 'currency', 'value', 'sharePercent', 'cumulativeSharePercent', 'supplier'], totals: ['currency', 'value', 'holdingCostPerYear', 'holdingCostPerMonth', 'holdingCostPerDay'] },
  optimize_order_plan: {
    plans: ['plan', 'lines', 'spend', 'holdingCost', 'shortageCost', 'expectedCost', 'costAboveOptimal', 'withinBudget', 'overBudgetAmount', 'budgetLeft'],
    items: ['sku', 'itemName', 'unit', 'supplier', 'position', 'openRequests', 'cycleDays', 'expectedDemand', 'minimumOrderQuantity', 'minimumOrderValue', 'unitPrice', 'optimalQuantity', 'reorderListQuantity', 'planQuantity', 'chanceShortNoOrderPercent', 'chanceShortWithOptimalPercent', 'chanceShortWithPlanPercent', 'reason'],
    'decision.lines': ['sku', 'itemName', 'quantity', 'unit', 'supplier', 'unitPrice', 'orderValue'],
  },
})

export function aiReadToolsFor(facts, context = null) {
  return toolsFor(facts, context)
}

// The tool definitions for a provider: Anthropic's Messages API
// ({ name, description, input_schema }) or chat completions
// ({ type: 'function', function: { name, description, parameters } }).
export function aiReadToolDefinitions(facts, { format = 'anthropic', context = null } = {}) {
  return aiReadToolsFor(facts, context).map((tool) => (format === 'chat_completions'
    ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }
    : { name: tool.name, description: tool.description, input_schema: tool.schema }))
}

// Runs one tool call as the asking user. Returns { ok: true, result } or
// { ok: false, error, details? }. An error is handed back to the model as the
// tool's result, so it can correct the call or say what it could not read.
export async function runAiReadTool(name, args, { facts, context = null } = {}) {
  const tool = toolsFor(facts, context).find((entry) => entry.name === name)
  if (!tool) return { ok: false, error: REGISTRY.some((entry) => entry.name === name) ? 'not_allowed' : 'unknown_tool' }
  const checked = validateAiToolArgs(tool.schema, args)
  if (!checked.ok) return { ok: false, error: 'invalid_arguments', details: checked.errors }
  try {
    const result = await tool.run(checked.args, { facts, context })
    if (result?.error) {
      const { error, candidates, details, order } = result
      return { ok: false, error, ...(candidates ? { candidates } : {}), ...(details ? { details } : {}), ...(order ? { order } : {}) }
    }
    return { ok: true, result }
  } catch {
    return { ok: false, error: 'tool_failed' }
  }
}

// Every ref ({ type, id, label }) in a tool result, once each, for the record
// links and the grounding check.
export function aiReadToolRefs(result) {
  const refs = []
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (value.ref && typeof value.ref === 'object' && value.ref.type && value.ref.id) refs.push(value.ref)
    for (const [key, entry] of Object.entries(value)) if (key !== 'ref') walk(entry)
  }
  walk(result)
  const seen = new Set()
  return refs.filter((ref) => !seen.has(`${ref.type}:${ref.id}`) && seen.add(`${ref.type}:${ref.id}`))
}
