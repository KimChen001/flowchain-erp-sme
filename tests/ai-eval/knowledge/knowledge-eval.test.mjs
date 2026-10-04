// Knowledge (RAG) evaluation: the sample documents and starter cases of the AI
// master plan, imported through the real parser and service into PostgreSQL.
// Offline it scores routing and retrieval only: which scope a question takes,
// which documents and sections are cited, and that other workspaces, archived
// documents and other reader groups never are.
//
// With AI_EVAL_PROVIDER_ENV=<env file>, the documents are also embedded and
// every answer is generated through that provider. The run then also scores the
// answers (`answer` in cases.json), their language, and whether a model answered
// at all; it records latency and the token usage the provider reports. Only the
// provider's own host can be reached. AI_EVAL_REPEAT=<n> asks every case n times.
//
//   npm run test:ai:eval:knowledge
//   AI_EVAL_PROVIDER_ENV=<env file> AI_EVAL_REPEAT=3 npm run test:ai:eval:knowledge
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const here = import.meta.dirname
const { corpus, cases } = JSON.parse(await readFile(join(here, 'cases.json'), 'utf8'))

// Only provider settings are taken from the file, and their values are never printed.
const PROVIDER_SETTING = /^(FLOWCHAIN_AI_PROVIDER_[A-Z_]+|FLOWCHAIN_AI_RUNTIME_MODE|FLOWCHAIN_KNOWLEDGE_[A-Z_]+|FLOWCHAIN_PARLEY_[A-Z_]+|PARLEY_API_KEY|FLOWCHAIN_AI_EMBEDDING_[A-Z_]+)$/
async function readProviderEnv(path) {
  if (!existsSync(path)) throw new Error(`AI_EVAL_PROVIDER_ENV: ${path} does not exist.`)
  const settings = {}
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match && PROVIDER_SETTING.test(match[1])) settings[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return settings
}
const providerFile = process.env.AI_EVAL_PROVIDER_ENV ? resolve(process.env.AI_EVAL_PROVIDER_ENV) : ''
const { knowledgeProviderEnv } = await import('../../../server/domain/ai-knowledge-config.mjs')
const env = providerFile ? knowledgeProviderEnv(await readProviderEnv(providerFile)) : {} // Offline: keyword-only retrieval, excerpt answers.
const hosts = [...new Set([env.FLOWCHAIN_AI_PROVIDER_ENDPOINT, env.FLOWCHAIN_AI_EMBEDDING_ENDPOINT].filter(Boolean).map(url => new URL(url).hostname.toLowerCase()))]
if (providerFile && hosts.length !== 1) throw new Error('AI_EVAL_PROVIDER_ENV: answers and embeddings must use one provider host.')
process.env.FLOWCHAIN_AI_EVAL_ALLOW_HOST = hosts[0] || ''
await import('../offline-guard.mjs')
const repeat = providerFile ? Math.min(Math.max(Number(process.env.AI_EVAL_REPEAT) || 1, 1), 5) : 1

const { createPrismaClient } = await import('../../../server/persistence/prisma-client.mjs')
const { answerKnowledgeQuery, createKnowledgeService } = await import('../../../server/domain/ai-knowledge-service.mjs')
const { parseKnowledgeFile } = await import('../../../server/domain/ai-knowledge-file-parser.mjs')
const { classifyQueryScope } = await import('../../../server/domain/ai-query-scope.mjs')
const { callConfiguredProvider, canCallConfiguredProvider } = await import('../../../server/domain/ai-runtime-provider-adapter-v2.mjs')
const { canCallEmbeddingProvider } = await import('../../../server/domain/ai-embedding-provider.mjs')
if (providerFile && !(canCallConfiguredProvider(env) && canCallEmbeddingProvider(env))) throw new Error('AI_EVAL_PROVIDER_ENV: the file does not configure both answers and embeddings.')

// The token usage the provider reports, by call type.
const usage = { chat: { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0 }, embeddings: { calls: 0, failed: 0, inputTokens: 0 } }
if (providerFile) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const kind = String(url).includes('/embeddings') ? 'embeddings' : 'chat'
    const response = await realFetch(url, init)
    usage[kind].calls += 1
    if (!response.ok) usage[kind].failed += 1
    try {
      const body = await response.clone().json()
      usage[kind].inputTokens += Number(body?.usage?.prompt_tokens) || 0
      if (kind === 'chat') usage.chat.outputTokens += Number(body?.usage?.completion_tokens) || 0
    } catch { /* A body without usage counts the call only. */ }
    return response
  }
}

