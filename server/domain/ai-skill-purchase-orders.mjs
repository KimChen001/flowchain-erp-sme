import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

// Purchase orders the question names: one order, the orders of the named
// suppliers, or every overdue order. Figures are the open purchase orders
// report's (facts.purchaseOrders.rows for open orders, .index for any order),
// so "PO-012 has 6,000 to receive" is the report's remaining quantity and a
// supplier's overdue count is the report's count for that supplier.

const array = (value) => Array.isArray(value) ? value : []
const PO_STATUSES = new Set(['draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'fully_received', 'closed', 'cancelled', 'rejected'])
const MAX_EVIDENCE = 8

export function aiSkillPurchaseOrderStatus(status, language) {
  return PO_STATUSES.has(status) ? aiSkillText(`po_status.${status}`, language) : aiSkillText('po_status.other', language, { status })
}

const byLateness = (a, b) => (b.overdueDays || 0) - (a.overdueDays || 0) || String(a.id).localeCompare(String(b.id))

export function runPurchaseOrders(facts, { route = null } = {}) {
  const po = facts?.purchaseOrders
  const mode = route?.mode || 'overdue'
  if (!po) return { skillId: 'purchase_orders', mode, hidden: true }
  const entities = route?.entities || {}
  if (mode === 'single') return { skillId: 'purchase_orders', mode, orders: array(entities.purchaseOrders).slice(0, 5) }
  if (mode === 'supplier') {
    const groups = array(entities.suppliers).map((supplier) => {
      const rows = po.rows.filter((row) => row.supplierId ? row.supplierId === supplier.id : row.supplier === supplier.name)
      return { supplier, open: rows.length, overdue: rows.filter((row) => row.overdueDays > 0).sort(byLateness), rows: [...rows].sort(byLateness) }
    })
    return { skillId: 'purchase_orders', mode, groups, late: Boolean(route?.signals?.late) }
  }
  if (mode === 'not_found') return { skillId: 'purchase_orders', mode, ids: array(entities.unresolved) }
  return { skillId: 'purchase_orders', mode: 'overdue', overdue: po.rows.filter((row) => row.overdueDays > 0).sort(byLateness) }
}

function orderEvidence(row, fmt, language, rank) {
  const status = aiSkillPurchaseOrderStatus(row.status, language)
  const summary = row.overdueDays > 0
    ? aiSkillText('po.evidence_late', language, { status, supplier: row.supplier, days: fmt.number(row.overdueDays) })
    : row.isOpen !== false && row.dueDate
      ? aiSkillText('po.evidence_due', language, { status, supplier: row.supplier, date: fmt.day(row.dueDate) })
      : aiSkillText('po.evidence_plain', language, { status, supplier: row.supplier })
  const open = row.isOpen !== false
  return {
    evidence: aiSkillRecordEvidence({
      evidenceType: 'purchase_order', entityType: 'purchase_order', entityId: row.id, label: row.orderNumber || row.id, status, summary,
      value: open && row.remaining !== null && row.remaining !== undefined ? aiSkillText('po.value_remaining', language, { remaining: fmt.quantity(row.remaining, row.unit) }) : null,
      severity: row.overdueDays > 0 ? 'risk' : open ? 'warning' : 'info', rank,
    }, language),
    impact: aiSkillRecordImpact({
      area: 'purchasing', entityId: row.id, severity: row.overdueDays > 0 ? 'risk' : 'info',
      impact: aiSkillText(row.overdueDays > 0 ? 'po.impact_late' : open ? 'po.impact_open' : 'po.impact_closed', language),
      explanation: aiSkillText(row.overdueDays > 0 ? 'po.impact_late.explanation' : open ? 'po.impact_open.explanation' : 'po.impact_closed.explanation', language),
    }, language),
    navigation: aiSkillNavigation({ label: row.orderNumber || row.id, entityType: 'purchase_order', entityId: row.id }, language),
  }
}

function singleSentences(row, fmt, language, amountsVisible) {
  const sentences = []
  sentences.push(row.ordered !== null && row.received !== null
    ? aiSkillText('po.detail', language, { supplier: row.supplier, ordered: fmt.quantity(row.ordered, row.unit), received: fmt.quantity(row.received, row.unit) })
    : aiSkillText('po.detail_supplier', language, { supplier: row.supplier }))
  if (row.isOpen) {
    if (row.overdueDays > 0) sentences.push(aiSkillCountText('po.due_overdue', row.overdueDays === 1 ? 1 : 2, language, { date: fmt.day(row.dueDate), days: fmt.number(row.overdueDays) }))
    else sentences.push(row.dueDate ? aiSkillText('po.due_on', language, { date: fmt.day(row.dueDate) }) : aiSkillText('po.due_missing', language))
  }
  if (amountsVisible && row.amount !== null && row.amount !== undefined) sentences.push(aiSkillText('po.amount', language, { amount: fmt.money(row.amount, row.currency) }))
  if (row.dataIncomplete) sentences.push(aiSkillText('po.incomplete', language))
  return sentences
}

function singleTitle(row, fmt, language) {
  const po = row.orderNumber || row.id
  if (row.isOpen) return row.remaining === null || row.remaining === undefined ? aiSkillText('po.single_mixed', language, { po }) : aiSkillText('po.single_remaining', language, { po, remaining: fmt.quantity(row.remaining, row.unit) })
  if (row.status === 'fully_received') return aiSkillText('po.single_received', language, { po })
  return aiSkillText('po.single_status', language, { po, status: aiSkillPurchaseOrderStatus(row.status, language) })
}

export function presentPurchaseOrders(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['prepare_action_draft', 'today_priorities'] }
  if (result.hidden) return presentAiSkillAnswer({ ...base, title: aiSkillText('po.title_hidden', language), summary: '', severity: 'info', items: [] })
  const fmt = aiSkillFormatter(facts, language)
  const amountsVisible = Boolean(facts.visibility?.amounts?.purchase_order_amounts)
  const asOf = aiSkillText('po.as_of', language, { date: fmt.day(facts.asOf) })
  const records = (rows) => rows.slice(0, MAX_EVIDENCE).map((row, index) => orderEvidence(row, fmt, language, index + 1))
  const answer = (title, summary, severity, built) => presentAiSkillAnswer({
    ...base, title, summary, severity,
    evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation),
  })

  if (result.mode === 'not_found' || (result.mode === 'single' && !result.orders.length)) {
    return presentAiSkillAnswer({ ...base, title: aiSkillText('po.not_found_title', language, { id: aiSkillList(array(result.ids), language) || query }), summary: aiSkillText('po.not_found_summary', language), severity: 'info', items: [], navigation: [] })
  }
  if (result.mode === 'single') {
    const [row, ...others] = result.orders
    const built = records(result.orders)
    const sentences = singleSentences(row, fmt, language, amountsVisible)
    for (const other of others) sentences.push(`${singleTitle(other, fmt, language)}${language === 'zh-CN' ? '。' : '.'}`)
    return answer(singleTitle(row, fmt, language), aiSkillSentences(sentences, language), row.overdueDays > 0 ? 'risk' : row.isOpen ? 'warning' : 'info', built)
  }
  if (result.mode === 'supplier') {
    const open = result.groups.reduce((sum, group) => sum + group.open, 0)
    const overdue = result.groups.reduce((sum, group) => sum + group.overdue.length, 0)
    const [first] = result.groups
    const title = result.groups.length === 1
      ? aiSkillText(first.open ? 'po.supplier_title' : 'po.supplier_title_none', language, { supplier: first.supplier.name, open: fmt.number(first.open), overdue: fmt.number(first.overdue.length) })
      : aiSkillText('po.supplier_many_title', language, { count: fmt.number(result.groups.length), open: fmt.number(open), overdue: fmt.number(overdue) })
    const sentences = result.groups.length > 1 ? result.groups.map((group) => aiSkillText('po.supplier_sentence', language, { supplier: group.supplier.name, open: fmt.number(group.open), overdue: fmt.number(group.overdue.length) })) : []
    const shown = result.groups.flatMap((group) => result.late ? group.overdue : group.rows).sort(byLateness)
    const lateList = result.groups.flatMap((group) => group.overdue).sort(byLateness).slice(0, 5).map((row) => aiSkillText('po.overdue_item', language, { po: row.orderNumber || row.id, days: fmt.number(row.overdueDays) }))
    if (lateList.length) sentences.push(aiSkillText('po.overdue_summary', language, { list: aiSkillList(lateList, language) }))
    sentences.push(asOf)
    return answer(title, aiSkillSentences(sentences, language), overdue ? 'risk' : 'info', records(shown))
  }
  const count = result.overdue.length
  const list = result.overdue.slice(0, 5).map((row) => aiSkillText('po.overdue_item', language, { po: row.orderNumber || row.id, days: fmt.number(row.overdueDays) }))
  return answer(
    aiSkillCountText('po.overdue_title', count, language, { count: fmt.number(count), date: fmt.day(facts.asOf) }),
    aiSkillSentences([list.length ? aiSkillText('po.overdue_summary', language, { list: aiSkillList(list, language) }) : '', asOf], language),
    count ? 'risk' : 'info',
    records(result.overdue),
  )
}
