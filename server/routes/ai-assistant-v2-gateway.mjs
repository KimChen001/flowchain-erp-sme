import { randomUUID } from 'node:crypto'
import { QUESTION_LIMITS, SETUP_FORM_ROWS } from '../../shared/assistant-protocol.mjs'
import { ASSISTANT_V2_LIMITS, SERVER_NOTE_PREFIX, answerAssistantV2 } from '../domain/ai-assistant-v2.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS } from '../domain/ai-assistant-v2-ui-tools.mjs'
import { AssistantModelError } from '../domain/ai-assistant-v2-model/model-error.mjs'
import { createAssistantV2CostLedger, createAssistantV2RateLimiter } from '../domain/ai-assistant-v2-controls.mjs'
import { assistantV2PermissionFingerprint, createAssistantV2ThreadStore } from '../domain/ai-assistant-v2-threads.mjs'
import { aiInjectionDetected } from '../domain/ai-injection-guard.mjs'
import { readFirstRunSetup } from '../domain/first-run-setup.mjs'
import { ITEM_SUPPLIER_NAMESPACE } from '../domain/master-data-commands.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { loadAiSkillContext } from '../domain/ai-skill-context.mjs'
import { recordAiSkillAudit } from '../domain/ai-skill-audit.mjs'
import { aiSkillText } from '../domain/ai-skill-copy.mjs'
import { presentAssistantV2Answer } from '../domain/ai-assistant-v2-answer.mjs'

// The assistant v2 branch of /api/ai-runtime/respond (docs/ai-assistant-v2-design.md
// §3.1, §3.2, §3.5, §3.8, §3.11). The gateway calls it, after the length
// check, when v2 is on for the request (assistantV2ModelClient). In order:
//   1. the injection guard: a fixed refusal in the question's language, no
//      model call, when the question or the open record trips it; earlier
//      turns that trip it are left out of the context instead (see
//      withoutInjectedTurns);
//   2. the per-user rate limit (30 questions per 10 minutes);
//   3. the cost reservation: when this month's remaining budget, less what
//      the workspace's running answers hold, cannot cover one answer's
//      ceiling, the over_cap notice;
//   4. the loop, on the user's thread, its events streamed as they happen and
//      stopped when the client goes away or the wall time runs out.
// Each request gets one codes-only audit row. A provider failure before any
// text or part was shown, or a month's cap that cannot cover an answer, gets
// a notice (unavailable, over_cap) with the loop's block in its audit row.
// Returns { handled: true }.

const THREADS = createAssistantV2ThreadStore()
const RATE_LIMITER = createAssistantV2RateLimiter()
const COST_LEDGER = createAssistantV2CostLedger()
// The loop ends itself at its own deadline, with an error event; this
// backstop only stops a loop that did not.
const BACKSTOP_MS = ASSISTANT_V2_LIMITS.timeoutMs + 5000
const THREAD_ID = /^[\w:-]{1,120}$/
const FORM_ID = /^[\w:-]{1,160}$/
const RECORD_ID = /^[\w-]{1,80}$/
const STATUS = /^[a-z_]{1,40}$/
const FORM_RESULTS = 5
const SETUP_TYPES = Object.freeze(['supplier', 'item'])
// A record a setup card reports counts only while its creation is this recent:
// as long as a thread lives.
const SETUP_NOTE_WINDOW_MS = 2 * 60 * 60 * 1000

const text = (value) => String(value ?? '').trim()

// The length check of a question assistant v2 answers: 2 to 8,000 characters,
// so rows pasted from a spreadsheet fit. The rules keep their 1,200.
export function validateAssistantV2Question(body = {}) {
  const length = text(body.message || body.question).length
  if (length > QUESTION_LIMITS.assistantV2) return { ok: false, status: 400, tooLong: true }
  // One character is a whole reply in a conversation (好, 行, 对, y); only an
  // empty question is too short (2026-11-06: "好" was refused with a 400).
  if (length < 1) return { ok: false, status: 400, tooLong: false }
  return { ok: true, status: 200 }
}

