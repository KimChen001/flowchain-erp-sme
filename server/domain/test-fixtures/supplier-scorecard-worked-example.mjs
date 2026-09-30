// The business rules worked example as real PO lines and posted receipts:
// one supplier, one quarter, 12 lines of 100 pcs, all originally promised for
// 2026-08-10 and none revised. It satisfies the scorecard definitions
// (server/domain/supplier-scorecard.mjs) and gives the example's figures:
//   on time  9 of 12 = 75.0%  (L10, L11, L12 first arrive 2, 5 and 8 days late)
//   in full 10 of 12 = 83.3%  (L11 and L12 were closed short)
//   OTIF     8 of 12 = 66.7%  (L9 was topped up after the promise, L10 was late)
//   rejected 30 of 1,200 received = 2.5%
//   average delay (2 + 5 + 8) / 3 = 5 days
export const WORKED_EXAMPLE_PROMISE = '2026-08-10'
export const WORKED_EXAMPLE_AS_OF = '2026-10-15'

const at = (day, time = '14:00:00') => new Date(`${day}T${time}Z`)
const promise = new Date(`${WORKED_EXAMPLE_PROMISE}T12:00:00Z`)

// [line, receipts as [arrival day, accepted, rejected], closed short on]
const plan = [
  ['L01', [['2026-08-09', 90, 10], ['2026-08-10', 10, 0]]], // 10 rejected, replaced by the promise
  ['L02', [['2026-08-10', 100, 0]]],
  ['L03', [['2026-08-10', 100, 0]]],
  ['L04', [['2026-08-08', 100, 0]]],
  ['L05', [['2026-08-10', 100, 0]]],
  ['L06', [['2026-08-09', 100, 0]]],
  ['L07', [['2026-08-10', 100, 0]]],
  ['L08', [['2026-08-10', 100, 0]]],
  ['L09', [['2026-08-10', 90, 10], ['2026-08-14', 10, 0]]], // on time, in full only after the promise
  ['L10', [['2026-08-12', 100, 0]]], // 2 days late, in full
  ['L11', [['2026-08-15', 80, 0]]], // 5 days late, closed short
  ['L12', [['2026-08-18', 90, 10]]], // 8 days late, 10 rejected, closed short
]
const closedShort = { L11: '2026-08-20', L12: '2026-08-25' }

export function workedExampleRows() {
  const purchaseOrder = {
    id: 'EXAMPLE-PO', tenantId: 'example-tenant', supplierId: 'EXAMPLE-SUP', supplierName: 'Example Supplier', currency: 'USD', status: 'partially_received', expectedDate: promise,
    lines: plan.map(([id]) => ({
      id: `EXAMPLE-${id}`, sku: 'EX-SKU', itemName: 'Example part', unit: 'pcs', orderedQuantity: 100, amount: 1000, originalPromisedDate: promise,
      metadata: { promisedDate: WORKED_EXAMPLE_PROMISE, ...(closedShort[id] ? { closedAt: closedShort[id], closeReason: 'Supplier cannot supply the balance' } : {}) },
    })),
  }
  const receipts = plan.flatMap(([id, lines]) => lines.map(([day, accepted, rejected], index) => ({
    id: `EXAMPLE-GRN-${id}-${index + 1}`, poId: purchaseOrder.id, supplierId: 'EXAMPLE-SUP', postingStatus: 'posted', arrivedAt: at(day),
    lines: [{ purchaseOrderLineId: `EXAMPLE-${id}`, acceptedQty: accepted, rejectedQty: rejected }],
  })))
  return { purchaseOrders: [purchaseOrder], receipts, suppliers: [{ id: 'EXAMPLE-SUP', name: 'Example Supplier' }] }
}
