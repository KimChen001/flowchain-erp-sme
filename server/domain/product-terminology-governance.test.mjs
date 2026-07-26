import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

const SCAN_ROOTS = ['README.md', 'docs', 'src', 'server', 'tests', 'package.json']
const SKIP_DIRS = new Set(['.git', '.claude', 'design-preview', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', 'blob-report'])
const SCAN_EXTENSIONS = new Set(['.md', '.js', '.mjs', '.ts', '.tsx', '.json'])
const FORBIDDEN_PRODUCT_POSITIONING = /\b(demo|uat|mock|fake)\b|sample data|demo data|mock data|fake data|演示|样例|示例|测试数据|演示数据|样例数据|示例数据|presentation-only|prototype-only/iu

const HISTORICAL_TECHNICAL_DOCS = new Set([
  'docs/action-draft-audit-db-adapter-v1.md',
  'docs/action-draft-audit-repository-adapter-v1.md',
  'docs/ai-provider-adapter-v1-plan.md',
  'docs/ai-runtime-real-provider-enablement-guide.md',
  'docs/ai-safety-and-draft-first-explainer-v1.md',
  'docs/ai-timeout-diagnostics-and-cockpit-fast-path-v1.md',
  'docs/alpha-feedback-template.md',
  'docs/alpha-operator-guide.md',
  'docs/aliyun-backend-deployment-roadmap.md',
  'docs/architecture-overview-v1.md',
  'docs/cross-round-integration-review-v1.md',
  'docs/data-source-audit.md',
  'docs/data-source-cleanup-roadmap.md',
  'docs/database-entity-model-v2.md',
  'docs/db-readiness-review-v1.md',
  'docs/demo-screenshot-checklist-v1.md',
  'docs/demo-script-v1.md',
  'docs/draft-first-action-boundary-v1.md',
  'docs/erpnext-reference-notes-for-flowchain.md',
  'docs/frontend-stability-review.md',
  'docs/full-repo-risk-scan-v1.md',
  'docs/global-business-search-v1.md',
  'docs/json-adapter-contract-tests-v1.md',
  'docs/master-data-db-adapter-v1.md',
  'docs/master-data-repository-adapter-v1.md',
  'docs/master-data-seed-mapping-v1.md',
  'docs/orm-decision-and-persistence-scaffold-v1.md',
  'docs/persistence-mode-and-adapter-registry-v1.md',
  'docs/planning-mrp-readiness-notes.md',
  'docs/procurement-inventory-read-repository-adapters-v1.md',
  'docs/product-scope-ia-review.md',
  'docs/repository-boundary-v1.md',
  'docs/route-context-repository-wiring-v1.md',
  'docs/route-mutation-classification-v1.md',
  'docs/phase-5-3-2-postgres-only-runtime-cutover.md',
  'docs/SCM_OPTIMIZATION_TODO.md',
  'docs/server-error-health-safety-v1.md',
  'docs/ui-typography-consistency-v1.md',
  'docs/ui-typography-system-v1.md',
  'docs/ui-typography-token-consolidation-v2.md',
  'docs/verification/browser-baseline-differential.md',
])

const TECHNICAL_FILE_PATTERNS = [
  /^package\.json$/,
  /^server\/domain\/product-terminology-governance\.test\.mjs$/,
  /^server\/domain\/authoritative-runtime-initialization\.test\.mjs$/,
  /^server\/domain\/postgres-only-runtime\.test\.mjs$/,
  /^tests\/browser\/authoritative-runtime-initialization\.spec\.ts$/,
  /(^|\/)ai-runtime-provider/i,
  /(^|\/)ai-provider-safety/i,
  /(^|\/)ai-model-router/i,
  /(^|\/)ai-audit-latency-hardening/i,
  /(^|\/)ai-output-quality-gate/i,
  /(^|\/)provider/i,
  /(^|\/).*smoke.*\.(mjs|js|ts|tsx)$/i,
  /(^|\/).*env.*\.(mjs|js|ts|tsx)$/i,
  /(^|\/)json-adapter-contract/i,
  /(^|\/)demo-data-/i,
  /(^|\/)user-data-import-(dry-run|commit-boundary)/i,
  /(^|\/)user-data-runtime-ai/i,
  /(^|\/)ai-empty/i,
  /(^|\/)capability(RouteGuard|-registry)\.(mjs|ts)$/i,
  /(^|\/)durable-import-cutover\.test\.mjs$/i,
]

const TECHNICAL_LINE_PATTERNS = [
  /data\/scm-demo\.json/i,
  /scm-demo\.json/i,
  /src\/data\/demo-data/i,
  /from ["'].*data\/demo-data["']/i,
  /import\(["'].*data\/demo-data["']\)/i,
  /scm-demo-(token|user)/i,
  /scm-demo/i,
  /browser-.*(demo|uat)/i,
  /FLOWCHAIN_DATA_MODE.*demo/i,
  /DATA_MODES\.demo|dataMode.*demo|dataSource.*scm-demo|readsDemoData|shouldReadDemoData/i,
  /^\s*demo:\s*['"]demo['"],?/i,
  /overwritesDemoData/i,
  /shouldReadDemoData|loadDemoDbSnapshot|assertNoDemoLeak|DEMO_ID/i,
  /FORBIDDEN_.*PATTERN/i,
  /\.replace\(\/.*(demo|UAT|sample data|mock|fake)/i,
  /not\.toContainText|doesNotMatch|not\.toMatch|forbidden/i,
  /assert\.equal\(.*Demo\|UAT/i,
  /demo-tenant|demo-user|token: `demo-/i,
  /fake-.*key|sk-fake|OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY/i,
  /\bmocked?\b.*(Prisma|adapter|client|repository|DB|database|parity|response|dispatcher|provider|function)/i,
  /\bsample(Row|Rows|Response|Item|Supplier|Key|Payload|Code|Size|Response|Price|Rate|sku|supplier|item)\b/,
  /edi-sample/i,
  /hasFakeCaret/i,
  /中文字段名.*示例值/,
  /dry-run/i,
]

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function collectFiles(entry, acc = []) {
  const absolute = path.join(repoRoot, entry)
  if (!fs.existsSync(absolute)) return acc
  const stat = fs.statSync(absolute)
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(absolute))) return acc
    for (const child of fs.readdirSync(absolute)) collectFiles(path.join(entry, child), acc)
    return acc
  }
  if (SCAN_EXTENSIONS.has(path.extname(absolute))) acc.push(absolute)
  return acc
}

function isAllowedTechnicalHit(relativePath, line) {
  if (HISTORICAL_TECHNICAL_DOCS.has(relativePath)) return true
  if (TECHNICAL_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) return true
  return TECHNICAL_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

test('product terminology governance blocks non-product positioning in visible sources', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectFiles(root))
  const violations = []

  for (const file of files) {
    const relativePath = toPosix(path.relative(repoRoot, file))
    const text = fs.readFileSync(file, 'utf8')
    text.split(/\r?\n/).forEach((line, index) => {
      if (!FORBIDDEN_PRODUCT_POSITIONING.test(line)) return
      if (isAllowedTechnicalHit(relativePath, line)) return
      violations.push(`${relativePath}:${index + 1}: ${line.trim()}`)
    })
  }

  assert.deepEqual(violations, [])
})

test('primary product docs use FlowChain inventory purchase stock supplier positioning', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
  const language = fs.readFileSync(path.join(repoRoot, 'docs', 'product-language-and-positioning-v1.md'), 'utf8')
  const narrative = fs.readFileSync(path.join(repoRoot, 'docs', 'product-narrative-v1.md'), 'utf8')
  const combined = [readme, language, narrative].join('\n')

  assert.match(combined, /FlowChain 是面向中小企业的 ERP 进销存协同平台/)
  assert.match(readme, /FlowChain is an ERP and inventory-purchase-sales \(进销存\) collaboration platform for SMEs/)
  assert.doesNotMatch(combined, FORBIDDEN_PRODUCT_POSITIONING)
  // 锁定新定位：禁止旧的自我降级表述回潮
  assert.doesNotMatch(combined, /轻量进销存|lightweight inventory|not a full ERP replacement|不是完整 ERP 替代|不做完整 ERP 替代|仅供辅助|辅助分析|auxiliary-only|demo-only/)
})
