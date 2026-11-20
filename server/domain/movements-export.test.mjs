import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchAllListRows } from '../../src/lib/listExport.ts'

// Product review 2026-11-20, item 30 (movements): movements come a page at a
// time from the server, so their export reads every page the filters match,
// with the server's total, and says when it is cut.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the movements export reads every page with the list\'s filters, and says when it is cut', async () => {
  const page = read('src/modules/inventory/Page.tsx')
  assert.match(page, /await fetchAllListRows<Movement>\(endpointFor\.movements\.url, filters, \{ itemsKey: endpointFor\.movements\.key \}\)/)
  for (const filter of ['if (query.trim()) filters.set("q", query.trim());', 'if (movementType) filters.set("movementType", movementType);', 'if (warehouse) filters.set("warehouseId", warehouse);']) assert.ok(page.includes(filter), filter)
  assert.match(page, /if \(truncated\) toast\.warning\(tr\("exportMovementsCut"\)/)
  assert.match(page, /\{view === "movements" && state === "ready" && <ExportButton onClick=\{\(\) => void exportMovements\(\)\} \/>\}/)
  assert.match(page, /exportMovementsCut: \["Exported the first \{shown\} of \{total\} movements\.[^"]*", "[^"]*\{total\}[^"]*\{shown\}[^"]*"\],/)
  // The reader on the movements route's answer ({ movements, total }), filters kept, cut at its limit.
  const asked = []
  const movements = Array.from({ length: 250 }, (_, at) => ({ movementId: `M${at}` }))
  const server = async (path) => {
    asked.push(path)
    const query = new URLSearchParams(path.split('?')[1])
    const size = Number(query.get('pageSize'))
    const start = (Number(query.get('page')) - 1) * size
    return { movements: movements.slice(start, start + size), total: movements.length }
  }
  const result = await fetchAllListRows('/api/inventory/movements', new URLSearchParams({ movementType: 'receipt' }), { itemsKey: 'movements', maxRows: 200, read: server })
  assert.deepEqual([result.rows.length, result.total, result.truncated], [200, 250, true])
  assert.ok(asked.every((path) => path.includes('movementType=receipt')))
})
