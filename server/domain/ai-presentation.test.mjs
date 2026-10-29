import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let modulePromise

async function loadPresentationModule() {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-presentation-'))
    const outfile = path.join(dir, 'presentation.mjs')
    await build({
      entryPoints: ['src/modules/ai-assistant/presentation.ts'],
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

test('AI message sanitization removes markdown heading markers', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(mod.sanitizeAiMessage('### 分析结果\n已找到 PO-2026-1287。'), '分析结果\n已找到 PO-2026-1287。')
})

test('AI message sanitization preserves business ids', async () => {
  const { mod } = await loadPresentationModule()
  const output = mod.sanitizeAiMessage('#### 结果\nPR-2026-2400 / RFQ-26-0047 / SKU-00412 需要复核。')
  assert.match(output, /PR-2026-2400/)
  assert.match(output, /RFQ-26-0047/)
  assert.match(output, /SKU-00412/)
})

test('AI message sanitization removes inline markdown emphasis', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(
    mod.sanitizeAiMessage('**采购待办**：__风险提示__，*重点* 查看 PO-2026-1287。'),
    '采购待办：风险提示，重点 查看 PO-2026-1287。'
  )
})

test('AI message sanitization normalizes amount shorthand with amount context', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(
    mod.sanitizeAiMessage('金额14.2万，发票金额1.4万，差异金额0.86万。'),
    '金额 142,000，发票金额 14,000，差异金额 8,600。'
  )
})

test('AI message amount shorthand keeps only a currency symbol the source text carried', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(mod.sanitizeAiMessage('金额¥14.2万，发票金额1.4万。'), '金额 ¥142,000，发票金额 14,000。')
})

test('AI message sanitization does not convert non-amount wan words', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(mod.sanitizeAiMessage('库存涉及万向节备件，需要查看 SKU-00412。'), '库存涉及万向节备件，需要查看 SKU-00412。')
})

test('mixed text with JSON object line removes that line', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(
    mod.sanitizeAiMessage('已找到相关记录。\n{"intent":"supplier_status","cards":[]}\n请查看下方结果。'),
    '已找到相关记录。\n请查看下方结果。'
  )
})

test('mixed text with cards debug line removes that line', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(
    mod.sanitizeAiMessage('已找到 PO-2026-1287。\ncards: [{"type":"supplier_status"}]'),
    '已找到 PO-2026-1287。'
  )
})

test('fenced JSON payload is removed from display text', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(
    mod.sanitizeAiMessage('已找到结果：\n```json\n{"cards":[]}\n```\n请查看卡片。'),
    '已找到结果：\n请查看卡片。'
  )
})

test('sanitization preserves document and item ids', async () => {
  const { mod } = await loadPresentationModule()
  const output = mod.sanitizeAiMessage('PO-2026-1287 PR-2026-2400 RFQ-26-0047 GRN-202605-0418 INV-SZ-260422 SKU-00412')
  for (const id of ['PO-2026-1287', 'PR-2026-2400', 'RFQ-26-0047', 'GRN-202605-0418', 'INV-SZ-260422', 'SKU-00412']) {
    assert.match(output, new RegExp(id))
  }
})

test('the progress line names what the assistant reads, in English and in Chinese', async () => {
  const { mod } = await loadPresentationModule()
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['purchase_orders'] }, 'en-US'), 'Reading purchase orders…')
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['purchase_orders'] }, 'zh-CN'), '正在读取采购订单…')
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['purchase_orders', 'suppliers', 'calculation'] }, 'en-US'), 'Reading purchase orders and suppliers…')
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['inventory', 'sales_orders', 'purchase_orders'] }, 'zh-CN'), '正在读取库存、销售订单、采购订单…')
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['documents'] }, 'en-US'), 'Searching your documents…')
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['calculation'] }, 'zh-CN'), '正在计算…')
  assert.equal(mod.aiProgressLine({ step: 'reading', sources: ['something_new'] }, 'en-US'), 'Searching your records…')
  assert.equal(mod.aiProgressLine({ step: 'writing' }, 'en-US'), 'Writing the answer…')
  assert.equal(mod.aiProgressLine({ step: 'checking' }, 'zh-CN'), '正在核对数字…')
})
