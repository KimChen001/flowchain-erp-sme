import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    return { mod, outfile, cleanup: () => rm(dir, { recursive: true, force: true }) }
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

// Date-only values (due dates, promised dates) are stored as UTC midnight. Read
// in a browser's local time west of UTC, 2026-11-06 showed as "Nov 5, 2026". The
// check runs in a child process on New York time, so a UTC machine cannot hide it.
function formatInNewYork(outfile, calls) {
  const script = [
    'const mod = await import(' + JSON.stringify(pathToFileURL(outfile).href) + ')',
    'const calls = ' + JSON.stringify(calls),
    'const value = (v) => v && v.date ? new Date(v.date) : v',
    'const local = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date("2026-11-06T00:00:00.000Z"))',
    'const shown = calls.map(([value_, locale, options]) => mod.formatCalendarDay(value(value_), locale, options))',
    'console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, local, shown }))',
  ].join('\n')
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' },
    encoding: 'utf8',
  })
  return JSON.parse(output)
}

test('calendar days show the day entered, also west of UTC', async () => {
  const { outfile } = await loadFormatModule()
  const result = formatInNewYork(outfile, [
    ['2026-11-06T00:00:00.000Z', 'en-US'],
    ['2026-11-06', 'en-US'],
    [{ date: '2026-11-06T00:00:00.000Z' }, 'en-US'],
    ['2026-11-06T00:00:00.000Z', 'zh-CN'],
    ['2026-01-01T00:00:00.000Z', 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }],
    [null, 'en-US'],
    ['', 'en-US'],
    ['next week', 'en-US'],
  ])
  // The child really runs on New York time: local formatting shows the day before.
  assert.equal(result.zone, 'America/New_York')
  assert.equal(result.local, 'Nov 5, 2026')
  assert.deepEqual(result.shown, [
    'Nov 6, 2026',
    'Nov 6, 2026',
    'Nov 6, 2026',
    '2026年11月6日',
    'Jan 1, 2026',
    '—',
    '—',
    'next week',
  ])
})

test('customer invoice and receivable due dates are shown as calendar days', async () => {
  const source = await readFile(new URL('../../src/modules/finance/OperationalFinanceO2cWorkbench.tsx', import.meta.url), 'utf8')
  assert.equal((source.match(/formatCalendarDay\(\w+\.dueDate, locale\)/g) || []).length, 4)
  // No local-time date formatting is left on the page.
  assert.doesNotMatch(source, /new Intl\.DateTimeFormat\(locale, \{ dateStyle: "medium" \}\)/)
})
