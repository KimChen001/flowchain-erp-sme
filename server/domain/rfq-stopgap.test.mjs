import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { mapRfq, rfqSupplierCounts } from '../repositories/db-procurement-read-repository.mjs'
import { buildProcurementRfqs } from './procurement-read-model.mjs'
import { buildTodayWork } from './today-work.mjs'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

// Design audit batch A7, the RFQ stop-gap. An RFQ cannot yet become a purchase
// order, so the assistant no longer leads into one (ai-assistant-v2-ui-tools
// tests), an RFQ can be opened and cancelled from its page, cancelling it lets
// the request be ordered (tests/postgres/procurement-db-flow.test.mjs), and
// the RFQ pages say so.

// L1-32 = L12-01: the header counts were written once (responses 0) and read
// as real values, so every RFQ showed no responses.
test('an RFQ counts its invited suppliers and responses from its participation records', () => {
  const record = { id: 'RFQ-1', supplierCount: 3, respondedSupplierCount: 0, metadata: {} }
  const participations = [
    { rfqId: 'RFQ-1', supplierId: 'SUP-A', status: 'response_recorded' },
    { rfqId: 'RFQ-1', supplierId: 'SUP-B', status: 'invited_internal' },
    { rfqId: 'RFQ-1', supplierId: 'SUP-C', status: 'invited_internal' },
    { rfqId: 'RFQ-2', supplierId: 'SUP-A', status: 'response_recorded' },
  ]
  // SUP-B has a quotation on record without its participation updated yet.
  const quotations = [{ rfqId: 'RFQ-1', supplierId: 'SUP-B' }, { rfqId: 'RFQ-2', supplierId: 'SUP-C' }]
  assert.deepEqual(rfqSupplierCounts(record, quotations, participations), { suppliers: 3, quoted: 2 })
  const mapped = mapRfq(record, quotations, participations)
  assert.deepEqual([mapped.suppliers, mapped.quoted], [3, 2])
  const [row] = buildProcurementRfqs({ rfqs: [mapped] })
  assert.deepEqual([row.supplierCount, row.respondedSupplierCount, row.pendingSupplierCount], [3, 2, 1])
  // Without participation records: the suppliers that quoted, never the stale 0.
  assert.deepEqual(rfqSupplierCounts({ id: 'RFQ-3', supplierCount: 2, respondedSupplierCount: 0 }, [{ rfqId: 'RFQ-3', supplierId: 'SUP-A' }]), { suppliers: 2, quoted: 1 })
})

test('the RFQ list and detail carry the version that opening or cancelling checks', () => {
  const [row] = buildProcurementRfqs({ rfqs: [mapRfq({ id: 'RFQ-1', status: 'draft', metadata: { version: 2 } })] })
  assert.equal(row.version, 2)
})

// L11-06: Today suggested turning a request into a purchase order while its
// RFQ was open, which the command refuses (409).
test('Today does not suggest ordering a request while its RFQ is open', () => {
  const now = new Date('2026-11-15T15:00:00Z')
  const request = (id) => ({ id, number: id, status: 'approved', requiredDate: '2026-11-20' })
  const kinds = (rfqs) => buildTodayWork({ purchaseRequests: [request('PR-1'), request('PR-2')], rfqs }, { now, timeZone: 'America/New_York' }).all
    .filter((row) => row.kind === 'purchase_request_to_convert').map((row) => row.label)
  assert.deepEqual(kinds([]), ['PR-1', 'PR-2'])
  assert.deepEqual(kinds([{ id: 'RFQ-1', status: 'open', linkedPr: 'PR-1' }]), ['PR-2'])
  assert.deepEqual(kinds([{ id: 'RFQ-1', status: 'draft', sourceRequest: 'PR-2' }]), ['PR-1'])
  // Once the RFQ is cancelled or closed, the request is ordered again.
  assert.deepEqual(kinds([{ id: 'RFQ-1', status: 'cancelled', linkedPr: 'PR-1' }, { id: 'RFQ-2', status: 'closed', linkedPr: 'PR-2' }]), ['PR-1', 'PR-2'])
})

test('the RFQ page has Open and Cancel, and the RFQ pages say an RFQ cannot become a purchase order yet', async () => {
  const detail = await read('src/modules/procurement/CanonicalRfqDetailPage.tsx')
  assert.match(detail, /canOpen = canTransition && record\.status === "draft"/)
  assert.match(detail, /CANCELLABLE_RFQ = \["draft", "open", "collecting_quotes"\]/)
  assert.match(detail, /procurementApi\.transitionRfq\(record\.id \|\| "", action, \{ expectedVersion: version/)
  assert.match(detail, /data-testid="rfq-open-button"/)
  assert.match(detail, /data-testid="rfq-cancel-button"/)
  assert.match(detail, /effectivePermissionCodes\.has\("procurement\.purchase_order\.revise"\)/)
  for (const page of ['CanonicalRfqDetailPage', 'RfqListPage', 'CanonicalRfqComparisonPage']) {
    assert.match(await read(`src/modules/procurement/${page}.tsx`), /<RfqNoOrderNote \/>/, page)
  }
  const note = await read('src/modules/procurement/RfqNoOrderNote.tsx')
  assert.match(note, /It cannot be turned into a purchase order yet/)
  assert.match(note, /目前还不能直接转成采购订单/)
  const list = await read('src/modules/procurement/RfqListPage.tsx')
  assert.match(list, /row\.status === "open" \|\| row\.status === "collecting_quotes"/)
})
