import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyQueryScope } from './ai-query-scope.mjs'

const cases = {
  business: ['哪些数据不完整?', '哪些数据依据不完整?', '当前库存多少?', '哪些订单逾期?', '发票数据缺失', '供应商数据不完整', 'Which records are incomplete?', 'Show current inventory', 'List overdue purchase orders', 'How many invoices are overdue?', 'Which items need replenishment?', 'Check data completeness'],
  knowledge: ['What is the warranty for LDM-001?', 'Explain the product specification', 'What inventory policy applies?', 'Company handbook', 'Product guide for LDM-001', 'What is the operating voltage?', '产品资料 LDM-001', '产品规格是什么?', '公司制度', '操作手册', 'LDM-001 保修多久?', '工作温度范围'],
  mixed: ['Which items need replenishment according to company policy?', 'List overdue invoices and cite the policy sources', 'Show current inventory and the product guide', '哪些订单逾期，根据公司制度如何处理?', '哪些数据不完整，根据资料解释要求', '哪些发票逾期，引用知识库来源'],
}
for (const [scope, questions] of Object.entries(cases)) {
  test(`routes ${scope} questions in automatic mode`, () => {
    for (const message of questions) assert.equal(classifyQueryScope({ message, queryMode: 'auto' }), scope, message)
  })
}
test('product ratings and policy rules go to documents; records named with their state go to business data', () => {
  const knowledge = ['Can ZX-PRO-SENSOR-100 operate at 70 degrees Celsius?', 'Our room reaches seventy degrees C. Is the ZX-PRO-SENSOR-100 suitable?', 'ZX-PRO-SENSOR-100 在七十摄氏度下可以用吗？', 'What voltage does ZX-PRO-SENSOR-200 need?', 'Is ZX-PRO-SENSOR-100 certified for food-contact use?', 'Can we automatically replace ZX-PRO-SENSOR-100 with model 200?', 'A PO line has no promised date. Should I call it overdue?', 'When should I escalate a supplier follow-up?', 'The invoice total is lower than the PO total. Is that necessarily a price variance?', 'Can I record a supplier invoice before receiving the goods?', '没有承诺日期的采购行算不算逾期？']
  for (const message of knowledge) assert.equal(classifyQueryScope({ message, queryMode: 'auto' }), 'knowledge', message)
  // Records and the policy together: business data first, the policy alongside.
  assert.equal(classifyQueryScope({ message: "Check Acme's outstanding orders, explain which need follow-up under our purchasing policy, and prepare a message asking about partial delivery.", queryMode: 'auto' }), 'mixed')
  assert.equal(classifyQueryScope({ message: 'Show open POs for Acme', queryMode: 'auto' }), 'business')
  assert.equal(classifyQueryScope({ message: '逾期的采购单，按政策该怎么跟进？', queryMode: 'auto' }), 'mixed')
  // Item names that contain a product word stay business questions.
  for (const message of ['How much stock of the Temperature Sensor do we have?', '温度传感器库存多少?', 'Which POs should I chase first?']) assert.equal(classifyQueryScope({ message, queryMode: 'auto' }), 'business', message)
})
test('live-data questions escape a stale knowledge selection; explicit business stays business', () => {
  assert.equal(classifyQueryScope({ message: '哪些数据不完整?', queryMode: 'knowledge' }), 'business')
  assert.equal(classifyQueryScope({ message: 'Zephyr', queryMode: 'knowledge' }), 'knowledge')
  assert.equal(classifyQueryScope({ message: 'What is the warranty?', queryMode: 'business' }), 'business')
})
