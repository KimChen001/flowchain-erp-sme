import test from 'node:test'
import assert from 'node:assert/strict'
import {
  receivingDecimalString,
  receivingMovementNetUnits,
  replayLedgerWithoutMovement,
} from './receiving-transaction-policy.mjs'
import { calculateMovementBalance } from './receiving-posting-command-service.mjs'

// Offline coverage for the ledger replay that decides whether a posted receipt
// may be reversed. The database regression lives in
// receiving-reversal-transaction.test.mjs and drives the same rule through the
// production receiving and inventory operations services.

const receipt = (id, quantity) => ({ id, quantityIn: quantity, quantityOut: '0', adjustmentQty: '0' })
const outbound = (id, quantity) => ({ id, quantityIn: '0', quantityOut: quantity, adjustmentQty: '0' })
const adjustment = (id, quantity) => ({ id, quantityIn: '0', quantityOut: '0', adjustmentQty: quantity })
const units = (value) => receivingDecimalString(value)

test('net movement units follow the reconciliation formula', () => {
  assert.equal(units(receivingMovementNetUnits(receipt('r', '4'))), '4.0000')
  assert.equal(units(receivingMovementNetUnits(outbound('o', '3.5000'))), '-3.5000')
  assert.equal(units(receivingMovementNetUnits(adjustment('a', '-1.2500'))), '-1.2500')
  // Missing quantities count as zero, as reconciliation already treats them.
  assert.equal(units(receivingMovementNetUnits({ id: 'n', quantityIn: null, quantityOut: undefined })), '0.0000')
  assert.equal(units(receivingMovementNetUnits({ id: 'm', quantityIn: '2', quantityOut: '0.5', adjustmentQty: '-0.25' })), '1.2500')
})

test('reconciliation and the replay share one formula', () => {
  // calculateMovementBalance backs reconcileInventoryBalance. If the two ever
  // disagreed, the reversal guard and the reconciliation report would describe
  // two different on-hand quantities for the same location.
  const ledger = [receipt('r1', '4'), outbound('o1', '3'), adjustment('a1', '-0.5000'), receipt('r2', '10.2500')]
  const summed = ledger.reduce((sum, movement) => sum + receivingMovementNetUnits(movement), 0n)
  assert.equal(calculateMovementBalance(ledger), units(summed))
  assert.equal(calculateMovementBalance(ledger), '10.7500')
})

test('a later receipt cannot mask consumption that depended on the removed receipt', () => {
  // GRN-1 4, transfer out 3, GRN-2 4. Without GRN-1 the transfer leaves -3.
  const ledger = [receipt('grn-1', '4'), outbound('transfer', '3'), receipt('grn-2', '4')]
  const replay = replayLedgerWithoutMovement(ledger, 'grn-1')
  assert.equal(replay.found, true)
  assert.equal(units(replay.lowest), '-3.0000')
  assert.equal(replay.lowestAtMovementId, 'transfer')
  assert.equal(units(replay.finalAfterRemoval), '1.0000')
})

test('consumption covered by another receipt does not depend on the removed receipt', () => {
  // GRN-1 4, GRN-2 4, transfer out 3. Without GRN-1: 4 then 1, never negative.
  // Refusing this would be the over-strict "any later outbound" rule.
  const ledger = [receipt('grn-1', '4'), receipt('grn-2', '4'), outbound('transfer', '3')]
  const replay = replayLedgerWithoutMovement(ledger, 'grn-1')
  assert.equal(replay.found, true)
  assert.equal(replay.lowest >= 0n, true)
  assert.equal(replay.lowestAtMovementId, null)
  assert.equal(units(replay.finalAfterRemoval), '1.0000')
})

test('stock that existed before the receipt is counted', () => {
  const earlier = receipt('earlier', '10')
  // 10 on hand before GRN-1, then 12 shipped: 2 of them needed GRN-1.
  const shortfall = replayLedgerWithoutMovement([earlier, receipt('grn-1', '4'), outbound('ship', '12')], 'grn-1')
  assert.equal(units(shortfall.lowest), '-2.0000')
  assert.equal(shortfall.lowestAtMovementId, 'ship')
  // Only 8 shipped: the earlier 10 covers it.
  const covered = replayLedgerWithoutMovement([earlier, receipt('grn-1', '4'), outbound('ship', '8')], 'grn-1')
  assert.equal(covered.lowest >= 0n, true)
})

test('negative adjustments count as consumption regardless of movement type', () => {
  // The replay reads quantities, not type names, so no outbound type can be
  // missing from a list and slip past the guard.
  const replay = replayLedgerWithoutMovement([receipt('grn-1', '4'), adjustment('write-off', '-4')], 'grn-1')
  assert.equal(units(replay.lowest), '-4.0000')
  assert.equal(replay.lowestAtMovementId, 'write-off')
})

test('a reversed later movement is still history, so the guard stays conservative', () => {
  // Intended behaviour, stated explicitly. The ledger is append-only: a
  // shipment and its reversal are both posted. Between them the goods were out,
  // and without GRN-1 nothing could have supplied them. The guard therefore
  // refuses. This can refuse a reversal that is safe in business terms when the
  // shipment was a mistaken posting, which is the safer failure for an
  // integrity guard than silently allowing an impossible history.
  const ledger = [receipt('grn-1', '4'), outbound('ship', '3'), receipt('ship-reversal', '3'), receipt('grn-2', '4')]
  const replay = replayLedgerWithoutMovement(ledger, 'grn-1')
  assert.equal(units(replay.lowest), '-3.0000')
  assert.equal(replay.lowestAtMovementId, 'ship')
})

test('a receipt with nothing after it can always be replayed out', () => {
  const replay = replayLedgerWithoutMovement([receipt('grn-1', '4')], 'grn-1')
  assert.equal(replay.found, true)
  assert.equal(units(replay.lowest), '0.0000')
  assert.equal(units(replay.finalAfterRemoval), '0.0000')
})

test('a receipt missing from its own ledger is reported rather than assumed safe', () => {
  assert.deepEqual(replayLedgerWithoutMovement([receipt('other', '4')], 'grn-1'), { found: false })
  assert.deepEqual(replayLedgerWithoutMovement([], 'grn-1'), { found: false })
})

test('the replay trusts the order it is given', () => {
  // Business order is the caller's responsibility (occurredAt, createdAt, id).
  // The same movements in a different order give a different answer, which is
  // why the database query sorts deterministically.
  const inOrder = replayLedgerWithoutMovement([receipt('grn-1', '4'), receipt('grn-2', '4'), outbound('transfer', '3')], 'grn-1')
  const consumedFirst = replayLedgerWithoutMovement([receipt('grn-1', '4'), outbound('transfer', '3'), receipt('grn-2', '4')], 'grn-1')
  assert.equal(inOrder.lowest >= 0n, true)
  assert.equal(consumedFirst.lowest < 0n, true)
})
