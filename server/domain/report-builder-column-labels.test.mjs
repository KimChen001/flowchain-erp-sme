import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { getRuntimeReportCatalog } from './runtime-report-read-model.mjs'

// The report builder named its supplier column "Suppliers": the column's
// label 供应商 was looked up in the same entry as the Suppliers subject. Each
// column now has its own entry, keyed by the catalog field key, so a column
// reads singular and a subject plural. Catalog keys and labels are unchanged.

let loaded
async function copyModule() {
  loaded ||= (async () => {
    await mkdir(path.resolve('node_modules/.cache'), { recursive: true })
    const dir = await mkdtemp(path.resolve('node_modules/.cache/flowchain-report-columns-'))
    const outfile = path.join(dir, 'reportLibraryCopy.mjs')
    await build({ entryPoints: ['src/modules/reports/reportLibraryCopy.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return (await loaded).module
}
test.after(async () => { if (loaded) await (await loaded).cleanup() })

const SINGULAR = { supplier: 'Supplier', customer: 'Customer', item: 'Item' }
const PLURAL_SUBJECTS = { purchase_orders: 'Purchase orders', sales_orders: 'Sales orders', inventory_balances: 'Inventory balances', supplier_invoices: 'Supplier invoices', suppliers: 'Suppliers' }

test('builder columns read singular and subjects plural, in English; Chinese is unchanged', async () => {
  const { reportColumnLabel, reportLibraryCopy, REPORT_COLUMN_LABELS } = await copyModule()
  const catalog = getRuntimeReportCatalog()
  const subjectNames = new Set(catalog.subjects.map((subject) => reportLibraryCopy(subject.label, 'en-US')))
  for (const subject of catalog.subjects) {
    const fields = catalog.fields[subject.id]
    // Every subject offers the supplier and customer columns.
    for (const key of ['supplier', 'customer']) assert.ok(fields.some((field) => field.key === key), `${subject.id} ${key}`)
    for (const field of fields) {
      // Each column has its own entry; none borrows a subject's name.
      assert.ok(Object.hasOwn(REPORT_COLUMN_LABELS, field.key), `${subject.id} ${field.key} has its own entry`)
      const english = reportColumnLabel(field, 'en-US')
      if (Object.hasOwn(SINGULAR, field.key)) assert.equal(english, SINGULAR[field.key], `${subject.id} ${field.key}`)
      assert.ok(!subjectNames.has(english), `${subject.id} ${field.key} reads "${english}", a subject name`)
      // The Chinese interface shows the catalog's own label, as before.
      assert.equal(reportColumnLabel(field, 'zh-CN'), field.label, `${subject.id} ${field.key} in Chinese`)
    }
  }
  // The subjects keep their plural names, and their Chinese.
  for (const [id, name] of Object.entries(PLURAL_SUBJECTS)) {
    const subject = catalog.subjects.find((entry) => entry.id === id)
    assert.equal(reportLibraryCopy(subject.label, 'en-US'), name, id)
    assert.equal(reportLibraryCopy(subject.label, 'zh-CN'), subject.label, `${id} in Chinese`)
  }
  // The catalog identifiers and labels the views store are unchanged.
  assert.deepEqual(catalog.fields.suppliers.map((field) => [field.key, field.label]).slice(2, 4), [['supplier', '供应商'], ['customer', '客户']])
})
