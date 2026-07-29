import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  assertSmokeSummarySafe,
  parseSmokeArgs,
  runAllFakeSmoke,
  runProviderSmoke,
} from '../../scripts/ai-runtime-provider-smoke.mjs'

const providerKinds = ['generic_http', 'openai_responses', 'deepseek_chat', 'doubao_chat']
const fakeModes = ['fake-safe', 'fake-unsafe', 'fake-timeout', 'fake-malformed', 'fake-non-2xx', 'fake-too-long']
const forbiddenSummaryPattern = /provider|model|endpoint|API|key|token|JSON|payload|fallback|mock|fake|OpenAI|DeepSeek|Doubao|豆包|system prompt|raw request|raw response|input package|full db/i
const dangerousTextPattern = /自动批准|发送给供应商|直接付款|付款/

function dataFileStat() {
  return fs.statSync(new URL('./test-fixtures/product-review-scenario.mjs', import.meta.url))
}

function assertBusinessSafeSummary(summary) {
  assert.equal(assertSmokeSummarySafe(summary), true)
  assert.doesNotMatch(summary, forbiddenSummaryPattern)
  assert.doesNotMatch(summary, dangerousTextPattern)
  assert.doesNotMatch(summary, /127\.0\.0\.1|local-smoke-key|local-smoke-model|FLOWCHAIN/i)
  assert.doesNotMatch(summary, /\{|\}|\[|\]/)
}

test('CLI arg parsing supports defaults all-fake unsupported options and verbose flag', () => {
  assert.deepEqual(parseSmokeArgs([]), { mode: 'fake-safe', kind: 'openai_responses', allFake: false, verbose: false })
  assert.equal(parseSmokeArgs(['--all-fake']).allFake, true)
  assert.equal(parseSmokeArgs(['--mode', 'fake-timeout', '--kind', 'deepseek_chat', '--verbose']).verbose, true)
  assert.equal(parseSmokeArgs(['--kind', 'unknown']).error, '当前辅助模式未配置，请选择可用的本地验证类型。')
  assert.equal(parseSmokeArgs(['--mode', 'unknown']).error, '当前辅助模式未配置，请选择可用的本地验证类型。')
})

test('fake-safe smoke passes for all supported auxiliary kinds with sanitized summary', async () => {
  for (const kind of providerKinds) {
    const result = await runProviderSmoke({ mode: 'fake-safe', kind, env: {} })
    assert.equal(result.exitCode, 0, kind)
    assert.equal(result.ok, true, kind)
    assert.match(result.summary, /最终结论：通过/)
    assert.equal(result.result.body.validationReport.overallValidationLabel, '安全评估通过')
    assertBusinessSafeSummary(result.summary)
  }
})

test('fake-unsafe smoke keeps dangerous text out and marks assisted result not adopted', async () => {
  for (const kind of providerKinds) {
    const result = await runProviderSmoke({ mode: 'fake-unsafe', kind, env: {} })
    assert.equal(result.exitCode, 0, kind)
    assert.match(result.summary, /外部辅助结果：未采用/)
    assert.equal(result.result.body.assistedResponseSummary.summaryLabel, '外部辅助结果未采用')
    assertBusinessSafeSummary(result.summary)
  }
})

test('fake timeout malformed non-2xx and too-long modes do not crash and stay business safe', async () => {
  for (const mode of ['fake-timeout', 'fake-malformed', 'fake-non-2xx', 'fake-too-long']) {
    const result = await runProviderSmoke({ mode, kind: 'deepseek_chat', env: {} })
    assert.equal(result.exitCode, 0, mode)
    assert.match(result.summary, /外部辅助结果：未采用/)
    assert.match(result.summary, /最终结论：通过|最终结论：需要人工复核/)
    assertBusinessSafeSummary(result.summary)
  }
})

test('all-fake runs every fake mode for every supported auxiliary kind', async () => {
  const result = await runAllFakeSmoke({ env: {}, kinds: ['generic_http', 'openai_responses'], modes: ['fake-safe', 'fake-unsafe'] })
  assert.equal(result.exitCode, 0)
  assert.equal(result.runs.length, 4)
  for (const run of result.runs) assertBusinessSafeSummary(run.summary)
})

test('real mode without local config is optional and does not attempt network', async () => {
  let networkAttempted = false
  const result = await runProviderSmoke({
    mode: 'real',
    kind: 'openai_responses',
    env: {},
    fetchImpl: async () => { networkAttempted = true },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.skipped, true)
  assert.equal(networkAttempted, false)
  assert.match(result.summary, /真实辅助验证未运行/)
  assert.doesNotMatch(result.summary, /secret-value|https:\/\/private\.example|real-model-value/)
})

test('unsupported auxiliary kind and mode return business error without stack traces', async () => {
  const badKind = await runProviderSmoke({ mode: 'fake-safe', kind: 'missing', env: {} })
  assert.equal(badKind.exitCode, 1)
  assert.equal(badKind.summary, '当前辅助模式未配置，请选择可用的本地验证类型。')
  assert.doesNotMatch(badKind.summary, /Error|stack|at /)

  const badMode = await runProviderSmoke({ mode: 'missing', kind: 'generic_http', env: {} })
  assert.equal(badMode.exitCode, 1)
  assert.equal(badMode.summary, '当前辅助模式未配置，请选择可用的本地验证类型。')
})

test('verbose smoke exposes only sanitized diagnostic labels', async () => {
  const result = await runProviderSmoke({ mode: 'fake-safe', kind: 'openai_responses', env: {}, verbose: true })
  assert.equal(result.exitCode, 0)
  assert.match(result.summary, /内部类型：openai_responses/)
  assert.doesNotMatch(result.summary, /127\.0\.0\.1|local-smoke-key|local-smoke-model|raw|payload|API key|endpoint/i)
})

test('smoke harness does not write env files persistent output or current workspace data', async () => {
  const before = dataFileStat()
  const artifactPaths = ['../../test-results', '../../playwright-report', '../../blob-report']
  const beforeArtifacts = artifactPaths.map(path => {
    const url = new URL(path, import.meta.url)
    return fs.existsSync(url) ? fs.statSync(url).mtimeMs : null
  })
  await runProviderSmoke({ mode: 'fake-safe', kind: 'doubao_chat', env: {} })
  const after = dataFileStat()
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(fs.existsSync(new URL('../../.env', import.meta.url)), false)
  assert.deepEqual(artifactPaths.map(path => {
    const url = new URL(path, import.meta.url)
    return fs.existsSync(url) ? fs.statSync(url).mtimeMs : null
  }), beforeArtifacts)
})
