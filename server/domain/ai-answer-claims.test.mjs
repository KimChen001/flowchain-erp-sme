import test from 'node:test'
import assert from 'node:assert/strict'
import { aiAnswerActionClaims, aiAnswerClaimsAction, aiAnswerRecordStates } from './ai-answer-claims.mjs'

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

test('a state word about a record named in the same sentence is its status when the record is in that state', () => {
  const states = aiAnswerRecordStates([
    { type: 'purchase_order', numbers: ['LOCAL-WALK-PO-021'], states: ['issued'] },
    { type: 'purchase_order', numbers: ['LOCAL-WALK-PO-022'], states: ['pending_approval'] },
    { type: 'receiving_doc', numbers: ['rd-12', 'LOCAL-WALK-GRN-012'], states: ['received', 'posted'] },
  ])
  // The record by its whole number or by its end, as answers write it.
  assert.deepEqual(aiAnswerActionClaims('Yes, PO-021 has been issued to Northstar.', states), [])
  assert.deepEqual(aiAnswerActionClaims('LOCAL-WALK-GRN-012（PO LOCAL-WALK-PO-021）拒收了 500 pcs，已过账。', states), [])
  // Not in that state, one named record not in it, or no record named.
  assert.deepEqual(aiAnswerActionClaims('PO-022 has been issued.', states), ['has been issued'])
  assert.deepEqual(aiAnswerActionClaims('PO-021 and PO-022 have been issued.', states), ['have been issued'])
  assert.deepEqual(aiAnswerActionClaims('2 笔已下达且逾期的订单。', states), ['已下达'])
  assert.deepEqual(aiAnswerActionClaims('PO-021 is late. It has been issued.', states), ['has been issued'])
  // "I" and words no status means are always claims; no states, every form.
  assert.deepEqual(aiAnswerActionClaims('I have issued PO-021.', states), ['I have issued'])
  assert.deepEqual(aiAnswerActionClaims('PO-021 was emailed to Northstar.', states), ['was emailed'])
  assert.deepEqual(aiAnswerActionClaims('PO-021 has been issued.'), ['has been issued'])
})
