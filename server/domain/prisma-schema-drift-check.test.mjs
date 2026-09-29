import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_DRIFT, classifyDrift, diffStatements } from '../../scripts/check-prisma-schema-drift.mjs'

test('schema drift check splits a migrate diff script into normalised statements', () => {
  assert.deepEqual(diffStatements('-- This is an empty migration.\n'), [])
  assert.deepEqual(diffStatements([
    '-- DropIndex',
    'DROP INDEX "RfqLine_rfqId_idx";',
    '',
    '-- AlterTable',
    'ALTER TABLE "IntakeRecord" ALTER COLUMN "sourceFormat" DROP DEFAULT,',
    'ALTER COLUMN "sourceLocator" DROP DEFAULT;',
    '',
  ].join('\r\n')), [
    'DROP INDEX "RfqLine_rfqId_idx";',
    'ALTER TABLE "IntakeRecord" ALTER COLUMN "sourceFormat" DROP DEFAULT, ALTER COLUMN "sourceLocator" DROP DEFAULT;',
  ])
})

test('schema drift check reports unexpected statements and stale allowances', () => {
  const allowed = [{ statement: 'ALTER INDEX "a" RENAME TO "b";', reason: 'test' }, { statement: 'DROP INDEX "gone";', reason: 'test' }]
  assert.deepEqual(classifyDrift(['ALTER INDEX "a" RENAME TO "b";', 'DROP INDEX "User_defaultWarehouseId_idx";'], allowed), {
    unexpected: ['DROP INDEX "User_defaultWarehouseId_idx";'],
    stale: [allowed[1]],
  })
  assert.deepEqual(classifyDrift(['ALTER INDEX "a" RENAME TO "b";'], allowed.slice(0, 1)), { unexpected: [], stale: [] })
})

test('every allowed schema drift statement is normalised and explains why Prisma cannot express it', () => {
  for (const entry of ALLOWED_DRIFT) {
    assert.deepEqual(diffStatements(entry.statement), [entry.statement])
    assert.ok(entry.reason?.length > 40, `ALLOWED_DRIFT entry needs a reason: ${entry.statement}`)
  }
})
