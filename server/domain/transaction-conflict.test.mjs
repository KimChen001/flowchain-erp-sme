import test from 'node:test'
import assert from 'node:assert/strict'
import { isTransactionConflict } from '../persistence/transaction-conflict.mjs'
import { backfillTenantAuthorization } from '../auth/authorization-backfill.mjs'

test('transaction conflict classification covers Prisma and raw adapter commit errors only', () => {
  for (const error of [{ code: 'P2034' }, { code: '40001' }, { cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } }, { meta: { driverAdapterError: { cause: { originalCode: '40001' } } } }]) {
    assert.equal(isTransactionConflict(error), true)
  }
  for (const error of [null, {}, { code: 'P2002' }, { cause: { originalCode: '23505' } }, new Error('TransactionWriteConflict')]) {
    assert.equal(isTransactionConflict(error), false)
  }
})

test('authorization backfill retries a raw commit conflict and preserves its retry budget', async () => {
  const conflict = Object.assign(new Error('TransactionWriteConflict'), { cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } })
  let attempts = 0
  const prisma = { $transaction: async (_work, options) => {
    assert.equal(options.isolationLevel, 'Serializable')
    if (++attempts < 2) throw conflict
    return { tenantId: 'tenant-test', createdAssignments: 1 }
  } }
  assert.equal((await backfillTenantAuthorization(prisma, 'tenant-test')).createdAssignments, 1)
  assert.equal(attempts, 2)
  attempts = 0
  await assert.rejects(backfillTenantAuthorization({ $transaction: async () => { attempts++; throw conflict } }, 'tenant-test'), error => error === conflict)
  assert.equal(attempts, 4)
  attempts = 0
  const denied = Object.assign(new Error('Denied'), { code: 'FORBIDDEN' })
  await assert.rejects(backfillTenantAuthorization({ $transaction: async () => { attempts++; throw denied } }, 'tenant-test'), error => error === denied)
  assert.equal(attempts, 1)
})
