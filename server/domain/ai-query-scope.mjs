// Product facts that live in documents: ratings, certification, compatibility.
// Bare "temperature" and 温度 are left out: they are part of item names
// ("Temperature Sensor", 温度传感器), and stock questions about those items are business questions.
const PRODUCT_DOCUMENT = /\b(?:degrees?|celsius|fahrenheit|voltage|volts?|certif(?:ied|ication|icate)s?|food[- ]contact|compatib(?:le|ility)|interchangeab(?:le|ility)|substitut(?:e|es|ed|ion|ing)|datasheets?|data sheets?)\b|°\s?[cf]\b|℃|\breplace\b.*\bwith\b|摄氏度|电压|认证|兼容|互换|替换|替代|代替|耐温/i
// Questions about what the rules say rather than about records.
const POLICY_QUESTION = /\b(?:should (?:i|we) (?:call|treat|label|mark|consider) (?:it|this|that|them)|when should (?:i|we) (?:escalate|follow[- ]?up|chase|remind)|is (?:that|it|this) (?:necessarily|required|allowed|mandatory)|(?:can|may) (?:i|we) (?:record|post|enter)\b.*\bbefore)\b|该不该|是否(?:应该|必须)|算不算|按(?:规定|政策|制度)|(?:什么时候|何时)(?:应该|需要)(?:升级|跟进|催)/i
// Records named together with their state: "Acme's outstanding orders", 逾期的采购单.
const RECORDS_IN_STATE = /\b(?:outstanding|open|overdue|late|pending|unpaid|undelivered)\s+(?:purchase\s+)?(?:orders?|pos?|invoices?|deliver(?:y|ies)|receipts?|rfqs?)\b|(?:未完成|未交|未到|在途|逾期|待收|未付)的?(?:订单|采购单|采购订单|发票|交货|收货)/i

// Business mode is explicit. Even in knowledge mode, clear live-data questions use business evidence.
export function classifyQueryScope(body = {}) {
  const message = String(body.message || '').trim()
  if (body.queryMode === 'business') return 'business'
  const documentQuestion = /knowledge base|product (?:spec|manual|information|guide)|\b(?:policy|policies|handbook|manual|warranty|specification)\b|according to.*(?:document|manual|policy)|cite.*source|procedure.*follow|operating (?:temperature|voltage)|知识库|产品资料|产品规格|公司制度|操作手册|引用.*来源|根据.*资料|保修|工作(?:电压|温度)/i.test(message) || PRODUCT_DOCUMENT.test(message) || POLICY_QUESTION.test(message)
  const businessQuestion = /(?:which|show|list|how many|current|today|now).*(?:incomplete|missing data|stock|inventory|orders?|invoices?|overdue|replenish)|(?:what|which).*(?:incomplete|missing data|overdue|replenish)|(?:库存|订单|发票|供应商|数据).*(?:不完整|缺失|缺货|多少|当前|逾期|补货)|哪些.*(?:数据|订单|发票)|需要补货|data (?:quality|completeness)|incomplete (?:data|records)/i.test(message) || RECORDS_IN_STATE.test(message)
  return businessQuestion ? (documentQuestion ? 'mixed' : 'business') : documentQuestion || body.queryMode === 'knowledge' ? 'knowledge' : 'business'
}
