import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { decimalDifference, outboundPreviewSentences } from '../../src/modules/sales/outboundPreviewText.ts'
import { outboundEnglish } from '../../src/modules/sales/outboundCopy.ts'

// The reserve, delivery draft and shipment dialogs say what the server's
// preview will do in plain sentences, in English by default and in Chinese
// through the language setting. SKUs, units, warehouse names and locations pass
// through as stored; the page resolves warehouse ids to names.

const names = { 'WH-e48e0d48': 'Main Warehouse' }
const lookup = {
  place: (warehouseId, location) => `${names[warehouseId] || warehouseId} / ${location || 'Default location'}`,
  reservation: (id) => (id === 'res-1' ? { warehouseId: 'WH-e48e0d48', location: 'A-01', sku: 'VALVE-100', unit: 'EA' } : undefined),
  line: (id) => (id === 'line-1' ? { sku: 'VALVE-100', unit: 'EA' } : undefined),
  unit: (sku) => (sku === 'VALVE-100' ? 'EA' : undefined),
}

const reserve = {
  operation: 'reserve',
  allowed: true,
  normalizedPlan: { allocations: [{ salesOrderLineId: 'line-1', sku: 'VALVE-100', unit: 'EA', warehouseId: 'WH-e48e0d48', location: 'A-01', quantity: '10.0000' }] },
  balanceImpacts: [{ balanceId: 'bal-1' }],
  reservationImpacts: [],
}
const draft = {
  operation: 'create_shipment_draft',
  allowed: true,
  normalizedPlan: { shipmentNumber: 'SHIP-1001', lines: [{ salesOrderLineId: 'line-1', requestedQuantity: '10.0000', allocations: [{ reservationId: 'res-1', quantity: '10.0000' }] }] },
  balanceImpacts: [],
  reservationImpacts: [{ reservationId: 'res-1', quantity: '10.0000' }],
}
const post = {
  operation: 'post_shipment',
  allowed: true,
  normalizedPlan: { shipmentId: 'ship-1' },
  balanceImpacts: [{ sku: 'VALVE-100', warehouseId: 'WH-e48e0d48', location: 'A-01', onHandBefore: '25.0000', onHandAfter: '15.0000', reservedBefore: '10.0000', reservedAfter: '0.0000' }],
  reservationImpacts: [{ reservationId: 'res-1', quantity: '10.0000' }],
}

test('reserve, delivery draft and post previews read as plain English sentences', () => {
  assert.deepEqual(outboundPreviewSentences('en-US', reserve, lookup), [
    'Reserves 10 EA of VALVE-100 at Main Warehouse / A-01. Available stock there goes down by 10.',
  ])
  assert.deepEqual(outboundPreviewSentences('en-US', draft, lookup), [
    'Creates delivery SHIP-1001 for 10 EA of VALVE-100 from Main Warehouse / A-01. Stock does not change until the shipment is posted.',
  ])
  assert.deepEqual(outboundPreviewSentences('en-US', post, lookup), [
    'Ships 10 EA of VALVE-100 from Main Warehouse / A-01. On hand and reserved both go down by 10.',
  ])
})

test('the same previews in Chinese, with the same SKU, unit, warehouse and quantity', () => {
  assert.deepEqual(outboundPreviewSentences('zh-CN', reserve, lookup), ['在 Main Warehouse / A-01 预留 VALVE-100 10 EA。该库位可用量减少 10。'])
  assert.deepEqual(outboundPreviewSentences('zh-CN', draft, lookup), ['创建发货单 SHIP-1001：从 Main Warehouse / A-01 发出 VALVE-100 10 EA。发货过账前库存不变。'])
  assert.deepEqual(outboundPreviewSentences('zh-CN', post, lookup), ['从 Main Warehouse / A-01 发出 VALVE-100 10 EA。在库量和预留量各减少 10。'])
})

