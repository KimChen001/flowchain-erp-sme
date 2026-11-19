import test from 'node:test'
import assert from 'node:assert/strict'
import { SUPPLIER_EMAIL_LIMITS, checkFollowUpContent, parseFollowUpEmail, supplierEmailDelivery } from './supplier-follow-up-email.mjs'
import { followUpMessage } from '../../src/modules/overview/followUpMessage.ts'
import { formatQuantity } from '../../src/lib/format.ts'

const mail = (fields = {}) => ({ to: 'orders@acme.example', confirmedTo: 'orders@acme.example', subject: 'Purchase order PO-1: delivery overdue', body: 'Dear Pat,\n\nPlease confirm.', ...fields })

test('the email is sent only to the address the person confirmed', () => {
  assert.deepEqual(parseFollowUpEmail(mail({ to: ' Orders@Acme.example ', confirmedTo: 'orders@acme.example' })), {
    to: 'orders@acme.example', subject: 'Purchase order PO-1: delivery overdue', body: 'Dear Pat,\n\nPlease confirm.',
  })
  assert.throws(() => parseFollowUpEmail(mail({ confirmedTo: '' })), { code: 'SUPPLIER_EMAIL_NOT_CONFIRMED' })
  assert.throws(() => parseFollowUpEmail(mail({ confirmedTo: 'other@acme.example' })), { code: 'SUPPLIER_EMAIL_NOT_CONFIRMED' })
})

test('one plain address, a one-line subject and a bounded message', () => {
  for (const to of ['', 'not an address', 'a@b', 'a@b.c, d@e.f', 'Pat <pat@acme.example>']) {
    assert.throws(() => parseFollowUpEmail(mail({ to, confirmedTo: to })), { code: 'SUPPLIER_EMAIL_ADDRESS_INVALID' }, to)
  }
  assert.throws(() => parseFollowUpEmail(mail({ subject: 'Two\nlines' })), { code: 'SUPPLIER_EMAIL_SUBJECT_INVALID' })
  assert.throws(() => parseFollowUpEmail(mail({ subject: 'x'.repeat(SUPPLIER_EMAIL_LIMITS.subjectMax + 1) })), { code: 'SUPPLIER_EMAIL_SUBJECT_INVALID' })
  assert.throws(() => parseFollowUpEmail(mail({ body: '   ' })), { code: 'SUPPLIER_EMAIL_BODY_INVALID' })
  assert.throws(() => parseFollowUpEmail(mail({ body: 'x'.repeat(SUPPLIER_EMAIL_LIMITS.bodyMax + 1) })), { code: 'SUPPLIER_EMAIL_BODY_INVALID' })
  assert.equal(parseFollowUpEmail(mail({ body: 'Line 1\r\nLine 2' })).body, 'Line 1\nLine 2')
})

test('a public-data workspace only ever writes to the outbox', () => {
  assert.equal(supplierEmailDelivery({ FLOWCHAIN_PUBLIC_DATA_EXTRACT: 'C:/data/extract.json', FLOWCHAIN_MAIL_PROVIDER: 'postmark' }), 'outbox')
  assert.equal(supplierEmailDelivery({ FLOWCHAIN_MAIL_PROVIDER: 'postmark' }), 'postmark')
  assert.equal(supplierEmailDelivery({}), 'outbox', 'outside production the default is the outbox')
  assert.equal(supplierEmailDelivery({ NODE_ENV: 'production' }), 'none', 'production without a provider sends nothing')
})

// Design audit 2026-11-15, L5-12: the card let the whole text be edited and
// the server checked only the address and the length.
const DRAFT = Object.freeze({
  type: 'supplier_follow_up', orderNumber: 'PO-202610-0007', dueDate: '2026-10-28', overdueDays: 5, moreLines: 0,
  supplier: { name: 'Acme', contactName: 'Pat', email: 'orders@acme.example' },
  lines: [{ sku: 'LDM-001', remaining: 1200, unit: 'pcs', promisedDate: '2026-10-28' }, { sku: 'LDM-002', remaining: 30, unit: 'pcs', promisedDate: '2026-10-25' }],
})
const letter = (body, fields = {}) => ({ to: 'orders@acme.example', subject: 'Purchase order PO-202610-0007: delivery overdue', body, ...fields })
const TEMPLATE = 'Dear Pat,\n\nOur purchase order PO-202610-0007 was due on 28 Oct 2026 and is now 5 days overdue. These lines are still to be delivered:\n- LDM-001: 1,200 pcs (promised 28 Oct 2026)\n- LDM-002: 30 pcs (promised 25 Oct 2026)\n\nPlease confirm when they will ship.\n\nThank you,'

