// The bilingual copy the assistant's server code still words itself: the
// answer frame, the notices that stand in for an answer, the words for left-out
// text, source names and the status labels the model reads beside each code.
// Everything else the assistant says, the model writes. Values in {braces}
// are filled with ids, names and numbers already formatted for the tenant's
// locale; the language never changes a business value, a currency or a
// number format.

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
  const signal = aiSkillQuestionLanguageSignal(message)
  return signal?.strength === 'strong' ? signal.language : aiSkillLanguage(interfaceLanguage)
}

// The language a message signals: { language, strength } or null. strong: the
// rules above decide it. weak: a short reply in one script only ("ok", "yes",
// 好, 行), which the rules leave to the interface language; assistant v2 lets
// the conversation's own language win over it (2026-11-05: a short reply in
// one language flipped the answer to the interface language). null: no
// letters at all ("100", "LDM-002 100") or an even mix.
export function aiSkillQuestionLanguageSignal(message) {
  const stripped = String(message || '').slice(0, 1200).replace(RECORD_ID, ' ').replace(/\d+/g, ' ')
  const strong = (language) => ({ language, strength: 'strong' })
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
  // A short English opener before Chinese words ("show me 85123A 的库存",
  // "Show me 华东电子的订单") says no language: the conversation's, else the
  // interface's, decides (the owner, 2026-11-12: in the Chinese interface
  // such a question is answered in Chinese; it was answered in English).
  // An English question word ("What is 茶杯 stock?") still makes it English.
  const latin = words.filter((match) => shouting || !acronym(match[0])).length
  const openersOnly = words.filter((match) => english.includes(match.index)).every((match) => !ENGLISH_QUESTION.has(match[0].toLowerCase()))
  if (english.length && !chinese.length && openersOnly && latin <= 3 && /[㐀-鿿]{2,}/u.test(stripped)) return null
  if (english.length && !chinese.length) return strong('en-US')
  if (chinese.length && !english.length) return strong('zh-CN')
  if (english.length) {
    if (CHINESE_FINAL_PARTICLE.test(stripped)) return strong('zh-CN')
    if (english.length !== chinese.length) return strong(english.length > chinese.length ? 'en-US' : 'zh-CN')
    return strong(Math.min(...english) < Math.min(...chinese) ? 'en-US' : 'zh-CN')
  }
  // No question words: "overdue POs" or "逾期订单". Chinese in two or more
  // places is Chinese wrapped around names the records write in English
  // (2026-11-07: "确认：从 Supplier of 22xxx codes (assumed) 订 60 个 Regency
  // Cakestand" was answered in English).
  if ((stripped.match(/[㐀-鿿]+/gu) || []).length >= 2) return strong('zh-CN')
  const cjkWords = (stripped.match(CJK_CHAR) || []).length / 2
  const latinWords = words.filter((match) => !acronym(match[0])).length
  if (latinWords >= 2 && latinWords > cjkWords) return strong('en-US')
  if (cjkWords >= 1 && cjkWords > latinWords) return strong('zh-CN')
  if (cjkWords > 0 && !latinWords) return { language: 'zh-CN', strength: 'weak' }
  if (latinWords > 0 && !cjkWords) return { language: 'en-US', strength: 'weak' }
  return null
}

