import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The phone card layout of list tables (src/components/ui/workbenchTable.ts)
// takes each row's roles from the header. A header marked data-card-status is
// the card's status; without one the first column named "Status" is, as
// before. The sales order list once showed "Not reserved" as a shipped order's
// status because "Reservation status" was its first column with "status" in
// its name.

let loaded
async function load() {
  if (loaded) return loaded.mod
  const dir = await mkdtemp(path.join(tmpdir(), 'list-table-cards-'))
  const outfile = path.join(dir, 'table.mjs')
  await build({ entryPoints: ['src/components/ui/workbenchTable.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  loaded = { mod: await import(pathToFileURL(outfile).href), cleanup: () => rm(dir, { recursive: true, force: true }) }
  return loaded.mod
}
test.after(async () => { await loaded?.cleanup() })

// Just enough of a DOM element for labelListTable.
function element(extra = {}) {
  const attributes = new Map(Object.entries(extra.attributes || {}))
  return {
    textContent: extra.text || '',
    colSpan: extra.colSpan || 1,
    attributes,
    hasAttribute: (name) => attributes.has(name),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    querySelector: () => (extra.checkbox ? {} : null),
  }
}
const th = (text, attributes = {}) => element({ text, attributes })
function table(headers, values) {
  const row = { ...element(), cells: values.map((text) => element({ text })) }
  return { ...element(), tHead: { rows: [{ cells: headers }] }, tBodies: [{ rows: [row] }], tFoot: null, row }
}
const roles = (row) => row.cells.map((cell) => cell.getAttribute('data-card-role'))
const labels = (row) => row.cells.map((cell) => cell.getAttribute('data-label'))

test('a header marked data-card-status is the card status, whatever the other headers say', async () => {
  const { labelListTable } = await load()
  // The sales order list as the review found it: three status columns.
  const list = table(
    [th('Order number'), th('Customer'), th('Workflow'), th('Reservation status'), th('Fulfillment status', { 'data-card-status': '' }), th('Ordered'), th('Actions')],
    ['SO-202611-0006', 'Store CA_1', 'Confirmed', 'Not reserved', 'Fulfilled', '1,882', 'View'],
  )
  labelListTable(list)
  assert.equal(list.getAttribute('data-list-cards'), '')
  assert.deepEqual(roles(list.row), ['title', 'field', 'field', 'field', 'status', 'field', 'actions'])
  assert.equal(labels(list.row)[3], 'Reservation status')
  assert.equal(labels(list.row)[4], null)

  // A marked column that is not named a status (a risk level).
  const risks = table([th('Sales order'), th('SKU / item'), th('Promised date'), th('Risk', { 'data-card-status': '' }), th('Risk reason'), th('Actions')], ['SO-1', 'SKU-1', 'Nov 7', 'High risk', 'Short', 'View'])
  labelListTable(risks)
  assert.deepEqual(roles(risks.row), ['title', 'field', 'field', 'status', 'field', 'actions'])
})

test('without a marked header the status column is found by name, as before', async () => {
  const { labelListTable } = await load()
  // A column named just "Status" wins over "Credit status".
  const customers = table([th('Customer'), th('Credit status'), th('Status'), th('')], ['Acme', 'On hold', 'Active', 'View'])
  labelListTable(customers)
  assert.deepEqual(roles(customers.row), ['title', 'field', 'status', 'actions'])
  // Else the first column with "status" (or 状态) in its name.
  const chinese = table([th('单号'), th('履约状态'), th('预留状态'), th('操作')], ['SO-1', '已履约', '未预留', '查看'])
  labelListTable(chinese)
  assert.deepEqual(roles(chinese.row), ['title', 'status', 'field', 'actions'])
  // No status column at all: every other cell is a labelled field.
  const movements = table([th('Shipment'), th('SKU'), th('Warehouse'), th('In'), th('Out'), th('Type')], ['DN-1', 'SKU-1', 'Main', '0', '12', 'Shipment'])
  labelListTable(movements)
  assert.deepEqual(roles(movements.row), ['title', 'field', 'field', 'field', 'field', 'field'])
  assert.deepEqual(labels(movements.row), [null, 'SKU', 'Warehouse', 'In', 'Out', 'Type'])
})

test('a status mark on the title column is ignored', async () => {
  const { labelListTable } = await load()
  const list = table([th('Order', { 'data-card-status': '' }), th('Status'), th('Actions')], ['SO-1', 'Open', 'View'])
  labelListTable(list)
  assert.deepEqual(roles(list.row), ['title', 'status', 'actions'])
})
