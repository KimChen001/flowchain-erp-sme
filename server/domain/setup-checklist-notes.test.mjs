import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { firstRunSetupSteps } from './today-work.mjs'
import { readFirstRunSetupCounts } from './first-run-setup.mjs'

// Product review 2026-11-20, item 22: the checklist could read 4 of 5 with no
// item linked to a supplier (so no purchase request can name one), and showed
// "Not started" for opening stock that was imported but not posted.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const all = { items: true, suppliers: true, customers: true, openingStock: true, teammates: true }
const counts = { items: 3, suppliers: 2, customers: 1, stockedItems: 0, activeUsers: 2, pendingInvitations: 0, itemSupplierLinks: 0, openingStockToPost: 4 }
const stepOf = (setup, id, options = {}) => firstRunSetupSteps(setup, { permissions: all, importEnabled: true, adjustmentsEnabled: true, ...options }).steps.find((step) => step.id === id)

test('suppliers but no item linked to one: the suppliers step says so and links to the item-supplier import', () => {
  assert.deepEqual(stepOf(counts, 'suppliers').note, { id: 'no_item_suppliers', href: '/app/master-data/import?type=item-suppliers' })
  // Without import, to the suppliers' pages; without item rights, no link.
  assert.equal(stepOf(counts, 'suppliers', { importEnabled: false }).note.href, '/app/master-data/suppliers')
  assert.equal(stepOf(counts, 'suppliers', { permissions: { ...all, items: false } }).note.href, null)
  // Once a link exists, or with no supplier yet, no note.
  assert.equal(stepOf({ ...counts, itemSupplierLinks: 1 }, 'suppliers').note, undefined)
  assert.equal(stepOf({ ...counts, suppliers: 0 }, 'suppliers').note, undefined)
  // Counts without the link figure (an older caller) add no note.
  assert.equal(stepOf({ ...counts, itemSupplierLinks: undefined }, 'suppliers').note, undefined)
})

test('opening stock imported but not posted reads as waiting to post, with the adjustments list', () => {
  const step = stepOf(counts, 'opening_stock')
  assert.deepEqual([step.done, step.note], [false, { id: 'opening_stock_to_post', count: 4, href: '/app/inventory/adjustments' }])
  assert.equal(stepOf(counts, 'opening_stock', { adjustmentsEnabled: false }).note.href, null)
  assert.equal(stepOf({ ...counts, stockedItems: 5 }, 'opening_stock').note, undefined)
  assert.equal(stepOf({ ...counts, openingStockToPost: 0 }, 'opening_stock').note, undefined)
  // Still five steps, done as before.
  assert.equal(firstRunSetupSteps(counts, { permissions: all }).total, 5)
})

test('the counts read the item-supplier links and the unposted opening-stock adjustments, in the workspace', async () => {
  const calls = []
  const counter = (name, value) => ({ count: async (args) => { calls.push([name, args.where]); return value } })
  const prisma = {
    item: counter('item', 3), supplier: counter('supplier', 2), runtimeRecord: counter('runtimeRecord', 0), inventoryBalance: counter('inventoryBalance', 0),
    user: counter('user', 1), workspaceInvitation: counter('workspaceInvitation', 0), inventoryAdjustmentDocument: counter('inventoryAdjustmentDocument', 4),
  }
  const result = await readFirstRunSetupCounts(prisma, { tenantId: 'T1', now: new Date('2026-11-20T00:00:00Z') })
  assert.deepEqual([result.itemSupplierLinks, result.openingStockToPost], [0, 4])
  assert.deepEqual(calls.find(([name, where]) => name === 'runtimeRecord' && where.namespace === 'master-data.item-suppliers')?.[1], { tenantId: 'T1', namespace: 'master-data.item-suppliers' })
  assert.deepEqual(calls.find(([name]) => name === 'inventoryAdjustmentDocument')[1], { tenantId: 'T1', reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: { in: ['draft', 'ready'] } })
})

test('Today shows the notes, in both languages', () => {
  const page = read('src/modules/overview/Page.tsx')
  assert.match(page, /data-testid=\{`first-run-note-\$\{step\.note\.id\}`\}/)
  assert.match(page, /step\.note\?\.id === "opening_stock_to_post" \? t\("stepToPost", \{ n: step\.note\.count \?\? 0 \}\)/)
  const copy = read('src/modules/overview/todayCopy.ts')
  for (const [key, english, chinese] of [
    ['stepToPost', 'Waiting to post ({n})', '待过账（{n}）'], ['noteLinkItems', 'Link items to suppliers', '为物料关联供应商'], ['notePost', 'Post them', '去过账'],
  ]) {
    assert.ok(copy.includes(`${key}: "${english}",`), key)
    assert.ok(copy.includes(`${key}: "${chinese}",`), key)
  }
})
