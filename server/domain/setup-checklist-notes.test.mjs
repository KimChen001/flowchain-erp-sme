import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { firstRunSetupSteps } from './today-work.mjs'
import { readFirstRunSetupCounts } from './first-run-setup.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'

// Product review 2026-11-20, item 22: the checklist could read 4 of 5 with no
// item linked to a supplier (so no purchase request can name one), and showed
// "Not started" for opening stock that was drafted but not posted.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const all = { items: true, suppliers: true, customers: true, openingStock: true, postOpeningStock: true, teammates: true }
const counts = { items: 3, suppliers: 2, customers: 1, stockedItems: 0, activeUsers: 2, pendingInvitations: 0, itemSupplierSources: 0, openingStockToPost: 4 }
const stepOf = (setup, id, options = {}) => firstRunSetupSteps(setup, { permissions: all, importEnabled: true, adjustmentsEnabled: true, ...options }).steps.find((step) => step.id === id)

test('suppliers but no item can name one: the suppliers step says so and links to the item-supplier import', () => {
  assert.deepEqual(stepOf(counts, 'suppliers').note, { id: 'no_item_suppliers', href: '/app/master-data/import?type=item-suppliers' })
  // Without import, to the suppliers' pages; without item rights, no link.
  assert.equal(stepOf(counts, 'suppliers', { importEnabled: false }).note.href, '/app/master-data/suppliers')
  assert.equal(stepOf(counts, 'suppliers', { permissions: { ...all, items: false } }).note.href, null)
  // Once an item can name a supplier, or with no supplier yet, no note.
  assert.equal(stepOf({ ...counts, itemSupplierSources: 1 }, 'suppliers').note, undefined)
  assert.equal(stepOf({ ...counts, suppliers: 0 }, 'suppliers').note, undefined)
  // Counts without the figure (an older caller) add no note.
  assert.equal(stepOf({ ...counts, itemSupplierSources: undefined }, 'suppliers').note, undefined)
})

test('opening stock drafted but not posted reads as waiting to post; the link only for those who may post', () => {
  const step = stepOf(counts, 'opening_stock')
  assert.deepEqual([step.done, step.note], [false, { id: 'opening_stock_to_post', count: 4, href: '/app/inventory/adjustments' }])
  assert.equal(stepOf(counts, 'opening_stock', { adjustmentsEnabled: false }).note.href, null)
  // A reader who may not post (a read-only viewer) gets the note without the link (#413 review).
  assert.equal(stepOf(counts, 'opening_stock', { permissions: { ...all, postOpeningStock: false } }).note.href, null)
  assert.equal(stepOf({ ...counts, stockedItems: 5 }, 'opening_stock').note, undefined)
  assert.equal(stepOf({ ...counts, openingStockToPost: 0 }, 'opening_stock').note, undefined)
  // Still five steps.
  assert.equal(firstRunSetupSteps(counts, { permissions: all }).total, 5)
})

test('the post permission comes from the reader\'s roles', () => {
  const actorWith = (codes) => ({ tenantId: 'T1', complete: true, authenticated: true, permissionCodes: new Set(codes), roleIds: [], permissionSourceRoleIds: new Map(), allWarehouses: true })
  assert.equal(reportReadAccessFor(actorWith(['inventory.adjustment.create', 'inventory.adjustment.post'])).home.setup.postOpeningStock, true)
  assert.equal(reportReadAccessFor(actorWith(['inventory.adjustment.read'])).home.setup.postOpeningStock, false)
})

test('the counts read active item-supplier links, items with a preferred supplier and unposted opening-stock drafts, in the workspace', async () => {
  const calls = []
  const counter = (name, value) => ({ count: async (args) => { calls.push([name, 'count', args.where]); return typeof value === 'function' ? value(args.where) : value } })
  const prisma = {
    item: counter('item', (where) => (where.preferredSupplierId ? 1 : 3)), supplier: counter('supplier', 2), inventoryBalance: counter('inventoryBalance', 0),
    user: counter('user', 1), workspaceInvitation: counter('workspaceInvitation', 0), inventoryAdjustmentDocument: counter('inventoryAdjustmentDocument', 4),
    runtimeRecord: {
      count: async (args) => { calls.push(['runtimeRecord', 'count', args.where]); return 0 },
      findMany: async (args) => { calls.push(['runtimeRecord', 'findMany', args.where]); return [{ payload: { active: true } }, { payload: { active: false } }, { payload: {} }] },
    },
  }
  const result = await readFirstRunSetupCounts(prisma, { tenantId: 'T1', now: new Date('2026-11-20T00:00:00Z') })
  // Two active links (a missing flag is active) and one item with a preferred supplier; the inactive link is not a source.
  assert.deepEqual([result.itemSupplierSources, result.openingStockToPost], [3, 4])
  assert.deepEqual(calls.find(([name, method]) => name === 'runtimeRecord' && method === 'findMany')[2], { tenantId: 'T1', namespace: 'master-data.item-suppliers' })
  assert.deepEqual(calls.find(([name, , where]) => name === 'item' && where.preferredSupplierId)[2], { tenantId: 'T1', preferredSupplierId: { not: null } })
  assert.deepEqual(calls.find(([name]) => name === 'inventoryAdjustmentDocument')[2], { tenantId: 'T1', reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: { in: ['draft', 'ready'] } })
})

test('Today shows the notes, hides Start while drafts wait, in both languages', () => {
  const page = read('src/modules/overview/Page.tsx')
  assert.match(page, /data-testid=\{`first-run-note-\$\{step\.note\.id\}`\}/)
  assert.match(page, /step\.note\?\.id === "opening_stock_to_post" \? t\("stepToPost", \{ n: step\.note\.count \?\? 0 \}\)/)
  assert.match(page, /\{!step\.done && step\.note\?\.id !== "opening_stock_to_post" \? \(step\.href \? <Link/)
  const copy = read('src/modules/overview/todayCopy.ts')
  for (const [key, english, chinese] of [
    ['stepToPost', 'Waiting to post ({n} drafts)', '待过账（{n} 张草稿）'], ['noteOpeningStockToPost', 'Drafted, not in stock until the adjustments are posted.', '已起草，库存调整过账后才计入库存。'],
    ['noteLinkItems', 'Link items to suppliers', '为物料关联供应商'], ['notePost', 'Post them', '去过账'],
  ]) {
    assert.ok(copy.includes(`${key}: "${english}",`), key)
    assert.ok(copy.includes(`${key}: "${chinese}",`), key)
  }
})
