import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchAllListRows } from '../../src/lib/listExport.ts'

// Design audit U-14 (1): the lists other than purchase orders and requests
// (receipts, supplier invoices, customer invoices, shipments, RFQs) export
// their results too, every row the filters match, as the PO and request lists
// already did.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('a list the server pages is read page after page, with its filters, until the total', async () => {
  const asked = []
  const rows = Array.from({ length: 230 }, (_, index) => ({ id: index + 1 }))
  const server = async (path) => {
    asked.push(path)
    const query = new URLSearchParams(path.split('?')[1])
    const page = Number(query.get('page'))
    const size = Number(query.get('pageSize'))
    return { items: rows.slice((page - 1) * size, page * size), total: rows.length }
  }
  const result = await fetchAllListRows('/api/finance/customer-invoices', new URLSearchParams({ status: 'issued', page: '3' }), { read: server })
  assert.equal(result.rows.length, 230)
  assert.equal(result.total, 230)
  assert.equal(result.truncated, false)
  // Every page asked once, 100 at a time (the servers' limit), filters kept,
  // and the page on screen does not decide where the export starts.
  assert.deepEqual(asked, [1, 2, 3].map((page) => `/api/finance/customer-invoices?status=issued&page=${page}&pageSize=100`))
  // The shipments list answers `shipments`, not `items`.
  const shipments = await fetchAllListRows('/api/sales/shipments', new URLSearchParams(), { itemsKey: 'shipments', read: async () => ({ shipments: [{ id: 'DN-1' }], total: 1 }) })
  assert.deepEqual(shipments.rows, [{ id: 'DN-1' }])
  // A list longer than the cap says it was cut.
  const capped = await fetchAllListRows('/x', new URLSearchParams(), { maxRows: 150, read: server })
  assert.equal(capped.rows.length, 150)
  assert.equal(capped.truncated, true)
})

test('each of the five lists has the Export results button and exports what its filters match', () => {
  const cases = [
    ['src/modules/procurement/ReceivingListPage.tsx', /<ExportButton onClick=\{\(\) => void exportReceipts\(\)\} \/>/, /exportRowsToCsv\("receipts-export\.csv", shown\.map/],
    ['src/modules/procurement/RfqListPage.tsx', /<ExportButton onClick=\{\(\) => void exportRfqs\(\)\} \/>/, /exportRowsToCsv\("rfqs-export\.csv", shown\.map/],
    ['src/modules/finance/OperationalFinanceP2pWorkbench.tsx', /<ExportButton onClick=\{\(\) => void exportInvoices\(\)\} \/>/, /fetchAllListRows<Record<string, any>>\(endpoint, filters\)[\s\S]*exportRowsToCsv\("supplier-invoices-export\.csv"/],
    ['src/modules/finance/OperationalFinanceO2cWorkbench.tsx', /<ExportButton onClick=\{\(\) => void exportInvoices\(\)\} \/>/, /fetchAllListRows<Invoice>\("\/api\/finance\/customer-invoices", filters\)[\s\S]*exportRowsToCsv\("customer-invoices-export\.csv"/],
    ['src/modules/sales/OutboundWorkbench.tsx', /<ExportButton onClick=\{\(\) => void exportShipments\(\)\} \/>/, /fetchAllListRows<ShipmentRow>\("\/api\/sales\/shipments", filters, \{ itemsKey: "shipments" \}\)[\s\S]*exportRowsToCsv\("shipments-export\.csv"/],
  ]
  for (const [file, button, rows] of cases) {
    const source = read(file)
    assert.match(source, button, file)
    assert.match(source, rows, file)
  }
  // The supplier invoice export is on the supplier invoice search, not the payables one.
  const p2p = read('src/modules/finance/OperationalFinanceP2pWorkbench.tsx')
  assert.ok(p2p.indexOf('<ExportButton onClick={() => void exportInvoices()} />') < p2p.indexOf('data-testid="supplier-invoice-new"'))
  // Dates are the workspace's calendar day; headers come in both languages.
  assert.match(read('src/modules/sales/OutboundWorkbench.tsx'), /instantDayInTimeZone\(value, timezone\)/)
  assert.match(read('src/modules/procurement/RfqListPage.tsx'), /exportCategory: \["Category", "类别"\]/)
})
