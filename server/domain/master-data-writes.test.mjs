import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { customerCreditStatus, customerInputIssues, itemInputIssues, saveItemMaster } from './master-data-commands.mjs'
import { supplierInputIssues } from './supplier-master-command.mjs'
import { createDbMasterDataRepository } from '../repositories/db-master-data-repository.mjs'
import { DATA_IMPORT_COLUMNS } from '../../shared/data-import-columns.mjs'

// Design audit C5: master data writes.
const root = resolve(import.meta.dirname, '../..')
const scope = { tenantId: 'T-1' }

// A stand-in transaction holding one item, recording what an update writes.
function itemTransaction(item) {
  const written = []
  const tx = {
    item: {
      findFirst: async () => item,
      update: async ({ data }) => { written.push(data); return { ...item, ...data } },
      create: async ({ data }) => { written.push(data); return data },
    },
    auditLog: { create: async () => ({}) },
  }
  return { prisma: { $transaction: async (work) => work(tx) }, written }
}

// L4-02: the edit form sent back the gaps the read filled in (pcs, 0, an MOQ
// of 1), and the server wrote a unit of pcs when none was sent.
test('changing only the name of an item writes no unit, category or number', async () => {
  const item = { id: 'ITEM-1', tenantId: 'T-1', sku: 'SKU-1', name: 'Valve', status: 'active', unit: null, category: null, safetyStock: null, reorderPoint: null, metadata: { version: 3 } }
  const { prisma, written } = itemTransaction(item)
  await saveItemMaster(prisma, 'ITEM-1', { itemName: 'Brass valve', expectedVersion: 3 }, 'U-1', scope)
  const data = written[0]
  assert.equal(data.name, 'Brass valve')
  assert.equal('unit' in data, false)
  assert.equal('baseUom' in data.metadata, false)
  assert.equal('safetyStock' in data, false)
  assert.equal('reorderPoint' in data, false)
  assert.equal(data.category, null)
  assert.equal('minimumOrderQuantity' in data.metadata, false)
  // An edit that sends no unit needs none, and keeps the stored one.
  assert.deepEqual(itemInputIssues({ itemName: 'Brass valve' }, item).issues, [])
  assert.equal(itemInputIssues({}, { ...item, unit: 'EA' }).values.unit, 'EA')
  // Sent empty, it is required; a new item needs one, none is made up (L4-20).
  assert.deepEqual(itemInputIssues({ baseUnit: '' }, item).issues.map((row) => row.code), ['UNIT_REQUIRED'])
  assert.ok(itemInputIssues({ sku: 'SKU-2', itemName: 'Pump' }).issues.some((row) => row.code === 'UNIT_REQUIRED'))
  // A unit that is sent is written.
  const sent = itemTransaction(item)
  await saveItemMaster(sent.prisma, 'ITEM-1', { baseUnit: 'EA', expectedVersion: 3 }, 'U-1', scope)
  assert.deepEqual([sent.written[0].unit, sent.written[0].metadata.baseUom], ['EA', 'EA'])
})

async function loadItemForm() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-item-form-'))
  const entry = `export { itemSaveBody } from './src/modules/master-data/ItemMasterWorkbench.tsx'`
  const result = await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'item-form-entry.tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' } })
  const file = join(directory, 'form.cjs')
  await writeFile(file, result.outputFiles[0].text)
  try { return (await import(pathToFileURL(file).href)).default } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the item form sends only the fields changed, and an emptied number as null', async () => {
  const { itemSaveBody } = await loadItemForm()
  const opened = { sku: 'SKU-1', itemName: 'Valve', baseUnit: '', category: '', safetyStock: '', reorderPoint: '12', minimumOrderQuantity: '', status: 'active', purchasable: true }
  assert.deepEqual(itemSaveBody({ ...opened, itemName: 'Brass valve' }, opened), { itemName: 'Brass valve' })
  assert.deepEqual(itemSaveBody({ ...opened, reorderPoint: '' }, opened), { reorderPoint: null })
  assert.deepEqual(itemSaveBody({ ...opened, safetyStock: '4' }, opened), { safetyStock: 4 })
  // The SKU is never sent on an edit; a new item sends what was filled in.
  assert.deepEqual(itemSaveBody({ ...opened, sku: 'OTHER' }, opened), {})
  assert.deepEqual(itemSaveBody({ ...opened, baseUnit: 'EA' }, null), { sku: 'SKU-1', itemName: 'Valve', baseUnit: 'EA', reorderPoint: 12, status: 'active', purchasable: true })
})

// L4-17: a supplier's code is the key imports match on.
test('a supplier code cannot change once the supplier exists', () => {
  const old = { code: 'SUP-001', name: 'Acme', status: 'active', metadata: { defaultCurrency: 'USD' } }
  const { issues, values } = supplierInputIssues({ supplierCode: 'SUP-999', supplierName: 'Acme' }, old)
  assert.deepEqual(issues.map((row) => row.code), ['CODE_LOCKED'])
  assert.equal(values.code, 'SUP-001')
  assert.deepEqual(supplierInputIssues({ supplierCode: 'SUP-001', supplierName: 'Acme' }, old).issues, [])
  assert.deepEqual(supplierInputIssues({ supplierName: 'Acme Ltd' }, old).values.code, 'SUP-001')
})

// L4-06, L4-26: a customer's country and credit standing are writable, and
// the standing is one of two codes.
test('a customer takes a country and a credit status of normal or restricted', () => {
  const { issues, values } = customerInputIssues({ code: 'C-1', name: 'Northwind', country: 'United Kingdom', creditStatus: 'restricted' })
  assert.deepEqual(issues, [])
  assert.deepEqual([values.text.country, values.text.creditStatus], ['United Kingdom', 'restricted'])
  assert.equal(customerInputIssues({ code: 'C-1', name: 'Northwind', creditStatus: '受限' }).values.text.creditStatus, 'restricted')
  assert.deepEqual(customerInputIssues({ code: 'C-1', name: 'Northwind', creditStatus: 'gold' }).issues.map((row) => row.code), ['CREDIT_STATUS_INVALID'])
  assert.equal(customerCreditStatus('正常'), 'normal')
  const columns = DATA_IMPORT_COLUMNS.customers.map((column) => column.key)
  assert.ok(columns.includes('country') && columns.includes('creditStatus'))
})

// L4-18: a name two records share found the first by id.
test('a lookup by a name two items share answers 409 with both, and a code still finds its item', async () => {
  const valves = [{ id: 'ITEM-A', sku: 'VALVE-A', name: 'Valve', tenantId: 'T-1', metadata: {} }, { id: 'ITEM-B', sku: 'VALVE-B', name: 'valve', tenantId: 'T-1', metadata: {} }]
  const prisma = { item: {
    findFirst: async ({ where }) => (where.sku?.equals === 'VALVE-B' ? valves[1] : null),
    findMany: async ({ where }) => (where.name ? valves : []),
  } }
  const env = { FLOWCHAIN_PERSISTENCE_MODE: 'database', DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain' }
  const repository = createDbMasterDataRepository({ env, prisma })
  await assert.rejects(repository.getItem('Valve', scope), (error) => error.status === 409 && error.code === 'NAME_AMBIGUOUS' && error.details.map((row) => row.code).join() === 'VALVE-A,VALVE-B')
  assert.equal((await repository.getItem('VALVE-B', scope)).sku, 'VALVE-B')
})
