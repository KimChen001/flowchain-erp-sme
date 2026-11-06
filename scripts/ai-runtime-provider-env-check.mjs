#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { providerSpecificAdapters } from '../server/domain/ai-runtime-provider-specific-adapters-v2.mjs'

// Every kind the runtime can call: the generic HTTP adapter and each specific
// adapter (Parley, Qwen and Anthropic included), so this list cannot drift.
const SUPPORTED_KINDS = ['generic_http', ...providerSpecificAdapters.map((adapter) => adapter.kind)]
const DATA_SCOPE = '当前工作区数据'
const FORBIDDEN_DEFAULT_OUTPUT = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|webhook|Coupa|RBAC|production|deploy|go-live|system prompt|prompt package|OpenAI|DeepSeek|Doubao|豆包/i
const FORBIDDEN_ACTION_OUTPUT = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite|保存配置|保存权限|保存边界|保存历史|保存准备度|修改权限|修改历史|修改准备度|删除历史|立即生效|自动应用|分配角色|创建用户|删除用户|禁用用户|创建租户|切换租户|合并租户|迁移数据|同步数据|跨租户查询|写入配置|写入日志|推送日志|导出审计报告|生成正式审计报告|发送审计报告|启用试点|开启试点|上线|部署|生成正式报告|导出正式报告|发送报告/i
const FORBIDDEN_VALUE_OUTPUT = /(https?:\/\/|sk-[A-Za-z0-9_-]+|secret|credential|auth|Bearer\s+|FLOWCHAIN_AI_PROVIDER_|<YOUR_LOCAL_API_KEY>)/i

function text(value) {
  return String(value ?? '').trim()
}

export function parseEnvCheckArgs(argv = []) {
  const parsed = { verbose: false }
  for (const arg of argv) {
    if (arg === '--verbose') parsed.verbose = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else parsed.error = true
  }
  return parsed
}

export function inspectProviderEnv(env = {}) {
  const runtimeMode = text(env.FLOWCHAIN_AI_RUNTIME_MODE)
  const kind = text(env.FLOWCHAIN_AI_PROVIDER_KIND)
  const hasEndpoint = Boolean(text(env.FLOWCHAIN_AI_PROVIDER_ENDPOINT))
  const hasKey = Boolean(text(env.FLOWCHAIN_AI_PROVIDER_API_KEY))
  const hasModel = Boolean(text(env.FLOWCHAIN_AI_PROVIDER_MODEL))
  const runtimeConfigured = runtimeMode === 'provider_assisted'
  const supportedKind = SUPPORTED_KINDS.includes(kind)
  const complete = runtimeConfigured && supportedKind && hasEndpoint && hasKey && hasModel
  const partiallyConfigured = Boolean(runtimeMode || kind || hasEndpoint || hasKey || hasModel)
  const suggestedAction = complete
    ? '继续本地验证'
    : supportedKind || partiallyConfigured
      ? '补充本机临时配置'
      : '保持本地证据回答'
  return {
    runtimeConfigured,
    supportedKind,
    kind,
    hasEndpoint,
    hasKey,
    hasModel,
    complete,
    partiallyConfigured,
    suggestedAction,
  }
}

function selectedLabel(inspected) {
  return inspected.supportedKind ? '已选择' : '未选择'
}

export function buildEnvCheckSummary(env = {}, options = {}) {
  const inspected = inspectProviderEnv(env)
  const lines = [
    'AI Runtime 辅助配置检查',
    `- 当前数据范围：${DATA_SCOPE}`,
    `- 运行模式：${inspected.runtimeConfigured ? '已配置' : '未配置'}`,
    `- 辅助类型：${selectedLabel(inspected)}`,
    `- 地址配置：${inspected.hasEndpoint ? '已配置' : '未配置'}`,
    `- 访问凭据：${inspected.hasKey ? '已配置' : '未配置'}`,
    `- 模型配置：${inspected.hasModel ? '已配置' : '未配置'}`,
    '- 输出安全：未显示敏感值',
    `- 建议动作：${inspected.supportedKind || !inspected.kind ? inspected.suggestedAction : '选择可用的本地辅助类型'}`,
  ]
  if (options.verbose) {
    lines.push(`- internal kind：${inspected.kind || 'none'}`)
    lines.push(`- runtime requested：${inspected.runtimeConfigured}`)
    lines.push(`- has address：${inspected.hasEndpoint}`)
    lines.push(`- has access：${inspected.hasKey}`)
    lines.push(`- has model：${inspected.hasModel}`)
    lines.push(`- supported kind：${inspected.supportedKind}`)
  }
  return lines.join('\n')
}

export function assertEnvCheckSummarySafe(summary = '', options = {}) {
  if (FORBIDDEN_ACTION_OUTPUT.test(summary)) return false
  if (FORBIDDEN_VALUE_OUTPUT.test(summary)) return false
  return options.verbose ? !/(https?:\/\/|sk-|Bearer\s+|secret|credential|auth|raw config|\{|\})/i.test(summary) : !FORBIDDEN_DEFAULT_OUTPUT.test(summary)
}

export function runEnvCheck(options = {}) {
  const env = options.env || process.env || {}
  const inspected = inspectProviderEnv(env)
  const summary = buildEnvCheckSummary(env, { verbose: options.verbose })
  const safe = assertEnvCheckSummarySafe(summary, { verbose: options.verbose })
  const unsupported = Boolean(inspected.kind) && !inspected.supportedKind
  return { ok: safe && !unsupported, exitCode: safe && !unsupported ? 0 : 1, summary, inspected }
}

function helpText() {
  return [
    'AI Runtime 辅助配置检查',
    '用法：node scripts/ai-runtime-provider-env-check.mjs',
    '可选：node scripts/ai-runtime-provider-env-check.mjs --verbose',
  ].join('\n')
}

async function main(argv = process.argv.slice(2)) {
  const args = parseEnvCheckArgs(argv)
  if (args.help) {
    console.log(helpText())
    return 0
  }
  if (args.error) {
    console.log('当前辅助模式未配置，请选择可用的本地验证类型。')
    return 1
  }
  const output = runEnvCheck({ verbose: args.verbose })
  console.log(output.summary)
  return output.exitCode
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = await main()
  process.exitCode = exitCode
}
