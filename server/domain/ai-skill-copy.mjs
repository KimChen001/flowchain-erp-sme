// The bilingual copy catalog for the workspace skills behind
// /api/ai-runtime/respond. Every visible sentence a skill answer carries comes
// from here, keyed by a stable code, in English (the default) and Chinese.
// Values in {braces} are filled by the presenter with ids, names and numbers
// that are already formatted for the tenant's locale; the language never
// changes a business value, a currency or a number format.

export const AI_SKILL_LANGUAGES = Object.freeze(['en-US', 'zh-CN'])

export function aiSkillLanguage(value) {
  return String(value || '').trim() === 'zh-CN' ? 'zh-CN' : 'en-US'
}

const entries = {
  // Answer frame
  'scope.label': ['Your workspace data', '当前工作区数据'],
  'answer.source': ['Answered from your workspace data', '基于当前工作区数据回答'],
  'answer.checked': ['Checked: {sources}', '已检查：{sources}'],
  'answer.review_boundary': ['This answer does not send, approve or change anything.', '本回答不会发送、批准或修改任何内容。'],

  // Skill titles and descriptions
  'skill.today_priorities.title': ["Today's priorities", '今日优先事项'],
  'skill.today_priorities.description': ['Ranks what needs attention today across purchasing, inventory, invoices and receiving.', '按采购、库存、发票和收货汇总今天需要优先处理的事项。'],
  'skill.highest_risk_items.title': ['Highest-risk items', '风险最高的事项'],
  'skill.highest_risk_items.description': ['Lists the items with the largest risk exposure, ordered by severity.', '按严重程度列出风险敞口最大的事项。'],
  'skill.records_needing_data.title': ['Records needing data', '需要补齐的数据'],
  'skill.records_needing_data.description': ['Finds records that are missing fields the reports need.', '找出缺少报表所需字段的记录。'],
  'skill.prepare_action_draft.title': ['Prepare an action draft', '准备处理草稿'],
  'skill.prepare_action_draft.description': ['Prepares follow-up drafts for your review. It never sends or approves anything.', '准备跟进草稿供你复核，不会发送或批准任何内容。'],
  'skill.workspace_metrics.title': ['Open purchase orders and spend', '未结采购订单与金额'],
  'skill.workspace_metrics.description': ['Reports open and overdue purchase orders, committed spend and short SKUs, as the reports count them.', '按报表口径汇总未结和逾期采购订单、已承诺金额和缺货 SKU。'],
  'skill.capability_overview.title': ['What I can help with', '我可以帮你做什么'],
  'skill.capability_overview.description': ['Explains what the assistant can answer from workspace data.', '说明助手能基于工作区数据回答哪些问题。'],

  // Capability and refusal
  'capability.title': ['Here is what I can help with', '我可以帮你做这些'],
  'capability.summary': ["I can help with today's priorities, the highest-risk items, records that need more data, open purchase orders and spend, and preparing an action draft for your review.", '我可以帮你查看今日优先事项、风险最高的事项、需要补齐的数据、未结采购订单与金额，并准备处理草稿供你复核。'],
  'capability.refusal.title': ["I can't do that, but I can prepare a draft", '我不能执行这个操作，但可以准备草稿'],
  'capability.refusal.summary': ["I can't approve, pay, send, issue, cancel or delete anything. I can prepare a draft for you to review.", '我不能批准、付款、发送、下达、取消或删除任何内容。我可以准备一份草稿供你复核。'],

  // Report figures, shared by several skills
  'metrics.open_pos': ['{open} open purchase orders, {overdue} overdue.', '未结采购订单 {open} 张，其中逾期 {overdue} 张。'],
  'metrics.no_overdue': ['{open} open purchase orders; none are overdue.', '未结采购订单 {open} 张，没有逾期。'],
  'metrics.committed_spend': ['Committed PO spend: {amounts}.', '已承诺采购金额：{amounts}。'],
  'metrics.committed_invoices': ['Committed supplier invoices: {amounts}.', '已提交供应商发票金额：{amounts}。'],
  'metrics.at_risk': ['{count} SKUs are short against open sales orders: {skus}.', '{count} 个 SKU 无法满足未结销售订单：{skus}。'],
  'metrics.at_risk_one': ['1 SKU is short against open sales orders: {skus}.', '1 个 SKU 无法满足未结销售订单：{skus}。'],
  'metrics.at_risk_none': ['No SKU is short against open sales orders.', '没有 SKU 无法满足未结销售订单。'],
  'metrics.amounts_hidden': ['Amounts are hidden for your role.', '你的角色无法查看金额。'],
  'metrics.title': ['{open} open purchase orders, {overdue} overdue (as of {date})', '未结采购订单 {open} 张，逾期 {overdue} 张（截至 {date}）'],

  // today_priorities
  'today.title': ['{count} items need attention today (as of {date})', '今天需要关注 {count} 项（截至 {date}）'],
  'today.title_one': ['1 item needs attention today (as of {date})', '今天需要关注 1 项（截至 {date}）'],
  'today.title_none': ['Nothing needs attention today (as of {date})', '今天没有需要优先处理的事项（截至 {date}）'],
  'today.focus_title': ['Why {id} needs attention', '{id} 需要关注的原因'],
  'today.focus_none': ['{id} has no open issue in the workspace data', '工作区数据中 {id} 没有待处理问题'],

  // highest_risk_items
  'risk.title': ['Highest risk: {first}', '风险最高：{first}'],
  'risk.first': ['{label} ({status})', '{label}（{status}）'],
  'risk.title_none': ['No high-risk items found (as of {date})', '未发现高风险事项（截至 {date}）'],
  'risk.summary': ['{count} items carry risk exposure, ordered by severity and amount.', '共 {count} 项存在风险敞口，按严重程度和金额排序。'],

  // records_needing_data
  'records.title': ['{count} records need more data', '{count} 条记录需要补齐'],
  'records.title_one': ['1 record needs more data', '1 条记录需要补齐'],
  'records.title_none': ['No records are missing required fields', '未发现缺失必填字段的记录'],
  'records.summary': ['Checked {checked} records across {sources} sources.', '已检查 {sources} 类来源共 {checked} 条记录。'],
  'records.missing': ['Missing {fields}.', '缺少{fields}。'],
  'records.status': ['Needs data', '需要补齐'],

  // prepare_action_draft
  'draft.title': ['{count} drafts ready for your review', '已准备 {count} 份草稿，等待你复核'],
  'draft.title_one': ['1 draft ready for your review', '已准备 1 份草稿，等待你复核'],
  'draft.title_blocked': ['Drafts need purchasing edit access', '准备草稿需要采购编辑权限'],
  'draft.title_none': ['No draft is needed right now', '当前不需要准备草稿'],
  'draft.summary': ['Review each draft before you send it. This answer does not send or change anything.', '发送前请逐一复核。本回答不会发送或修改任何内容。'],
  'draft.none_summary': ['No open issue calls for a follow-up draft. Open the records below to review them.', '当前没有需要跟进草稿的问题。可打开下面的记录查看。'],
  'draft.no_permission': ['Your role cannot prepare procurement drafts, so only links are shown.', '你的角色无法准备采购草稿，因此只显示链接。'],
  'draft.po_followup.title': ['Follow up with {supplier} on {po}', '就 {po} 跟进 {supplier}'],
  'draft.po_followup.message': ['Please confirm a delivery date for the remaining {remaining} {unit} of {sku} on {po}.', '请确认 {po} 上 {sku} 剩余 {remaining} {unit} 的交货日期。'],
  'draft.po_followup.message_generic': ['Please confirm a delivery date for the remaining quantity on {po}.', '请确认 {po} 剩余数量的交货日期。'],
  'draft.invoice.title': ['Ask {supplier} about the variance on {invoice}', '就 {invoice} 的差异联系 {supplier}'],
  'draft.invoice.message': ['Invoice {invoice} differs from the purchase order by {amount}. Please send a corrected invoice or the reason for the difference.', '发票 {invoice} 与采购订单相差 {amount}。请提供更正后的发票或差异原因。'],
  'draft.invoice.message_hidden': ['Invoice {invoice} differs from the purchase order. Please send a corrected invoice or the reason for the difference.', '发票 {invoice} 与采购订单存在差异。请提供更正后的发票或差异原因。'],
  'draft.pr.title': ['Request {quantity} {unit} of {sku}', '申请采购 {sku} {quantity} {unit}'],
  'draft.pr.reason': ['{available} available against a target of {target}; nothing incoming covers it.', '可用 {available}，目标 {target}；没有在途订单覆盖。'],
  'draft.review': ['Review draft', '复核草稿'],
  'draft.create_pr': ['Create purchase request draft', '创建采购申请草稿'],

  // Signal types: evidence status labels
  'signal.po_overdue.status': ['Overdue', '逾期'],
  'signal.po_due_7d.status': ['Due within 7 days', '7 天内到期'],
  'signal.po_partially_received.status': ['Partially received', '部分收货'],
  'signal.stock_shortage.status': ['Short against demand', '无法满足需求'],
  'signal.stock_below_safety.status': ['Below safety stock', '低于安全库存'],
  'signal.stock_below_reorder.status': ['At or below reorder point', '达到再订货点'],
  'signal.invoice_variance.status': ['Invoice variance', '发票差异'],
  'signal.pr_awaiting_approval.status': ['Awaiting approval', '待审批'],
  'signal.rfq_ready_to_award.status': ['Ready to award', '可以授标'],
  'signal.grn_rejected_qty.status': ['Rejected quantity', '有拒收数量'],
  'signal.grn_received_unposted.status': ['Not posted', '未过账'],

  // Signal reasons: evidence summaries
  'signal.po_overdue.reason': ['{days} days past the promised date; {remaining} still to receive from {supplier}.', '已超过承诺日期 {days} 天；{supplier} 仍有 {remaining} 未交。'],
  'signal.po_due_7d.reason': ['Due {date}; {remaining} still to receive from {supplier}.', '{date} 到期；{supplier} 仍有 {remaining} 未交。'],
  'signal.po_partially_received.reason': ['Partially received: {received} of {ordered}.', '部分收货：已收 {received}，订购 {ordered}。'],
  'signal.stock_shortage.reason': ['{available} available against {demand} on open sales orders, short {shortage}; {incoming} incoming on open POs.', '可用 {available}，未结销售订单需求 {demand}，缺口 {shortage}；在途采购 {incoming}。'],
  'signal.stock_below_safety.reason': ['{available} available against a safety stock of {safety}; {incoming} incoming on open POs.', '可用 {available}，安全库存 {safety}；在途采购 {incoming}。'],
  'signal.stock_below_reorder.reason': ['Available to promise {atp} is at or below the reorder point of {reorder}.', '可承诺量 {atp} 已达到或低于再订货点 {reorder}。'],
  'signal.invoice_variance.reason': ['Invoice variance of {amount} from {supplier}.', '{supplier} 的发票差异为 {amount}。'],
  'signal.invoice_variance.reason_hidden': ['Invoice variance from {supplier}; the amount is hidden for your role.', '{supplier} 的发票存在差异；你的角色无法查看金额。'],
  'signal.pr_awaiting_approval.reason': ['{priority} purchase request awaiting approval.', '{priority}采购申请待审批。'],
  'signal.rfq_ready_to_award.reason': ['{responses} quotes received, no award yet.', '已收到 {responses} 份报价，尚未授标。'],
  'signal.grn_rejected_qty.reason': ['{rejected} rejected on receipt from {supplier}.', '收货时拒收 {rejected}（{supplier}）。'],
  'signal.grn_received_unposted.reason': ['Received but not yet posted to inventory.', '已收货，尚未过账到库存。'],
  'signal.covered': ['Covered by open purchase orders.', '已有在途采购订单覆盖。'],
  'signal.supplier_exposure.status': ['Supplier exposure', '供应商风险'],
  'signal.supplier_exposure.reason': ['{count} open issues with {supplier}: {issues}.', '{supplier} 有 {count} 个待处理问题：{issues}。'],

  // Business impact, aligned by position with the evidence
  'impact.po_overdue': ['Late supply can delay receiving and the customer orders that depend on it.', '供货延误会影响收货以及依赖它的客户订单。'],
  'impact.po_due_7d': ['Confirm the delivery date so receiving can plan.', '确认交货日期，便于收货安排。'],
  'impact.po_partially_received': ['The remaining quantity is still expected from the supplier.', '剩余数量仍待供应商交付。'],
  'impact.stock_shortage': ['Open customer orders cannot be fully shipped from available stock.', '现有可用库存无法满足未结客户订单。'],
  'impact.stock_below_safety': ['Stock is below the buffer set for this item.', '库存低于该物料设定的安全缓冲。'],
  'impact.stock_below_reorder': ['A replenishment decision is due.', '需要做出补货决定。'],
  'impact.invoice_variance': ['The invoice should not be approved until the difference is resolved.', '差异解决前不应批准该发票。'],
  'impact.pr_awaiting_approval': ['The purchase cannot proceed until the request is approved.', '申请批准前，采购无法继续。'],
  'impact.rfq_ready_to_award': ['Quotes are in; a supplier can be selected.', '报价已齐，可以选择供应商。'],
  'impact.grn_rejected_qty': ['Rejected goods need a return or replacement from the supplier.', '拒收货物需要供应商退换。'],
  'impact.grn_received_unposted': ['Stock is not available until the receipt is posted.', '收货过账前库存不可用。'],
  'impact.supplier_exposure': ['Several open issues with one supplier add up to delivery and payment risk.', '同一供应商的多个待处理问题会叠加交付和付款风险。'],

  // Evidence values
  'value.days_late': ['{days} days late', '逾期 {days} 天'],
  'value.due_in': ['Due in {days} days', '{days} 天后到期'],
  'value.received_of': ['{received} of {ordered}', '{received} / {ordered}'],
  'value.short': ['Short {shortage}', '缺口 {shortage}'],
  'value.of': ['{value} of {target}', '{value} / {target}'],
  'value.quotes': ['{responses} quotes', '{responses} 份报价'],
  'value.issues': ['{count} issues', '{count} 个问题'],
  'value.unknown': ['unknown', '未知'],

  // Areas
  'area.purchasing': ['Purchasing', '采购'],
  'area.inventory': ['Inventory', '库存'],
  'area.finance': ['Finance', '财务'],
  'area.receiving': ['Receiving', '收货'],
  'area.sourcing': ['Sourcing', '寻源'],
  'area.master_data': ['Master data', '基础资料'],

  // Sources
  'source.purchase_orders': ['purchase orders', '采购订单'],
  'source.purchase_requests': ['purchase requests', '采购申请'],
  'source.rfqs': ['RFQs', '询价单'],
  'source.inventory': ['inventory balances', '库存余额'],
  'source.supplier_invoices': ['supplier invoices', '供应商发票'],
  'source.receipts': ['receipts', '收货单'],
  'source.items': ['items', '物料'],
  'source.suppliers': ['suppliers', '供应商'],
  'source.sales_orders': ['sales orders', '销售订单'],
  'source.workspace': ['workspace skills', '工作区技能'],

  // Fields checked by records_needing_data
  'field.unit': ['unit', '单位'],
  'field.preferred_supplier': ['preferred supplier', '首选供应商'],
  'field.safety_stock': ['safety stock', '安全库存'],
  'field.reorder_point': ['reorder point', '再订货点'],
  'field.stock_threshold': ['a safety stock or reorder point', '安全库存或再订货点'],
  'field.available_quantity': ['available quantity', '可用数量'],
  'field.promised_date': ['promised date', '承诺交期'],
  'field.line_quantity': ['ordered or received quantity', '订购或已收数量'],
  'field.lines': ['lines', '明细行'],
  'field.required_date': ['required date', '需求日期'],
  'field.currency': ['currency', '币种'],
  'field.amount': ['amount', '金额'],
  'field.supplier': ['supplier', '供应商'],
  'field.name': ['name', '名称'],
  'field.invoice_date': ['invoice date', '发票日期'],
  'field.status': ['status', '状态'],
  'field.purchase_order': ['purchase order', '采购订单'],

  // Priority
  'priority.high': ['High-priority', '高优先级'],
  'priority.medium': ['Medium-priority', '中优先级'],
  'priority.low': ['Low-priority', '低优先级'],
  'priority.none': ['A', ''],

  // Limitations
  'limitation.hidden_by_permission.label': ['Some records are hidden', '部分记录已隐藏'],
  'limitation.hidden_by_permission.description': ['Your role cannot view {sources}, so they were left out of this answer.', '你的角色无法查看{sources}，因此本次回答未包含这些内容。'],
  'limitation.amounts_hidden.label': ['Amounts hidden', '金额已隐藏'],
  'limitation.amounts_hidden.description': ['Your role cannot view amounts on {what}, so they are not shown.', '你的角色无法查看{what}的金额，因此未显示。'],
  'limitation.truncated.label': ['Not every record was read', '未读取全部记录'],
  'limitation.truncated.description': ['Only the first {limit} {source} were read, so counts may be low.', '只读取了前 {limit} 条{source}，数量可能偏低。'],
  'limitation.currency_missing.label': ['Currency missing', '币种缺失'],
  'limitation.currency_missing.description': ['Some amounts have no currency, so they are shown as plain numbers and not totalled.', '部分金额没有币种，因此以普通数字显示，未合计。'],
  'limitation.multi_currency.label': ['Several currencies', '多个币种'],
  'limitation.multi_currency.description': ['Amounts are shown per currency and not converted.', '金额按币种分别显示，未折算。'],
  'limitation.amount_missing.label': ['Amount missing', '金额缺失'],
  'limitation.amount_missing.description': ['Some records have no amount, so their total is not shown.', '部分记录缺少金额，因此未显示合计。'],
  'limitation.draft_permission.label': ['Drafts not available', '无法准备草稿'],
  'limitation.report_day.label': ['Report day', '报表日期'],
  'limitation.report_day.description': ['Overdue days are counted to {date}, the day the open purchase orders report uses.', '逾期天数按 {date} 计算，与未结采购订单报表一致。'],

  // Follow-up suggestions (the prompts are the chip texts)
  'followup.today.label': ["Today's priorities", '今日优先事项'],
  'followup.today.prompt': ['What should I handle first today?', '今天先处理什么？'],
  'followup.risk.label': ['Highest risk', '风险最高'],
  'followup.risk.prompt': ['Which items have the highest risk?', '哪些事项风险最高？'],
  'followup.records.label': ['Records needing data', '需要补齐的数据'],
  'followup.records.prompt': ['Which records need more data?', '哪些数据需要补齐？'],
  'followup.draft.label': ['Prepare a draft', '准备草稿'],
  'followup.draft.prompt': ['Prepare an action draft', '帮我准备一个处理草稿'],
  'followup.metrics.label': ['Open POs and spend', '未结 PO 与金额'],
  'followup.metrics.prompt': ['How many open purchase orders do we have?', '现在有多少未结采购订单？'],

  // Navigation
  'nav.open': ['Open {id}', '打开 {id}'],
  'nav.open_pos_report': ['Open purchase orders report', '未结采购订单报表'],
}