// The open record's fields go into the model's context as they are sent.
const activeContextInjected = (active) => Boolean(active && typeof active === 'object')
  && ['moduleId', 'entityType', 'entityId'].some((key) => aiInjectionDetected(active[key]))

// Earlier turns from the client reach the model only when the server has no
// thread for the conversation (new, expired, or busy), as plain context. A
// turn that trips the injection guard is left out rather than refusing the
// question: the client keeps sending a refused question in its history, and
// refusing would then refuse every later question of that conversation.
function withoutInjectedTurns(conversationContext) {
  if (!conversationContext || typeof conversationContext !== 'object') return { conversationContext, dropped: 0 }
  const injected = (...values) => values.some((value) => aiInjectionDetected(value))
  const turns = Array.isArray(conversationContext.previousTurns) ? conversationContext.previousTurns : []
  const previousTurns = turns.filter((turn) => !injected(turn?.question, turn?.answer))
  const previousDropped = injected(conversationContext.previousQuestion, conversationContext.previousConclusionTitle)
  const dropped = turns.length - previousTurns.length + (previousDropped ? 1 : 0)
  if (!dropped) return { conversationContext, dropped }
  const { previousQuestion, previousConclusionTitle, ...rest } = conversationContext
  return { conversationContext: { ...rest, previousTurns, ...(previousDropped ? {} : { previousQuestion, previousConclusionTitle }) }, dropped }
}