test('the figures, the order number and the recipient are checked against the order', () => {
  assert.deepEqual(checkFollowUpContent(letter(TEMPLATE), DRAFT), { recipientOnRecord: true })
  // The words may change; so may the Chinese template's dates.
  assert.deepEqual(checkFollowUpContent(letter('Hi Pat, PO-202610-0007 is 5 days late: LDM-001 1200 pcs, LDM-002 30 pcs, due 2026年10月28日. Call me on +44 20 7946 0000.'), DRAFT), { recipientOnRecord: true })
  // A changed quantity, a changed date or a new figure.
  assert.throws(() => checkFollowUpContent(letter(TEMPLATE.replace('1,200 pcs', '1,500 pcs')), DRAFT), { code: 'SUPPLIER_EMAIL_FIGURE_CHANGED' })
  assert.throws(() => checkFollowUpContent(letter(TEMPLATE.replace('was due on 28 Oct', 'was due on 21 Oct')), DRAFT), { code: 'SUPPLIER_EMAIL_FIGURE_CHANGED' })
  assert.throws(() => checkFollowUpContent(letter(`${TEMPLATE}\nAlso send 400 of LDM-009.`), DRAFT), { code: 'SUPPLIER_EMAIL_FIGURE_CHANGED' })
  // The order number must stay; prices stay out.
  assert.throws(() => checkFollowUpContent(letter('Please ship soon.', { subject: 'Late delivery' }), DRAFT), { code: 'SUPPLIER_EMAIL_ORDER_MISSING' })
  assert.throws(() => checkFollowUpContent(letter(`${TEMPLATE}\nAt £2.95 each.`), DRAFT), { code: 'SUPPLIER_EMAIL_PRICE' })
  assert.throws(() => checkFollowUpContent(letter(`${TEMPLATE}\nTotal 30 GBP.`), DRAFT), { code: 'SUPPLIER_EMAIL_PRICE' })
  assert.throws(() => checkFollowUpContent(letter(`${TEMPLATE}\n单价 30元。`), DRAFT), { code: 'SUPPLIER_EMAIL_PRICE' })
  // Another address only when confirmed as not on record.
  assert.throws(() => checkFollowUpContent(letter(TEMPLATE, { to: 'someone@else.example' }), DRAFT), { code: 'SUPPLIER_EMAIL_RECIPIENT_NOT_ON_RECORD' })
  assert.deepEqual(checkFollowUpContent(letter(TEMPLATE, { to: 'someone@else.example' }), DRAFT, { recipientNotOnRecord: true }), { recipientOnRecord: false })
  assert.throws(() => checkFollowUpContent(letter(TEMPLATE), { ...DRAFT, supplier: { ...DRAFT.supplier, email: null } }), { code: 'SUPPLIER_EMAIL_RECIPIENT_NOT_ON_RECORD' })
  // No follow-up built from the order: nothing is sent.
  assert.throws(() => checkFollowUpContent(letter(TEMPLATE), null), { code: 'SUPPLIER_EMAIL_DRAFT_MISSING' })
  // The refusal names the figure and the order, for the card to say in the
  // interface language.
  assert.throws(() => checkFollowUpContent(letter(TEMPLATE.replace('1,200 pcs', '1,500 pcs')), DRAFT), (error) => error.details[0].figure === '1,500' && error.details[0].orderNumber === 'PO-202610-0007')
  assert.throws(() => checkFollowUpContent(letter('Please ship soon.', { subject: 'Late delivery' }), DRAFT), (error) => error.details[0].orderNumber === 'PO-202610-0007')
})

// The card's own text (followUpMessage, the dates and quantities formatted as
// the card formats them) passes the server's check unedited, in English and
// Chinese and in every workspace locale: a supplier follow-up the card wrote
// is never refused. A contact or item name with digits in it is the record's,
// not a changed figure.
test('the generated follow-up passes the check in both languages and every workspace locale', () => {
  const draft = {
    type: 'supplier_follow_up', orderNumber: 'PO-202611-0031', dueDate: '2026-11-04', overdueDays: 14, moreLines: 3,
    supplier: { name: 'Supplier 22 Ltd', contactName: 'Team 2 (Pat)', email: 'orders@acme.example' },
    lines: [
      { sku: '22951', itemName: '60 Cake Cases Dolly Girl Design', supplierSku: 'AC-4410', remaining: 1200, unit: 'pcs', promisedDate: '2026-11-04' },
      { sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', supplierSku: null, remaining: 12.5, unit: 'pcs', promisedDate: '2026-10-30' },
    ],
  }
  const unit = { 'en-US': 'pcs', 'zh-CN': '件' }
  for (const locale of ['en-US', 'en-GB', 'zh-CN', 'de-DE', 'fr-FR']) {
    const day = (value) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${value}T00:00:00Z`))
    for (const language of ['en-US', 'zh-CN']) {
      const generated = followUpMessage(language, {
        orderNumber: draft.orderNumber, contactName: draft.supplier.contactName, due: day(draft.dueDate), overdueDays: draft.overdueDays,
        lines: draft.lines.map((line) => ({ sku: line.sku, itemName: line.itemName, supplierSku: line.supplierSku, quantity: `${formatQuantity(line.remaining)} ${unit[language]}`, promised: day(line.promisedDate) })),
        moreLines: draft.moreLines,
      })
      assert.deepEqual(checkFollowUpContent({ to: 'orders@acme.example', subject: generated.subject, body: generated.body }, draft), { recipientOnRecord: true }, `${language} in ${locale}`)
    }
  }
  // A date with dots is checked part by part: a changed day is still refused.
  const german = 'PO-202611-0031 war am 04.11.2026 fällig; 1,200 Stück 22951 fehlen.'
  assert.deepEqual(checkFollowUpContent({ to: 'orders@acme.example', subject: 'PO-202611-0031', body: german }, draft), { recipientOnRecord: true })
  assert.throws(() => checkFollowUpContent({ to: 'orders@acme.example', subject: 'PO-202611-0031', body: german.replace('04.11.2026', '07.11.2026') }, draft), (error) => error.code === 'SUPPLIER_EMAIL_FIGURE_CHANGED' && error.details[0].figure === '07')
})
