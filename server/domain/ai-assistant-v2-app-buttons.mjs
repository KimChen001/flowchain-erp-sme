// The buttons an answer may name, as the app labels them (English source and
// its Chinese translation), by where they are. The prompt lists them, and a
// button an answer names that is not among them is flagged like a figure no
// result holds (2026-11-12: answers sent users to the "cancel action" of an
// issued order, which has only Close PO, and to 催货 and 改期 buttons that do
// not exist; a survey of published agent guidance found no such check). Keep
// these in step with the labels in the app's copy:
//   the request form and record cards in chat   src/i18n/I18n.tsx (ai.v2.form.*, ai.v2.actions.button.*)
//   a purchase order's page                     src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx, PurchaseOrderPromiseDates.tsx
//   the receiving form                          src/modules/procurement/ReceivingForm.tsx
//   decision cards on Today                     src/modules/overview/decisionCopy.ts
export const ASSISTANT_APP_BUTTONS = Object.freeze([
  { where: 'the request form in chat', buttons: [['Create draft request', '创建草稿申请'], ['Submit for approval', '提交审批'], ['Cancel draft', '取消草稿'], ['Cancel request', '取消申请'], ['Withdraw', '撤回']] },
  { where: 'the card on a request or an order in chat', buttons: [['Approve', '批准'], ['Reject', '驳回'], ['Create purchase order', '生成采购订单'], ['Request quotes (RFQ)', '发起询价'], ['Mark as issued', '标记为已下达']] },
  { where: 'a purchase order\'s page', buttons: [['Submit for approval', '提交审批'], ['Approve', '批准'], ['Reject', '驳回'], ['Mark as issued', '标记为已下达'], ['Cancel PO', '取消采购订单'], ['Close PO', '关闭采购订单'], ['Change promised date', '修改承诺交期'], ['Save revision', '保存修改'], ['Receive', '收货']] },
  { where: 'the receiving form', buttons: [['Save draft', '保存草稿'], ['Save and submit', '保存并提交']] },
  { where: 'a decision card on Today', buttons: [['Review and create the request', '核对并创建申请'], ['Copy and mark chased', '复制并记为已催'], ['Review and send', '核对并发送'], ['Create the purchase orders', '生成采购订单'], ['Open the request', '打开申请'], ['Not now', '以后再说'], ['Not needed', '不需要'], ['Reopen', '重新打开']] },
])

// The prompt's line: every button with both labels, by where it is.
export const assistantAppButtonsLine = () => `- The buttons the app has, by where they are (English / 中文): ${ASSISTANT_APP_BUTTONS.map((group) => `${group.where}: ${group.buttons.map(([en, zh]) => `${en} / ${zh}`).join(', ')}`).join('; ')}. Name a button only from this list, with its label in answerLanguage exactly as written here; describe any other step without a button name.`

// A label as compared: NFKC, lower case, no quotes, stars or spaces, and no
// count of lines after it ("Create draft request (2 lines)", 创建草稿申请（1 行）).
const normal = (label) => String(label ?? '').normalize('NFKC').toLowerCase()
  .replace(/\(\s*\d+\s*(?:lines?|行)\s*\)\s*$/u, '')
  .replace(/[\s"'“”‘’「」『』*_.,:;!?。，：；！？]+/gu, '')
const KNOWN = new Set(ASSISTANT_APP_BUTTONS.flatMap((group) => group.buttons.flat()).map(normal))
const known = (label) => {
  if (KNOWN.has(normal(label))) return true
  // Both labels given together: 修改承诺交期（Change promised date）, Close PO / 关闭采购订单.
  const parts = String(label).normalize('NFKC').split(/[()（）/]/u).map((part) => part.trim()).filter(Boolean)
  return parts.length > 1 && parts.every((part) => KNOWN.has(normal(part)))
}

// Where a text names a button: after click, press, tap or hit (点击, 按下,
// 点 after 再, 然后, 请 and the like; 按 alone is "by", as in 按“到期日”排序)
// in quotes or bold; or in quotes or bold before "button" (按钮, 操作).
const QUOTED = String.raw`(?:\*\*|__|["“'‘「『])([^*_"”'’」』\n]{1,60}?)(?:\*\*|__|["”'’」』])`
const NAMED = [
  new RegExp(String.raw`\b(?:click|clicking|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?${QUOTED}`, 'giu'),
  new RegExp(String.raw`(?:点击|点一下|按下|(?<=^|[再并请就先后以接你和或、，,\s])点)\s*${QUOTED}`, 'gu'),
  new RegExp(String.raw`${QUOTED}\s*(?:button|按钮|操作)`, 'giu'),
]

// The button names in a text that the app does not have, each once, as
// written.
export function unknownAppButtons(text) {
  const value = String(text ?? '').normalize('NFKC')
  const found = []
  for (const pattern of NAMED) {
    for (const match of value.matchAll(pattern)) {
      const label = match[1].trim()
      if (!label || /\d{3,}|PO-|PR-|SO-/i.test(label) || known(label) || found.includes(label)) continue
      found.push(label)
    }
  }
  return found
}
