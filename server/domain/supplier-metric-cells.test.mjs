import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The supplier list's and Supplier evaluation's metric cells (design audit
// C7), rendered as the browser would: esbuild bundles supplierMetrics.tsx and
// react-dom/server renders the cells in English.

const root = resolve(import.meta.dirname, '../..')

async function loadCells() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-supplier-cells-'))
  const entry = `
    import { createElement, Fragment } from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { useSupplierMetricCells, sortSuppliersBy, spendInOrder } from './src/modules/srm/supplierMetrics.tsx'
    function Cells({ insight, which }) {
      const cells = useSupplierMetricCells()
      return createElement(Fragment, null, cells[which](insight))
    }
    export const cell = (which, insight) => renderToStaticMarkup(createElement(Cells, { which, insight }))
    export { sortSuppliersBy, spendInOrder }
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'supplier-cells-entry.tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  })
  const file = join(directory, 'cells.cjs')
  await writeFile(file, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(file).href)).default
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const rate = (value, count, of, withheld = 0) => ({ rate: value, count, of, sampleStatus: value === null ? 'insufficient_sample' : 'ok', withheld })
const insight = (extra = {}) => ({ spend12m: [], spendComplete: true, orders12m: 0, openPos: 0, overduePos: 0, onTime: rate(null, 0, 0), otif: rate(null, 0, 0), openIssues: 0, ...extra })
const textOf = (markup) => markup.replace(/<[^>]+>/g, '')

test('on time and OTIF show a percentage, or below 5 deliveries the counts, never a bare dash for a supplier that delivered', async () => {
  const cells = await loadCells()
  // L9-03: OTIF is its own cell beside on time.
  const rated = insight({ onTime: rate(0.8, 4, 5), otif: rate(0.6, 3, 5) })
  assert.equal(textOf(cells.cell('onTimeCell', rated)), '80%')
  assert.equal(textOf(cells.cell('otifCell', rated)), '60%')
  assert.match(cells.cell('otifCell', rated), /3 of 5 deliveries on time and in full against the date on the PO/)
  // L9-13: a monthly supplier has 3 deliveries in 90 days: "3/3", not "—".
  const monthly = insight({ onTime: rate(null, 3, 3), otif: rate(null, 2, 3) })
  assert.equal(textOf(cells.cell('onTimeCell', monthly)), '3/3')
  assert.equal(textOf(cells.cell('otifCell', monthly)), '2/3')
  assert.match(cells.cell('onTimeCell', monthly), /A percentage needs 5 deliveries\./)
  // Nothing judged: a dash that says so.
  assert.match(cells.cell('onTimeCell', insight()), /title="No deliveries judged in the last 90 days\."[^>]*>—</)
  // L9-06: deliveries withheld for warehouses the reader cannot see are named.
  assert.match(cells.cell('onTimeCell', insight({ onTime: rate(1, 5, 5, 2) })), /2 deliveries received in warehouses you cannot see are left out\./)
  // Hidden for the role: a dash, never 0.
  assert.match(cells.cell('otifCell', insight({ otif: null })), /Hidden for your role/)
})

test('spend with amounts missing says it is incomplete instead of showing zero', async () => {
  const cells = await loadCells()
  // L9-17: no amount known at all reads "—", not $0.00.
  const none = cells.cell('spendCell', insight({ spend12m: [], spendComplete: false }))
  assert.equal(textOf(none), '—')
  assert.match(none, /have no amount on record/)
  // Some known: the total, marked incomplete.
  const some = cells.cell('spendCell', insight({ spend12m: [{ currency: 'USD', amount: 120 }], spendComplete: false }))
  assert.match(textOf(some), /\$120\.00 incomplete/)
  // Complete: the amount alone.
  assert.equal(textOf(cells.cell('spendCell', insight({ spend12m: [{ currency: 'USD', amount: 120 }] }))), '$120.00')
})

test('spend sorts the workspace currency first and never compares amounts across currencies', async () => {
  const { sortSuppliersBy, spendInOrder } = await loadCells()
  // L9-16: 90,000 yen is not more than 500 pounds.
  assert.deepEqual(spendInOrder([{ currency: 'GBP', amount: 500 }, { currency: 'JPY', amount: 90000 }], 'GBP').map((row) => row.currency), ['GBP', 'JPY'])
  assert.deepEqual(spendInOrder([{ currency: 'GBP', amount: 500 }, { currency: 'JPY', amount: 90000 }], 'JPY').map((row) => row.currency), ['JPY', 'GBP'])
  const rows = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, supplierName: `Supplier ${id}` }))
  const spend = {
    A: [{ currency: 'JPY', amount: 90000 }],
    B: [{ currency: 'GBP', amount: 500 }],
    C: [{ currency: 'GBP', amount: 900 }, { currency: 'USD', amount: 10 }],
    D: [{ currency: 'EUR', amount: 50 }],
    E: [],
  }
  const order = sortSuppliersBy(rows, 'spend', (id) => insight({ spend12m: spend[id] }), 'GBP').map((row) => row.id)
  assert.deepEqual(order, ['C', 'B', 'D', 'A', 'E'])
  // OTIF sorts the lowest first; a supplier without a rate goes last.
  const otif = { A: 0.9, B: 0.5, C: null }
  assert.deepEqual(sortSuppliersBy(rows.slice(0, 3), 'otif', (id) => insight({ otif: rate(otif[id], 1, 5) })).map((row) => row.id), ['B', 'A', 'C'])
})
