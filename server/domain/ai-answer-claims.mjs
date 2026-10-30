// Wording that claims the assistant acted: "I approved", "was paid", 已下达.
// One list for the server's answer validator and the assistant evaluation, so
// the server refuses to send exactly what the evaluation flags. A status
// label states a record's state ("Approved, not yet issued", 审批通过) and
// never uses these forms. A Chinese state word right after a status label
// (状态：已过账, 过账状态：已过账, 当前状态是已取消, 状态为已批准) is that status too
// (the owner's decision of 2026-10-30); the same word anywhere else reads as
// an action ("收货单已过账", "我已付款").
export const AI_ANSWER_ACTION_CLAIMS = Object.freeze([
  /\b(I|we)\s+(have\s+|had\s+|just\s+|already\s+)?(sent|emailed|approved|paid|issued|placed|posted|cancelled|canceled|deleted|removed)\b/i,
  /\b(was|were|has been|have been)\s+(sent|emailed|approved|paid|issued|placed|posted|cancelled|canceled|deleted|removed)\b/i,
  /(?<!状态\s*(?:[：:]|是|为)?\s*)(?:已发送|已批准|已付款|已支付|已下单|已下达|已过账|已删除|已取消)/,
])

export function aiAnswerClaimsAction(value) {
  const text = String(value ?? '')
  return AI_ANSWER_ACTION_CLAIMS.some((pattern) => pattern.test(text))
}
