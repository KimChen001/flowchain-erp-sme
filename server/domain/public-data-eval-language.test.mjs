import test from 'node:test'
import assert from 'node:assert/strict'
import { answerLanguage } from '../../tests/ai-eval/v2-public/score.mjs'

test('the question set reads an answer\'s language without counting the English names it cites', () => {
  // The 2026-11-13 answer to 有哪些采购订单逾期了？, scored English before.
  const chinese = '目前有 3 张采购订单逾期，最早的是 PO-202610-0022，已逾期 9 天。\n这 3 张订单涉及 2 家供应商：Acme Home Goods 有 2 张（85023A 的 White Hanging Heart T-Light Holder），Globex Party Supplies 有 1 张（84879 的 Assorted Colour Bird Ornament）。PO-202610-0022 已部分收货 120 件，还有 120 件未到。'
  assert.equal(answerLanguage(chinese), 'zh-CN')
  // English prose stays English, names or not, and a Chinese name in it does not change that.
  assert.equal(answerLanguage('Three purchase orders are overdue; PO-202610-0022 from Acme Home Goods is the oldest, 9 days late.'), 'en-US')
  assert.equal(answerLanguage('Show the late orders from 华东电子, the oldest first.'), 'en-US')
  assert.equal(answerLanguage('PO-202610-0022 Acme Home Goods'), 'en-US')
  // Chinese prose with a few English words is Chinese; English prose with a Chinese phrase is English.
  assert.equal(answerLanguage('这张订单的 status 还是 issued，供应商还没有发货。'), 'zh-CN')
})
