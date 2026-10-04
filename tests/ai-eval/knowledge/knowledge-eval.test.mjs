// Knowledge (RAG) evaluation: the sample documents and starter cases of the AI
// master plan, imported through the real parser and service into PostgreSQL.
// Offline it scores routing and retrieval only: which scope a question takes,
// which documents and sections are cited, and that other workspaces, archived
// documents and other reader groups never are. Answer wording needs a model;
// the plan's `expect` and `mustNot` text is kept in cases.json for that run.
//
//   npm run test:ai:eval:knowledge
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createPrismaClient } from '../../../server/persistence/prisma-client.mjs'
import { answerKnowledgeQuery, createKnowledgeService } from '../../../server/domain/ai-knowledge-service.mjs'
import { parseKnowledgeFile } from '../../../server/domain/ai-knowledge-file-parser.mjs'
import { classifyQueryScope } from '../../../server/domain/ai-query-scope.mjs'

const here = import.meta.dirname
const { corpus, cases } = JSON.parse(await readFile(join(here, 'cases.json'), 'utf8'))
const env = {} // No provider: retrieval is keyword-only and answers are excerpts.
const tenants = { C: 'knowledge-eval-c', D: 'knowledge-eval-d' }
const actor = (tenant, role) => ({
  tenantId: tenants[tenant],
  userId: `knowledge-eval-${tenant}-${role}`,
  permissionCodes: new Set({ admin: ['settings.workspace.manage', 'finance.payable.read', 'procurement.purchase_order.read'], buyer: ['procurement.purchase_order.read'], finance: ['finance.payable.read'] }[role]),
})
const lastHeading = citation => String(citation.heading || '').split(' › ').at(-1)

let prisma
let service
const keyOf = new Map() // documentId -> corpus key
const idOf = new Map() // corpus key -> documentId
const results = []

before(async () => {
  prisma = await createPrismaClient(process.env)
  service = createKnowledgeService(prisma, { env })
  await prisma.tenant.createMany({ data: Object.entries(tenants).map(([name, id]) => ({ id, name: `Knowledge eval ${name}` })) })
  for (const entry of corpus) {
    const admin = actor(entry.tenant, 'admin')
    let document
    if (entry.file) {
      const bytes = await readFile(join(here, entry.file))
      const extracted = await parseKnowledgeFile({ fileName: basename(entry.file), contentBase64: bytes.toString('base64') })
      document = await service.add(admin, { title: extracted.title, content: extracted.content })
    } else {
      document = await service.add(admin, { title: entry.title, content: entry.content, requiredPermission: entry.requiredPermission || null })
    }
    const key = entry.key || basename(entry.file)
    keyOf.set(document.id, key)
    idOf.set(key, document.id)
    if (entry.archived) await service.archive(admin, document.id)
  }
})

