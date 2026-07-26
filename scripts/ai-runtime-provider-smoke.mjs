#!/usr/bin/env node
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { buildAiRuntimeEvaluationV2 } from '../server/domain/ai-runtime-observability-v2.mjs'
import { createEmptyDataset } from '../server/domain/data-mode.mjs'
import {
  FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN,
  FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN,
} from '../server/domain/ai-runtime-provider-adapter-v2.mjs'

const DEFAULT_MODE = 'fake-safe'
const DEFAULT_KIND = 'openai_responses'
const SUPPORTED_MODES = ['fake-safe', 'fake-unsafe', 'fake-timeout', 'fake-malformed', 'fake-non-2xx', 'fake-too-long', 'real']
const SUPPORTED_KINDS = ['generic_http', 'openai_responses', 'deepseek_chat', 'doubao_chat']
const FAKE_MODES = SUPPORTED_MODES.filter((mode) => mode !== 'real')
const SAFE_TEXT = '建议查看当前证据、数据限制和人工复核入口。'
const UNSAFE_TEXT = '可以自动批准并发送给供应商，也可以直接付款。'
const UNSUPPORTED_MESSAGE = '当前辅助模式未配置，请选择可用的本地验证类型。'
const REAL_NOT_RUN_MESSAGE = [
  '真实辅助验证未运行：缺少本地服务端配置。',
  '请仅在本机临时设置 endpoint、key、model 后重试。',
  '未使用任何真实外部辅助结果。',
].join('\n')
const FORBIDDEN_SUMMARY_PATTERN = /provider|model|endpoint|API|key|token|JSON|payload|fallback|mock|fake|OpenAI|DeepSeek|Doubao|豆包|system prompt|raw request|raw response|input package|full db/i

export function loadSmokeDb() {
  return createEmptyDataset({ mode: 'test' })
}

export function parseSmokeArgs(argv = []) {
  const parsed = { mode: DEFAULT_MODE, kind: DEFAULT_KIND, allFake: false, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all-fake') {
      parsed.allFake = true
    } else if (arg === '--verbose') {
      parsed.verbose = true
    } else if (arg === '--mode') {
      parsed.mode = String(argv[index + 1] || '').trim()
      index += 1
    } else if (arg === '--kind') {
      parsed.kind = String(argv[index + 1] || '').trim()
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else {
      parsed.error = UNSUPPORTED_MESSAGE
    }
  }
  if (!parsed.allFake && !SUPPORTED_MODES.includes(parsed.mode)) parsed.error = UNSUPPORTED_MESSAGE
  if (!parsed.allFake && !SUPPORTED_KINDS.includes(parsed.kind)) parsed.error = UNSUPPORTED_MESSAGE
  return parsed
}

function safeResponseFor(kind, text = SAFE_TEXT) {
  if (kind === 'openai_responses') return { output_text: text }
  if (kind === 'deepseek_chat') return { choices: [{ message: { content: text } }] }
  if (kind === 'doubao_chat') return { output: { text } }
  return { conclusion: { summary: text } }
}

async function withFakeServer(mode, kind, run) {
  const sockets = new Set()
  const server = http.createServer((_req, res) => {
    if (mode === 'fake-timeout') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('late')
      }, 90)
      return
    }
    if (mode === 'fake-non-2xx') {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('busy')
      return
    }
    if (mode === 'fake-malformed') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ nope: true }))
      return
    }
    const text = mode === 'fake-unsafe' ? UNSAFE_TEXT : mode === 'fake-too-long' ? '过长内容'.repeat(80) : SAFE_TEXT
    res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(safeResponseFor(kind, text)))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}

function smokeEnv(baseEnv, kind, endpoint, mode) {
  return {
    ...baseEnv,
    FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
    FLOWCHAIN_AI_PROVIDER_KIND: kind,
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
    FLOWCHAIN_AI_PROVIDER_API_KEY: baseEnv.FLOWCHAIN_AI_PROVIDER_API_KEY || 'local-smoke-key',
    FLOWCHAIN_AI_PROVIDER_MODEL: baseEnv.FLOWCHAIN_AI_PROVIDER_MODEL || 'local-smoke-model',
    FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: mode === 'fake-timeout' ? '25' : baseEnv.FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS || '1000',
    FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS: mode === 'fake-too-long' ? '30' : baseEnv.FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS || '6000',
  }
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|evaluationId|scenarioId|query|intent|entityType|entityId|moduleId|source|returnTo|returnContext|payload|raw|mode|providerContract|reason|reasonCode)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

function hasForbiddenText(value) {
  const text = typeof value === 'string' ? value : visibleText(value)
  return FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN.test(text) ||
    FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN.test(text) ||
    FORBIDDEN_SUMMARY_PATTERN.test(text)
}

function statusLabel(pass) {
  return pass ? '通过' : '需要人工复核'
}

function externalResultLabel(body = {}) {
  return body.assistedResponseSummary?.summaryLabel === '外部辅助结果已通过安全评估'
    ? '已通过安全评估'
    : '未采用'
}

function modeLabel(mode) {
  if (mode === 'real') return '服务端辅助模式'
  if (mode === 'fake-safe') return '本地安全模拟'
  return '本地边界模拟'
}