const tenants = { C: 'knowledge-eval-c', D: 'knowledge-eval-d' }
const actor = (tenant, role) => ({
  tenantId: tenants[tenant],
  userId: `knowledge-eval-${tenant}-${role}`,
  permissionCodes: new Set({ admin: ['settings.workspace.manage', 'finance.payable.read', 'procurement.purchase_order.read'], buyer: ['procurement.purchase_order.read'], finance: ['finance.payable.read'] }[role]),
})
const lastHeading = citation => String(citation.heading || '').split(' › ').at(-1)
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null }
// Each check belongs to the stage that failed, so a failure points at what to fix.
const STAGE = { scope: 'routing', sources: 'retrieval', sections: 'retrieval', forbiddenSections: 'retrieval', firstSection: 'retrieval', isolation: 'permission', open: 'permission', generation: 'generation', answer: 'answer', language: 'language' }

let prisma
let service
const keyOf = new Map() // documentId -> corpus key
const idOf = new Map() // corpus key -> documentId
const indexStatus = new Map() // corpus key -> index status after import
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
    indexStatus.set(key, document.indexAttemptError ? `${document.indexStatus} (${document.indexAttemptError})` : document.indexStatus)
    if (entry.archived) await service.archive(admin, document.id)
  }
})

after(async () => {
  const attempts = results.flatMap(row => row.attempts)
  const latencies = attempts.map(attempt => attempt.latencyMs)
  const failuresByStage = {}
  for (const attempt of attempts) for (const failure of attempt.failures) failuresByStage[STAGE[failure.check]] = (failuresByStage[STAGE[failure.check]] || 0) + 1
  const summary = {
    mode: providerFile ? 'provider' : 'offline retrieval',
    model: providerFile ? env.FLOWCHAIN_AI_PROVIDER_MODEL : null,
    embeddingModel: providerFile ? env.FLOWCHAIN_AI_EMBEDDING_MODEL : null,
    repeat,
    cases: results.length,
    casesPassed: results.filter(row => row.attempts.every(attempt => !attempt.failures.length)).length,
    attempts: attempts.length,
    attemptsPassed: attempts.filter(attempt => !attempt.failures.length).length,
    failuresByStage,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
    usage: providerFile ? usage : null,
    knownGaps: [...new Set(results.flatMap(row => row.attempts.flatMap(attempt => attempt.knownGaps.map(gap => `${row.id}: ${gap}`))))],
    indexStatus: Object.fromEntries(indexStatus),
  }
  const report = { generatedAt: new Date().toISOString(), summary, cases: results }
  const file = process.env.AI_EVAL_KNOWLEDGE_REPORT || join(tmpdir(), 'flowchain-ai-eval', providerFile ? 'knowledge-provider-report.json' : 'knowledge-report.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nKnowledge eval (${summary.mode}${providerFile ? `, ${summary.model}, repeat ${repeat}` : ''}): ${summary.casesPassed}/${summary.cases} cases passed${repeat > 1 ? `, ${summary.attemptsPassed}/${summary.attempts} attempts` : ''}${summary.knownGaps.length ? `, known gaps: ${summary.knownGaps.length}` : ''}`)
  for (const row of results) {
    const passed = row.attempts.filter(attempt => !attempt.failures.length).length
    console.log(`${passed === row.attempts.length ? 'pass' : 'FAIL'}  ${row.id.padEnd(26)} ${row.scope.padEnd(9)} ${repeat > 1 ? `${passed}/${row.attempts.length} ` : ''}${row.attempts[0].retrieved.map(c => `${c.document}#${c.section || c.position}`).join(', ')}`)
    for (const failure of [...new Set(row.attempts.flatMap(attempt => attempt.failures.map(f => `${STAGE[f.check]}: ${f.detail}`)))]) console.log(`        ${failure}`)
  }
  for (const gap of summary.knownGaps) console.log(`known gap  ${gap}`)
  if (Object.keys(failuresByStage).length) console.log(`failures by stage: ${JSON.stringify(failuresByStage)}`)
  console.log(`latency p50 / p95: ${summary.latencyMs.p50} / ${summary.latencyMs.p95} ms over ${attempts.length} questions`)
  if (providerFile) console.log(`provider calls: chat ${usage.chat.calls} (${usage.chat.failed} failed, ${usage.chat.inputTokens} in / ${usage.chat.outputTokens} out tokens), embeddings ${usage.embeddings.calls} (${usage.embeddings.failed} failed, ${usage.embeddings.inputTokens} tokens)`)
  console.log(`report: ${file}`)
  await prisma?.$disconnect()
})

test('the sample documents are stored by section, with their headings', async () => {
  const guide = await service.get(actor('C', 'buyer'), idOf.get('product-guide.md'))
  assert.deepEqual(guide.chunks.map(chunk => chunk.heading), ['FlowChain Demo Sensor Guide', 'FlowChain Demo Sensor Guide › FC-DEMO-SENSOR-100', 'FlowChain Demo Sensor Guide › FC-DEMO-SENSOR-200'])
  const policy = await service.get(actor('C', 'buyer'), idOf.get('purchasing-policy.md'))
  assert.deepEqual(policy.chunks.map(lastHeading), ['Example Purchasing Follow-up Policy', 'Overdue goods', 'Follow-up and escalation', 'Replacement products'])
})

test('with a provider, every document is embedded', { skip: !providerFile && 'offline run' }, () => {
  assert.deepEqual([...indexStatus].filter(([, status]) => status !== 'semantic'), [])
})

// Why a model reply was not used as a generated answer, in the order
// answerKnowledgeQuery checks it.
function rejectionReason(response, citations) {
  if (!response.ok) return `provider ${response.reason || response.status || 'error'}`
  let output = response.rawOutput?.conclusion?.summary || response.rawOutput
  try { if (typeof output === 'string') output = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { return 'reply is not JSON' }
  if (Array.isArray(output?.citationIds) && !output.citationIds.length) return `reply cites nothing (a no-answer): "${String(output.answer || '').slice(0, 160)}"`
  if (typeof output?.answer !== 'string' || !output.answer.trim()) return 'reply has no answer'
  if (output.answer.length > 2400) return 'answer longer than 2,400 characters'
  if (!Array.isArray(output.citationIds)) return 'reply has no citationIds'
  if (!output.citationIds.every(id => citations.some(c => c.id === id))) return 'reply cites an id that was not retrieved'
  return 'an inline [n] reference names a source the reply did not cite'
}

async function ask(entry) {
  const tenant = entry.tenant || 'C'
  const reader = actor(tenant, entry.role || 'buyer')
  const failures = []
  const knownGaps = []
  const check = (name, ok, detail) => {
    if (ok) return
    if (entry.knownGaps?.[name]) knownGaps.push(`${name}: ${detail} (${entry.knownGaps[name]})`)
    else failures.push({ check: name, detail })
  }

  const scope = classifyQueryScope({ message: entry.question, queryMode: 'auto' })
  check('scope', scope === entry.scope, `routed to ${scope}, expected ${entry.scope}`)

  // The knowledge path as the knowledge mode, or a mixed answer's supporting documents, run it.
  const started = Date.now()
  let raw = null
  let sent = null
  const provider = async (input, providerEnv) => { sent = input.evidencePackage?.citations || null; const response = await callConfiguredProvider(input, providerEnv); raw = response; return response }
  const result = await answerKnowledgeQuery({ question: entry.question, language: entry.language || 'en-US', actor: reader, service, env, provider })
  const latencyMs = Date.now() - started
  const describe = list => list.map(citation => ({ document: keyOf.get(citation.documentId) || citation.documentId, section: lastHeading(citation), position: citation.position, id: citation.id, documentId: citation.documentId }))
  // Retrieval is scored on what was retrieved: the passages sent to the model,
  // or all of them when no model answered. A generated answer cites only the
  // passages it used, which is scored with the answer.
  const retrieved = describe(sent || result.citations)
  const citations = describe(result.citations)
  const cited = new Set([...retrieved, ...citations].map(citation => citation.document))
  const retrievedDocuments = new Set(retrieved.map(citation => citation.document))
  const sections = retrieved.map(citation => citation.section)
  for (const source of entry.sources || []) check('sources', retrievedDocuments.has(source), `${source} not retrieved`)
  for (const source of entry.notSources || []) check('sources', !cited.has(source), `${source} cited`)
  for (const section of entry.sections || []) check('sections', sections.includes(section), `section "${section}" not retrieved`)
  for (const section of entry.forbiddenSections || []) check('forbiddenSections', !sections.includes(section), `section "${section}" retrieved`)
  if (entry.firstSection) check('firstSection', sections[0] === entry.firstSection, `top passage is "${sections[0] || 'none'}"`)

  // Every case: nothing archived, nothing from the other workspace, nothing
  // from a reader group the asker is not in.
  check('isolation', !cited.has('archived-guide'), 'an archived document was cited')
  check('isolation', tenant === 'D' || !cited.has('other-tenant-guide'), 'another workspace was cited')
  check('isolation', tenant === 'C' || [...cited].every(key => key === 'other-tenant-guide'), 'workspace C was cited in workspace D')
  check('isolation', reader.permissionCodes.has('finance.payable.read') || !cited.has('finance-limits'), 'a finance-only document was cited')

  // Opening a cited passage reads it again with the reader's own access.
  const first = citations[0] || retrieved[0]
  if (first) {
    const opened = await service.get(reader, first.documentId)
    check('open', opened.chunks.some(chunk => chunk.id === first.id), 'the cited passage could not be opened')
  }
  if (entry.openDenied) {
    const denied = await service.get(reader, idOf.get(entry.openDenied)).then(() => null, error => error.code)
    check('open', denied === 'KNOWLEDGE_NOT_FOUND', `opening ${entry.openDenied} returned ${denied || 'the document'}`)
  }

  // The answer itself is scored only when a model wrote it. A case lists the
  // modes it accepts in `modes`; by default only a generated answer. A
  // no-answer ("the documents do not answer this") is right only where the
  // documents the reader can see really are silent.
  if (providerFile) {
    const modes = entry.modes || ['generated']
    check('generation', modes.includes(result.mode), `answer mode is ${result.mode}, expected ${modes.join(' or ')}${raw && result.mode !== 'generated' ? `: ${rejectionReason(raw, result.citations)}` : ''}`)
    if (result.mode === 'generated' || result.mode === 'no_answer') {
      // A no-answer is a fixed server sentence: only its language is scored.
      if (result.mode === 'generated') {
        for (const pattern of entry.answer?.matches || []) check('answer', new RegExp(pattern, 'iu').test(result.answer), `does not match /${pattern}/`)
        for (const pattern of entry.answer?.mustNotMatch || []) check('answer', !new RegExp(pattern, 'iu').test(result.answer), `matches /${pattern}/`)
      }
      const chinese = /\p{Script=Han}/u.test(result.answer)
      check('language', (entry.language || 'en-US') === 'zh-CN' ? chinese : !chinese, (entry.language || 'en-US') === 'zh-CN' ? 'the answer is not in Chinese' : 'the English answer contains Chinese')
    }
  }
  const brief = list => list.map(({ document, section, position }) => ({ document, section, position }))
  return { scope, attempt: { mode: result.mode, latencyMs, retrieved: brief(retrieved), citations: brief(citations), answer: providerFile ? result.answer : null, failures, knownGaps } }
}

for (const entry of cases) {
  test(entry.id, async t => {
    const attempts = []
    let scope = ''
    for (let round = 0; round < repeat; round += 1) {
      const asked = await ask(entry)
      scope = asked.scope
      attempts.push(asked.attempt)
    }
    results.push({ id: entry.id, tenant: entry.tenant || 'C', role: entry.role || 'buyer', question: entry.question, scope, expect: entry.expect || null, mustNot: entry.mustNot || null, attempts })
    for (const gap of new Set(attempts.flatMap(attempt => attempt.knownGaps))) t.diagnostic(`known gap: ${gap}`)
    assert.deepEqual(attempts.flatMap(attempt => attempt.failures.map(failure => `${failure.check}: ${failure.detail}`)), [])
  })
}