const entries = {
  // The answer frame: where an answer came from and what it read.
  'scope.label': ['Your workspace data', '当前工作区数据'],
  'answer.source_none': ['No workspace data was read for this answer', '本次回答没有读取工作区数据'],
  'answer.source_assistant_v2': ['Written by AI from your records', '由 AI 根据你的记录撰写'],
  'answer.checked': ['Checked: {sources}', '已检查：{sources}'],
  'nav.open': ['Open {id}', '打开 {id}'],
  // Assistant v2: notices, and the words that stand in for text left out.
  'assistant_v2.replace.action_claim': ['This part of the answer is not shown because it read as if something had been done for you. The assistant changes nothing: open the record to see its status and act there.', '这部分回答读起来像是已替你执行了操作，因此不显示。助手不会修改任何内容：请打开相关记录查看状态，并在那里操作。'],
  'assistant_v2.replace.withheld': ['[not shown]', '[不显示]'],
  'assistant_v2.replace.action_claim_sentence': ['(A sentence is left out here because it read as if something had been done for you. Open the record to see its status.)', '（此处略去一句：它读起来像是已替你执行了操作。请打开记录查看状态。）'],
  'assistant_v2.notice.injection_refused': ['This question asks the assistant to ignore its rules, so it was not answered.', '该问题要求助手忽略它的规则，因此没有回答。'],
  'assistant_v2.notice.rate_limited': ['You have asked many questions in a short time. Wait a few minutes, then ask again.', '短时间内提问较多，请几分钟后再问。'],
  'assistant_v2.notice.unavailable': ['The assistant is not available right now. Try again in a few minutes. Nothing was changed.', '助手暂时不可用，请几分钟后再试。未修改任何数据。'],
  'assistant_v2.notice.over_cap': ['This workspace has used this month\'s assistant allowance. An administrator can see the spend in Settings > AI.', '本工作区本月的助手额度已用完。管理员可以在 设置 > AI 中查看用量。'],
  'assistant_v2.notice.ai_off': ['AI is off for this workspace. A workspace administrator can switch it on in Settings > AI.', '此工作区未开启 AI。工作区管理员可以在 设置 > AI 中开启。'],
  'assistant_v2.notice.no_provider': ['The assistant is not set up on this server yet.', '此服务器尚未配置 AI 助手。'],
  // What each source is called in a "Checked:" line.
  'source.purchase_orders': ['purchase orders', '采购订单'],
  'source.purchase_requests': ['purchase requests', '采购申请'],
  'source.rfqs': ['RFQs', '询价单'],
  'source.inventory': ['inventory balances', '库存余额'],
  'source.supplier_invoices': ['supplier invoices', '采购发票'],
  'source.receipts': ['receipts', '收货单'],
  'source.items': ['items', '物料'],
  'source.suppliers': ['suppliers', '供应商'],
  'source.sales_orders': ['sales orders', '销售订单'],
  'source.documents': ['documents', '文档'],
  'source.contracts': ['contracts', '合同'],
  'source.supplier_risks': ['supplier risks', '供应商风险'],
  'source.workspace': ['workspace records', '工作区记录'],
  // The answer's sources line only.
  'source.receivables': ['receivables', '应收账款'],
  'source.overview': ['the business overview', '业务概况'],
  'source.payables': ['payables', '应付账款'],
  'source.payments': ['recorded payments', '收付款记录'],
  'source.gross_profit': ['customer invoices and reference prices', '客户发票和参考价'],
  // Status labels the model reads beside the codes (statusLabel).
  'po_status.draft': ['Draft', '草稿'],
  'po_status.pending_approval': ['Waiting for approval', '待审批'],
  'po_status.approved': ['Approved, not yet issued', '已批准，待下达'],
  'po_status.issued': ['Issued to the supplier', '已下达'],
  'po_status.partially_received': ['Partially received', '部分收货'],
  'po_status.fully_received': ['Fully received', '全部收货'],
  'po_status.closed': ['Closed', '关闭'],
  'po_status.cancelled': ['Cancelled', '已取消'],
  'po_status.rejected': ['Rejected', '已驳回'],
  'po_status.other': ['Status {status}', '{status}'],
  'stock_status.out_of_stock': ['Out of stock', '缺货'],
  'stock_status.below_safety_stock': ['Below safety stock', '低于安全库存'],
  'stock_status.below_reorder_point': ['Below reorder point', '低于再订货点'],
  'stock_status.ok': ['In stock', '库存正常'],
  'stock_status.unknown': ['Unknown', '未知'],
  'match.matched': ['Matched', '已匹配'],
  'match.exception': ['Match exception', '匹配异常'],
  'match.pending': ['Awaiting match', '待匹配'],
}

export const AI_SKILL_COPY = Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, [en, zh]]) => [key, Object.freeze({ en, zh })])))

