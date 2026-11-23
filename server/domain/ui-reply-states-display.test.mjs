import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SUPPLIER_REPLY_EMAIL_ORDER_STATES } from '../../shared/supplier-reply-contract.mjs'
import { EMAIL_ORDER_LINKED, severalOrdersOnce, shownIssue } from '../../src/modules/purchasing/supplierReply/supplierReplyLogic.ts'
import { SUPPLIER_REPLY_COPY, supplierReplyText } from '../../src/modules/purchasing/supplierReply/supplierReplyCopy.ts'
import { STATUS_CHART_COLORS, STATUS_TONE_SHADES, statusToneOf } from '../../src/components/ui/statusTones.ts'

// The supplier-reply card's several-orders note, shown more simply (11/23,
// the coordinator's call for the owner): the reason said once, a past-tense
// note once the card is decided, the other orders as links with chips.
// Display only: what is held, proposed or recorded is unchanged.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const held = (issue, over = {}) => ({ outcome: 'needs_you', issue, purchaseOrderLineId: 'pol-1', ...over })
const card = (lines, emailOrders) => ({ lines, ...(emailOrders ? { emailOrders } : {}) })
const orders = [{ number: 'PO-1', status: 'this' }, { number: 'PO-2', status: 'read' }]

test('the several-orders reason is said once when every held line has it and the note is shown', () => {
  const every = card([held('several_orders'), held('several_orders', { purchaseOrderLineId: 'pol-2' })], orders)
  assert.equal(severalOrdersOnce(every), true)
  assert.equal(shownIssue(every, 'several_orders'), null)
  // A line held for another reason keeps it, and then every line keeps its own.
  const mixed = card([held('several_orders'), held('line_mismatch', { purchaseOrderLineId: 'pol-2' })], orders)
  assert.equal(severalOrdersOnce(mixed), false)
  assert.equal(shownIssue(mixed, 'several_orders'), 'several_orders')
  assert.equal(shownIssue(mixed, 'line_mismatch'), 'line_mismatch')
  // Without the note (no emailOrders) the line says it, as before.
  const noNote = card([held('several_orders')])
  assert.equal(severalOrdersOnce(noNote), false)
  assert.equal(shownIssue(noNote, 'several_orders'), 'several_orders')
  // Proposed lines do not count; no held line at all means nothing to say once.
  assert.equal(severalOrdersOnce(card([{ outcome: 'proposed', issue: null }], orders)), false)
  assert.equal(shownIssue(every, null), null)
})

test('the card uses the reason once, the past-tense note once decided, links and chips', () => {
  const source = read('src/modules/purchasing/supplierReply/SupplierReplyCard.tsx')
  assert.ok(source.includes('<div>{t(open ? "emailOrders" : "emailOrdersDone", { n: card.emailOrders.length, number: card.purchaseOrderNumber, limit: SUPPLIER_REPLY_EMAIL_ORDER_LIMIT })}</div>'))
  assert.ok(source.includes('{open && severalOrdersOnce(card) ? <div className="mt-0.5 text-amber-800" data-testid="supplier-reply-several-orders-once">{t("severalOrdersOnce")}</div> : null}'))
  // Every place a line's reason shows reads shownIssue: the question box,
  // the manual form and the Not used list.
  assert.equal(source.split('shownIssue(card, line.issue)').length - 1, 3)
  assert.ok(!/\{line\??\.issue && /.test(source))
  // Found orders link to their page; each state is a chip in the shared tone,
  // with the full sentence as the tooltip.
  assert.ok(source.includes('{EMAIL_ORDER_LINKED.has(item.status) ? <Link className="font-medium text-blue-600 hover:underline" to={`/app/procurement/orders/${encodeURIComponent(item.number)}`} data-testid="supplier-reply-email-order-link">{item.number}</Link> : <span className="font-medium">{item.number}</span>}'))
  assert.ok(source.includes('<StatusChip label={t(`emailOrderChip_${item.status}` as SupplierReplyCopyKey, { limit: SUPPLIER_REPLY_EMAIL_ORDER_LIMIT })} tone={statusToneOf(item.status)} />'))
  assert.ok(source.includes('title={t(`emailOrder_${item.status}` as SupplierReplyCopyKey, { number: item.number, limit: SUPPLIER_REPLY_EMAIL_ORDER_LIMIT })}'))
  // The flag link it matches.
  assert.ok(source.includes('to={`/app/procurement/orders/${encodeURIComponent(flag.orderNumber)}`}'))
  assert.deepEqual([...EMAIL_ORDER_LINKED].sort(), ['closed', 'open_card_kept', 'other_supplier', 'read'])
})

test('each other-order state has a chip label in both languages and a tone from the shared table', () => {
  const tones = { read: 'success', open_card_kept: 'warning', over_limit: 'warning', closed: 'neutral', other_supplier: 'neutral', unknown: 'neutral' }
  for (const status of SUPPLIER_REPLY_EMAIL_ORDER_STATES.filter((value) => value !== 'this')) {
    const [english, chinese] = SUPPLIER_REPLY_COPY[`emailOrderChip_${status}`]
    assert.ok(english && /[㐀-鿿]/.test(chinese), status)
    assert.equal(statusToneOf(status), tones[status], status)
    assert.ok(STATUS_TONE_SHADES[tones[status]].includes(STATUS_CHART_COLORS[status]), status)
  }
  assert.equal(supplierReplyText('en-US', 'emailOrderChip_over_limit', { limit: 5 }), 'Over the 5-order limit, not read')
  assert.equal(supplierReplyText('zh-CN', 'emailOrderChip_over_limit', { limit: 5 }), '超过 5 张上限，未读取')
  assert.equal(supplierReplyText('en-US', 'emailOrdersDone', { n: 3, number: 'PO-1' }), "This email named 3 orders. This card covered only PO-1's lines.")
  assert.equal(supplierReplyText('zh-CN', 'emailOrdersDone', { n: 3, number: 'PO-1' }), '这封邮件提到了 3 张订单。本卡片只涉及 PO-1 的行。')
  assert.equal(supplierReplyText('zh-CN', 'severalOrdersOnce'), '请对照整封邮件逐行确认，自己填写交期。')
  // The new codes sit on their own lines at the end of each tone, after
  // every existing entry, so no existing code changed tone or chart shade.
  const table = read('src/components/ui/statusTones.ts')
  assert.ok(table.includes('"已入库", "已收货",\n    "read", //'))
  assert.ok(table.includes('"人工复核", "缺少收货",\n    "open_card_kept", "over_limit", //'))
  assert.ok(table.includes('"已撤回", "已关闭",\n    "other_supplier", //'))
})
