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

// The language to answer in: the language the question is phrased in, else
// the interface language. A question is phrased by the words that make it a
// question: English question words, auxiliaries, "please" and an imperative
// opening a clause ("Show", "List"); Chinese question words, particles and
// request words (多少, 哪些, 吗, 请, 帮我, 一下). Names do not count, so
// "Bank of America 的发票是多少？" is Chinese and "How many 未结采购订单 do we
// have?" is English: of, and, the and other function words are never
// question words. With question words in both languages, a sentence-final
// Chinese particle, then the larger count, then the earlier word decides.
// Without any, the balance of Latin words and Chinese characters (about two
// to a word) decides, and a tie falls back to the interface language. Record
// ids, SKUs and numbers are removed first. Only the first 1,200 characters
// are read: a longer question is rejected anyway.
const CJK_CHAR = /[㐀-鿿豈-﫿]/gu
const RECORD_ID = /\b[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d+\b/g
const ENGLISH_QUESTION = new Set(['what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'would', 'will', 'should', 'shall', 'may', 'might', 'has', 'have', 'had', 'please'])
// Imperatives and "any" count only at the start of a clause ("Show me...",
// "Any open POs?"), not inside a name or a noun phrase ("PO list").
const ENGLISH_OPENER = new Set(['show', 'list', 'give', 'tell', 'find', 'check', 'get', 'any', 'count', 'compare', 'explain', 'summarize', 'summarise'])
const CHINESE_QUESTION = /吗|呢|吧|哪些|哪个|哪家|哪张|哪里|哪儿|多少|什么|怎么|怎样|为什么|是否|有没有|是不是|几个|几张|几家|几天|几笔|请|帮我|给我|替我|查一下|看一下|看看|一下|列出|告诉我/gu
const CHINESE_FINAL_PARTICLE = /[吗呢吧][\s?？!！。.]*$/u

export function aiSkillQuestionLanguage(message, interfaceLanguage) {
  const stripped = String(message || '').slice(0, 1200).replace(RECORD_ID, ' ').replace(/\d+/g, ' ')
  // Short all-capital tokens (SKU, PO, ATP, US) are acronyms, unless the
  // whole question is written in capitals.
  const shouting = !/[a-z]/.test(stripped)
  const acronym = (word) => word === word.toUpperCase() && word.length <= 4
  const words = [...stripped.matchAll(/[A-Za-z]{2,}/g)]
  const english = words.filter((match) => {
    const word = match[0].toLowerCase()
    if (!shouting && acronym(match[0])) return false
    if (ENGLISH_QUESTION.has(word)) return true
    // "Show 一下…" is the Chinese verb-plus-一下 request, with an English verb.
    if (/^\s*一下/u.test(stripped.slice(match.index + match[0].length))) return false
    return ENGLISH_OPENER.has(word) && /(^|[.!?;:,，。？！；：])\s*$/u.test(stripped.slice(0, match.index))
  }).map((match) => match.index)
  const chinese = [...stripped.matchAll(CHINESE_QUESTION)].map((match) => match.index)
  if (english.length && !chinese.length) return 'en-US'
  if (chinese.length && !english.length) return 'zh-CN'
  if (english.length) {
    if (CHINESE_FINAL_PARTICLE.test(stripped)) return 'zh-CN'
    if (english.length !== chinese.length) return english.length > chinese.length ? 'en-US' : 'zh-CN'
    return Math.min(...english) < Math.min(...chinese) ? 'en-US' : 'zh-CN'
  }
  // No question words: "overdue POs" or "逾期订单".
  const cjkWords = (stripped.match(CJK_CHAR) || []).length / 2
  const latinWords = words.filter((match) => !acronym(match[0])).length
  if (latinWords >= 2 && latinWords > cjkWords) return 'en-US'
  if (cjkWords >= 1 && cjkWords > latinWords) return 'zh-CN'
  return aiSkillLanguage(interfaceLanguage)
}

const entries = {
  // Answer frame
  'scope.label': ['Your workspace data', '当前工作区数据'],
  'answer.source': ['Answered from your workspace data', '基于当前工作区数据回答'],
  'answer.checked': ['Checked: {sources}', '已检查：{sources}'],
  'answer.review_boundary': ['This answer does not send, approve or change anything.', '本回答不会发送、批准或修改任何内容。'],
  // A question with several parts, answered part by part (ai-skill-compound.mjs).
  'compound.title': ['Your question, answered part by part', '按问题的各部分分别回答'],

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
  'skill.purchase_orders.title': ['Purchase orders', '采购订单'],
  'skill.purchase_orders.description': ["Looks up a purchase order, a supplier's orders or the purchase orders overdue now, with the open purchase orders report's figures. Not sales orders, and not deliveries that already arrived late.", '按未结采购订单报表口径，查询一张采购订单、某个供应商的订单或当前逾期的采购订单。不含销售订单，也不含已经迟到的到货。'],
  'skill.pending_approvals.title': ['Waiting for approval', '待审批'],
  'skill.pending_approvals.description': ['Lists the purchase orders and purchase requests waiting for approval.', '列出待审批的采购订单和采购申请。'],
  'skill.inventory_availability.title': ['Stock and availability', '库存与可用量'],
  'skill.inventory_availability.description': ['States on hand, available, open demand, incoming and available-to-promise quantities for a SKU, or the SKUs that need attention.', '说明某个 SKU 的在手、可用、未结需求、在途和可承诺数量，或列出需要关注的 SKU。'],
  'skill.invoice_summary.title': ['Supplier invoices', '供应商发票'],
  'skill.invoice_summary.description': ['Totals submitted supplier invoices per currency and counts their three-way match results.', '按币种汇总已提交的供应商发票，并统计三单匹配结果。'],
  'skill.rfq_followups.title': ['RFQ follow-ups', '询价跟进'],
  'skill.rfq_followups.description': ['Lists open RFQs without an award: those with quotes waiting for a supplier to be selected, those with no quote yet, and those past their quote due date.', '列出尚未授标的询价单：已有报价待选定供应商的、还没有报价的，以及已过报价截止日的。'],
  'skill.receiving_issues.title': ['Receiving issues', '收货问题'],
  'skill.receiving_issues.description': ['Lists receipts with rejected quantities on open purchase orders and receipts not yet posted to inventory.', '列出未结采购订单上有拒收数量的收货单，以及尚未过账到库存的收货单。'],
  'skill.supplier_attention.title': ['Suppliers needing attention', '需要注意的供应商'],
  'skill.supplier_attention.description': ['Lists the suppliers with open work, ordered by date: overdue purchase orders, orders due within 7 days, receipts with rejected quantities or not posted, and invoice variances, each with its most urgent record; and the suppliers with new orders, receipts or invoices in the last 7 days. Answers general questions about suppliers.', '按日期列出有待处理事项的供应商：逾期采购订单、7 天内到期的订单、有拒收或未过账的收货单、有差异的发票，并说明每家最急的一条；以及最近 7 天有新下单、到货或发票的供应商。用于回答关于供应商的笼统问题。'],
  'skill.capability_overview.title': ['What I can help with', '我可以帮你做什么'],
  'skill.capability_overview.description': ['Explains what the assistant can answer from workspace data.', '说明助手能基于工作区数据回答哪些问题。'],

  // Capability and refusal
  'capability.title': ['Here is what I can help with', '我可以帮你做这些'],
  'capability.summary': ['Ask me about priorities, risks, purchase orders, suppliers, invoices, RFQs, receiving or stock, or try a suggestion below.', '可以问我优先事项、风险、采购订单、供应商、发票、询价、收货或库存，也可以试试下面的建议。'],
  'capability.unsupported_id': ["I can't look up {id} by its number yet.", '暂时无法按编号查询 {id}。'],
  'capability.unsupported_ids': ["I can't look up {id} by their numbers yet.", '暂时无法按编号查询 {id}。'],
  'capability.outside': ['I can only answer questions about your workspace data.', '我只能回答与当前工作区数据有关的问题。'],
  'capability.topic': ["I couldn't tell what you want to know about {topic}.", '我没能确定你想了解{topic}的哪方面。'],
  'topic.suppliers': ['suppliers', '供应商'],
  'topic.purchase_orders': ['purchase orders', '采购订单'],
  'topic.inventory': ['stock', '库存'],
  'topic.invoices': ['supplier invoices', '供应商发票'],
  'topic.rfqs': ['RFQs', '询价'],
  'topic.receiving': ['receiving', '收货'],
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
  'risk.focus_title': ['Risk on {id}: {first}', '{id} 的风险：{first}'],
  'risk.focus_none': ['No risk found for {id} (as of {date})', '{id} 没有发现风险（截至 {date}）'],
  'risk.summary': ['{count} items carry risk exposure, ordered by severity and amount.', '共 {count} 项存在风险敞口，按严重程度和金额排序。'],

  // records_needing_data
  'records.title': ['{count} records need more data', '{count} 条记录需要补齐'],
  'records.title_one': ['1 record needs more data', '1 条记录需要补齐'],
  'records.title_none': ['No records are missing required fields', '未发现缺失必填字段的记录'],
  'records.focus_title': ['{id} needs more data', '{id} 需要补齐数据'],
  'records.focus_none': ['{id} has no missing required fields', '{id} 没有缺失必填字段'],
  'records.summary': ['Checked {checked} records across {sources} sources.', '已检查 {sources} 类来源共 {checked} 条记录。'],
  'records.missing': ['Missing {fields}.', '缺少{fields}。'],
  'records.status': ['Needs data', '需要补齐'],

  // prepare_action_draft
  'draft.title': ['{count} drafts ready for your review', '已准备 {count} 份草稿，等待你复核'],
  'draft.title_one': ['1 draft ready for your review', '已准备 1 份草稿，等待你复核'],
  'draft.title_blocked': ['Drafts need purchasing edit access', '准备草稿需要采购编辑权限'],
  'draft.title_none': ['No draft is needed right now', '当前不需要准备草稿'],
  'draft.focus_title': ['A draft for {id} is ready for your review', '已为 {id} 准备草稿，等待你复核'],
  'draft.focus_title_many': ['{count} drafts for {id} are ready for your review', '已为 {id} 准备 {count} 份草稿，等待你复核'],
  'draft.focus_none': ['{id} needs no draft right now', '{id} 当前不需要草稿'],
  'draft.summary': ['Review each draft before you send it. This answer does not send or change anything.', '发送前请逐一复核。本回答不会发送或修改任何内容。'],
  'draft.none_summary': ['No open issue calls for a follow-up draft. Open the records below to review them.', '当前没有需要跟进草稿的问题。可打开下面的记录查看。'],
  'draft.no_permission': ['Your role cannot prepare procurement drafts, so only links are shown.', '你的角色无法准备采购草稿，因此只显示链接。'],
  'draft.po_followup.title': ['Follow up with {supplier} on {po}', '就 {po} 跟进 {supplier}'],
  'draft.po_followup.message_generic': ['Please confirm a delivery date for the remaining quantity on {po}.', '请确认 {po} 剩余数量的交货日期。'],
  'draft.invoice.title': ['Ask {supplier} about the variance on {invoice}', '就 {invoice} 的差异联系 {supplier}'],
  'draft.invoice.message': ['Invoice {invoice} differs from the purchase order by {amount}. Please send a corrected invoice or the reason for the difference.', '发票 {invoice} 与采购订单相差 {amount}。请提供更正后的发票或差异原因。'],
  'draft.invoice.message_hidden': ['Invoice {invoice} differs from the purchase order. Please send a corrected invoice or the reason for the difference.', '发票 {invoice} 与采购订单存在差异。请提供更正后的发票或差异原因。'],
  'draft.pr.title': ['Request {quantity} {unit} of {sku}', '申请采购 {sku} {quantity} {unit}'],
  'draft.pr.reason': ['{available} available against a target of {target}; nothing incoming covers it.', '可用 {available}，目标 {target}；没有在途订单覆盖。'],
  'draft.review': ['Review draft', '复核草稿'],
  // A supplier message draft: greeting, body and closing, each line of the
  // body a record fact (docs/ai-prefill-autocomplete-design.md, J1/J2).
  'draft.greeting': ['Hello {name},', '{name}，您好：'],
  'draft.closing': ['Thank you.', '谢谢。'],
  'draft.po_followup.intro_one': ['Please confirm a delivery date for the open line on {po}:', '请确认 {po} 上以下未交货行的交货日期：'],
  'draft.po_followup.intro_many': ['Please confirm delivery dates for the open lines on {po}:', '请确认 {po} 上以下未交货行的交货日期：'],
  'draft.po_followup.bullet': ['- {sku}{item}: {quantity} still to deliver{promised}', '- {sku}{item}：仍有 {quantity} 未交{promised}'],
  'draft.po_followup.promised': [', promised {date}', '，承诺日期 {date}'],
  'draft.po_followup.originally': [' (originally {date})', '（原定 {date}）'],
  'draft.po_followup.subject': ['{po}: delivery dates for {count} open lines', '{po}：{count} 行未交货的交货日期'],
  'draft.po_followup.subject_one': ['{po}: delivery date for {sku}', '{po}：{sku} 的交货日期'],
  'draft.po_followup.subject_generic': ['{po}: delivery date', '{po}：交货日期'],
  'draft.invoice.subject': ['Invoice {invoice}: difference from the purchase order', '发票 {invoice}：与采购订单的差异'],
  // The next step each answer line states.
  'next.po_followup': ['Next: ask {supplier} to confirm a delivery date.', '下一步：请 {supplier} 确认交货日期。'],
  'next.chase_po': ['Next: chase {po}, which brings this item.', '下一步：跟进带来该物料的 {po}。'],
  'next.raise_pr': ['Next: raise a purchase request for {quantity}.', '下一步：申请采购 {quantity}。'],
  'next.await_pr': ['Next: get the pending purchase request approved.', '下一步：推动待审批的采购申请通过。'],
  'next.invoice_query': ['Next: ask {supplier} about the difference.', '下一步：就差异询问 {supplier}。'],
  'next.rejected': ['Next: tell {supplier} about the rejected quantity.', '下一步：告知 {supplier} 拒收数量。'],
  'next.post_receipt': ['Next: post the receipt.', '下一步：过账这张收货单。'],
  'next.review_request': ['Next: review the request.', '下一步：审核这张申请。'],
  'next.compare_quotes': ['Next: compare the quotes and award.', '下一步：比较报价并授标。'],
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
  // supplier_attention
  'suppliers.title': ['{count} suppliers have open work; the most urgent is {supplier} ({lead})', '{count} 家供应商有待处理的事，最急的是 {supplier}（{lead}）'],
  'suppliers.title_one': ['1 supplier has open work: {supplier} ({lead})', '1 家供应商有待处理的事：{supplier}（{lead}）'],
  'suppliers.title_none': ['No supplier has open work (as of {date})', '截至 {date}，没有供应商有待处理的事'],
  'suppliers.title_named_none': ['{supplier} has no open work (as of {date})', '截至 {date}，{supplier} 没有待处理的事'],
  'suppliers.title_hidden': ['Your role cannot see supplier orders, receipts or invoices', '你的角色无法查看供应商的订单、收货或发票'],
  'suppliers.lead.overdue': ['{days} days overdue', '逾期 {days} 天'],
  'suppliers.lead.overdue_one': ['1 day overdue', '逾期 1 天'],
  'suppliers.lead.due': ['due {date}', '{date} 到期'],
  'suppliers.lead.open': ['open {days} days', '已挂起 {days} 天'],
  'suppliers.lead.open_one': ['open 1 day', '已挂起 1 天'],
  'suppliers.lead.open_none': ['since today', '今天发生'],
  'suppliers.part.po_overdue': ['{count} overdue purchase orders', '{count} 张逾期采购订单'],
  'suppliers.part.po_overdue_one': ['1 overdue purchase order', '1 张逾期采购订单'],
  'suppliers.part.po_due_7d': ['{count} purchase orders due within 7 days', '{count} 张 7 天内到期的采购订单'],
  'suppliers.part.po_due_7d_one': ['1 purchase order due within 7 days', '1 张 7 天内到期的采购订单'],
  'suppliers.part.grn_rejected_qty': ['{count} receipts with rejected quantities', '{count} 张有拒收的收货单'],
  'suppliers.part.grn_rejected_qty_one': ['1 receipt with rejected quantities', '1 张有拒收的收货单'],
  'suppliers.part.grn_received_unposted': ['{count} receipts not posted', '{count} 张未过账的收货单'],
  'suppliers.part.grn_received_unposted_one': ['1 receipt not posted', '1 张未过账的收货单'],
  'suppliers.part.invoice_variance': ['{count} invoice variances', '{count} 张有差异的发票'],
  'suppliers.part.invoice_variance_one': ['1 invoice variance', '1 张有差异的发票'],
  'suppliers.issues': ['{parts}.', '{parts}。'],
  'suppliers.most_urgent': ['Most urgent: {id}. {reason}', '最急的是 {id}：{reason}'],
  'suppliers.totals': ['In all: {parts}.', '合计：{parts}。'],
  'suppliers.quiet': ['{count} other suppliers have nothing open.', '另外 {count} 家供应商目前没有待处理的事。'],
  'suppliers.quiet_one': ['1 other supplier has nothing open.', '另外 1 家供应商目前没有待处理的事。'],
  'suppliers.more': ['{count} more suppliers have open work; open the supplier scorecard to see all of them.', '还有 {count} 家供应商有待处理的事，可打开供应商评分卡查看全部。'],
  'suppliers.more_one': ['1 more supplier has open work; open the supplier scorecard to see all of them.', '还有 1 家供应商有待处理的事，可打开供应商评分卡查看全部。'],
  'suppliers.recent': ['In the last {days} days: {list}.', '最近 {days} 天有往来：{list}。'],
  'suppliers.recent_none': ['No new orders, receipts or invoices in the last {days} days.', '最近 {days} 天没有新的下单、到货或发票。'],
  'suppliers.activity.entry': ['{supplier} ({parts})', '{supplier}（{parts}）'],
  'suppliers.activity.orders': ['{count} new orders', '新下单 {count} 张'],
  'suppliers.activity.orders_one': ['1 new order', '新下单 1 张'],
  'suppliers.activity.receipts': ['{count} receipts', '到货 {count} 张'],
  'suppliers.activity.receipts_one': ['1 receipt', '到货 1 张'],
  'suppliers.activity.invoices': ['{count} invoices', '发票 {count} 张'],
  'suppliers.activity.invoices_one': ['1 invoice', '发票 1 张'],
  'suppliers.view_all': ['View all suppliers (scorecard)', '查看全部供应商（评分卡）'],
  'suppliers.tier_title': ['{count} {group} have open work; the most urgent is {supplier} ({lead})', '{group}中有 {count} 家有待处理的事，最急的是 {supplier}（{lead}）'],
  'suppliers.tier_title_one': ['1 of the {group} has open work: {supplier} ({lead})', '{group}中有 1 家有待处理的事：{supplier}（{lead}）'],
  'suppliers.tier_title_none': ['None of the {group} has open work (as of {date})', '截至 {date}，{group}都没有待处理的事'],
  'suppliers.tier_empty': ['There are no {group} yet', '目前还没有{group}'],
  // Supplier tiers (docs/supplier-tiers-design.md): labels and filters only.
  'tier.1': ['Tier 1', '一级'],
  'tier.2': ['Tier 2', '二级'],
  'tier.3': ['Tier 3', '三级'],
  'tier.supplier': ['{name} ({tier})', '{name}（{tier}）'],
  'tier.group_1': ['Tier 1 suppliers', '一级供应商'],
  'tier.group_2': ['Tier 2 suppliers', '二级供应商'],
  'tier.group_3': ['Tier 3 suppliers', '三级供应商'],
  'tier.group_none': ['suppliers not yet tiered', '未分级供应商'],
  'tier.unavailable': ['Supplier tiers are not visible with your access, so this list is not narrowed by tier.', '你的权限看不到供应商层级，因此这份清单没有按层级筛选。'],
  // The date a line is ordered by (aiSkillWhenText).
  'signal.when.overdue': ['{days} days past {date}.', '已超过 {date} {days} 天。'],
  'signal.when.overdue_one': ['1 day past {date}.', '已超过 {date} 1 天。'],
  'signal.when.due': ['Due {date}, in {days} days.', '{date} 到期，还有 {days} 天。'],
  'signal.when.due_one': ['Due {date}, tomorrow.', '{date}（明天）到期。'],
  'signal.when.due_none': ['Due today ({date}).', '今天（{date}）到期。'],
  'signal.when.open': ['Open {days} days, since {date}.', '已挂起 {days} 天（自 {date}）。'],
  'signal.when.open_one': ['Open 1 day, since {date}.', '已挂起 1 天（自 {date}）。'],
  'signal.when.open_none': ['Since today ({date}).', '今天（{date}）发生。'],
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
  'value.a_supplier': ['a supplier', '某供应商'],

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
  'limitation.compound_parts_limited.label': ['Only the first parts were answered', '只回答了前几个部分'],
  'limitation.compound_parts_limited.description': ['I answered the first {count} parts of your question. Ask about the rest separately.', '已回答问题的前 {count} 个部分，其余部分请分开提问。'],

  // Purchase order status labels. Neutral wording: a label states the record's
  // state and never reads as the assistant having acted.
  'po_status.draft': ['Draft', '草稿'],
  'po_status.pending_approval': ['Waiting for approval', '待审批'],
  'po_status.approved': ['Approved, not yet issued', '审批通过，待发出'],
  'po_status.issued': ['Issued to the supplier', '已发给供应商'],
  'po_status.partially_received': ['Partially received', '部分收货'],
  'po_status.fully_received': ['Fully received', '全部收货'],
  'po_status.closed': ['Closed', '关闭'],
  'po_status.cancelled': ['Cancelled', '作废'],
  'po_status.rejected': ['Rejected', '驳回'],
  'po_status.other': ['Status {status}', '状态 {status}'],

  // purchase_orders
  'po.title_hidden': ['Purchase orders are hidden for your role', '你的角色无法查看采购订单'],
  'stock.title_hidden': ['Inventory is hidden for your role', '你的角色无法查看库存'],
  'po.single_remaining': ['{po}: {remaining} still to receive', '{po}：还有 {remaining} 待收货'],
  'po.single_received': ['{po} is fully received', '{po} 全部收货'],
  'po.single_status': ['{po}: {status}', '{po}：{status}'],
  'po.single_mixed': ['{po}: lines use different units, so there is no single remaining quantity', '{po}：各行单位不同，无法合计待收数量'],
  'po.detail': ['Supplier {supplier}. Ordered {ordered}, received {received}.', '供应商 {supplier}。订购 {ordered}，已收 {received}。'],
  'po.detail_supplier': ['Supplier {supplier}.', '供应商 {supplier}。'],
  'po.due_overdue': ['Due {date}, {days} days overdue.', '应到货日期 {date}，逾期 {days} 天。'],
  'po.due_overdue_one': ['Due {date}, 1 day overdue.', '应到货日期 {date}，逾期 1 天。'],
  'po.due_on': ['Due {date}.', '应到货日期 {date}。'],
  'po.due_missing': ['No promised date is recorded.', '未记录承诺到货日期。'],
  'po.amount': ['Order amount {amount}.', '订单金额 {amount}。'],
  'po.incomplete': ['Some line quantities or dates are missing, so these figures may be incomplete.', '部分行缺少数量或日期，以上数字可能不完整。'],
  'po.supplier_title': ['{name}: {open} open purchase orders, {overdue} overdue', '{name}：未结采购订单 {open} 张，逾期 {overdue} 张'],
  'po.supplier_title_one': ['{name}: 1 open purchase order, {overdue} overdue', '{name}：未结采购订单 1 张，逾期 {overdue} 张'],
  'po.supplier_title_none': ['{name} has no open purchase orders', '{name} 没有未结采购订单'],
  'po.sku_title': ['{name}: {open} open purchase orders, {overdue} overdue', '{name}：未结采购订单 {open} 张，逾期 {overdue} 张'],
  'po.sku_title_one': ['{name}: 1 open purchase order, {overdue} overdue', '{name}：未结采购订单 1 张，逾期 {overdue} 张'],
  'po.sku_title_none': ['{name} has no open purchase orders', '{name} 没有未结采购订单'],
  'po.group_sentence': ['{name}: {open} open, {overdue} overdue.', '{name}：未结 {open} 张，逾期 {overdue} 张。'],
  'po.many_title': ['{count} matches: open purchase orders {open}, overdue {overdue}', '{count} 项：未结采购订单 {open} 张，逾期 {overdue} 张'],
  'po.hidden_lookup': ["Your role can't view purchase orders, so I can't look up {id}", '你的角色无法查看采购订单，因此无法查询 {id}'],
  'po.ambiguous_title': ['{id} matches more than one purchase order', '{id} 对应多张采购订单'],
  'po.ambiguous_summary': ['Which one do you mean: {list}?', '你指的是哪一张：{list}？'],
  'po.not_read_title': ['{id} is not among the purchase orders I read', '{id} 不在本次读取的采购订单中'],
  'po.not_read_summary': ['Only the first {limit} purchase orders were read. Search the purchase orders list for it.', '本次只读取了前 {limit} 张采购订单，请在采购订单列表中搜索。'],
  'po.not_read_summary_unknown': ['Not every purchase order was read. Search the purchase orders list for it.', '本次没有读取全部采购订单，请在采购订单列表中搜索。'],
  'lookup.not_found_title': ["I couldn't find {id} in this workspace", '当前工作区中找不到 {id}'],
  'lookup.not_found_summary': ['Check the number or the name, or ask without it.', '请核对编号或名称，或不带它再问一次。'],
  'access.ask_admin': ['Ask an administrator if you need access.', '如需查看，请联系管理员开通权限。'],
  'po.single_closed': ['{po}: {status}, nothing will be received', '{po}：{status}，不会再收货'],
  'po.single_not_committed': ['{po}: {status}, not yet committed ({ordered} ordered)', '{po}：{status}，尚未生效（订购 {ordered}）'],
  'po.as_of': ['Counted as in the open purchase orders report, as of {date}.', '按截至 {date} 的未结采购订单报表统计。'],
  'po.overdue_title': ['{count} purchase orders are overdue (as of {date})', '截至 {date}，逾期采购订单 {count} 张'],
  'po.overdue_title_one': ['1 purchase order is overdue (as of {date})', '截至 {date}，逾期采购订单 1 张'],
  'po.overdue_title_none': ['No purchase order is overdue (as of {date})', '截至 {date}，没有逾期采购订单'],
  'po.tier_overdue_title': ['{count} purchase orders from {group} are overdue (as of {date})', '截至 {date}，{group}的逾期采购订单 {count} 张'],
  'po.tier_overdue_title_one': ['1 purchase order from {group} is overdue (as of {date})', '截至 {date}，{group}的逾期采购订单 1 张'],
  'po.tier_overdue_title_none': ['No purchase order from {group} is overdue (as of {date})', '截至 {date}，{group}没有逾期采购订单'],
  'po.overdue_summary': ['Most overdue first: {list}.', '按逾期天数排列：{list}。'],
  'po.overdue_item': ['{po} ({days} days)', '{po}（{days} 天）'],
  'po.not_found_title': ["I couldn't find {id} in this workspace", '当前工作区中找不到 {id}'],
  'po.not_found_summary': ['Check the number, or ask about open or overdue purchase orders.', '请核对编号，或询问未结、逾期的采购订单。'],
  'po.evidence_late': ['{status} · {supplier} · {days} days late', '{status} · {supplier} · 逾期 {days} 天'],
  'po.evidence_due': ['{status} · {supplier} · due {date}', '{status} · {supplier} · 应到货 {date}'],
  'po.evidence_plain': ['{status} · {supplier}', '{status} · {supplier}'],
  'po.value_remaining': ['{remaining} to receive', '待收 {remaining}'],
  'po.impact_late': ['Late receipt', '收货延迟'],
  'po.impact_late.explanation': ['A late receipt can hold up the stock and sales orders that depend on it.', '收货延迟会影响依赖它的库存和销售订单。'],
  'po.impact_open': ['Still to receive', '待收货'],
  'po.impact_open.explanation': ['Follow up with the supplier before the due date.', '请在应到货日期前与供应商跟进。'],
  'po.impact_closed': ['Nothing to receive', '无待收货'],
  'po.impact_closed.explanation': ['Nothing is outstanding on this order.', '该订单没有待收数量。'],

  // pending_approvals
  'approval.title': ['{count} purchase orders are waiting for approval', '{count} 张采购订单待审批'],
  'approval.title_one': ['1 purchase order is waiting for approval', '1 张采购订单待审批'],
  'approval.title_none': ['No purchase order is waiting for approval', '没有待审批的采购订单'],
  'approval.filtered_title': ['{name}: {count} purchase orders waiting for approval', '{name}：{count} 张采购订单待审批'],
  'approval.filtered_title_one': ['{name}: 1 purchase order waiting for approval', '{name}：1 张采购订单待审批'],
  'approval.filtered_title_none': ['{name}: no purchase order waiting for approval', '{name}：没有待审批的采购订单'],
  'approval.filtered_summary': ['Only orders for {name} are counted.', '只统计 {name} 的订单。'],
  'approval.requests': ['{count} purchase requests are also waiting for approval.', '另有 {count} 张采购申请待审批。'],
  'approval.requests_one': ['1 purchase request is also waiting for approval.', '另有 1 张采购申请待审批。'],
  'approval.requests_none': ['No purchase request is waiting for approval.', '没有待审批的采购申请。'],
  'approval.amounts': ['The waiting orders total {amounts}.', '待审批订单金额合计 {amounts}。'],
  'approval.po_summary': ['{supplier} · created {date}', '{supplier} · 创建于 {date}'],
  'approval.pr_summary': ['Required by {date}', '需求日期 {date}'],
  'approval.status': ['Waiting for approval', '待审批'],
  'approval.impact.explanation': ['An order waiting for approval cannot go to the supplier yet.', '待审批的订单还不能发给供应商。'],

  // RFQ follow-ups
  'rfq.title': ['{count} open RFQs without an award', '{count} 张询价单尚未授标'],
  'rfq.title_one': ['1 open RFQ without an award', '1 张询价单尚未授标'],
  'rfq.title_none': ['No open RFQ is waiting for an award', '没有待授标的询价单'],
  'rfq.title_hidden': ['RFQs are hidden for your role', '你的角色无法查看询价单'],
  'rfq.ready': ['{count} have quotes and are waiting for a supplier to be selected.', '{count} 张已有报价，待选定供应商。'],
  'rfq.ready_one': ['1 has quotes and is waiting for a supplier to be selected.', '1 张已有报价，待选定供应商。'],
  'rfq.waiting': ['{count} have no quote yet.', '{count} 张还没有报价。'],
  'rfq.waiting_one': ['1 has no quote yet.', '1 张还没有报价。'],
  'rfq.past_due': ['{count} are past their quote due date.', '{count} 张已过报价截止日。'],
  'rfq.past_due_one': ['1 is past its quote due date.', '1 张已过报价截止日。'],
  'rfq.waiting_status': ['Waiting for quotes', '等待报价'],
  'rfq.row_quotes_of': ['{responses} of {invited} suppliers quoted', '{invited} 家供应商中 {responses} 家已报价'],
  'rfq.row_quotes': ['{count} quotes received', '已收到 {count} 份报价'],
  'rfq.row_quotes_one': ['1 quote received', '已收到 1 份报价'],
  'rfq.row_quotes_none': ['No quote yet', '还没有报价'],
  'rfq.row_due': ['quotes due {date}', '报价截止 {date}'],
  'rfq.row_past_due': ['quote due date {date} has passed', '报价截止日 {date} 已过'],
  'rfq.impact.waiting': ['Without quotes, the request cannot become a purchase order.', '没有报价，这项需求还不能转成采购订单。'],

  // Receiving issues
  'receiving.title': ['{count} receipts need attention', '{count} 张收货单需要处理'],
  'receiving.title_one': ['1 receipt needs attention', '1 张收货单需要处理'],
  'receiving.title_none': ['No receipt needs attention', '没有需要处理的收货单'],
  'receiving.title_hidden': ['Receipts are hidden for your role', '你的角色无法查看收货单'],
  'receiving.rejected': ['{count} have rejected quantities on open purchase orders.', '{count} 张在未结采购订单上有拒收数量。'],
  'receiving.rejected_one': ['1 has a rejected quantity on an open purchase order.', '1 张在未结采购订单上有拒收数量。'],
  'receiving.unposted': ['{count} are received but not posted to inventory.', '{count} 张已收货但未过账到库存。'],
  'receiving.unposted_one': ['1 is received but not posted to inventory.', '1 张已收货但未过账到库存。'],
  'receiving.none_summary': ['No receipt has a rejected quantity on an open purchase order, and none is waiting to be posted.', '没有在未结采购订单上有拒收数量的收货单，也没有等待过账的收货单。'],

  // inventory_availability
  'stock.single_title': ['{sku}: {atp} available to promise', '{sku}：可承诺 {atp}'],
  'stock.single_title_unknown': ['{sku}: available to promise is not known', '{sku}：可承诺数量未知'],
  'stock.single_title_negative': ['{sku}: nothing to promise, {missing} short even with incoming receipts', '{sku}：没有可承诺数量，计入在途后仍缺 {missing}'],
  'stock.no_stock_title': ['{sku}: no stock or demand recorded', '{sku}：没有库存或需求记录'],
  'stock.no_stock_summary': ['The item exists, but no stock balance, open sales order or open purchase order includes it.', '该物料存在，但没有库存余额、未结销售订单或未结采购订单涉及它。'],
  'stock.not_read_title': ['SKU {id} is not among the stock records I read', 'SKU {id} 不在本次读取的库存记录中'],
  'stock.not_read_summary': ['Only the first {limit} stock records were read. Search the inventory list for it.', '本次只读取了前 {limit} 条库存记录，请在库存列表中搜索。'],
  'stock.not_read_summary_unknown': ['Not every stock record was read. Search the inventory list for it.', '本次没有读取全部库存记录，请在库存列表中搜索。'],
  'stock.hidden_lookup': ["Your role can't view inventory, so I can't look up {id}", '你的角色无法查看库存，因此无法查询 {id}'],
  'stock.single_summary': ['On hand {onHand}, reserved {reserved}, available {available}. Open sales demand {demand}; incoming on approved purchase orders {incoming}.', '在手 {onHand}，已预留 {reserved}，可用 {available}。未结销售需求 {demand}；审批通过的采购订单在途 {incoming}。'],
  'stock.short': ['Before incoming receipts, stock is {shortage} short of open sales orders.', '不计在途，库存比未结销售订单少 {shortage}。'],
  'stock.status': ['Stock status: {status}.', '库存状态：{status}。'],
  'stock.atp_definition': ['Available to promise is on hand plus incoming, less reservations and open demand.', '可承诺量为在手加在途，减去预留和未结需求。'],
  'stock.overview_title': ['{count} of {total} SKUs need attention', '{total} 个 SKU 中有 {count} 个需要关注'],
  'stock.overview_title_none': ['None of the {total} SKUs needs attention', '{total} 个 SKU 都不需要特别关注'],
  'stock.short_title': ['{count} SKUs are short against open sales orders', '{count} 个 SKU 无法满足未结销售订单'],
  'stock.short_title_one': ['1 SKU is short against open sales orders', '1 个 SKU 无法满足未结销售订单'],
  'stock.short_title_none': ['No SKU is short against open sales orders', '没有 SKU 无法满足未结销售订单'],
  'stock.evidence': ['ATP {atp} · available {available} · {status}', '可承诺 {atp} · 可用 {available} · {status}'],
  'stock.not_found_title': ["I couldn't find SKU {id} in this workspace", '当前工作区中找不到 SKU {id}'],
  'stock.not_found_summary': ['Check the SKU, or ask which SKUs are short.', '请核对 SKU，或询问哪些 SKU 缺货。'],
  'stock_status.out_of_stock': ['Out of stock', '缺货'],
  'stock_status.below_safety_stock': ['Below safety stock', '低于安全库存'],
  'stock_status.below_reorder_point': ['Below reorder point', '低于再订货点'],
  'stock_status.ok': ['In stock', '库存正常'],
  'stock_status.unknown': ['Unknown', '未知'],
  'stock.impact_short': ['Short against demand', '需求短缺'],
  'stock.impact_short.explanation': ['Stock and incoming receipts cannot fill every open sales order.', '现有库存和在途收货无法满足全部未结销售订单。'],
  'stock.impact_low': ['Below its stock threshold', '低于库存阈值'],
  'stock.impact_low.explanation': ['Stock is under the level set to absorb demand swings.', '库存低于用于应对需求波动的设定水平。'],
  'stock.impact_ok': ['Covered', '可满足'],
  'stock.impact_ok.explanation': ['Stock and incoming receipts cover open demand.', '库存和在途收货可满足未结需求。'],
  'stock.impact_unknown': ['Not known', '未知'],
  'stock.impact_unknown.explanation': ['Some quantities for this SKU are not recorded.', '该 SKU 的部分数量未记录。'],

  // invoice_summary
  'invoice.scope_all': ["This total is for all suppliers; I can't total one supplier's invoices yet.", '这是全部供应商的合计，暂时无法按单个供应商汇总。'],
  'invoice.title': ['Committed supplier invoices: {amounts} across {count} invoices', '已提交供应商发票：{amounts}，共 {count} 张'],
  'invoice.title_hidden': ['{count} committed supplier invoices', '已提交供应商发票 {count} 张'],
  'invoice.title_none': ['No committed supplier invoices', '没有已提交的供应商发票'],
  'invoice.title_unavailable': ['Supplier invoices are hidden for your role', '你的角色无法查看供应商发票'],
  'invoice.match': ['{matched} matched, {exception} with a match exception, {pending} awaiting match.', '已匹配 {matched} 张，匹配异常 {exception} 张，待匹配 {pending} 张。'],
  'invoice.variances': ['{count} have a variance against the order or receipt.', '其中 {count} 张与订单或收货存在差异。'],
  'invoice.variances_one': ['1 has a variance against the order or receipt.', '其中 1 张与订单或收货存在差异。'],
  'invoice.variances_none': ['None has a variance against the order or receipt.', '没有与订单或收货存在差异的发票。'],
  'invoice.evidence': ['{supplier} · {match}', '{supplier} · {match}'],
  'match.matched': ['Matched', '已匹配'],
  'match.exception': ['Match exception', '匹配异常'],
  'match.pending': ['Awaiting match', '待匹配'],
  'invoice.impact': ['Variance', '存在差异'],
  'invoice.impact.explanation': ['Review the variance with the order and receipt before payment.', '付款前请对照订单和收货复核差异。'],

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
  'followup.orders.label': ['Overdue purchase orders', '逾期采购订单'],
  'followup.orders.prompt': ['Which purchase orders are overdue?', '哪些采购订单逾期了？'],
  'followup.approvals.label': ['Waiting for approval', '待审批'],
  'followup.approvals.prompt': ['Which purchase orders are waiting for approval?', '哪些采购订单待审批？'],
  'followup.stock.label': ['Short SKUs', '缺货 SKU'],
  'followup.stock.prompt': ['Which SKUs are short against open sales orders?', '哪些 SKU 无法满足未结销售订单？'],
  'followup.invoices.label': ['Supplier invoices', '供应商发票'],
  'followup.invoices.prompt': ['What is the total of our committed supplier invoices?', '已提交的供应商发票金额是多少？'],
  'followup.rfqs.label': ['Open RFQs', '未授标询价'],
  'followup.rfqs.prompt': ['Which RFQs are still open?', '哪些询价单还没授标？'],
  'followup.suppliers.label': ['Suppliers needing attention', '需要注意的供应商'],
  'followup.suppliers.prompt': ['Which suppliers need attention?', '哪些供应商需要注意？'],
  'followup.receiving.label': ['Receiving issues', '收货问题'],
  'followup.receiving.prompt': ['Which receipts need attention?', '哪些收货单需要处理？'],

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
// With { or: true }, a choice: "a or b" / "a 还是 b".
export function aiSkillList(parts, language, { or = false } = {}) {
  const items = parts.filter(Boolean)
  if (items.length <= 1) return items.join('')
  // 和 takes a space before a number or a Latin name: 收货单和 1 张发票, ……和 Northstar.
  if (aiSkillLanguage(language) === 'zh-CN') return `${items.slice(0, -1).join('、')}${or ? ' 还是 ' : /^[0-9A-Za-z]/.test(items.at(-1)) ? '和 ' : '和'}${items.at(-1)}`
  const word = or ? 'or' : 'and'
  return items.length === 2 ? `${items[0]} ${word} ${items[1]}` : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`
}
