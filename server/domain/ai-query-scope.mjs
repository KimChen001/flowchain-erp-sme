// Business mode is explicit. Even in knowledge mode, clear live-data questions use business evidence.
export function classifyQueryScope(body = {}) {
  const message = String(body.message || '').trim()
  if (body.queryMode === 'business') return 'business'
  const documentQuestion = /knowledge base|product (?:spec|manual|information|guide)|\b(?:policy|policies|handbook|manual|warranty|specification)\b|according to.*(?:document|manual|policy)|cite.*source|procedure.*follow|operating (?:temperature|voltage)|知识库|产品资料|产品规格|公司制度|操作手册|引用.*来源|根据.*资料|保修|工作(?:电压|温度)/i.test(message)
  const businessQuestion = /(?:which|show|list|how many|current|today|now).*(?:incomplete|missing data|stock|inventory|orders?|invoices?|overdue|replenish)|(?:what|which).*(?:incomplete|missing data|overdue|replenish)|(?:库存|订单|发票|供应商|数据).*(?:不完整|缺失|缺货|多少|当前|逾期|补货)|哪些.*(?:数据|订单|发票)|需要补货|data (?:quality|completeness)|incomplete (?:data|records)/i.test(message)
  return businessQuestion ? (documentQuestion ? 'mixed' : 'business') : documentQuestion || body.queryMode === 'knowledge' ? 'knowledge' : 'business'
}
