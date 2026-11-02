import { randomUUID } from 'node:crypto'
import { ASSISTANT_V2_LIMITS, answerAssistantV2 } from '../domain/ai-assistant-v2.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS } from '../domain/ai-assistant-v2-ui-tools.mjs'
import { AssistantModelError } from '../domain/ai-assistant-v2-model/model-error.mjs'
import { assistantV2CostReservation, createAssistantV2RateLimiter } from '../domain/ai-assistant-v2-controls.mjs'
import { assistantV2PermissionFingerprint, createAssistantV2ThreadStore } from '../domain/ai-assistant-v2-threads.mjs'
import { aiInjectionDetected } from '../domain/ai-injection-guard.mjs'
import { loadAiSkillContext } from '../domain/ai-skill-context.mjs'
import { recordAiSkillAudit } from '../domain/ai-skill-audit.mjs'
import { aiSkillText } from '../domain/ai-skill-copy.mjs'
import { presentAiModelFirstAnswer } from '../domain/ai-model-first.mjs'

// The assistant v2 branch of /api/ai-runtime/respond (docs/ai-assistant-v2-design.md
// §3.1, §3.2, §3.5, §3.8, §3.11). The gateway calls it, after the length
// check, when v2 is on for the request (assistantV2ModelClient). In order:
//   1. the injection guard: a fixed refusal in the question's language, no
//      model call;
//   2. the per-user rate limit (30 questions per 10 minutes);
//   3. the cost reservation: when this month's remaining budget cannot cover
//      one answer's ceiling, the rules answer instead, with the over_cap notice;
//   4. the loop, on the user's thread, its events streamed as they happen and
//      stopped when the client goes away or the wall time runs out.
// Each request gets one codes-only audit row. A provider failure before any
// text or part was shown hands the request back to the gateway, which answers
// with the rules and the unavailable notice; the audit row of that answer
// carries the loop's block.
//
// Returns { handled: true } when it answered, else { handled: false,
// fallback: 'over_cap' | 'unavailable', audit }.

const THREADS = createAssistantV2ThreadStore()
const RATE_LIMITER = createAssistantV2RateLimiter()
// The loop ends itself at its own deadline, with an error event; this
// backstop only stops a loop that did not.
const BACKSTOP_MS = ASSISTANT_V2_LIMITS.timeoutMs + 5000
const THREAD_ID = /^[\w:-]{1,120}$/
const FORM_ID = /^[\w:-]{1,160}$/
const RECORD_ID = /^[\w-]{1,80}$/
const STATUS = /^[a-z_]{1,40}$/
const FORM_RESULTS = 5

const text = (value) => String(value ?? '').trim()

// The answer for a refusal before the model: the notice as the panel shows it,
// and the same words in the folded body for a client that reads only that.
function noticeAnswer(code, language, query) {
  const summary = aiSkillText(`assistant_v2.notice.${code}`, language)
  const response = presentAiModelFirstAnswer({ answer: { title: summary, answer: summary, records: [] }, refs: [], stats: { calls: [] }, facts: null, language, query })
  const label = aiSkillText('answer.source_none', language)
  return {
    ...response,
    responseId: `ai-assistant-v2-${randomUUID()}`,
    intent: 'assistant_v2',
    answerSource: 'assistant_v2',
    answerSourceLabel: label,
    runtimeModeLabel: label,
    conclusion: { ...response.conclusion, severity: 'warning' },
    parts: [],
  }
}

// What an in-chat form created, as reported by the client, becomes a note in
// the thread only when the server can confirm it: a purchase request of this
// workspace that this user created from that very form (its creation carries
// the form's idempotency key, ai-form:<formId>, and, when the form recorded a
// suggestion trail, the ai_assistant origin). Anything else is ignored.
async function addFormNotes({ context, session, threadId, userId, formResults }) {
  if (!context.prisma || !Array.isArray(formResults)) return 0
  let added = 0
  for (const entry of formResults.slice(0, FORM_RESULTS)) {
    const formId = text(entry?.formId)
    const requestId = text(entry?.purchaseRequestId)
    if (!FORM_ID.test(formId) || !formId.startsWith(`${threadId}:`) || !RECORD_ID.test(requestId) || session.notedForms.has(formId)) continue
    try {
      const [request, created] = await Promise.all([
        context.prisma.purchaseRequest.findFirst({ where: { id: requestId, tenantId: context.tenantId }, select: { id: true, status: true, requester: true } }),
        context.prisma.auditLog.findFirst({ where: { tenantId: context.tenantId, entityType: 'PurchaseRequest', entityId: requestId, action: 'purchase_request_created' }, select: { actorId: true, metadata: true } }),
      ])
      const metadata = created?.metadata && typeof created.metadata === 'object' ? created.metadata : {}
      const origin = metadata.suggestions?.origin
      if (!request || text(request.requester) !== userId || text(created?.actorId) !== userId) continue
      if (metadata.idempotencyKey !== `ai-form:${formId}` || (origin !== undefined && origin !== 'ai_assistant')) continue
      const status = text(request.status).toLowerCase()
      session.notedForms.add(formId)
      session.thread.messages.push({ role: 'user', content: [{ type: 'text', text: `Note from the server, not the user's words: form ${formId} created ${request.id} (${STATUS.test(status) ? status : 'unknown'}).` }] })
      added += 1
    } catch {
      // An unreadable report adds no note; the answer goes on.
    }
  }
  return added
}

