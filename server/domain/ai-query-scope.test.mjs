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
test('live-data questions escape a stale knowledge selection; explicit business stays business', () => {
  assert.equal(classifyQueryScope({ message: '哪些数据不完整?', queryMode: 'knowledge' }), 'business')
  assert.equal(classifyQueryScope({ message: 'Zephyr', queryMode: 'knowledge' }), 'knowledge')
  assert.equal(classifyQueryScope({ message: 'What is the warranty?', queryMode: 'business' }), 'business')
})