// The answer for a refusal before the model: the notice as the panel shows it,
// and the same words in the folded body for a client that reads only that.
function noticeAnswer(code, language, query) {
  const summary = aiSkillText(`assistant_v2.notice.${code}`, language)
  const response = presentAssistantV2Answer({ summary, language, query })
  const label = aiSkillText('answer.source_none', language)
  return {
    ...response,
    responseId: `ai-assistant-v2-${randomUUID()}`,
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
// suggestion trail, the ai_assistant origin). Anything else is ignored. The
// thread keeps each confirmed form with its request, which the loop accepts
// as backing for saying that request was created (design §8.4).
async function addFormNotes({ context, session, threadId, userId, formResults }) {
  if (!context.prisma || !Array.isArray(formResults)) return 0
  let added = 0
  // A record card reports each step the user took in it ({ actionId, type,
  // id, action }); forms report what they created.
  for (const entry of formResults.filter((row) => row && typeof row === 'object' && 'actionId' in row).slice(0, ACTION_RESULTS)) {
    added += await addActionNote({ context, session, threadId, userId, entry })
  }
  for (const entry of formResults.filter((row) => !(row && typeof row === 'object' && 'actionId' in row)).slice(0, FORM_RESULTS)) {
    const formId = text(entry?.formId)
    // A setup card reports the suppliers and items it created instead.
    if (Array.isArray(entry?.created)) {
      if (FORM_ID.test(formId) && formId.startsWith(`${threadId}:`)) added += await addSetupNote({ context, session, formId, userId, created: entry.created })
      continue
    }
    const requestId = text(entry?.purchaseRequestId)
    if (!FORM_ID.test(formId) || !formId.startsWith(`${threadId}:`) || !RECORD_ID.test(requestId) || session.forms.has(formId)) continue
    try {
      const [request, created] = await Promise.all([
        context.prisma.purchaseRequest.findFirst({ where: { id: requestId, tenantId: context.tenantId }, select: { id: true, status: true, requester: true } }),
        context.prisma.auditLog.findFirst({ where: { tenantId: context.tenantId, entityType: 'PurchaseRequest', entityId: requestId, action: 'purchase_request_created' }, select: { actorId: true, metadata: true, createdAt: true } }),
      ])
      const metadata = created?.metadata && typeof created.metadata === 'object' ? created.metadata : {}
      const origin = metadata.suggestions?.origin
      if (!request || text(request.requester) !== userId || text(created?.actorId) !== userId) continue
      if (metadata.idempotencyKey !== `ai-form:${formId}` || (origin !== undefined && origin !== 'ai_assistant')) continue
      const status = STATUS.test(text(request.status).toLowerCase()) ? text(request.status).toLowerCase() : 'unknown'
      const linked = await suppliersAddedWith({ context, requestId: request.id, linkIds: entry?.addedSupplierLinks, userId })
      const also = linked.length ? ` The same click added ${linked.join('; ')}.` : ''
      session.note(formId, { purchaseRequestId: request.id, status }, { role: 'user', content: [{ type: 'text', text: `Note from the server, not the user's words: form ${formId} created ${request.id} (${status}).${also}` }] })
      added += 1
    } catch {
      // An unreadable report adds no note; the answer goes on.
    }
  }
  return added
}

// The suppliers the form's click made approved suppliers of the request's
// items before it created the request: only the item-supplier links the form
// reports it created (addedSupplierLinks), each one a link of this workspace,
// for an item of the request, whose create audit row names this user while a
// thread can live. 2026-11-05: a window of "links this user created in the
// last minutes" also caught a link set up by other means and the answer said
// the click had added a supplier that was already approved. The note names
// them, so the model may say they were added. Nothing when it cannot be read.
async function suppliersAddedWith({ context, requestId, linkIds, userId }) {
  try {
    const ids = [...new Set((Array.isArray(linkIds) ? linkIds : []).map(text).filter((id) => RECORD_ID.test(id)))].slice(0, 8)
    if (!ids.length) return []
    const lines = await context.prisma.purchaseRequestLine.findMany({ where: { purchaseRequestId: requestId }, select: { itemId: true, sku: true } })
    const items = new Map(lines.filter((line) => text(line.itemId)).map((line) => [text(line.itemId), text(line.sku)]))
    if (!items.size) return []
    const since = new Date(Date.now() - SETUP_NOTE_WINDOW_MS)
    const added = []
    for (const id of ids) {
      const link = await context.prisma.runtimeRecord.findFirst({ where: { id, tenantId: context.tenantId, namespace: ITEM_SUPPLIER_NAMESPACE }, select: { id: true, payload: true } })
      const itemId = text(link?.payload?.itemId)
      if (!link || !items.has(itemId)) continue
      const creation = await context.prisma.auditLog.findFirst({ where: { tenantId: context.tenantId, entityType: 'item_supplier', entityId: id, action: 'create', actorId: userId, createdAt: { gte: since } }, select: { id: true } })
      if (!creation) continue
      const supplierId = text(link.payload?.supplierId)
      const supplier = supplierId ? await context.prisma.supplier.findFirst({ where: { id: supplierId, tenantId: context.tenantId }, select: { name: true, code: true } }) : null
      const name = noteName(supplier?.name) || noteName(supplier?.code)
      if (name) added.push(`${name} as an approved supplier of ${noteName(items.get(itemId)) || itemId}`)
    }
    return added
  } catch {
    return []
  }
}

// The steps a record card offers (offer_record_actions), each with the audit
// row its command writes (procurement-request-command-service.mjs,
// procurement-db-command-service.mjs) and the statuses its record may be in
// once the user took it: the one it leaves, or one a later step of the card
// leads to. Requesting quotes leaves the request approved, with its RFQ.
const RECORD_STEPS = Object.freeze({
  purchase_request: Object.freeze({
    submit: { audit: 'purchase_request_submit', entityType: 'PurchaseRequest', statuses: ['submitted', 'approved', 'rejected', 'converted'] },
    approve: { audit: 'purchase_request_approve', entityType: 'PurchaseRequest', statuses: ['approved', 'converted'] },
    reject: { audit: 'purchase_request_reject', entityType: 'PurchaseRequest', statuses: ['rejected'] },
    create_po: { audit: 'purchase_request_converted_to_purchase_orders', entityType: 'PurchaseRequest', statuses: ['converted'] },
    create_rfq: { audit: 'rfq_created_from_purchase_request', entityType: 'Rfq', statuses: ['approved'] },
  }),
  purchase_order: Object.freeze({
    approve: { audit: 'purchase_order_approve', entityType: 'PurchaseOrder', statuses: ['approved', 'issued', 'partially_received', 'fully_received', 'closed'] },
    issue: { audit: 'purchase_order_issue', entityType: 'PurchaseOrder', statuses: ['issued', 'partially_received', 'fully_received', 'closed'] },
  }),
})
const ACTION_ID = /^[\w:-]{1,200}$/
const ACTION_RESULTS = 10
const statusCode = (value) => (STATUS.test(text(value).toLowerCase()) ? text(value).toLowerCase() : 'unknown')
const orderNumber = (row) => noteName(row?.metadata?.orderNumber) || text(row?.id)

// A step the user took in a record card, as reported by the client, becomes
// a note in the thread only when the server can confirm it: the command's
// audit row in this workspace, with this user as the actor, written while a
// thread can live, under the card's idempotency key for that step
// (ai-action:<actionId>, the actionId naming this thread, the step and the
// record's version); and the record in this workspace, in a status the step
// leads to. Anything else is ignored. The note says what the user did, so the
// model may say it; the thread keeps the step, which the loop accepts as
// backing for saying it was taken.
async function addActionNote({ context, session, threadId, userId, entry }) {
  const actionId = text(entry?.actionId)
  const type = text(entry?.type)
  const id = text(entry?.id)
  const action = text(entry?.action)
  const step = RECORD_STEPS[type]?.[action]
  const key = `action:${actionId}`
  if (!step || !ACTION_ID.test(actionId) || !actionId.startsWith(`${threadId}:`) || !new RegExp(`:${action}:v\\d{1,9}$`).test(actionId) || !RECORD_ID.test(id) || session.forms.has(key)) return 0
  try {
    const { prisma, tenantId } = context
    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: step.audit, entityType: step.entityType, actorId: userId, createdAt: { gte: new Date(Date.now() - SETUP_NOTE_WINDOW_MS) }, ...(step.entityType === 'Rfq' ? {} : { entityId: id }) },
      select: { entityId: true, actorId: true, metadata: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const audit = (Array.isArray(audits) ? audits : []).find((row) => {
      const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
      return text(row.actorId) === userId && metadata.idempotencyKey === `ai-action:${actionId}` && (step.entityType === 'Rfq' ? text(metadata.purchaseRequestId) === id : text(row.entityId) === id)
    })
    if (!audit) return 0
    const cardId = actionId.replace(new RegExp(`:${action}:v\\d{1,9}$`), '')
    let words
    let record
    let created = []
    if (type === 'purchase_order') {
      const order = await prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId }, select: { id: true, status: true, metadata: true } })
      if (!order || !step.statuses.includes(statusCode(order.status))) return 0
      record = { number: orderNumber(order), status: statusCode(order.status) }
      words = action === 'approve'
        ? `approved ${record.number} (status now: ${record.status})`
        : `marked ${record.number} as issued (status now: ${record.status}); FlowChain records the issue and sends nothing to the supplier`
    } else {
      const request = await prisma.purchaseRequest.findFirst({ where: { id, tenantId: context.tenantId }, select: { id: true, status: true } })
      if (!request || !step.statuses.includes(statusCode(request.status))) return 0
      record = { number: text(request.id), status: statusCode(request.status) }
      if (action === 'create_po') {
        const ids = (Array.isArray(audit.metadata?.purchaseOrderIds) ? audit.metadata.purchaseOrderIds : []).map(text).filter((value) => RECORD_ID.test(value)).slice(0, 10)
        const orders = ids.length ? await prisma.purchaseOrder.findMany({ where: { tenantId: context.tenantId, id: { in: ids } }, select: { id: true, status: true, metadata: true } }) : []
        created = (Array.isArray(orders) ? orders : []).map((order) => ({ type: 'purchase_order', number: orderNumber(order), status: statusCode(order.status) }))
        if (!created.length) return 0
        words = `created ${created.map((order) => `${order.number} (status: ${order.status})`).join(' and ')} from ${record.number} (status now: ${record.status})`
      } else if (action === 'create_rfq') {
        const rfq = await prisma.rfq.findFirst({ where: { id: text(audit.entityId), tenantId: context.tenantId, sourceRequestId: id }, select: { id: true, status: true } })
        if (!rfq) return 0
        created = [{ type: 'rfq', number: text(rfq.id), status: statusCode(rfq.status) }]
        words = `created ${created[0].number} (status: ${created[0].status}; nothing is sent to suppliers until the RFQ is opened) from ${record.number} to request quotes`
      } else {
        words = `${{ submit: 'submitted', approve: 'approved', reject: 'rejected' }[action]} ${record.number}${action === 'submit' ? ' for approval' : ''} (status now: ${record.status})`
      }
    }
    session.note(key, { action: { type, action, id, number: record.number, status: record.status, created } }, { role: 'user', content: [{ type: 'text', text: `${SERVER_NOTE_PREFIX}, not the user's words: with card ${cardId} the user ${words}.` }] })
    return 1
  } catch {
    // An unreadable report adds no note; the answer goes on.
    return 0
  }
}