after(async () => {
  const summary = { total: results.length, passed: results.filter(row => !row.failures.length).length, knownGaps: results.flatMap(row => row.knownGaps.map(gap => `${row.id}: ${gap}`)) }
  const report = { generatedAt: new Date().toISOString(), mode: 'offline retrieval', summary, cases: results }
  const file = process.env.AI_EVAL_KNOWLEDGE_REPORT || join(tmpdir(), 'flowchain-ai-eval', 'knowledge-report.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nKnowledge eval: ${summary.passed}/${summary.total} passed${summary.knownGaps.length ? `, known gaps: ${summary.knownGaps.length}` : ''}`)
  for (const row of results) console.log(`${row.failures.length ? 'FAIL' : 'pass'}  ${row.id.padEnd(26)} ${row.scope.padEnd(9)} ${row.citations.map(c => `${c.document}#${c.section || c.position}`).join(', ')}`)
  for (const gap of summary.knownGaps) console.log(`known gap  ${gap}`)
  console.log(`report: ${file}`)
  await prisma?.$disconnect()
})

test('the sample documents are stored by section, with their headings', async () => {
  const guide = await service.get(actor('C', 'buyer'), idOf.get('product-guide.md'))
  assert.deepEqual(guide.chunks.map(chunk => chunk.heading), ['FlowChain Demo Sensor Guide', 'FlowChain Demo Sensor Guide › FC-DEMO-SENSOR-100', 'FlowChain Demo Sensor Guide › FC-DEMO-SENSOR-200'])
  const policy = await service.get(actor('C', 'buyer'), idOf.get('purchasing-policy.md'))
  assert.deepEqual(policy.chunks.map(lastHeading), ['Example Purchasing Follow-up Policy', 'Overdue goods', 'Follow-up and escalation', 'Replacement products'])
})

for (const entry of cases) {
  test(entry.id, async t => {
    const tenant = entry.tenant || 'C'
    const role = entry.role || 'buyer'
    const reader = actor(tenant, role)
    const failures = []
    const knownGaps = []
    const check = (name, ok, detail) => {
      if (ok) return
      if (entry.knownGaps?.[name]) knownGaps.push(`${name}: ${detail} (${entry.knownGaps[name]})`)
      else failures.push(`${name}: ${detail}`)
    }

    const scope = classifyQueryScope({ message: entry.question, queryMode: 'auto' })
    check('scope', scope === entry.scope, `routed to ${scope}, expected ${entry.scope}`)

    // The knowledge path as the knowledge mode, or a mixed answer's supporting documents, run it.
    const result = await answerKnowledgeQuery({ question: entry.question, language: entry.language || 'en-US', actor: reader, service, env })
    const citations = result.citations.map(citation => ({ document: keyOf.get(citation.documentId) || citation.documentId, section: lastHeading(citation), position: citation.position, id: citation.id, documentId: citation.documentId }))
    const cited = new Set(citations.map(citation => citation.document))
    const sections = citations.map(citation => citation.section)
    for (const source of entry.sources || []) check('sources', cited.has(source), `${source} not cited`)
    for (const source of entry.notSources || []) check('sources', !cited.has(source), `${source} cited`)
    for (const section of entry.sections || []) check('sections', sections.includes(section), `section "${section}" not cited`)
    for (const section of entry.forbiddenSections || []) check('forbiddenSections', !sections.includes(section), `section "${section}" cited`)
    if (entry.firstSection) check('firstSection', sections[0] === entry.firstSection, `first citation is "${sections[0] || 'none'}"`)

    // Every case: nothing archived, nothing from the other workspace, nothing
    // from a reader group the asker is not in.
    check('isolation', !cited.has('archived-guide'), 'an archived document was cited')
    check('isolation', tenant === 'D' || !cited.has('other-tenant-guide'), 'another workspace was cited')
    check('isolation', tenant === 'C' || [...cited].every(key => key === 'other-tenant-guide'), 'workspace C was cited in workspace D')
    check('isolation', reader.permissionCodes.has('finance.payable.read') || !cited.has('finance-limits'), 'a finance-only document was cited')

    // Opening a cited passage reads it again with the reader's own access.
    const first = citations[0]
    if (first) {
      const opened = await service.get(reader, first.documentId)
      check('open', opened.chunks.some(chunk => chunk.id === first.id), 'the cited passage could not be opened')
    }
    if (entry.openDenied) {
      const denied = await service.get(reader, idOf.get(entry.openDenied)).then(() => null, error => error.code)
      check('open', denied === 'KNOWLEDGE_NOT_FOUND', `opening ${entry.openDenied} returned ${denied || 'the document'}`)
    }

    results.push({ id: entry.id, tenant, role, question: entry.question, scope, mode: result.mode, citations: citations.map(({ document, section, position }) => ({ document, section, position })), failures, knownGaps, expect: entry.expect || null, mustNot: entry.mustNot || null })
    for (const gap of knownGaps) t.diagnostic(`known gap: ${gap}`)
    assert.deepEqual(failures, [])
  })
}