// Fills {name} placeholders. A missing value renders as an empty string, never
// as the placeholder or "undefined".
// A value that ends with its own period ("Acme Valve Co.") stands in for the
// template's period after it, so a sentence never ends "Co..".
function fill(template, values = {}) {
  return template.replace(/\{(\w+)\}(\.?)/g, (_, name, dot) => {
    const value = values[name] === undefined || values[name] === null ? '' : String(values[name])
    return value + (dot && value.endsWith('.') ? '' : dot)
  })
}

export function aiSkillText(key, language, values) {
  const entry = AI_SKILL_COPY[key]
  if (!entry) throw Object.assign(new Error(`Unknown AI skill copy key: ${key}`), { code: 'AI_SKILL_COPY_KEY_UNKNOWN' })
  if (aiSkillLanguage(language) !== 'zh-CN') return fill(entry.en, values)
  // A Chinese unit word ends its quantity: "仍有 300 箱未交", not "300 箱 未交".
  return fill(entry.zh, values).replace(ZH_UNIT_GAP, '$1')
}

// Unit labels for the unit codes items and order lines store, as [one, many,
// Chinese]: "1 box", "300 boxes", "300 箱". Only the label changes; the stored
// code stays the record's value. A unit not listed is shown as stored.
const UNIT_LABELS = (() => {
  const labels = {}
  const add = (codes, entry) => { for (const code of codes) labels[code] = entry }
  add(['pcs', 'pc', 'piece', 'pieces'], ['pcs', 'pcs', '件'])
  add(['ea', 'each'], ['ea', 'ea', '个'])
  add(['unit', 'units'], ['unit', 'units', '个'])
  add(['box', 'boxes'], ['box', 'boxes', '箱'])
  add(['case', 'cases'], ['case', 'cases', '箱'])
  add(['carton', 'cartons', 'ctn'], ['carton', 'cartons', '箱'])
  add(['roll', 'rolls'], ['roll', 'rolls', '卷'])
  add(['ft', 'foot', 'feet'], ['ft', 'ft', '英尺'])
  add(['m', 'meter', 'meters', 'metre', 'metres'], ['m', 'm', '米'])
  add(['kg', 'kgs'], ['kg', 'kg', '千克'])
  add(['set', 'sets'], ['set', 'sets', '套'])
  add(['pack', 'packs', 'pk'], ['pack', 'packs', '包'])
  add(['bag', 'bags'], ['bag', 'bags', '袋'])
  add(['pair', 'pairs'], ['pair', 'pairs', '双'])
  add(['pallet', 'pallets'], ['pallet', 'pallets', '托'])
  add(['sheet', 'sheets'], ['sheet', 'sheets', '张'])
  return Object.freeze(labels)
})()
const ZH_UNIT_WORDS = [...new Set(Object.values(UNIT_LABELS).map((entry) => entry[2]))]
const ZH_UNIT_GAP = new RegExp(`(\\d (?:${ZH_UNIT_WORDS.join('|')})) (?=[㐀-鿿])`, 'gu')

export function aiSkillUnitLabel(unit, language, quantity) {
  const code = String(unit ?? '').trim()
  const entry = UNIT_LABELS[code.toLowerCase()]
  if (!entry) return code
  if (aiSkillLanguage(language) === 'zh-CN') return entry[2]
  return Number(quantity) === 1 ? entry[0] : entry[1]
}

// A list of already localized parts: "a, b and c" / "a、b 和 c".
// With { or: true }, a choice: "a or b" / "a 还是 b".
export function aiSkillList(parts, language, { or = false } = {}) {
  const items = parts.filter(Boolean)
  if (items.length <= 1) return items.join('')
  // 和 takes a space next to a number or a Latin name: 收货单和 1 张发票,
  // ……和 Northstar, PO-001 和 PO-008.
  if (aiSkillLanguage(language) === 'zh-CN') {
    const head = items.slice(0, -1).join('、')
    const last = items.at(-1)
    if (or) return `${head} 还是 ${last}`
    return `${head}${/[0-9A-Za-z)%.]$/.test(head) ? ' ' : ''}和${/^[0-9A-Za-z$€£¥]/.test(last) ? ' ' : ''}${last}`
  }
  const word = or ? 'or' : 'and'
  return items.length === 2 ? `${items[0]} ${word} ${items[1]}` : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`
}