// The first-day checklist for the panel's empty state, as Today builds it
// (first-run-setup.mjs): open, and whether its first steps (items,
// suppliers) are still open, when the panel offers setup starters. null when
// it cannot be read; the panel then shows its usual starters.
export async function assistantV2SetupState(ctx) {
  try {
    const context = await loadAiSkillContext(ctx)
    if (!context.prisma) return null
    const checklist = await readFirstRunSetup(context.prisma, { tenantId: context.tenantId, now: context.now, access: reportReadAccessFor(context.actor), env: ctx.env || process.env })
    const open = (id) => checklist.steps.some((step) => step.id === id && !step.done)
    return { open: checklist.done < checklist.total, firstStepsOpen: open('items') || open('suppliers') }
  } catch {
    return null
  }
}

// A name as a note gives it: one line, clipped, and left out when it reads
// as an instruction (a name typed into the card never passed the guard).
const noteName = (value) => {
  const name = text(value).replace(/\s+/g, ' ').slice(0, 120)
  return name && !aiInjectionDetected(name) ? name : ''
}

// What a setup card created, as reported by the client: each supplier or item
// that exists in this workspace and that this user created (the create audit
// row the Suppliers and Items pages' commands write) while a thread can live.
// Each record is noted once, so a card that creates more after a retry adds
// only the new ones. The note names them, so the model may say "you created".
async function addSetupNote({ context, session, formId, userId, created }) {
  const wanted = []
  for (const entry of created.slice(0, SETUP_FORM_ROWS)) {
    const type = text(entry?.type)
    const id = text(entry?.id)
    const key = `${formId}|${type}:${id}`
    if (!SETUP_TYPES.includes(type) || !RECORD_ID.test(id) || session.forms.has(key) || wanted.some((row) => row.key === key)) continue
    wanted.push({ type, id, key })
  }
  const since = Date.now() - SETUP_NOTE_WINDOW_MS
  const confirmed = []
  for (const row of wanted) {
    try {
      const [record, creation] = await Promise.all([
        row.type === 'supplier'
          ? context.prisma.supplier.findFirst({ where: { id: row.id, tenantId: context.tenantId }, select: { id: true, code: true, name: true } })
          : context.prisma.item.findFirst({ where: { id: row.id, tenantId: context.tenantId }, select: { id: true, sku: true, name: true } }),
        context.prisma.auditLog.findFirst({ where: { tenantId: context.tenantId, entityType: row.type, entityId: row.id, action: 'create' }, select: { actorId: true, createdAt: true } }),
      ])
      const at = creation?.createdAt ? new Date(creation.createdAt).getTime() : Number.NaN
      if (!record || text(creation?.actorId) !== userId || !(at >= since)) continue
      const [code, name] = row.type === 'supplier' ? [noteName(record.code), noteName(record.name)] : [noteName(record.sku), noteName(record.name)]
      confirmed.push({ ...row, words: row.type === 'supplier' ? `supplier ${name || code || record.id}${code && name ? ` (code ${code})` : ''}` : `item ${code || record.id}${name ? ` (${name})` : ''}` })
    } catch {
      // An unreadable record adds nothing to the note.
    }
  }
  if (!confirmed.length) return 0
  const form = { setup: true, records: confirmed.map(({ type, id }) => ({ type, id })) }
  for (const row of confirmed.slice(1)) session.forms.set(row.key, form)
  session.note(confirmed[0].key, form, { role: 'user', content: [{ type: 'text', text: `${SERVER_NOTE_PREFIX}, not the user's words: with form ${formId} the user created ${confirmed.map((row) => row.words).join(', ')}.` }] })
  return confirmed.length
}

