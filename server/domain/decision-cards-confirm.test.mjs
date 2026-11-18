import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Design audit 2026-11-15 (L5-13): the assistant's record card asks for a
// second, inline click before it turns an approved request into purchase
// orders; the same step on Today's card made them in one click. Today's
// card now asks too, in English and Chinese.

const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const cards = source('src/modules/overview/DecisionCards.tsx')
const copy = source('src/modules/overview/decisionCopy.ts')

test('turning a request into orders on Today takes a second, inline click, as in the assistant\'s card', () => {
  const body = cards.slice(cards.indexOf('function ConversionBody('), cards.indexOf('\n}\n', cards.indexOf('function ConversionBody(')))
  // The first click opens the card and only asks (L11-05: the card then says
  // what it will create); Confirm creates; Cancel goes back.
  assert.match(body, /onClick=\{\(\) => \{ onOpen\(\); setConfirming\(true\); \}\} data-testid="decision-create-orders">\{t\("createOrders"\)\}/)
  assert.match(body, /disabled=\{busy \|\| !checked\} className=\{BUTTON\.primary\} onClick=\{onCreate\} data-testid="decision-primary">\{busy \? t\("creating"\) : t\("confirmCreate"\)\}/)
  assert.match(body, /onClick=\{\(\) => setConfirming\(false\)\}>\{t\("cancel"\)\}/)
  assert.equal((body.match(/onClick=\{onCreate\}/g) || []).length, 1)
  for (const line of [
    'confirmCreateApproved: "Create {n} approved purchase orders from this request?"',
    'confirmCreateApprovedOne: "Create 1 approved purchase order from this request?"',
    'confirmCreateApproved: "确认由此申请生成 {n} 张已批准的采购订单？"',
    'confirmCreateApprovedOne: "确认由此申请生成 1 张已批准的采购订单？"',
    'confirmCreateDraft: "Create {n} draft purchase orders from this request?"',
    'confirmCreateDraft: "确认由此申请生成 {n} 张采购订单草稿？"',
  ]) assert.ok(copy.includes(line), line)
})

// Design audit L11-05: before the second click the card says what it will
// create, read from the purchase-order preview: approved orders (D3) or
// drafts when the workspace turns that off, each line, and what refuses them.
test('the card says it will create approved orders, and lists each line, before Confirm (L11-05)', () => {
  const body = cards.slice(cards.indexOf('function ConversionBody('), cards.indexOf('\n}\n', cards.indexOf('function ConversionBody(')))
  assert.match(cards, /apiJson<OrderPreview>\(`\/api\/procurement\/requests\/\$\{encodeURIComponent\(requestId\)\}\/purchase-order-preview`\)/)
  // Read only when the card is open, so Today's list reads nothing more.
  assert.match(body, /useOrderPreview\(draft\.purchaseRequestId, draft\.version, open && canDecide, t\.language\)/)
  assert.match(body, /t\.count\(approved \? "willCreateApproved" : "willCreateDraft", plan\.orders\.length\)/)
  assert.match(body, /data-testid="decision-order-line">\{t\("previewLine"/)
  for (const line of [
    'willCreateApproved: "Will create {n} approved purchase orders"',
    'willCreateApproved: "将生成 {n} 张已批准的采购订单"',
    'willCreateDraft: "Will create {n} draft purchase orders"',
    'willCreateDraft: "将生成 {n} 张采购订单草稿"',
  ]) assert.ok(copy.includes(line), line)
  // The design note says what D3 does (DD-3 reworded 2026-11-17).
  const design = source('docs/drafted-decisions-design.md')
  assert.ok(design.includes('**DD-3 reworded 2026-11-17**'))
  assert.doesNotMatch(design, /Create draft documents, record a promised date/)
  assert.match(source('scripts/run-product-recovery-playwright.mjs'), /"tests\/browser\/today-conversion-card\.spec\.ts"/)
})
