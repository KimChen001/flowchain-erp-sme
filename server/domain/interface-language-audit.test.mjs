import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Design audit L6-20: the language audit reports only Chinese with no
// English pair, so it can be read as a gate (it counted 771 lines, most of
// them paired, and skipped routeRegistry).
const script = new URL('../../scripts/audit-interface-language.mjs', import.meta.url)

function audit(files) {
  const folder = mkdtempSync(join(tmpdir(), 'language-audit-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(folder, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    }
    return JSON.parse(execFileSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), `--root=${folder}`, '--list'], { encoding: 'utf8' }))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

test('paired Chinese is not reported; Chinese with no English is', () => {
  const result = audit({
    'paired.tsx': [
      'const COPY = { title: ["Purchase orders", "采购订单"], note: ["Open", "未结"] }',
      'const label = say("Supplier", "供应商")',
      'const other = tr("来源采购申请", "Source PR")',
      'const word = language === "en-US" ? "Receipt / invoice" : "收货 / 发票"',
      "const dictionary = { '待审批': 'Pending approval' }",
      'const shown = copy("待审批")',
      'if (status === "已取消") return null',
      'const late = /逾期|超时/.test(text)',
      'const rule = [/^Sign-in link used\\.$/, null, "已使用登录链接。"]',
      'const split = [',
      '  "A long English sentence that wraps",',
      '  "一句换行的中文",',
      ']',
      '// 注释里的中文不算',
      'const template = `${say("From", "来自")} ${line}`',
    ].join('\n'),
    'english-and-chinese-objects.ts': [
      'export const EN = { workTitle: "Today\'s work" }',
      'export const ZH = { workTitle: "今日需处理" }',
    ].join('\n'),
    'unpaired.tsx': [
      'export const Title = () => <h1>采购订单</h1>',
      'const hint = "请先维护供应商"',
      'const missing = copy("没有词典条目")',
    ].join('\n'),
  })
  assert.deepEqual(result.findings.map((finding) => [finding.file, finding.line, finding.text]), [
    ['unpaired.tsx', 1, '采购订单'],
    ['unpaired.tsx', 2, '请先维护供应商'],
    ['unpaired.tsx', 3, '没有词典条目'],
  ])
  assert.equal(result.unpairedChineseLiterals, 3)
})
