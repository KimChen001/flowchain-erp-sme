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
  // The first click only asks; Confirm creates; Cancel goes back.
  assert.match(body, /onClick=\{\(\) => setConfirming\(true\)\} data-testid="decision-create-orders">\{t\("createOrders"\)\}/)
  assert.match(body, /onClick=\{onCreate\} data-testid="decision-primary">\{busy \? t\("creating"\) : t\("confirmCreate"\)\}/)
  assert.match(body, /onClick=\{\(\) => setConfirming\(false\)\}>\{t\("cancel"\)\}/)
  assert.equal((body.match(/onClick=\{onCreate\}/g) || []).length, 1)
  for (const line of [
    'confirmCreateOrders: "Create {n} purchase orders from this request?"',
    'confirmCreateOrdersOne: "Create 1 purchase order from this request?"',
    'confirmCreateOrders: "确认由此申请生成 {n} 张采购订单？"',
    'confirmCreateOrdersOne: "确认由此申请生成 1 张采购订单？"',
  ]) assert.ok(copy.includes(line), line)
})
