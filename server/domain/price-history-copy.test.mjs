import assert from 'node:assert/strict'
import test from 'node:test'
import { priceHistoryCount, priceHistoryText } from '../../src/modules/procurement/priceHistoryText.ts'

// The price history copy in both interface languages: English first, zh-CN
// through the language setting. Codes, prices and dates pass through as given.

const vsLastPo = (language) => priceHistoryText(language, 'withAverage', {
  last: priceHistoryText(language, 'vsLastPo', { price: 'USD 4.20', po: 'PO-0031', date: '2026-09-14', pct: '+7.1%' }),
  average: priceHistoryText(language, 'averageShort', { n: 3, price: 'USD 4.31' }),
})

test('a quote beside the last PO price and the average reads the same facts in both languages', () => {
  assert.equal(vsLastPo('en-US'), 'vs last PO USD 4.20 (PO-0031, 2026-09-14): +7.1%; average of 3: USD 4.31')
  assert.equal(vsLastPo('zh-CN'), '对比上次采购订单 USD 4.20（PO-0031，2026-09-14）：+7.1%；3 笔平均：USD 4.31')
  // Any other language falls back to English.
  assert.equal(vsLastPo('fr-FR'), vsLastPo('en-US'))
})

test('"not comparable" names what the earlier POs were in; an unpriced quote says so', () => {
  assert.equal(priceHistoryText('en-US', 'notComparableEarlierIn', { list: 'USD' }), 'Not comparable: earlier POs in USD')
  assert.equal(priceHistoryText('zh-CN', 'notComparableEarlierIn', { list: 'USD' }), '无法比较：以往采购订单以 USD 计')
  assert.equal(priceHistoryText('en-US', 'noQuotePrice'), 'No price quoted')
  assert.equal(priceHistoryText('zh-CN', 'noQuotePrice'), '未报价')
})

test('the average is labelled as a quantity-weighted PO price, and the note says what the prices are', () => {
  assert.equal(priceHistoryText('en-US', 'averageOf', { n: 2, price: 'USD 4.30' }), 'Average PO price of 2 (by quantity): USD 4.30')
  assert.equal(priceHistoryText('zh-CN', 'averageOf', { n: 2, price: 'USD 4.30' }), '2 笔采购订单按数量加权平均价：USD 4.30')
  assert.match(priceHistoryText('en-US', 'poPriceNote'), /not invoiced or paid prices\. Nothing is filled in/)
  assert.match(priceHistoryText('zh-CN', 'poPriceNote'), /不是发票或付款价格，不会自动填入/)
})

test('an issue date that was never recorded is told apart from a PO not issued', () => {
  assert.deepEqual(['issueDateNotRecorded', 'notIssued', 'notIssuedInFlowChain'].map((key) => priceHistoryText('en-US', key)), ['Issue date not recorded', 'Not issued yet', 'Not issued in FlowChain'])
  assert.deepEqual(['issueDateNotRecorded', 'notIssued', 'notIssuedInFlowChain'].map((key) => priceHistoryText('zh-CN', key)), ['未记录下达日期', '尚未下达', '未在 FlowChain 下达'])
  assert.equal(priceHistoryText('en-US', 'orderedNotIssued', { date: '2026-09-10' }), '2026-09-10 (ordered, not issued in FlowChain)')
})

test('the supplier note is a plain draft with a complete sign-off in each language', () => {
  const lines = priceHistoryText('en-US', 'noteLine', { item: 'LDM-001', quote: 'USD 4.50', unit: 'pcs', last: 'USD 4.20', po: 'PO-0031', date: '2026-09-14', average: priceHistoryText('en-US', 'noteAverage', { n: 3, price: 'USD 4.31' }) })
  assert.equal(lines, '- LDM-001: quoted USD 4.50 / pcs; our last PO USD 4.20 (PO-0031, 2026-09-14); average of 3: USD 4.31')
  const english = priceHistoryText('en-US', 'noteTemplate', { supplier: 'Acme', rfq: 'RFQ-0007', lines })
  assert.match(english, /^Hello Acme,\n\nThank you for your quotation for RFQ-0007\./)
  assert.ok(english.includes(`\n${lines}\n`))
  assert.ok(english.endsWith('\n\nBest regards'))
  const chinese = priceHistoryText('zh-CN', 'noteTemplate', { supplier: 'Acme', rfq: 'RFQ-0007', lines: '- LDM-001' })
  assert.match(chinese, /^Acme 您好：\n\n感谢您就 RFQ-0007 提供报价。/)
  assert.ok(chinese.endsWith('\n\n此致\n敬礼'))
})

test('counts use the singular form for 1', () => {
  assert.equal(priceHistoryCount('en-US', 'unitNotRecordedLines', 1), '1 earlier line has no unit recorded, not compared')
  assert.equal(priceHistoryCount('en-US', 'unitNotRecordedLines', 8), '8 earlier lines have no unit recorded, not compared')
  assert.equal(priceHistoryCount('zh-CN', 'unitNotRecordedLines', 8), '8 个以往采购行未记录单位，未比较')
})

test("a supplier's page says when nothing was issued to this supplier, apart from the item's own history", () => {
  assert.equal(priceHistoryText('en-US', 'noIssuedPoFromSupplier'), 'No issued PO from this supplier yet')
  assert.equal(priceHistoryText('zh-CN', 'noIssuedPoFromSupplier'), '尚无向该供应商下达的采购订单')
  assert.equal(priceHistoryText('en-US', 'noIssuedPo'), 'No issued PO for this item yet')
})
