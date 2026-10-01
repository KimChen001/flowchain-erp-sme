import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

// Purchase orders the question names: one order, the orders of the named
// suppliers or of a SKU, or every overdue order. Figures are the open purchase
// orders report's (facts.purchaseOrders.rows for open orders, .index for any
// order), so "PO-012 has 6,000 to receive" is the report's remaining quantity
// and a supplier's overdue count is the report's count for that supplier.
// An order number the role may not look up, or that matches several orders,
// gets an answer that says so (ai-skill-entities.mjs).

const array = (value) => Array.isArray(value) ? value : []
const PO_STATUSES = new Set(['draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'fully_received', 'closed', 'cancelled', 'rejected'])
const MAX_EVIDENCE = 8
const byLateness = (a, b) => (b.overdueDays || 0) - (a.overdueDays || 0) || String(a.id).localeCompare(String(b.id))
const figure = (code, entityId, value, extra = {}) => ({ key: entityId ? `${code}:${entityId}` : code, code, entityId: entityId || null, value, ...extra })

export function aiSkillPurchaseOrderStatus(status, language) {
  return PO_STATUSES.has(status) ? aiSkillText(`po_status.${status}`, language) : aiSkillText('po_status.other', language, { status })
}

export function runPurchaseOrders(facts, { route = null } = {}) {
  const mode = route?.mode || 'overdue'
  const entities = route?.entities || {}
  const base = { skillId: 'purchase_orders', mode, late: Boolean(route?.signals?.late) }
  const ids = (list) => array(list).map((entry) => entry.id)
  if (mode === 'hidden') return { ...base, ids: ids(entities.hidden) }
  const po = facts?.purchaseOrders
  if (!po) return { ...base, mode: 'hidden', ids: [] }
  if (mode === 'single') return { ...base, orders: array(entities.purchaseOrders).slice(0, 5) }
  if (mode === 'ambiguous') return { ...base, ambiguous: array(entities.ambiguous) }
  if (mode === 'not_found') {
    // A number that is not there says so; only when every named number is
    // missing from a source read up to its limit is it "not among the
    // records read", with that source's limit.
    const absent = ids(entities.absent)
    const truncated = array(entities.truncated)
    const source = truncated[0]?.source || null
    const limit = array(facts.limitations).find((row) => row.code === 'truncated' && row.source === source)?.limit ?? null
    return absent.length ? { ...base, ids: absent, truncated: false } : { ...base, ids: ids(truncated), truncated: true, source, limit }
  }
  if (mode === 'supplier') {
    const groups = array(entities.suppliers).map((supplier) => {
      const rows = po.rows.filter((row) => row.supplierId ? row.supplierId === supplier.id : row.supplier === supplier.name)
      return { supplier, open: rows.length, overdue: rows.filter((row) => row.overdueDays > 0).sort(byLateness), rows: [...rows].sort(byLateness) }
    })
    return { ...base, groups }
  }
  if (mode === 'sku') {
    const groups = array(entities.skus).map((sku) => {
      const rows = po.rows.filter((row) => array(row.skus).includes(sku.sku) || row.sku === sku.sku)
      return { sku, open: rows.length, overdue: rows.filter((row) => row.overdueDays > 0).sort(byLateness), rows: [...rows].sort(byLateness) }
    })
    return { ...base, groups }
  }
  return { ...base, mode: 'overdue', overdue: po.rows.filter((row) => row.overdueDays > 0).sort(byLateness) }
}

function orderEvidence(row, fmt, language, rank) {
  const status = aiSkillPurchaseOrderStatus(row.status, language)
  const open = row.isOpen !== false
  const summary = row.overdueDays > 0
    ? aiSkillText('po.evidence_late', language, { status, supplier: row.supplier, days: fmt.number(row.overdueDays) })
    : open && row.dueDate
      ? aiSkillText('po.evidence_due', language, { status, supplier: row.supplier, date: fmt.day(row.dueDate) })
      : aiSkillText('po.evidence_plain', language, { status, supplier: row.supplier })
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

// The headline for one order. "Still to receive" only while the order is
// open; a finished, cancelled or not yet committed order says what it is.
function singleTitle(row, fmt, language) {
  const po = row.orderNumber || row.id
  const status = aiSkillPurchaseOrderStatus(row.status, language)
  if (row.isOpen) return row.remaining === null || row.remaining === undefined ? aiSkillText('po.single_mixed', language, { po }) : aiSkillText('po.single_remaining', language, { po, remaining: fmt.quantity(row.remaining, row.unit) })
  if (row.status === 'fully_received') return aiSkillText('po.single_received', language, { po })
  if (['cancelled', 'rejected'].includes(row.status)) return aiSkillText('po.single_closed', language, { po, status })
  if (['draft', 'pending_approval'].includes(row.status)) return aiSkillText('po.single_not_committed', language, { po, status, ordered: fmt.quantity(row.ordered, row.unit) })
  return aiSkillText('po.single_status', language, { po, status })
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

export function presentPurchaseOrders(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['prepare_action_draft', 'today_priorities'] }
  const idList = (ids) => aiSkillList(array(ids), language)
  if (result.mode === 'hidden') {
    return presentAiSkillAnswer({ ...base, title: result.ids?.length ? aiSkillText('po.hidden_lookup', language, { id: idList(result.ids) }) : aiSkillText('po.title_hidden', language), summary: aiSkillText('access.ask_admin', language), severity: 'info', items: [], navigation: [] })
  }
  const fmt = aiSkillFormatter(facts, language)
  const amountsVisible = Boolean(facts.visibility?.amounts?.purchase_order_amounts)
  const asOf = aiSkillText('po.as_of', language, { date: fmt.day(facts.asOf) })
  const records = (rows) => rows.slice(0, MAX_EVIDENCE).map((row, index) => orderEvidence(row, fmt, language, index + 1))
  const answer = (title, summary, severity, built, figures = []) => presentAiSkillAnswer({
    ...base, title, summary, severity, figures,
    evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation),
  })
  const empty = (title, summary) => presentAiSkillAnswer({ ...base, title, summary, severity: 'info', items: [], navigation: [] })

  if (result.mode === 'ambiguous') {
    const [first] = result.ambiguous
    return empty(aiSkillText('po.ambiguous_title', language, { id: first?.id || '' }), aiSkillText('po.ambiguous_summary', language, { list: aiSkillList(array(first?.candidates), language, { or: true }) }))
  }
  if (result.mode === 'not_found' || (result.mode === 'single' && !result.orders.length)) {
    const id = idList(result.ids) || query
    if (result.truncated) {
      const prefix = result.source === 'inventory' ? 'stock' : 'po'
      const summary = result.limit === null || result.limit === undefined ? aiSkillText(`${prefix}.not_read_summary_unknown`, language) : aiSkillText(`${prefix}.not_read_summary`, language, { limit: fmt.number(result.limit) })
      return empty(aiSkillText(`${prefix}.not_read_title`, language, { id }), summary)
    }
    return empty(aiSkillText('lookup.not_found_title', language, { id }), aiSkillText(result.ids.every((value) => /(^|-)P\.?O-\d+$/i.test(value)) ? 'po.not_found_summary' : 'lookup.not_found_summary', language))
  }
  if (result.mode === 'single') {
    const [row, ...others] = result.orders
    const sentences = singleSentences(row, fmt, language, amountsVisible)
    for (const other of others) sentences.push(`${singleTitle(other, fmt, language)}${language === 'zh-CN' ? '。' : '.'}`)
    const figures = result.orders.filter((entry) => entry.isOpen && entry.remaining !== null && entry.remaining !== undefined).map((entry) => figure('po_remaining', entry.id, entry.remaining, { unit: entry.unit || null }))
    return answer(singleTitle(row, fmt, language), aiSkillSentences(sentences, language), row.overdueDays > 0 ? 'risk' : row.isOpen ? 'warning' : 'info', records(result.orders), figures)
  }
  if (result.mode === 'supplier' || result.mode === 'sku') {
    const bySupplier = result.mode === 'supplier'
    const name = (group) => bySupplier ? group.supplier.name : group.sku.sku
    const open = result.groups.reduce((sum, group) => sum + group.open, 0)
    const overdue = result.groups.reduce((sum, group) => sum + group.overdue.length, 0)
    const [first] = result.groups
    const key = bySupplier ? 'po.supplier' : 'po.sku'
    const title = result.groups.length === 1
      ? aiSkillText(!first.open ? `${key}_title_none` : first.open === 1 ? `${key}_title_one` : `${key}_title`, language, { name: name(first), open: fmt.number(first.open), overdue: fmt.number(first.overdue.length) })
      : aiSkillText('po.many_title', language, { count: fmt.number(result.groups.length), open: fmt.number(open), overdue: fmt.number(overdue) })
    const sentences = result.groups.length > 1 ? result.groups.map((group) => aiSkillText('po.group_sentence', language, { name: name(group), open: fmt.number(group.open), overdue: fmt.number(group.overdue.length) })) : []
    const lateList = result.groups.flatMap((group) => group.overdue).sort(byLateness).slice(0, 5).map((row) => aiSkillText('po.overdue_item', language, { po: row.orderNumber || row.id, days: fmt.number(row.overdueDays) }))
    if (lateList.length) sentences.push(aiSkillText('po.overdue_summary', language, { list: aiSkillList(lateList, language) }))
    sentences.push(asOf)
    const shown = result.groups.flatMap((group) => result.late ? group.overdue : group.rows).sort(byLateness)
    const figures = result.groups.flatMap((group) => bySupplier
      ? [figure('supplier_open_po', group.supplier.id, group.open), figure('supplier_overdue_po', group.supplier.id, group.overdue.length)]
      : [figure('sku_open_po', group.sku.sku, group.open), figure('sku_overdue_po', group.sku.sku, group.overdue.length)])
    return answer(title, aiSkillSentences(sentences, language), overdue ? 'risk' : 'info', records(shown), figures)
  }
  const count = result.overdue.length
  const list = result.overdue.slice(0, 5).map((row) => aiSkillText('po.overdue_item', language, { po: row.orderNumber || row.id, days: fmt.number(row.overdueDays) }))
  return answer(
    aiSkillCountText('po.overdue_title', count, language, { count: fmt.number(count), date: fmt.day(facts.asOf) }),
    aiSkillSentences([list.length ? aiSkillText('po.overdue_summary', language, { list: aiSkillList(list, language) }) : '', asOf], language),
    count ? 'risk' : 'info',
    records(result.overdue),
    [figure('overdue_po_count', null, count), figure('open_po_count', null, facts.purchaseOrders.open)],
  )
}
