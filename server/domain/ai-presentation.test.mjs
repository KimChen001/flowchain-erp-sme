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

