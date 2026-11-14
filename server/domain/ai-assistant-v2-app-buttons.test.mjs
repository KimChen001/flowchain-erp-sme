import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ASSISTANT_APP_BUTTONS, assistantAppButtonsLine, unknownAppButtons } from './ai-assistant-v2-app-buttons.mjs'

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

test('the prompt lists every button with both labels, and the labels are the app\'s own', () => {
  const line = assistantAppButtonsLine()
  for (const group of ASSISTANT_APP_BUTTONS) for (const [en, zh] of group.buttons) assert.ok(line.includes(`${en} / ${zh}`), en)
  // Each label is in the app's copy, so a renamed button fails here first.
  const copy = ['src/i18n/I18n.tsx', 'src/modules/purchasing/components/PurchaseOrderWorkflowActions.tsx', 'src/modules/purchasing/components/PurchaseOrderPromiseDates.tsx', 'src/modules/procurement/ReceivingForm.tsx', 'src/modules/overview/decisionCopy.ts', 'src/modules/finance/SupplierInvoiceScreens.tsx']
    .map((file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')).join('\n')
  for (const group of ASSISTANT_APP_BUTTONS) for (const label of group.buttons.flat()) assert.ok(copy.includes(`"${label}`), `${label} is not in the app's copy`)
})
