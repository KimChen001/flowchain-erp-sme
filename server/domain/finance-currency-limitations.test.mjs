import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { financeCurrencyLimitations } from './operational-finance-o2c-read-service.mjs'

test('supplier invoices alone make a single-currency finance overview', () => {
  // The walkthrough has USD supplier invoices and no payables yet.
  const limitations = financeCurrencyLimitations([], [], [{ currency: 'USD' }, { currency: 'usd' }], [])
  assert.equal(limitations.aggregationStatus, 'single_currency')
  assert.deepEqual(limitations.currencies, ['USD'])
})

test('mixed currencies stay unconverted and an empty workspace has no currency data', () => {
  assert.equal(financeCurrencyLimitations([{ currency: 'USD' }], [{ currency: 'CNY' }]).aggregationStatus, 'multi_currency_unconverted')
  const empty = financeCurrencyLimitations([], [], [{ currency: '' }], [])
  assert.equal(empty.aggregationStatus, 'no_currency_data')
  assert.equal(empty.fxConverted, false)
})

test('the finance landing reads invoice currencies, not only open obligations', async () => {
  const source = await readFile(new URL('./operational-finance-o2c-read-service.mjs', import.meta.url), 'utf8')
  assert.match(source, /prisma\.supplierInvoice\.findMany\(\{\s*where: \{ tenantId: current\.tenantId, status: \{ notIn: CLOSED_DOCUMENT_STATUSES \} \},\s*distinct: \["currency"\]/)
  assert.match(source, /currencyLimitations: financeCurrencyLimitations\(/)
})
