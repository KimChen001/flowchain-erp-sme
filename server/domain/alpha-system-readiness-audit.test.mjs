import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('R66 Alpha readiness classification is documented without production claims', () => {
  const review = readSource('docs', 'frontend-stability-review.md')

  assert.match(review, /Core Alpha ready/)
  assert.match(review, /Optional guided Alpha/)
  assert.match(review, /Observation-only/)
  assert.match(review, /Excluded from Alpha/)
  assert.match(review, /Forecast \/ MRP planning review and draft preview only/)
  assert.match(review, /Preview flows must remain non-mutating/)
  assert.doesNotMatch(review, /ready for production/i)
})

test('Overview work items use review-first runtime procurement wording', () => {
  const overview = readSource('src', 'modules', 'overview', 'Page.tsx')
  const copy = readSource('src', 'modules', 'overview', 'todayCopy.ts')
  const work = readSource('server', 'domain', 'today-work.mjs')

  assert.match(overview, /"\/api\/home\/overview"/)
  assert.match(work, /'purchase_request_to_approve'/)
  assert.match(work, /'draft_purchase_order'/)
  assert.match(copy, /采购申请待审批/)
  assert.match(copy, /Draft PO 待复核/)
  assert.match(copy, /Draft PO awaiting review/)
  assert.doesNotMatch(overview, /title: "释放 MRP 计划订单"/)
  assert.doesNotMatch(overview, /suggestedAction: .*"生成补货 PR"/)
})
