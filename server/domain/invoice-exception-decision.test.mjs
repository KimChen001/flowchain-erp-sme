import test from 'node:test'
import assert from 'node:assert/strict'
import { raiseInvoiceExceptionDecision } from '../services/invoice-exception-decision.mjs'

function fakeCtx(invoice) {
  const created = []
  const prisma = {
    supplierInvoice: { findFirst: async ({ where }) => (invoice && where.id === invoice.id && where.tenantId === 't1' ? invoice : null) },
    decisionItem: { createMany: async ({ data, skipDuplicates }) => { created.push(...data.map((row) => ({ ...row, skipDuplicates }))); return { count: data.length } } },
  }
  return { ctx: { identity: { tenantId: 't1' }, homeOverviewPrisma: prisma, tenantTimezone: 'America/New_York' }, created }
}

test('a match that holds the invoice raises its decision at once, at the time of the match', async () => {
  const { ctx, created } = fakeCtx({ id: 'INV-1', status: 'exception', invoiceDate: new Date('2026-11-10T00:00:00Z') })
  const now = new Date('2026-11-13T15:00:00Z')
  const row = await raiseInvoiceExceptionDecision(ctx, 'INV-1', { now })
  assert.deepEqual(row, { kind: 'bill_exception', entityType: 'supplier_invoice', recordId: 'INV-1', date: '2026-11-10' })
  assert.equal(created.length, 1)
  assert.equal(created[0].activeKey, 'bill_exception:INV-1')
  assert.equal(created[0].state, 'open')
  assert.equal(created[0].raisedAt.toISOString(), now.toISOString())
  assert.equal(created[0].snapshot.raisedOn, '2026-11-13')
  // One live item per key: a second raise, or Today's own read, keeps one.
  assert.equal(created[0].skipDuplicates, true)
})

test('a clean match, another workspace\'s invoice or a failure raises nothing and never throws', async () => {
  const clean = fakeCtx({ id: 'INV-2', status: 'matched', invoiceDate: null })
  assert.equal(await raiseInvoiceExceptionDecision(clean.ctx, 'INV-2'), null)
  assert.equal(clean.created.length, 0)
  const missing = fakeCtx(null)
  assert.equal(await raiseInvoiceExceptionDecision(missing.ctx, 'INV-3'), null)
  const reported = []
  const broken = { identity: { tenantId: 't1' }, homeOverviewPrisma: { supplierInvoice: { findFirst: async () => { throw new Error('db down') } }, decisionItem: {} }, reportError: (error) => reported.push(error.message) }
  assert.equal(await raiseInvoiceExceptionDecision(broken, 'INV-4'), null)
  assert.deepEqual(reported, ['db down'])
})
