import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  assertEnvCheckSummarySafe,
  buildEnvCheckSummary,
  inspectProviderEnv,
  parseEnvCheckArgs,
  runEnvCheck,
} from '../../scripts/ai-runtime-provider-env-check.mjs'

const providerKinds = ['generic_http', 'openai_responses', 'deepseek_chat', 'doubao_chat']
const forbiddenDefaultText = /API key|token|endpoint URL|JSON|payload|raw|provider|model|endpoint|OpenAI|DeepSeek|Doubao|豆包|system prompt|prompt package/i
const realValues = /https:\/\/private\.example|LOCAL_ACCESS_VALUE|LOCAL_MODEL_VALUE|Bearer|secret-value/i
const forbiddenActions = /自动批准|自动下单|发送|付款|写库存|写财务凭证|改主数据|覆盖数据/

function dataFileStat() {
  return fs.statSync(new URL('./test-fixtures/product-review-scenario.mjs', import.meta.url))
}

function assertDefaultSafe(summary) {
  assert.equal(assertEnvCheckSummarySafe(summary), true)
  assert.doesNotMatch(summary, forbiddenDefaultText)
  assert.doesNotMatch(summary, realValues)
  assert.doesNotMatch(summary, forbiddenActions)
  assert.doesNotMatch(summary, /\{|\}|\[|\]/)
}

test('arg parser supports default help and verbose mode', () => {
  assert.deepEqual(parseEnvCheckArgs([]), { verbose: false })
  assert.deepEqual(parseEnvCheckArgs(['--verbose']), { verbose: true })
  assert.equal(parseEnvCheckArgs(['--help']).help, true)
  assert.equal(parseEnvCheckArgs(['--bad']).error, true)
})

test('no env reports unconfigured local evidence guidance without sensitive values', () => {
  const result = runEnvCheck({ env: {} })
  assert.equal(result.exitCode, 0)
  assert.match(result.summary, /运行模式：未配置/)
  assert.match(result.summary, /辅助类型：未选择/)
  assert.match(result.summary, /建议动作：保持本地证据回答/)
  assertDefaultSafe(result.summary)
})

test('partial env stays business safe and recommends temporary local completion', () => {
  const result = runEnvCheck({
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'LOCAL_ADDRESS_VALUE',
    },
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.summary, /运行模式：已配置/)
  assert.match(result.summary, /辅助类型：已选择/)
  assert.match(result.summary, /访问凭据：未配置/)
  assert.match(result.summary, /建议动作：补充本机临时配置/)
  assertDefaultSafe(result.summary)
})

test('complete env for each supported kind is safe and recommends local validation', () => {
  for (const kind of providerKinds) {
    const result = runEnvCheck({
      env: {
        FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
        FLOWCHAIN_AI_PROVIDER_KIND: kind,
        FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'LOCAL_ADDRESS_VALUE',
        FLOWCHAIN_AI_PROVIDER_API_KEY: 'LOCAL_ACCESS_VALUE',
        FLOWCHAIN_AI_PROVIDER_MODEL: 'LOCAL_MODEL_VALUE',
      },
    })
    assert.equal(result.exitCode, 0, kind)
    assert.equal(result.inspected.complete, true, kind)
    assert.match(result.summary, /运行模式：已配置/)
    assert.match(result.summary, /辅助类型：已选择/)
    assert.match(result.summary, /地址配置：已配置/)
    assert.match(result.summary, /访问凭据：已配置/)
    assert.match(result.summary, /模型配置：已配置/)
    assert.match(result.summary, /建议动作：继续本地验证/)
    assertDefaultSafe(result.summary)
  }
})

test('unsupported kind returns business-safe guidance without stack traces', () => {
  const result = runEnvCheck({
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'unknown_kind',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'LOCAL_ADDRESS_VALUE',
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'LOCAL_ACCESS_VALUE',
      FLOWCHAIN_AI_PROVIDER_MODEL: 'LOCAL_MODEL_VALUE',
    },
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.summary, /辅助类型：未选择/)
  assert.match(result.summary, /建议动作：选择可用的本地辅助类型/)
  assert.doesNotMatch(result.summary, /Error|stack|at /)
  assertDefaultSafe(result.summary)
})

test('verbose mode prints only internal booleans and kind name without values', () => {
  const result = runEnvCheck({
    verbose: true,
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'LOCAL_ADDRESS_VALUE',
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'LOCAL_ACCESS_VALUE',
      FLOWCHAIN_AI_PROVIDER_MODEL: 'LOCAL_MODEL_VALUE',
    },
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.summary, /internal kind：deepseek_chat/)
  assert.match(result.summary, /runtime requested：true/)
  assert.match(result.summary, /has address：true/)
  assert.match(result.summary, /has access：true/)
  assert.match(result.summary, /has model：true/)
  assert.doesNotMatch(result.summary, realValues)
  assert.doesNotMatch(result.summary, /token|auth|secret|raw config|\{|\}/i)
})

test('summary sanitizer rejects forbidden default output terms', () => {
  assert.equal(assertEnvCheckSummarySafe('AI Runtime 辅助配置检查\n- 建议动作：继续本地验证'), true)
  assert.equal(assertEnvCheckSummarySafe('endpoint URL https://private.example'), false)
  assert.equal(assertEnvCheckSummarySafe('API key LOCAL_ACCESS_VALUE'), false)
  assert.equal(assertEnvCheckSummarySafe('raw payload JSON'), false)
  assert.equal(assertEnvCheckSummarySafe('OpenAI DeepSeek Doubao 豆包 system prompt'), false)
})

test('env check does not write env files persistent output or current workspace data', () => {
  const before = dataFileStat()
  const artifactPaths = ['../../test-results', '../../playwright-report', '../../blob-report']
  const beforeArtifacts = artifactPaths.map(path => {
    const url = new URL(path, import.meta.url)
    return fs.existsSync(url) ? fs.statSync(url).mtimeMs : null
  })
  const result = runEnvCheck({ env: {} })
  const after = dataFileStat()
  assert.equal(result.exitCode, 0)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(fs.existsSync(new URL('../../.env', import.meta.url)), false)
  assert.deepEqual(artifactPaths.map(path => {
    const url = new URL(path, import.meta.url)
    return fs.existsSync(url) ? fs.statSync(url).mtimeMs : null
  }), beforeArtifacts)
})

test('inspection helper is value-free and does not expose raw config object in summary', () => {
  const inspected = inspectProviderEnv({
    FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
    FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'LOCAL_ADDRESS_VALUE',
    FLOWCHAIN_AI_PROVIDER_API_KEY: 'LOCAL_ACCESS_VALUE',
    FLOWCHAIN_AI_PROVIDER_MODEL: 'LOCAL_MODEL_VALUE',
  })
  assert.equal(inspected.complete, true)
  const summary = buildEnvCheckSummary({}, {})
  assertDefaultSafe(summary)
})