// The answer when assistant v2 cannot answer for this workspace at all
// (code: ai_off, no_provider or over_cap): a notice, with its audit row.
export async function answerWithAssistantV2Notice(ctx, body, code, { started = Date.now() } = {}) {
  const message = text(body.message || body.question)
  const answer = noticeAnswer(code, body.answerLanguage, message)
  await recordAiSkillAudit(ctx, { response: answer, facts: null, message, latencyMs: Date.now() - started, assistantV2: { status: 'off', reason: code } })
  if (ctx.aiStreamEvent) {
    ctx.aiStreamEvent({ type: 'notice', code })
    ctx.aiStreamEvent({ type: 'answer', status: 200, body: answer })
  } else ctx.send(ctx.res, 200, answer)
  return { handled: true }
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
  // A question the loop cannot take (the month's cap, the provider failing
  // before anything was shown) gets a notice that says so; there is no rules
  // answer behind it any more (owner direction 2026-11-05).
  const handBack = async (code, block) => {
    const answer = noticeAnswer(code, language, message)
    await audit(answer, block)
    if (emit) {
      emit({ type: 'notice', code })
      emit({ type: 'answer', status: 200, body: answer })
    } else send(res, 200, answer)
    return { handled: true }
  }

  if (aiInjectionDetected(message) || activeContextInjected(body.activeContext)) return refuse('injection_refused', 'injection')
  const { conversationContext, dropped: droppedTurns } = withoutInjectedTurns(body.conversationContext)

  // The actor from the server's identity: the thread, the rate limit and the
  // permission fingerprint all hang on it, never on anything the client sent.
  const context = await loadAiSkillContext(ctx)
  const userId = text(context.actor?.user?.id || context.actor?.userId || ctx.identity?.userId)
  if (!(ctx.aiAssistantV2RateLimiter || RATE_LIMITER).allow(`${context.tenantId}:${userId}`)) return refuse('rate_limited', 'rate_limited')

  const reservation = (ctx.aiAssistantV2CostLedger || COST_LEDGER).reserve(context.tenantId, ctx.aiWorkspaceAccess)
  if (!reservation.ok) return handBack('over_cap', { status: 'fallback', reason: 'over_cap' })

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
      result = await answerAssistantV2(loopCtx, { ...body, conversationContext, threadId }, {
        emit, signal: controller.signal, modelClient: client, uiTools: AI_ASSISTANT_V2_UI_TOOLS, thread: session.thread,
        formNotes: [...session.forms.values()],
        limits: { capRemainingMicros: reservation.capRemainingMicros },
      })
    } catch (error) {
      if (!(error instanceof AssistantModelError)) throw error
      return await handBack('unavailable', { status: 'fallback', reason: 'provider_error', ...(error.audit || {}) })
    }
    await audit(result.body, { status: gone ? 'cancelled' : backstop ? 'timeout' : 'answered', formNotes: notes, droppedTurns, ...result.audit })
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
    reservation.release()
  }
}
