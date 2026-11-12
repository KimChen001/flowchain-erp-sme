import test from 'node:test'
import assert from 'node:assert/strict'
import { SUPPLIER_EMAIL_LIMITS, parseFollowUpEmail, supplierEmailDelivery } from './supplier-follow-up-email.mjs'

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
