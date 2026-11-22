import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SUPPLIER_TIER_DEFINITIONS, SUPPLIER_TIER_NAMES, SUPPLIER_TIERS } from '../../shared/supplier-tiers.mjs'
import { SUPPLIER_TIERS as COMMAND_TIERS, reviewSupplierTier, changeSupplierTier } from './supplier-tier-command.mjs'
import { AI_READ_TOOLS } from './ai-read-tools.mjs'

// Design audit C7, part 2: tier reviews (L9-12), the tiers' meanings in one
// place (L9-26) and the prompt to review a Tier 1 supplier that delivers
// poorly (L7-37). FlowChain never suggests or changes a tier itself.

const root = resolve(import.meta.dirname, '../..')
const source = (file) => readFileSync(join(root, file), 'utf8')

async function loadClient() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-supplier-tier-'))
  const entry = `
    import { tierReviewPrompted, TIER_ONE_REVIEW_BELOW } from './src/modules/srm/SupplierEvaluationPage.tsx'
    import { TIER_OPTIONS } from './src/modules/srm/SupplierTier.tsx'
    import { supplierCopy } from './src/modules/srm/supplierCopy.ts'
    export { tierReviewPrompted, TIER_ONE_REVIEW_BELOW, TIER_OPTIONS, supplierCopy }
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'supplier-tier-entry.tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  })
  const file = join(directory, 'tier.cjs')
  await writeFile(file, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(file).href)).default
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the tiers mean one thing everywhere: the command, the pages and the assistant read shared/supplier-tiers.mjs', async () => {
  const client = await loadClient()
  assert.deepEqual(SUPPLIER_TIERS, [1, 2, 3])
  assert.equal(COMMAND_TIERS, SUPPLIER_TIERS)
  assert.equal(SUPPLIER_TIER_NAMES, '1 strategic, 2 core, 3 transactional')
  // The page's options are the shared meanings, plus Not tiered, and each label has its Chinese.
  assert.deepEqual(client.TIER_OPTIONS.map((option) => [option.tier, option.label, option.meaning]), [
    ...SUPPLIER_TIER_DEFINITIONS.map((definition) => [definition.tier, `Tier ${definition.tier} · ${definition.name}`, definition.meaning]),
    [null, 'Not tiered', 'Nobody has decided yet.'],
  ])
  for (const option of client.TIER_OPTIONS) assert.notEqual(client.supplierCopy(option.label, 'zh-CN'), option.label, option.label)
  // The assistant's tools say the same names.
  const tool = (name) => AI_READ_TOOLS.find((entry) => entry.name === name)
  assert.ok(tool('list_suppliers').description.includes(`tier (${SUPPLIER_TIER_NAMES}, or none)`))
  assert.ok(JSON.stringify(tool('list_purchase_orders').schema).includes(`this tier (${SUPPLIER_TIER_NAMES})`))
  // No page or tool keeps its own copy of the meanings.
  assert.equal(source('src/modules/srm/SupplierTier.tsx').includes('Losing this supplier would stop'), false)
  assert.equal(source('server/domain/ai-read-tools.mjs').includes('1 strategic, 2 core'), false)
})

test('a Tier 1 supplier with on time or OTIF below 80% is prompted for review, never changed', async () => {
  const { tierReviewPrompted, TIER_ONE_REVIEW_BELOW } = await loadClient()
  const insight = (onTime, otif) => ({ onTime: onTime === undefined ? null : { rate: onTime, count: 0, of: 0, sampleStatus: 'ok' }, otif: otif === undefined ? null : { rate: otif, count: 0, of: 0, sampleStatus: 'ok' } })
  assert.equal(TIER_ONE_REVIEW_BELOW, 0.8)
  // L7-37: Acme was Tier 1 at 77% on time.
  assert.equal(tierReviewPrompted(1, insight(0.77, 0.9)), true)
  assert.equal(tierReviewPrompted(1, insight(0.95, 0.6)), true)
  assert.equal(tierReviewPrompted(1, insight(0.8, 0.8)), false)
  // Below the minimum sample there is no rate, so no prompt; hidden figures neither.
  assert.equal(tierReviewPrompted(1, insight(null, null)), false)
  assert.equal(tierReviewPrompted(1, insight()), false)
  // Only Tier 1.
  assert.equal(tierReviewPrompted(2, insight(0.5, 0.5)), false)
  assert.equal(tierReviewPrompted(null, insight(0.5, 0.5)), false)
  // The prompt says the tier is the team's to set.
  const { supplierCopy } = await loadClient()
  assert.equal(supplierCopy('Review tier?', 'zh-CN'), '复核层级？')
  assert.ok(source('src/modules/srm/SupplierEvaluationPage.tsx').includes('this is only a prompt to review'))
})

test('the tier form keeps a tier by recording a review, and changes it through the tier endpoint', () => {
  const form = source('src/modules/srm/SupplierTier.tsx')
  assert.ok(form.includes('/tier-review`, { method: "POST"'))
  assert.ok(form.includes('/tier`, { method: "PATCH"'))
  assert.ok(form.includes('const reviewing = tierChoice === supplier.tier'))
  assert.ok(form.includes('nextReviewOn: nextReviewOn || null'))
})