export async function answerWithAssistantV2(ctx, body, { client, started = Date.now() } = {}) {
  const { res } = ctx
  const send = ctx.send
  const emit = ctx.aiStreamEvent || null
  const message = text(body.message || body.question)
  const language = body.answerLanguage
  const audit = (response, assistantV2, extra = {}) => recordAiSkillAudit(ctx, { response, facts: null, message, latencyMs: Date.now() - started, assistantV2, ...extra })
  const refuse = async (code, reason) => {
    const answer = noticeAnswer(code, language, message)
    await audit(answer, { status: 'refused', reason }, { refusal: true })
    if (emit) {
      emit({ type: 'notice', code })
      emit({ type: 'answer', status: 200, body: answer })
    } else send(res, 200, answer)
    return { handled: true }
  }

  if (aiInjectionDetected(message)) return refuse('injection_refused', 'injection')

  // The actor from the server's identity: the thread, the rate limit and the
  // permission fingerprint all hang on it, never on anything the client sent.
  const context = await loadAiSkillContext(ctx)
  const userId = text(context.actor?.user?.id || context.actor?.userId || ctx.identity?.userId)
  if (!(ctx.aiAssistantV2RateLimiter || RATE_LIMITER).allow(`${context.tenantId}:${userId}`)) return refuse('rate_limited', 'rate_limited')

  const reservation = assistantV2CostReservation(ctx.aiWorkspaceAccess)
  if (!reservation.ok) return { handled: false, fallback: 'over_cap', audit: { status: 'fallback', reason: 'over_cap' } }

  const threadId = THREAD_ID.test(text(body.threadId)) ? text(body.threadId) : `thr_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const session = (ctx.aiAssistantV2Threads || THREADS).open({ tenantId: context.tenantId, userId, threadId, fingerprint: assistantV2PermissionFingerprint(context.actor) })
  // A client that goes away stops the answer: no further model call is made
  // or metered. The response's 'close' is used, not the request's: the
  // request closes as soon as its body has been read.
  const controller = new AbortController()
  let gone = false
  let backstop = false
  const onClose = () => {
    if (res?.writableEnded) return
    gone = true
    controller.abort()
  }
  res?.on?.('close', onClose)
  const timer = setTimeout(() => { backstop = true; controller.abort() }, BACKSTOP_MS)
  try {
    const notes = await addFormNotes({ context, session, threadId, userId, formResults: body.formResults })
    // The loop reads the same actor rather than resolving it again.
    const loopCtx = { ...ctx, aiSkillActor: context.actor, ...(context.prisma ? { aiSkillPrisma: context.prisma } : {}) }
    let result
    try {
      result = await answerAssistantV2(loopCtx, { ...body, threadId }, {
        emit, signal: controller.signal, modelClient: client, uiTools: AI_ASSISTANT_V2_UI_TOOLS, thread: session.thread,
        limits: { capRemainingMicros: reservation.capRemainingMicros },
      })
    } catch (error) {
      if (!(error instanceof AssistantModelError)) throw error
      return { handled: false, fallback: 'unavailable', audit: { status: 'fallback', reason: 'provider_error', ...(error.audit || {}) } }
    }
    await audit(result.body, { status: gone ? 'cancelled' : backstop ? 'timeout' : 'answered', formNotes: notes, ...result.audit })
    if (gone) return { handled: true }
    if (backstop) {
      if (emit) {
        emit({ type: 'error', code: 'timeout', retryable: true })
        emit({ type: 'answer', status: 200, body: result.body })
      } else send(res, 200, result.body)
      return { handled: true }
    }
    // A streaming client already has the answer line, which ended the stream.
    if (!emit) send(res, 200, result.body)
    return { handled: true }
  } finally {
    clearTimeout(timer)
    res?.off?.('close', onClose)
    session.close()
  }
}
