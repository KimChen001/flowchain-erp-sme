import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let modulePromise

async function loadFormatModule() {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowchain-format-'))
    const outfile = path.join(dir, 'format.mjs')
    await build({
      entryPoints: ['src/lib/format.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    })
    const mod = await import(pathToFileURL(outfile).href)
    return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return modulePromise
}

test.after(async () => {
  if (!modulePromise) return
  const loaded = await modulePromise
  await loaded.cleanup()
})

test('currency amounts render as full comma-formatted values', async () => {
  const { mod } = await loadFormatModule()
  // fmt() never invents a currency symbol; it uses the currency the caller knows.
  assert.equal(mod.fmt(140000), '140,000')
  assert.equal(mod.fmt(140000, ''), '140,000')
  assert.equal(mod.fmt(140000, 'USD'), '$140,000.00')
  assert.equal(mod.fmt(140000, 'CNY'), 'CN¥140,000.00')
  // Missing currency must not invent CNY; explicit document currencies remain authoritative.
  assert.equal(mod.formatCurrencyAmount(1280000), '1,280,000')
  assert.equal(mod.formatCurrencyAmount(12345.67, 'USD'), '$12,345.67')
  assert.equal(mod.formatCurrencyAmount(12345.67, 'CNY'), 'CN¥12,345.67')
  assert.equal(mod.formatCurrencyAmount(12345.67, 'EUR'), '€12,345.67')
  // A missing or hidden amount is a dash, never 0; a real zero stays 0.
  assert.equal(mod.formatCurrencyAmount(null), '—')
  assert.equal(mod.formatCurrencyAmount(undefined, 'USD'), '—')
  assert.equal(mod.formatCurrencyAmount(0, 'USD'), '$0.00')
  assert.equal(mod.fmt('125.50', 'USD'), '$125.50')
})

test('number amount formatter handles invalid values safely', async () => {
  const { mod } = await loadFormatModule()
  assert.equal(mod.formatNumberAmount(Number.NaN), '—')
  assert.equal(mod.formatNumberAmount(''), '—')
  assert.equal(mod.formatNumberAmount(0), '0')
  assert.equal(mod.formatNumberAmount(12500.556, { maximumFractionDigits: 1 }), '12,500.6')
})