test('the tier form marks Reason required with the form standard mark, and tags no field optional', () => {
  const form = source('src/modules/srm/SupplierTier.tsx')
  assert.ok(form.includes('<label htmlFor={reasonId} className={fieldLabelClass} style={fieldLabelStyle}>{t("Reason")}</label><RequiredMark />'))
  assert.ok(form.includes('aria-required="true" aria-invalid={!!fieldError("reason")}'))
  assert.ok(form.includes('<label htmlFor={reviewDayId} className={fieldLabelClass} style={fieldLabelStyle}>{t("Next review on")}</label>'))
  assert.ok(!form.includes('t("Optional")'))
  assert.doesNotMatch(source('src/modules/srm/supplierCopy.ts'), /'Optional'/)
})

// A stand-in transaction for the command: one supplier, and the rows written.
function standInPrisma(supplier) {
  const written = { audit: [], updates: [] }
  const tx = {
    supplier: {
      findFirst: async () => supplier,
      update: async ({ data }) => { written.updates.push(data); return { ...supplier, ...data } },
    },
    auditLog: { create: async ({ data }) => { written.audit.push(data); return data } },
  }
  return { prisma: { $transaction: async (work) => work(tx) }, written }
}
const scope = { tenantId: 'T-1' }
const supplier = () => ({ id: 'SUP-1', tenantId: 'T-1', tier: 2, tierReason: 'Regular source', metadata: { version: 4 } })

test('a review keeps the tier, bumps the version and keeps the indicators the route read', async () => {
  const { prisma, written } = standInPrisma(supplier())
  const indicators = { asOf: '2026-11-16', onTime: { rate: 0.8, count: 4, of: 5 }, otif: null, overduePos: 1, openIssues: 0 }
  const now = new Date('2026-11-16T15:00:00Z')
  await reviewSupplierTier(prisma, 'SUP-1', { reason: 'Quarterly review: still core', nextReviewOn: '2027-02-16', expectedVersion: 4 }, 'U-1', scope, { indicators, now })
  assert.equal('tier' in written.updates[0], false)
  assert.deepEqual(written.updates[0].metadata.tierReview, { reviewedAt: '2026-11-16T15:00:00.000Z', reviewedById: 'U-1', nextReviewOn: '2027-02-16' })
  assert.equal(written.updates[0].metadata.version, 5)
  assert.deepEqual([written.audit[0].action, written.audit[0].metadata.tier, written.audit[0].metadata.indicators, written.audit[0].summary], ['tier_reviewed', 2, indicators, 'Supplier tier reviewed and kept at Tier 2'])
  // Indicators in the request body are not taken: only the options' are.
  const other = standInPrisma(supplier())
  await reviewSupplierTier(other.prisma, 'SUP-1', { reason: 'Quarterly review', indicators: { onTime: { rate: 1 } }, expectedVersion: 4 }, 'U-1', scope)
  assert.equal('indicators' in other.written.audit[0].metadata, false)
  assert.equal(other.written.audit[0].metadata.nextReviewOn, null)
})

test('a review needs a reason and a real date; a change to the same tier is still refused', async () => {
  const { prisma } = standInPrisma(supplier())
  await assert.rejects(reviewSupplierTier(prisma, 'SUP-1', { reason: 'ok', expectedVersion: 4 }, 'U-1', scope), (error) => error.details?.[0]?.field === 'reason')
  await assert.rejects(reviewSupplierTier(prisma, 'SUP-1', { reason: 'Quarterly review', nextReviewOn: '2027-02-30', expectedVersion: 4 }, 'U-1', scope), (error) => error.details?.[0]?.field === 'nextReviewOn')
  await assert.rejects(reviewSupplierTier(prisma, 'SUP-1', { reason: 'Quarterly review', expectedVersion: 3 }, 'U-1', scope), (error) => error.code === 'VERSION_CONFLICT')
  await assert.rejects(changeSupplierTier(prisma, 'SUP-1', { tier: 2, reason: 'Same again', expectedVersion: 4 }, 'U-1', scope), (error) => error.code === 'TIER_UNCHANGED')
  // A change sets the next review date and keeps the indicators.
  const change = standInPrisma(supplier())
  await changeSupplierTier(change.prisma, 'SUP-1', { tier: 1, reason: 'Now the only source', nextReviewOn: '2027-01-10', expectedVersion: 4 }, 'U-1', scope, { indicators: { overduePos: 0 } })
  assert.deepEqual([change.written.audit[0].metadata.toTier, change.written.audit[0].metadata.nextReviewOn, change.written.audit[0].metadata.indicators], [1, '2027-01-10', { overduePos: 0 }])
  assert.equal(change.written.updates[0].metadata.tierReview.nextReviewOn, '2027-01-10')
})
