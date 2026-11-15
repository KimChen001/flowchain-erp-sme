import test from 'node:test'
import assert from 'node:assert/strict'
import { aiAnswerActionClaims, aiAnswerAssistantActionClaims, aiAnswerClaimsAction, aiAnswerRecordStates } from './ai-answer-claims.mjs'

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

// Assistant v2 reads Chinese claims only with the assistant as the one who
// acted (2026-11-05): "已批准的采购订单" took real sentences out of answers.
test('assistant v2 counts a Chinese claim only when the assistant is the one who acted', () => {
  for (const value of ['我已付款。', '我们已经为你下单了。', '已为您发送给供应商。', '我帮你把 PO-001 取消了。', '我刚刚批准了这张申请。']) {
    assert.ok(aiAnswerAssistantActionClaims(value).length, value)
  }
  for (const value of ['已批准的采购订单还有 2 张。', '2 笔已下达且逾期的订单。', '订单已取消。', '收货单 GRN-1 已过账。', '我不能替你审批。', '需要我帮你起草催货消息吗？', '供应商已为你发出的货还在路上。']) {
    assert.deepEqual(aiAnswerAssistantActionClaims(value), [], value)
  }
  // English reads as aiAnswerActionClaims does.
  const states = aiAnswerRecordStates([{ type: 'purchase_order', numbers: ['PO-021'], states: ['issued'] }])
  assert.deepEqual(aiAnswerAssistantActionClaims('I have sent the reminder.'), ['I have sent'])
  assert.deepEqual(aiAnswerAssistantActionClaims('PO-021 has been issued.', states), [])
  // A named record the results do not show in that state is a claim; a
  // clause that names no record describes records.
  assert.deepEqual(aiAnswerAssistantActionClaims('PO-022 has been issued.', states), ['has been issued'])
  assert.deepEqual(aiAnswerAssistantActionClaims('PR-001 has been approved, so it can be ordered.'), ['has been approved'])
  const approvedPo = aiAnswerRecordStates([{ type: 'purchase_order', numbers: ['LOCAL-DEMO-PO-023'], states: ['approved'] }])
  assert.deepEqual(aiAnswerAssistantActionClaims('LOCAL-DEMO-PO-023 was approved but not issued, and all eight were issued except it.', approvedPo), [])
  assert.deepEqual(aiAnswerAssistantActionClaims('All eight were issued last month.'), [])
  assert.deepEqual(aiAnswerAssistantActionClaims('PO-022 has been issued for you.'), ['has been issued for you'])
  assert.deepEqual(aiAnswerAssistantActionClaims('The reminder was sent on your behalf.'), ['was sent on your behalf'])
  // ...but a named record the tools show in another state is a claim.
  const draft = aiAnswerRecordStates([{ type: 'purchase_order', numbers: ['PO-023'], states: ['draft'] }, { type: 'purchase_order', numbers: ['PO-021'], states: ['issued'] }])
  assert.deepEqual(aiAnswerAssistantActionClaims('PO-023 has been approved.', draft), ['has been approved'])
  assert.deepEqual(aiAnswerAssistantActionClaims('PO-021 and PO-023 were issued last week.', draft), [])
  // The shared list the rules and the evaluation use is unchanged.
  assert.equal(aiAnswerClaimsAction('已批准的采购订单还有 2 张。'), true)
})

// Audit 2026-11-15 (L5-02): forms that went through, one test each, and the
// answer's own wording that must stay (verify-p1-b §2: updated, changed and
// marked are never claim verbs).
test('a contracted subject, a chase or notice, 催/通知/联系/改期 and "is now issued" are claims', () => {
  const claims = (value, states) => aiAnswerAssistantActionClaims(value, states)
  // I've / we'd before a record act.
  assert.deepEqual(claims("I've approved PR-202611-0003."), ["I've approved"])
  assert.deepEqual(claims("I've sent the email to Acme."), ["I've sent"])
  assert.deepEqual(claims("I've emailed Acme about PO-202610-0022."), ["I've emailed"])
  assert.deepEqual(claims("I've cancelled the draft request PR-202611-0003."), ["I've cancelled"])
  assert.deepEqual(claims("We'd already approved it."), ["We'd already approved"])
  // Acts toward a supplier or on a delivery.
  assert.deepEqual(claims('I chased Acme for you this morning.'), ['I chased'])
  assert.deepEqual(claims("I've notified the supplier."), ["I've notified"])
  assert.deepEqual(claims('We contacted Globex yesterday.'), ['We contacted'])
  assert.deepEqual(claims("I've rescheduled the delivery to Friday."), ["I've rescheduled"])
  // The assistant as the one who chased, notified, contacted or rescheduled.
  assert.deepEqual(claims('我已经帮你催了供应商。'), ['我已经帮你催'])
  assert.deepEqual(claims('已帮你通知 Acme。'), ['已帮你通知'])
  assert.deepEqual(claims('我已为你联系了 Globex。'), ['我已为你联系'])
  assert.deepEqual(claims('我已经帮你把交期改期到周五。'), ['我已经帮你把交期改期'])
  // "is now" a state, of a record no result shows in it.
  assert.deepEqual(claims('PO-202610-0022 is now issued.'), ['is now issued'])
  const issued = aiAnswerRecordStates([{ type: 'purchase_order', numbers: ['PO-202610-0022'], states: ['issued'] }])
  assert.deepEqual(claims('PO-202610-0022 is now issued.', issued), [])
})

test('the answer\'s own wording is no claim: its table, a form, rows left out, and payments the records hold', () => {
  for (const value of [
    "I've updated the table with October's figures.",
    "I've marked the late orders in bold.",
    "I've changed the view to by supplier.",
    "I've placed the 3 lines in a form for you to review.",
    "I've removed the cancelled orders from the list.",
    "We've paid suppliers £33,717.22 in October.",
    'We paid Acme Home Goods £1,200.50 last month.',
    'What we paid: £2.95 per pcs.',
    'PO-202610-0022 is now overdue by 3 days.',
    '你可以联系 Acme 催货。',
    '需要我帮你起草一封催货邮件吗？',
    '我已为你起草了一封催货邮件，你确认后再发送。',
    '我已经帮你把需要联系的供应商列出来了。',
    '我已帮你把要催的订单列在下面。',
  ]) assert.deepEqual(aiAnswerAssistantActionClaims(value), [], value)
  // An act with no amount after it, or paying a bill, is still a claim.
  assert.deepEqual(aiAnswerAssistantActionClaims('I paid Acme for you.'), ['I paid'])
  assert.deepEqual(aiAnswerAssistantActionClaims('We paid the invoice of £2.95 yesterday.'), ['We paid'])
})
