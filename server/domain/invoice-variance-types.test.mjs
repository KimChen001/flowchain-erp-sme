import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { INVOICE_VARIANCE_TYPES } from './invoice-matching-review.mjs'

let loaded

async function load() {
  if (loaded) return loaded
  loaded = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowchain-variance-types-'))
    const outfile = path.join(dir, 'variance-types.mjs')
    await build({ entryPoints: ['src/domain/procurement/variance-types.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return { mod: await import(pathToFileURL(outfile).href), cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return loaded
}

test.after(async () => {
  if (loaded) await (await loaded).cleanup()
})

test('every server variance code has an English and a Chinese label', async () => {
  const { mod } = await load()
  for (const code of [...INVOICE_VARIANCE_TYPES, 'amount_variance']) {
    const english = mod.invoiceVarianceLabel(code, 'en-US')
    const chinese = mod.invoiceVarianceLabel(code, 'zh-CN')
    assert.notEqual(english, code, `${code} has an English label`)
    assert.doesNotMatch(english, /[\u3400-\u9fff]/, `${code} English label`)
    assert.match(chinese, /[\u3400-\u9fff]/, `${code} Chinese label`)
  }
  assert.equal(mod.invoiceVarianceLabel('price_variance', 'en-US'), 'Price variance')
  assert.equal(mod.invoiceVarianceLabel('price_variance', 'zh-CN'), '价格差异')
  assert.equal(mod.invoiceVarianceLabel('none', 'en-US'), 'No variance')
})

test('legacy Chinese values resolve to the same code, label and filter option', async () => {
  const { mod } = await load()
  for (const [legacy, code] of [['价格差异', 'price_variance'], ['金额差异', 'amount_variance'], ['无差异', 'none'], ['缺少收货', 'missing_grn'], ['重复发票', 'duplicate_invoice']]) {
    assert.equal(mod.invoiceVarianceCode(legacy), code)
    assert.equal(mod.invoiceVarianceLabel(legacy, 'en-US'), mod.invoiceVarianceLabel(code, 'en-US'))
    assert.ok(mod.matchesInvoiceVarianceFilter(legacy, code), `${legacy} matches the ${code} filter`)
    assert.ok(mod.matchesInvoiceVarianceFilter(code, code))
  }
  assert.ok(mod.isNoInvoiceVariance('none'))
  assert.ok(mod.isNoInvoiceVariance('无差异'))
  assert.ok(!mod.isNoInvoiceVariance('price_variance'))
  assert.ok(!mod.matchesInvoiceVarianceFilter('price_variance', 'quantity_variance'))
  assert.ok(mod.matchesInvoiceVarianceFilter('price_variance', 'all'))
  // Free text that is not a known type is shown as it is, not hidden.
  assert.equal(mod.invoiceVarianceLabel('Freight surcharge', 'en-US'), 'Freight surcharge')
})