export const AI_SKILL_COPY = Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, [en, zh]]) => [key, Object.freeze({ en, zh })])))

// Fills {name} placeholders. A missing value renders as an empty string, never
// as the placeholder or "undefined".
function fill(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (_, name) => (values[name] === undefined || values[name] === null ? '' : String(values[name])))
}

export function aiSkillText(key, language, values) {
  const entry = AI_SKILL_COPY[key]
  if (!entry) throw Object.assign(new Error(`Unknown AI skill copy key: ${key}`), { code: 'AI_SKILL_COPY_KEY_UNKNOWN' })
  return fill(aiSkillLanguage(language) === 'zh-CN' ? entry.zh : entry.en, values)
}

// Chooses the _one / _none variant of a counted key when the catalog has it.
export function aiSkillCountText(key, count, language, values = {}) {
  const variant = count === 0 && AI_SKILL_COPY[`${key}_none`] ? `${key}_none` : count === 1 && AI_SKILL_COPY[`${key}_one`] ? `${key}_one` : key
  return aiSkillText(variant, language, { count, ...values })
}

// Sentences of one answer: separated by a space in English, run together in Chinese.
export function aiSkillSentences(parts, language) {
  return parts.filter(Boolean).join(aiSkillLanguage(language) === 'zh-CN' ? '' : ' ')
}

// A list of already localized parts: "a, b and c" / "a、b 和 c".
export function aiSkillList(parts, language) {
  const items = parts.filter(Boolean)
  if (items.length <= 1) return items.join('')
  if (aiSkillLanguage(language) === 'zh-CN') return `${items.slice(0, -1).join('、')}和${items.at(-1)}`
  return items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
