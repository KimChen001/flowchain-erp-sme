import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let loaded

async function loadCopyModule() {
  if (loaded) return loaded.mod
  const dir = await mkdtemp(path.join(tmpdir(), 'master-data-copy-'))
  const outfile = path.join(dir, 'copy.mjs')
  await build({
    entryPoints: ['src/modules/master-data/masterDataCopy.ts'],
    outfile, bundle: true, platform: 'node', format: 'esm',
    external: ['react', 'react-dom'], logLevel: 'silent', jsx: 'automatic',
  })
  loaded = { mod: await import(pathToFileURL(outfile).href), cleanup: () => rm(dir, { recursive: true, force: true }) }
  return loaded.mod
}

test.after(async () => { await loaded?.cleanup() })

test('tax rates keep every stored digit instead of rounding to whole percent', async () => {
  const { formatPercent } = await loadCopyModule()
  assert.equal(formatPercent(0.0825, 'en-US'), '8.25%')
  assert.equal(formatPercent(0.0738, 'en-US'), '7.38%')
  assert.equal(formatPercent(0, 'en-US'), '0%')
  assert.equal(formatPercent(Number.NaN, 'en-US'), '—')
})

test('tax types, due rules and statuses render in the active language', async () => {
  const { taxTypeLabel, dueDateRule, masterDataCopy, orNotProvided } = await loadCopyModule()
  assert.equal(taxTypeLabel('sales_tax', 'en-US'), 'Sales tax')
  assert.equal(taxTypeLabel('sales_tax', 'zh-CN'), '销售税')
  assert.equal(taxTypeLabel('exempt', 'en-US'), 'Exempt')
  assert.equal(taxTypeLabel('', 'en-US'), '—')
  assert.equal(taxTypeLabel('gst', 'en-US'), 'gst')
  assert.equal(dueDateRule(0, 'en-US'), 'Due on receipt')
  assert.equal(dueDateRule(30, 'en-US'), 'Due 30 days after the invoice date')
  assert.equal(dueDateRule(30, 'zh-CN'), '发票日期后 30 天到期')
  assert.equal(masterDataCopy('启用', 'en-US'), 'Active')
  assert.equal(masterDataCopy('冻结', 'en-US'), 'Frozen')
  assert.equal(masterDataCopy('Tax rate', 'zh-CN'), '税率')
  assert.equal(masterDataCopy('{count} need attention', 'en-US', { count: 2 }), '2 need attention')
  assert.equal(masterDataCopy('{count} need attention', 'zh-CN', { count: 2 }), '2 个需关注')
  assert.equal(orNotProvided('  '), '—')
})

test('every English master data label has a Chinese translation', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile('src/modules/master-data/masterDataCopy.ts', 'utf8'))
  const tables = await Promise.all(['MasterDataTables.tsx', 'StandardMasterTables.tsx', 'export.ts', 'Page.tsx'].map((file) =>
    import('node:fs/promises').then(({ readFile }) => readFile(`src/modules/master-data/${file}`, 'utf8'))))
  const { masterDataCopy } = await loadCopyModule()
  const labels = new Set()
  for (const text of tables) for (const match of text.matchAll(/(?:copy\(|\[\s*|,\s*)"([A-Z][A-Za-z0-9 ()/{}.,:—-]+)"/g)) labels.add(match[1])
  const missing = [...labels].filter((label) => label !== 'SKU' && masterDataCopy(label, 'zh-CN') === label)
  assert.deepEqual(missing, [])
  assert.ok(source.includes('const en = Object.fromEntries'))
})
