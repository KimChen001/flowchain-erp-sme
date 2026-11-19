import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { followUpMessage, followUpSendErrorText } from '../../src/modules/overview/followUpMessage.ts'
import { buildDecisionDrafts } from './decision-drafts.mjs'

// Today's decision cards (src/modules/overview/DecisionCards.tsx) for the
// drafts the server prepares (decision-drafts.mjs), design audit A2.

const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const cards = source('src/modules/overview/DecisionCards.tsx')
const copy = source('src/modules/overview/decisionCopy.ts')

const facts = (lines) => ({ orderNumber: 'PO-202610-0003', contactName: 'Pat Lee', due: 'Nov 2, 2026', overdueDays: 10, lines, moreLines: 0 })

// L11-22: the follow-up named each line by SKU alone.
test('the follow-up names each late line by SKU, item and the supplier part number, in English and Chinese', () => {
  const lines = [
    { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', supplierSku: 'AC-100', quantity: '60 pcs', promised: 'Nov 2, 2026' },
    // No part number recorded, and an item name that only repeats the SKU.
    { sku: '22423', itemName: '22423', supplierSku: null, quantity: '5 pcs', promised: null },
  ]
  const english = followUpMessage('en-US', facts(lines)).body.split('\n')
  assert.ok(english.includes('- 85123A White Hanging Heart T-Light Holder (your part no. AC-100): 60 pcs (promised Nov 2, 2026)'), english.join('\n'))
  assert.ok(english.includes('- 22423: 5 pcs'))
  const chinese = followUpMessage('zh-CN', facts(lines)).body.split('\n')
  assert.ok(chinese.includes('- 85123A White Hanging Heart T-Light Holder（贵司料号 AC-100）：60 pcs（承诺日期 Nov 2, 2026）'), chinese.join('\n'))
  assert.ok(chinese.includes('- 22423：5 pcs'))
  // A line without either reads as before.
  assert.ok(followUpMessage('en-US', facts([{ sku: 'SKU-1', quantity: '3 pcs', promised: null }])).body.includes('- SKU-1: 3 pcs'))
})

test('the card passes the item name and the part number of each draft line to the message', () => {
  assert.match(cards, /itemName: line\.itemName \|\| null,\s*supplierSku: line\.supplierSku \|\| null,/)
  assert.match(copy, /export \{ followUpMessage, followUpSendErrorText, type FollowUpFacts \} from "\.\/followUpMessage"/)
})

// L11-01: an overdue order approved but never sent gets send_purchase_order;
// without a card for it Today showed a card with no action.
test('every draft type the server prepares has its own card, and "send the order" opens the order', () => {
  const now = new Date('2026-11-12T15:00:00Z')
  const timeZone = 'America/New_York'
  const order = (id, status) => ({ id, orderNumber: id, supplierId: 'SUP-1', supplierName: 'Acme', status, currency: 'USD', expectedDate: '2026-11-02', lines: [{ id: `${id}-L1`, sku: 'SKU-1', orderedQuantity: 10, receivedQuantity: 0, unit: 'pcs', promisedDate: '2026-11-02' }] })
  const context = {
    suppliers: [{ id: 'SUP-1', name: 'Acme' }],
    purchaseOrders: [order('PO-SENT', 'issued'), order('PO-UNSENT', 'approved')],
    purchaseRequests: [{ id: 'PR-1', number: 'PR-1', status: 'approved', version: 1, lines: [{ sku: 'A', supplierId: 'SUP-1', currency: 'USD', targetWarehouseId: 'WH-1' }] }],
  }
  const sources = {
    reorder: { rows: [{ itemId: 'ITEM-1', sku: 'SKU-1', purchaseRequest: { quantity: 5 } }] },
    invoiceExceptions: {
      amountsVisible: true,
      invoices: [{ id: 'INV-1', invoiceNumber: 'BILL-1', supplierId: 'SUP-1', currency: 'USD' }],
      exceptions: [{ id: 'EX-1', matchLineId: 'L1', supplierInvoiceId: 'INV-1', exceptionType: 'price', status: 'open', expectedValue: '1.27', actualValue: '1.32' }],
      lines: { L1: { sku: 'SKU-1', unit: 'pcs', orderedQuantity: '10', receivedQuantity: '10', previouslyInvoicedQuantity: '0', invoiceQuantity: '10', poUnitPrice: '1.27', invoiceUnitPrice: '1.32' } },
      orderPrices: [],
    },
  }
  const rows = [
    { kind: 'reorder_now', recordId: 'ITEM-1' },
    { kind: 'purchase_order_overdue', recordId: 'PO-SENT' },
    { kind: 'purchase_order_overdue', recordId: 'PO-UNSENT' },
    { kind: 'purchase_request_to_convert', recordId: 'PR-1' },
    { kind: 'bill_exception', recordId: 'INV-1' },
  ]
  const types = [...new Set(Object.values(buildDecisionDrafts(rows, { context, sources, now, timeZone })).map((draft) => draft.type))].sort()
  assert.deepEqual(types, ['invoice_exception', 'purchase_orders_from_request', 'purchase_request', 'send_purchase_order', 'supplier_follow_up'])
  for (const type of types) assert.ok(cards.includes(`draft?.type === "${type}"`), `no card for ${type}`)
  // The send-order card: its own body, the order page as the main button.
  assert.match(cards, /draft\?\.type === "send_purchase_order" \? <SendOrderBody /)
  assert.match(cards, /function SendOrderBody[\s\S]*?\/app\/procurement\/orders\/\$\{encodeURIComponent\(draft\.purchaseOrderId\)\}[\s\S]*?t\("openOrder"\)/)
  // English first, Chinese through the same copy table.
  for (const text of ['sendOrderDraft: "Send the order to {supplier}"', 'openOrder: "Open the order"', 'sendOrderDraft: "把订单发给{supplier}"', 'openOrder: "打开订单"', 'sendOrderShort: "Not sent to the supplier yet"', 'sendOrderShort: "尚未发给供应商"']) {
    assert.ok(copy.includes(text), text)
  }
})

// Design audit L5-12: a refused follow-up says what to change in the
// interface language; the card showed "try again in a moment" for all of them.
test('every refusal of a supplier follow-up has its own words in English and Chinese', () => {
  const detail = { figure: '1,500', orderNumber: 'PO-202610-0007' }
  assert.equal(followUpSendErrorText('SUPPLIER_EMAIL_FIGURE_CHANGED', detail, 'en-US'), "1,500 is not on order PO-202610-0007. The order's figures cannot be changed; edit only the wording.")
  assert.equal(followUpSendErrorText('SUPPLIER_EMAIL_FIGURE_CHANGED', detail, 'zh-CN'), '1,500 不是订单 PO-202610-0007 上的数字。订单的数字不能改，只能改措辞。')
  assert.equal(followUpSendErrorText('SUPPLIER_EMAIL_ORDER_MISSING', detail, 'zh-CN'), '请在邮件中保留订单号 PO-202610-0007。')
  assert.equal(followUpSendErrorText('SUPPLIER_EMAIL_FIGURE_CHANGED', {}, 'en-US'), "A figure in the message is not on the order. The order's figures cannot be changed; edit only the wording.")
  assert.equal(followUpSendErrorText('SUPPLIER_EMAIL_PRICE', null, 'zh-CN'), '催货邮件里不要写价格或币种。')
  assert.equal(followUpSendErrorText('VERSION_CONFLICT', null, 'en-US'), null, 'not a follow-up refusal: the shared wording applies')
  // Every SUPPLIER_EMAIL_ code the server can return has both.
  const codes = new Set(['server/domain/supplier-follow-up-email.mjs', 'server/services/supplier-follow-up-email-service.mjs', 'server/routes/decision-items.routes.mjs'].flatMap((file) => source(file).match(/SUPPLIER_EMAIL_[A-Z_]+/g) || []))
  codes.delete('SUPPLIER_EMAIL_PERMISSION')
  codes.delete('SUPPLIER_EMAIL_LIMITS')
  codes.delete('SUPPLIER_EMAIL_AUDIT_ACTION')
  assert.ok(codes.size >= 15, [...codes].join(', '))
  for (const code of codes) {
    const english = followUpSendErrorText(code, detail, 'en-US')
    const chinese = followUpSendErrorText(code, detail, 'zh-CN')
    assert.ok(english && !/[\u4e00-\u9fff]/.test(english), `${code} in English`)
    assert.ok(chinese && /[\u4e00-\u9fff]/.test(chinese), `${code} in Chinese`)
  }
  // The card shows them, and its own copy failure, instead of the generic retry.
  const cards = source('src/modules/overview/DecisionCards.tsx')
  assert.match(cards, /followUpSendErrorText\(error\.code, error\.details\?\.\[0\], t\.language\)/)
  assert.ok(!cards.includes('throw new Error(t("copyFailed"))'))
  // The message starts in the interface language; the person may switch it.
  assert.equal((cards.match(/useState<"en-US" \| "zh-CN">\(language === "zh-CN" \? "zh-CN" : "en-US"\)/g) || []).length, 2)
})
