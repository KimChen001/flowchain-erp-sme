import test from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessReadContextService } from '../services/business-read-context-service.mjs'
import { orderHasOpenDemand } from '../repositories/db-sales-order-read-repository.mjs'
import { stockTruncatedSubjects } from './reorder-list-read-service.mjs'
import { tenantCalendarDay } from './tenant-calendar-day.mjs'

const shipped = (id) => ({ id, workflowStatus: 'confirmed', fulfillmentStatus: 'fully_fulfilled', lines: [] })
const open = (id) => ({ id, workflowStatus: 'confirmed', fulfillmentStatus: 'not_fulfilled', lines: [] })

// A workspace whose sales order read stops at `read` orders; openTotal is what
// the database counts as still needing stock.
function contextWith({ read, openTotal }) {
  const repositories = {
    salesOrders: {
      async listOrders(scope) {
        scope.onTruncated({ subject: 'sales_orders', limit: read.length })
        return read
      },
      async countOrdersWithOpenDemand() { return openTotal },
    },
  }
  return createBusinessReadContextService({ repositories, dataMode: 'user' }).read({ tenantId: 'tenant-a' })
}

test('sales orders cut only from history do not make stock views warn', async () => {
  const context = await contextWith({ read: [shipped('SO-3'), open('SO-2')], openTotal: 1 })
  const entry = context.truncatedSubjects.find((row) => row.subject === 'sales_orders')
  assert.equal(entry.openDemandComplete, true)
  assert.deepEqual(stockTruncatedSubjects(context.truncatedSubjects), [])
})

test('an open order left out of the read keeps the stock views warning', async () => {
  const context = await contextWith({ read: [shipped('SO-3'), open('SO-2')], openTotal: 2 })
  const entry = context.truncatedSubjects.find((row) => row.subject === 'sales_orders')
  assert.equal(entry.openDemandComplete, undefined)
  assert.deepEqual(stockTruncatedSubjects(context.truncatedSubjects).map((row) => row.subject), ['sales_orders'])
})

test('stock views keep the truncations that change a position', () => {
  const entries = [
    { subject: 'inventory_items', limit: 10 },
    { subject: 'purchase_orders', limit: 10 },
    { subject: 'customers', limit: 10 },
    { subject: 'sales_orders', limit: 10, openDemandComplete: true },
  ]
  assert.deepEqual(stockTruncatedSubjects(entries).map((row) => row.subject), ['inventory_items', 'purchase_orders'])
  assert.deepEqual(stockTruncatedSubjects(undefined), [])
  assert.equal(orderHasOpenDemand({ workflowStatus: 'confirmed', fulfillmentStatus: 'partially_fulfilled' }), true)
  assert.equal(orderHasOpenDemand({ workflowStatus: 'draft', fulfillmentStatus: 'not_fulfilled' }), false)
  assert.equal(orderHasOpenDemand({ workflowStatus: 'cancelled', fulfillmentStatus: 'not_fulfilled' }), false)
  assert.equal(orderHasOpenDemand({ workflowStatus: 'confirmed', fulfillmentStatus: 'fully_fulfilled' }), false)
})

test('the tenant calendar day is the same from a cached formatter', () => {
  const instant = new Date('2026-11-07T03:30:00Z')
  assert.equal(tenantCalendarDay(instant, 'America/Los_Angeles'), '2026-11-06')
  assert.equal(tenantCalendarDay(instant, 'Europe/London'), '2026-11-07')
  assert.equal(tenantCalendarDay(instant, 'America/Los_Angeles'), '2026-11-06')
  assert.equal(tenantCalendarDay(instant, 'Not/AZone'), '2026-11-06')
})