export function buildSmokeSummary(result, options = {}) {
  const body = result?.body || {}
  const validation = body.validationReport || {}
  const validationPass = validation.overallValidationLabel === '安全评估通过'
  const evidencePass = validation.evidenceGroundingPass === true
  const reviewPass = validation.reviewFirstPass === true
  const navigationPass = validation.navigationPass === true
  const limitationPass = (body.dataLimitationReport?.assistedDataLimitationCount || 0) > 0
  const safetyPass = validation.safetyBoundaryPass === true && validation.forbiddenWordingPass === true
  const lines = [
    'AI Runtime 辅助验证',
    `- 验证类型：${modeLabel(options.mode)}`,
    '- 当前数据范围：当前工作区数据',
    `- 回复结构：${statusLabel(validation.contractPass === true)}`,
    `- 证据约束：${statusLabel(evidencePass)}`,
    `- 复核优先：${statusLabel(reviewPass)}`,
    `- 跳转返回：${statusLabel(navigationPass)}`,
    `- 数据限制：${limitationPass ? '已覆盖' : '需要人工复核'}`,
    `- 安全边界：${statusLabel(safetyPass)}`,
    `- 外部辅助结果：${externalResultLabel(body)}`,
    `- 最终结论：${validationPass ? '通过' : '需要人工复核'}`,
  ]
  if (options.verbose) {
    lines.push(`- 内部类型：${options.kind}`)
    lines.push(`- 内部场景：today_attention`)
    lines.push(`- 临时服务：${options.mode === 'real' ? '未使用' : '已使用'}`)
    lines.push(`- 质量评分：${body.qualityScores?.overallQualityScore ?? '未评估'}`)
    lines.push(`- 结构检查：${validation.contractPass === true ? '通过' : '需要人工复核'}`)
  }
  return lines.join('\n')
}

export function assertSmokeSummarySafe(summary = '') {
  return !hasForbiddenText(summary)
}

function assertVerboseSummarySafe(summary = '') {
  return !/(127\.0\.0\.1|https?:\/\/|local-smoke-key|FLOWCHAIN|raw request|raw response|input package|full db|payload|API key|token|secret|credential|auth|endpoint URL)/i.test(summary) &&
    !FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN.test(summary)
}

async function runEvaluation({ mode, kind, env, fetchImpl = globalThis.fetch }) {
  return buildAiRuntimeEvaluationV2(loadSmokeDb(), {
    scenarioId: 'today_attention',
    evaluationMode: 'local_vs_assisted',
  }, { env, fetchImpl })
}

export async function runProviderSmoke(options = {}) {
  const mode = options.mode || DEFAULT_MODE
  const kind = options.kind || DEFAULT_KIND
  const baseEnv = options.env || process.env || {}
  if (!SUPPORTED_MODES.includes(mode) || !SUPPORTED_KINDS.includes(kind)) {
    return { ok: false, exitCode: 1, summary: UNSUPPORTED_MESSAGE }
  }
  if (mode === 'real') {
    const hasRealConfig = Boolean(baseEnv.FLOWCHAIN_AI_PROVIDER_ENDPOINT && baseEnv.FLOWCHAIN_AI_PROVIDER_API_KEY && baseEnv.FLOWCHAIN_AI_PROVIDER_MODEL)
    if (!hasRealConfig) return { ok: true, exitCode: 0, skipped: true, summary: REAL_NOT_RUN_MESSAGE }
    const env = smokeEnv(baseEnv, kind, baseEnv.FLOWCHAIN_AI_PROVIDER_ENDPOINT, mode)
    const result = await runEvaluation({ mode, kind, env, fetchImpl: options.fetchImpl })
    const summary = buildSmokeSummary(result, { mode, kind, verbose: options.verbose })
    const safe = options.verbose ? assertVerboseSummarySafe(summary) : assertSmokeSummarySafe(summary)
    return { ok: safe, exitCode: safe ? 0 : 1, summary, result }
  }
  return withFakeServer(mode, kind, async (endpoint) => {
    const env = smokeEnv(baseEnv, kind, endpoint, mode)
    const result = await runEvaluation({ mode, kind, env, fetchImpl: options.fetchImpl })
    const summary = buildSmokeSummary(result, { mode, kind, verbose: options.verbose })
    const safe = options.verbose ? assertVerboseSummarySafe(summary) : assertSmokeSummarySafe(summary)
    return { ok: safe, exitCode: safe ? 0 : 1, summary, result }
  })
}

export async function runAllFakeSmoke(options = {}) {
  const runs = []
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds : SUPPORTED_KINDS
  const modes = Array.isArray(options.modes) && options.modes.length ? options.modes : FAKE_MODES
  for (const kind of kinds) {
    for (const mode of modes) {
      runs.push(await runProviderSmoke({ ...options, mode, kind, verbose: false }))
    }
  }
  const summary = runs.map((run, index) => [
    `Smoke ${index + 1}`,
    run.summary,
  ].join('\n')).join('\n\n')
  return { ok: runs.every((run) => run.ok), exitCode: runs.every((run) => run.ok) ? 0 : 1, summary, runs }
}

function helpText() {
  return [
    'AI Runtime 辅助验证',
    '用法：node scripts/ai-runtime-provider-smoke.mjs --mode fake-safe --kind openai_responses',
    '或：node scripts/ai-runtime-provider-smoke.mjs --all-fake',
  ].join('\n')
}

async function main(argv = process.argv.slice(2)) {
  const args = parseSmokeArgs(argv)
  if (args.help) {
    console.log(helpText())
    return 0
  }
  try {
    const output = args.allFake
      ? await runAllFakeSmoke({ verbose: args.verbose })
      : await runProviderSmoke({ mode: args.mode, kind: args.kind, verbose: args.verbose })
    console.log(output.summary)
    return output.exitCode
  } catch {
    console.log(UNSUPPORTED_MESSAGE)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = await main()
  process.exitCode = exitCode
}
