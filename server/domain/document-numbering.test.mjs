import test from 'node:test'
import assert from 'node:assert/strict'
import { DOCUMENT_NUMBER_TYPES, documentNumberPrefix, formatDocumentNumber, numberingPeriod } from '../../shared/document-numbering.mjs'
import { allocateDocumentNumber } from './document-numbering.mjs'
import { mergeOperationalSettings, validateOperationalSection } from './workspace-settings-contract.mjs'

// A transaction double: the tenant row and one sequence counter per
// workspace, type and month, as the INSERT … ON CONFLICT would keep them.
function fakeTx({ timezone = 'America/New_York', numbering } = {}) {
  const counters = new Map()
  return {
    counters,
    tenant: { findUnique: async () => ({ timezone, operationalSettings: numbering ? { numbering } : {} }) },
    sequence: async (_tx, { tenantId, documentType, period }) => {
      const key = `${tenantId}|${documentType}|${period}`
      counters.set(key, (counters.get(key) || 0) + 1)
      return counters.get(key)
    },
  }
}

test('a document number is PREFIX-YYYYMM-NNNN and grows past four digits', () => {
  assert.equal(formatDocumentNumber('SO', '202611', 1), 'SO-202611-0001')
  assert.equal(formatDocumentNumber('GRN', '202612', 42), 'GRN-202612-0042')
  assert.equal(formatDocumentNumber('SO', '202611', 12345), 'SO-202611-12345')
  assert.throws(() => formatDocumentNumber('SO', '202611', 0), { code: 'DOCUMENT_NUMBER_SEQUENCE_INVALID' })
})

test('the month is the workspace month, not the UTC month', () => {
  // 03:30 UTC on Dec 1 is still Nov 30 in New York.
  const moment = new Date('2026-12-01T03:30:00Z')
  assert.equal(numberingPeriod(moment, 'America/New_York'), '202611')
  assert.equal(numberingPeriod(moment, 'Asia/Shanghai'), '202612')
  assert.equal(numberingPeriod(moment, 'Not/AZone'), '202611')
})

test('the prefix is the saved rule when valid, otherwise the default', () => {
  assert.equal(documentNumberPrefix({ rules: [{ id: 'NUM-SO', prefix: 'sal' }] }, 'sales_order'), 'SAL')
  assert.equal(documentNumberPrefix({ rules: [{ id: 'NUM-SO', prefix: 'S-O' }] }, 'sales_order'), 'SO')
  assert.equal(documentNumberPrefix(undefined, 'receiving_document'), 'GRN')
  assert.throws(() => documentNumberPrefix({}, 'unknown'), { code: 'DOCUMENT_NUMBER_TYPE_UNKNOWN' })
})

test('numbers run per type and restart each month', async () => {
  const tx = fakeTx()
  const allocate = (documentType, at) => allocateDocumentNumber(tx, { tenantId: 't1', documentType, at: new Date(at), sequence: tx.sequence })
  assert.equal(await allocate('sales_order', '2026-11-04T15:00:00Z'), 'SO-202611-0001')
  assert.equal(await allocate('sales_order', '2026-11-20T15:00:00Z'), 'SO-202611-0002')
  assert.equal(await allocate('receiving_document', '2026-11-20T15:00:00Z'), 'GRN-202611-0001')
  assert.equal(await allocate('sales_order', '2026-12-02T15:00:00Z'), 'SO-202612-0001')
})

test('a number the workspace already has is skipped', async () => {
  const tx = fakeTx()
  const taken = new Set(['SO-202611-0001', 'SO-202611-0002'])
  const number = await allocateDocumentNumber(tx, { tenantId: 't1', documentType: 'sales_order', at: new Date('2026-11-04T15:00:00Z'), sequence: tx.sequence, isTaken: async (value) => taken.has(value) })
  assert.equal(number, 'SO-202611-0003')
})

test('a changed prefix applies to new numbers and keeps the sequence', async () => {
  const tx = fakeTx({ numbering: { rules: [{ id: 'NUM-SO', prefix: 'SAL' }] } })
  const at = new Date('2026-11-04T15:00:00Z')
  await tx.sequence(tx, { tenantId: 't1', documentType: 'sales_order', period: '202611' })
  assert.equal(await allocateDocumentNumber(tx, { tenantId: 't1', documentType: 'sales_order', at, sequence: tx.sequence }), 'SAL-202611-0002')
})

test('settings keep one rule per document type; only the prefix can change', () => {
  const merged = mergeOperationalSettings({ numbering: { rules: [{ id: 'NUM-SO', prefix: 'sal', datePattern: 'YYYYMMDD', separator: '/', sequenceLength: 8 }, { id: 'NUM-SI', prefix: 'SI' }] } })
  assert.deepEqual(merged.numbering.rules.map((rule) => rule.id), DOCUMENT_NUMBER_TYPES.map((entry) => entry.ruleId))
  const salesOrder = merged.numbering.rules.find((rule) => rule.id === 'NUM-SO')
  assert.deepEqual(salesOrder, { id: 'NUM-SO', document: 'Sales Order', prefix: 'SAL', datePattern: 'YYYYMM', separator: '-', sequenceLength: 4 })
  assert.equal(validateOperationalSection('numbering', { rules: [{ id: 'NUM-SO', prefix: 'SAL' }] }).rules.find((rule) => rule.id === 'NUM-SO').prefix, 'SAL')
  assert.throws(() => validateOperationalSection('numbering', { rules: [{ id: 'NUM-SO', prefix: 'GRN' }] }), { code: 'NUMBERING_RULE_CONFLICT' })
  assert.throws(() => validateOperationalSection('numbering', { rules: [{ id: 'NUM-SO', prefix: 'S/O' }] }), { code: 'NUMBERING_PREFIX_INVALID' })
  assert.throws(() => validateOperationalSection('numbering', { rules: [{ id: 'NUM-XX', prefix: 'XX' }] }), { code: 'NUMBERING_RULE_UNKNOWN' })
})
