import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ASSISTANT_APP_BUTTONS, assistantAppButtonsLine, unknownAppButtons } from './ai-assistant-v2-app-buttons.mjs'
import { RECORD_ACTION_RULES } from '../../shared/assistant-record-actions.mjs'

// 2026-11-12: answers sent users to a "cancel action" an issued order does not
// have, and to 催货 and 改期 buttons that do not exist.
test('a button an answer names is checked against the buttons the app has', () => {
  assert.deepEqual(unknownAppButtons('Review the lines, then click **Create draft request**.'), [])
  assert.deepEqual(unknownAppButtons('Click **Create draft request (2 lines)** when ready.'), [])
  assert.deepEqual(unknownAppButtons('请勾选后点击“创建草稿申请（1 行）”。'), [])
  assert.deepEqual(unknownAppButtons('open PO-202610-0023 and click **Close PO**; the **Change promised date** button needs a reason.'), [])
  assert.deepEqual(unknownAppButtons('在订单页面点击“修改承诺交期（Change promised date）”。'), [])
  assert.deepEqual(unknownAppButtons('On Today, use **Copy and mark chased** or click "Review and send".'), [])
  assert.deepEqual(unknownAppButtons('Open PO-202610-0023 and click **Cancel order**.'), ['Cancel order'])
  assert.deepEqual(unknownAppButtons('需要使用系统里的“催货”或“改期”操作。'), ['改期'])
  assert.deepEqual(unknownAppButtons('点击“催货”按钮，再点“催货”。'), ['催货'])
  assert.deepEqual(unknownAppButtons('在订单页面用“更改承诺交期”按钮修改。'), ['更改承诺交期'])
  // Pages, record numbers and words in quotes that name no button are left alone.
  assert.deepEqual(unknownAppButtons('Use the **reorder list** and open "PO-202610-0023".'), [])
  assert.deepEqual(unknownAppButtons('This is **not** urgent: 132 pcs are “available”.'), [])
  // 按 alone is "by"; 点 counts after 然后, 再 and the like.
  assert.deepEqual(unknownAppButtons('按“逾期天数”排序，这是重点“关注”的一张。'), [])
  assert.deepEqual(unknownAppButtons('然后点“提交审批”，再点“催货”。'), ['催货'])
})

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
// Every double-quoted string of a source file.
const quoted = (file) => [...read(file).matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((match) => match[1])
// The app's I18n copy: [English, Chinese] of a key.
function i18nCopy() {
  const text = read('src/i18n/I18n.tsx')
  const at = text.indexOf('\nconst en')
  const entries = (part) => new Map([...part.matchAll(/^\s*"([\w.-]+)": "((?:[^"\\]|\\.)*)",?\s*$/gm)].map((match) => [match[1], JSON.parse(`"${match[2]}"`)]))
  const zh = entries(text.slice(0, at))
  const en = entries(text.slice(at))
  return { pair: (key) => [en.get(key), zh.get(key)], keys: (prefix) => [...en.keys()].filter((key) => key.startsWith(prefix)) }
}

// The labels each place shows now, read from the screens that draw them. The
// chat record card draws only the steps RECORD_ACTION_RULES offers, so a
// label whose step left the card (Request quotes (RFQ), design audit A7)
// is not among them even while its I18n key remains.
function labelsOnScreen() {
  const copy = i18nCopy()
  // "Create draft request ({count} lines)" is named without its count.
  const withoutCount = (label) => String(label).replace(/\s*[(（]\{count\}[^)）]*[)）]$/u, '')
  const card = Object.entries(RECORD_ACTION_RULES).flatMap(([type, steps]) => Object.keys(steps).flatMap((step) => copy.pair(`ai.v2.actions.button.${type}.${step}`)))
  return new Map([
    ['the request form in chat', copy.keys('ai.v2.form.').flatMap((key) => copy.pair(key)).map(withoutCount)],
    ['a request or order card in chat', card],
    ['a purchase order\'s page', [...quoted('src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx'), ...quoted('src/modules/purchasing/components/PurchaseOrderPromiseDates.tsx')]],
    ['the receiving form', quoted('src/modules/procurement/ReceivingForm.tsx')],
    ['a decision card on Today', quoted('src/modules/overview/decisionCopy.ts')],
    ['a supplier invoice\'s page', [...quoted('src/modules/finance/SupplierInvoiceScreens.tsx'), ...copy.keys('finance.action.').flatMap((key) => copy.pair(key))]],
  ].map(([where, labels]) => [where, new Set(labels.filter(Boolean))]))
}

test('the prompt lists every button with both labels, and each label is on the screen it names', () => {
  const line = assistantAppButtonsLine()
  for (const group of ASSISTANT_APP_BUTTONS) for (const [en, zh] of group.buttons) assert.ok(line.includes(`${en} / ${zh}`), en)
  // Each label is drawn where the group says, so a renamed or removed
  // button fails here first.
  const screens = labelsOnScreen()
  for (const group of ASSISTANT_APP_BUTTONS) {
    const shown = screens.get(group.where)
    assert.ok(shown, `no screen is read for "${group.where}"`)
    for (const label of group.buttons.flat()) assert.ok(shown.has(label), `${label} is not on ${group.where}`)
  }
})

test('the record card offers no RFQ, and the three-way match buttons of a supplier invoice are known (design audit A7, B2)', () => {
  const labels = ASSISTANT_APP_BUTTONS.flatMap((group) => group.buttons.flat())
  assert.ok(!labels.includes('Request quotes (RFQ)') && !labels.includes('发起询价'))
  assert.deepEqual(unknownAppButtons('On the request card, click **Request quotes (RFQ)**.'), ['Request quotes (RFQ)'])
  const invoice = ASSISTANT_APP_BUTTONS.find((group) => group.where === 'a supplier invoice\'s page').buttons
  assert.deepEqual(invoice, [['Match', '匹配'], ['Match again', '重新匹配'], ['Approve difference', '批准差异'], ['Reject difference', '驳回差异'], ['Accept at received quantity', '按实收数量接受']])
  assert.deepEqual(unknownAppButtons('Wait for the goods and click **Match again**, or click **Accept at received quantity**.'), [])
  assert.deepEqual(unknownAppButtons('请点击“按实收数量接受”，或收货后点“重新匹配”。'), [])
})
