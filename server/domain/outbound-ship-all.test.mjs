import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Design audit C8: whole-order reserving and shipping (L4-08) and the order's
// progress steps (L7-42). The plans the order page sends are pure functions;
// the Postgres suite (outbound-posting-transaction.test.mjs) sends them to the
// server and checks one multi-line shipment comes back.
const root = resolve(import.meta.dirname, '../..')

export async function loadOutboundPlans() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-outbound-plans-'))
  const result = await build({ entryPoints: [join(root, 'src/modules/sales/outboundPlans.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  const file = join(directory, 'plans.mjs')
  await writeFile(file, result.outputFiles[0].text)
  try { return await import(pathToFileURL(file).href) } finally { await rm(directory, { recursive: true, force: true }) }
}

const balance = (id, available, extra = {}) => ({ id, warehouseId: 'WH-1', location: id, availableQuantity: available, selectable: true, ...extra })

test('reserve all covers every open line from the largest balances, never counting stock twice', async () => {
  const { reserveAllPlan } = await loadOutboundPlans()
  const lines = [
    { id: 'L1', sku: 'A', remainingToReserve: '6.0000' },
    { id: 'L2', sku: 'B', remainingToReserve: '2.0000' },
    // The same SKU again: it shares L1's balances.
    { id: 'L3', sku: 'A', remainingToReserve: '5.0000' },
    // Nothing left, and a remainder this reader may not see: left out.
    { id: 'L4', sku: 'C', remainingToReserve: '0.0000' },
    { id: 'L5', sku: 'D', remainingToReserve: null },
  ]
  const shared = [balance('A-small', '3.0000'), balance('A-big', '5.0000'), balance('A-locked', '50.0000', { selectable: false })]
  const availability = [
    { salesOrderLineId: 'L1', balances: shared },
    { salesOrderLineId: 'L2', balances: [balance('B-1', '2.5000')] },
    { salesOrderLineId: 'L3', balances: shared },
    { salesOrderLineId: 'L5', balances: [balance('D-1', '9.0000')] },
  ]
  const plan = reserveAllPlan(lines, availability)
  assert.deepEqual(plan.allocations.map((row) => [row.salesOrderLineId, row.location, row.quantity]), [
    ['L1', 'A-big', '5'], ['L1', 'A-small', '1'],
    ['L2', 'B-1', '2'],
    ['L3', 'A-small', '2'],
  ])
  // L3 wanted 5; only 2 were left after L1, and the locked balance is not this user's to use.
  assert.deepEqual(plan.short, [{ salesOrderLineId: 'L3', quantity: '3' }])
})

test('ship all puts every reservation free to ship on one shipment, a line for each order line', async () => {
  const { shipAllPlan } = await loadOutboundPlans()
  const lines = [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }]
  const reservations = [
    { id: 'R1', salesOrderLineId: 'L1', allocatableQuantity: '4.0000' },
    { id: 'R2', salesOrderLineId: 'L1', allocatableQuantity: '1.5000' },
    // Already on a shipment draft: nothing free.
    { id: 'R3', salesOrderLineId: 'L2', allocatableQuantity: '0.0000' },
    { id: 'R4', salesOrderLineId: 'L3', allocatableQuantity: '2.0000' },
  ]
  assert.deepEqual(shipAllPlan(lines, reservations), [
    { salesOrderLineId: 'L1', allocations: [{ reservationId: 'R1', quantity: '4' }, { reservationId: 'R2', quantity: '1.5' }] },
    { salesOrderLineId: 'L3', allocations: [{ reservationId: 'R4', quantity: '2' }] },
  ])
})

test('the order progress steps: placed, reserved, shipped, invoiced, paid', async () => {
  const { salesOrderProgress } = await loadOutboundPlans()
  const line = (ordered, reserved, fulfilled) => ({ orderedQuantity: ordered, reservedQuantity: reserved, fulfilledQuantity: fulfilled })
  const steps = (facts) => salesOrderProgress({ invoicing: null, invoices: null, ...facts }).map((step) => step.status).join(' ')
  assert.equal(steps({ workflowStatus: 'draft', lines: [line('5', '0', '0')] }), 'current pending pending pending pending')
  assert.equal(steps({ workflowStatus: 'confirmed', lines: [line('5', '2', '0')] }), 'done current pending pending pending')
  // On hold: the step it stopped at is a warning.
  assert.equal(steps({ workflowStatus: 'on_hold', lines: [line('5', '5', '0')] }), 'done done warning pending pending')
  // Shipping uses up the reservation: a shipped line counts as reserved.
  assert.equal(steps({ workflowStatus: 'confirmed', lines: [line('5', '0', '5')], invoicing: 'partly_invoiced', invoices: [] }), 'done done done current pending')
  const paid = { workflowStatus: 'confirmed', lines: [line('5', '0', '5')], invoicing: 'invoiced' }
  assert.equal(steps({ ...paid, invoices: [{ status: 'issued', paymentStatus: 'to_be_paid' }] }), 'done done done done current')
  // A cancelled invoice bills nothing; every other one must be paid.
  assert.equal(steps({ ...paid, invoices: [{ status: 'issued', paymentStatus: 'settled' }, { status: 'cancelled' }] }), 'done done done done done')
  // A cancelled order has no current step.
  assert.equal(steps({ workflowStatus: 'cancelled', lines: [line('5', '0', '0')] }), 'pending pending pending pending pending')
})
