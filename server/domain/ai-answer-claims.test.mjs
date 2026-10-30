import test from 'node:test'
import assert from 'node:assert/strict'
import { aiAnswerClaimsAction } from './ai-answer-claims.mjs'

test('a claim of acting is flagged in either language', () => {
  for (const value of ['I have sent the reminder to Acme Components.', 'We approved PO-024.', 'PO-001 was paid on Oct 3.', 'The invoice has been posted.', '收货单 GRN-1 已过账。', '我已付款。', '订单已取消。', 'PO-1 已下达给供应商。', '（已过账）', '状态：过账完成，我已付款。']) {
    assert.equal(aiAnswerClaimsAction(value), true, value)
  }
})

test('a Chinese state word right after a status label is a status, not a claim', () => {
  for (const value of ['状态：已过账', '收货单 GRN-012 过账状态：已过账。', 'PO-030 当前状态是已取消。', '审批状态为已批准', '收货单状态已过账。', '状态: 已下达', 'Status: posted', '状态：审批通过，未过账。']) {
    assert.equal(aiAnswerClaimsAction(value), false, value)
  }
})
