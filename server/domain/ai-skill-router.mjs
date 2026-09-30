import { AI_SKILL_IDS } from './ai-skill-registry.mjs'

// Deterministic routing from a question to a workspace skill. It reads only the
// raw message, the chip's skillHint and the page focus; it never reads the
// answer language, so the same question routes the same way in English and
// Chinese. Order: a known hint, an exact prompt chip, then word-bounded rules
// (draft, action refusal, records, risk, metrics, today). No match returns
// null and the caller answers with the capability overview.

const text = (value) => String(value ?? '').trim()
const normalize = (value) => text(value).toLowerCase().replace(/\s+/g, ' ').replace(/[?？!！。.]+$/u, '').trim()

// The assistant's prompt chips (Panel.tsx) and the skill follow-up prompts.
const CHIPS = [
  ['What should I handle first today?', '今天先处理什么？', 'today_priorities'],
  ['Which items have the highest risk?', '哪些事项风险最高？', 'highest_risk_items'],
  ['Which records need more data?', '哪些数据需要补齐？', 'records_needing_data'],
  ['Prepare an action draft', '帮我准备一个处理草稿', 'prepare_action_draft'],
  ['How many open purchase orders do we have?', '现在有多少未结采购订单？', 'workspace_metrics'],
  // Purchase order focus chips.
  ['Why does this PO need attention?', '这个 PO 为什么需要关注？', 'today_priorities'],
  ['Which receipt or invoice evidence is missing?', '还差哪些收货或发票证据？', 'records_needing_data'],
  ['What will a delay affect?', '延误会影响什么？', 'highest_risk_items'],
  ['What should happen next?', '建议下一步是什么？', 'prepare_action_draft'],
  // SKU focus chips.
  ['Does this SKU need replenishment?', '这个 SKU 需要补货吗？', 'today_priorities'],
  ['What is the available inventory?', '当前可用库存是多少？', 'today_priorities'],
  ['Which orders will be affected?', '哪些订单会受影响？', 'highest_risk_items'],
  ['What action is recommended?', '建议如何处理？', 'prepare_action_draft'],
]
const chipSkill = new Map(CHIPS.flatMap(([en, zh, skillId]) => [[normalize(en), skillId], [normalize(zh), skillId]]))

// A draft request: prepare/write/create ... draft, or a draft of a message.
const DRAFT = [
  /\b(prepare|write|create|make|compose)\b[^.?!]*\bdraft\b/i,
  /^\s*draft\b/i,
  /\bdraft\s+(a|an|the|me)\b/i,
  /\b(prepare|write|compose|create)\b[^.?!]*\b(message|email|note)\b/i,
  /(准备|写|生成|拟|做)[^。？！]*草稿|起草|草拟/,
]
// An instruction to act, not a question about it. Word-bounded, at the start
// of the request or after a directive ("please", "go ahead and", 直接, 帮我),
// so "Which POs need approval?" and "payment terms" are not refused.
const ACTION = [
  /^(please\s+|kindly\s+)?((can|could|would|will) you\s+(please\s+)?|go ahead and\s+|help me\s+|just\s+|now\s+)?(approve|pay|delete|send|issue|cancel|post|release)\b/i,
  /\b(please|go ahead and|automatically|immediately)\s+(approve|pay|delete|send|issue|cancel)\b/i,
  /^(请|帮我|直接|马上|立即|立刻|现在)?(批准|付款|支付|删除|发送|下达|取消|过账)/,
  /(直接|自动|马上|立即|立刻|帮我|替我)(批准|付款|支付|删除|发送|下达|取消|过账)/,
]
const RECORDS = [
  /\b(missing|incomplete|blank|empty fields?|data quality|fill in|need(s)? (more )?data|lacks?)\b/i,
  /补齐|缺失|缺少|不完整|数据质量|补充数据|还差哪些/,
]
const RISK = [
  /\b(risks?|riskiest|risky|exposure|at risk)\b/i,
  /风险|敞口|受影响/,
]
const METRICS = [
  /\bopen (purchase orders?|pos?)\b/i,
  /\bhow many\b[^?]*\b(pos?|purchase orders?)\b/i,
  /\b(committed|total) (po |purchase )?spend\b|\bspend\b[^?]*\b(po|purchase)/i,
  /\boverdue (pos?|purchase orders?)\b/i,
  /未结\s*(采购订单|PO)|开放\s*PO|多少[^？]*(采购订单|PO)|采购金额|已承诺金额|逾期[^？]*(采购订单|PO)/i,
]
const TODAY = [
  /\b(today|first|priorit(y|ies|ise|ize)|attention|urgent|to-?do)\b/i,
  /今天|今日|优先|先处理|待办|重点|需要关注|需要处理/,
]

const FOCUS_TYPES = new Set(['purchase_order', 'item', 'supplier', 'purchase_request', 'rfq', 'supplier_invoice', 'receiving_doc'])

function focusOf(focusTarget) {
  const entityType = text(focusTarget?.entityType)
  const entityId = text(focusTarget?.entityId)
  return entityType && entityId && FOCUS_TYPES.has(entityType) ? { entityType, entityId } : null
}

const matches = (patterns, message) => patterns.some((pattern) => pattern.test(message))

export function detectAiActionRequest(message) {
  return matches(ACTION, text(message))
}

export function routeSkill({ message, skillHint, focusTarget } = {}) {
  const raw = text(message)
  const focus = focusOf(focusTarget)
  const hint = text(skillHint)
  if (hint && AI_SKILL_IDS.includes(hint)) return hint === 'capability_overview' ? { capability: true } : { skillId: hint, focus }
  if (!raw) return null
  const chip = chipSkill.get(normalize(raw))
  if (chip) return { skillId: chip, focus }
  if (matches(DRAFT, raw)) return { skillId: 'prepare_action_draft', focus }
  if (matches(ACTION, raw)) return { capability: true, refusal: true }
  if (matches(RECORDS, raw)) return { skillId: 'records_needing_data', focus }
  if (matches(RISK, raw)) return { skillId: 'highest_risk_items', focus }
  if (matches(METRICS, raw)) return { skillId: 'workspace_metrics', focus }
  if (matches(TODAY, raw)) return { skillId: 'today_priorities', focus }
  return null
}