test('release, cancel and reverse previews name the reservation by its warehouse, never its id', () => {
  const release = { operation: 'release', allowed: true, normalizedPlan: { releases: [{ reservationId: 'res-1', quantity: '2.5000' }] }, balanceImpacts: [], reservationImpacts: [] }
  const cancel = { operation: 'cancel_shipment_draft', allowed: true, normalizedPlan: { shipmentId: 'ship-1' }, balanceImpacts: [], reservationImpacts: [{ reservationId: 'res-1', quantity: '10.0000' }] }
  const reverse = { ...post, operation: 'reverse_shipment', balanceImpacts: [{ ...post.balanceImpacts[0], onHandBefore: '15.0000', onHandAfter: '25.0000' }] }
  assert.deepEqual(outboundPreviewSentences('en-US', release, lookup), ['Releases 2.5 EA of VALVE-100 reserved at Main Warehouse / A-01. Available stock there goes up by 2.5.'])
  assert.deepEqual(outboundPreviewSentences('en-US', cancel, lookup), ['Cancels this delivery draft. 10 EA of VALVE-100 at Main Warehouse / A-01 stays reserved for the order.'])
  assert.deepEqual(outboundPreviewSentences('en-US', reverse, lookup), ['Returns 10 EA of VALVE-100 to Main Warehouse / A-01. On hand and reserved both go up by 10.'])
  for (const sentence of [release, cancel, reverse].flatMap((preview) => outboundPreviewSentences('en-US', preview, lookup))) {
    assert.doesNotMatch(sentence, /res-1|WH-e48e0d48|\{|\}/)
  }
})

test('a blocked preview has no sentences; the dialog shows why it is blocked', () => {
  assert.deepEqual(outboundPreviewSentences('en-US', { ...reserve, allowed: false }, lookup), [])
})

test('quantities are exact decimal differences in the shared quantity format', () => {
  assert.equal(decimalDifference('25.0000', '15.0000'), '10.0000')
  assert.equal(decimalDifference('0.5', '1.25'), '-0.75')
  assert.equal(decimalDifference('1234.5000', '0'), '1234.5000')
  assert.equal(decimalDifference('abc', '1'), '')
  const large = { ...post, balanceImpacts: [{ ...post.balanceImpacts[0], onHandBefore: '1500.0000', onHandAfter: '0.0000' }] }
  assert.match(outboundPreviewSentences('en-US', large, lookup)[0], /^Ships 1,500 EA of VALVE-100/)
})

test('every timeline title the order workbench API builds has an English label', async () => {
  const source = await readFile(new URL('./outbound-workbench-read-service.mjs', import.meta.url), 'utf8')
  const reservationEvents = ['已创建', '已释放', '已分配', '已取消分配', '已消耗', '已恢复', '已更新']
  for (const suffix of reservationEvents) assert.match(source, new RegExp(suffix))
  assert.match(source, /`库存预留\$\{/)
  for (const title of [...reservationEvents.map((suffix) => `库存预留${suffix}`), '发货出库流水已创建', '发货冲销流水已创建']) {
    assert.ok(outboundEnglish[title], `${title} needs an English label`)
    assert.doesNotMatch(outboundEnglish[title], /[㐀-鿿]/)
  }
  assert.match(source, /"发货出库流水已创建"/)
  assert.match(source, /"发货冲销流水已创建"/)
})

test('the sales dialogs have no unconditional Chinese confirm button, developer note or JSON dump', async () => {
  const source = await readFile(new URL('../../src/modules/sales/OutboundWorkbench.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /"确认执行"/)
  assert.doesNotMatch(source, /JSON\.stringify\(preview/)
  assert.doesNotMatch(source, /后端 API/)
  assert.doesNotMatch(source, /PostgreSQL 正式记录/)
  assert.doesNotMatch(source, /前端不计算权威库存/)
  for (const english of ['Reserve inventory', 'Create delivery draft', 'Post shipment']) assert.match(source, new RegExp(`say\\("${english}"`))
})
