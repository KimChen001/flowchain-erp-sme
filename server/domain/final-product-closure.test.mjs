import test from 'node:test'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const docs = {
  productization: 'docs/productization-final-closure-v1.md',
  readiness: 'docs/final-operating-readiness-checklist-v1.md',
  acceptance: 'docs/final-acceptance-checklist-v1.md',
  scope: 'docs/product-scope-and-boundary-v1.md',
  language: 'docs/product-language-and-positioning-v1.md',
  narrative: 'docs/product-narrative-v1.md',
}

const FORBIDDEN_PRODUCT_TERMINOLOGY_PATTERN = /\b(demo|uat|sample|mock|fake)\b|演示|样例|示例|测试数据|演示数据|样例数据|示例数据/iu
const FORBIDDEN_FINAL_DOC_TECHNICAL_PATTERN = /\bprovider\b|\bmodel\b|endpoint|API key|\bAPI\b|\bkey\b|\btoken\b|JSON|payload|fallback|OpenAI|DeepSeek|Doubao|豆包|tenantId|userId|datasetId|raw enum|entityType|response_card|system prompt|prompt package|deterministic|writesDb|writesFiles|\bDB\b|database|schema|environment|production|deploy|go-live|stack trace|route error|request failed/i
const DANGEROUS_EXECUTION_TERMS = [
  '自动批准',
  '自动下单',
  '正式创建 PO',
  '正式创建 PR',
  '下发 PO',
  '发送 PO',
  '发布 RFQ',
  '邀请供应商',
  '发送邮件',
  '发送',
  '推送',
  '已发送',
  '提交收货',
  '库存过账',
  '付款',
  '会计过账',
  '修改供应商主数据',
  '更新银行账户',
  '自动修复',
  '自动提交导入',
  '自动覆盖数据',
  '自动写入数据库',
  '批量删除',
  '清空数据',
  '保存权限',
  '分配角色',
  '创建用户',
  '删除用户',
  '导出正式报告',
  '生成正式报告',
  '发送报告',
]
const REQUIRED_BOUNDARIES = [
  '不自动审批',
  '不自动下单',
  '不提交收货',
  '不写库存',
  '不写财务凭证',
  '不处理资金',
  '不修改供应商主数据',
  '不外发供应商邮件',
  '不覆盖当前工作区数据',
  '不形成正式业务处理',
]

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readDb() {
  return createProductReviewScenarioDb()
}

function readmeCurrentProductState(readme = read('README.md')) {
  return readme.match(/## Current Product State[\s\S]*?(?=\n## |\s*$)/)?.[0] || ''
}

function docSection(relativePath, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return read(relativePath).match(new RegExp(`## ${escaped}[\\s\\S]*?(?=\\n## |\\s*$)`))?.[0] || ''
}

function finalClosurePackageText() {
  return [
    readmeCurrentProductState(),
    ...Object.values(docs).slice(0, 4).map(read),
    docSection(docs.language, 'Final Closure Language'),
    docSection(docs.narrative, 'Current Product State'),
  ].join('\n')
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|sourceId|responseId|query|intent|entityType|entityId|moduleId|linkTarget|returnContext|returnTo|source|reason|draftType|payload|originEvidence|mode|providerContract)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

function isNegatedBoundaryLine(line = '', term = '') {
  if (!term) return false
  const index = line.indexOf(term)
  if (index < 0) return false
  const prefix = line.slice(0, index)
  return /不|不会|不得|禁止|不做|不覆盖|不形成/.test(prefix)
}

function positiveDangerousLines(text = '') {
  return text.split(/\r?\n/).filter((line) =>
    DANGEROUS_EXECUTION_TERMS.some((term) => line.includes(term) && !isNegatedBoundaryLine(line, term))
  )
}

test('final docs exist', () => {
  for (const relativePath of Object.values(docs).slice(0, 4)) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), true, relativePath)
  }
})

test('final docs and README preserve product positioning and surfaces', () => {
  const readme = read('README.md')
  const packageText = finalClosurePackageText()
  assert.match(readme, /FlowChain 是面向中小企业的 ERP 进销存协同平台/)
  assert.match(packageText, /FlowChain 是面向中小企业的 ERP 进销存协同平台/)
  for (const label of ['今日行动', 'AI 建议', 'AI 助手', '核心业务链', '数据接入与质量', '角色权限', '业务审计', '工作区边界', '人工复核', '草稿预览']) {
    assert.match(packageText, new RegExp(label), label)
  }
  assert.match(packageText, /不声明完整商业化运行能力/)
})

test('final docs state boundaries and scope without old product wording', () => {
  const finalDocs = finalClosurePackageText()
  for (const boundary of REQUIRED_BOUNDARIES) assert.match(finalDocs, new RegExp(boundary), boundary)
  const scope = read(docs.scope)
  for (const label of ['完整财务总账', '真实付款', '正式审批流', '自动下单', '自动库存过账', '自动发票过账', '外部供应商门户正式外发', '完整 CRM', 'HR']) {
    assert.match(scope, new RegExp(label), label)
  }
  const packageText = [readmeCurrentProductState(), finalDocs].join('\n')
  assert.doesNotMatch(packageText, FORBIDDEN_PRODUCT_TERMINOLOGY_PATTERN)
  assert.doesNotMatch(finalDocs, FORBIDDEN_FINAL_DOC_TECHNICAL_PATTERN)
  assert.deepEqual(positiveDangerousLines(finalDocs), [])
})

