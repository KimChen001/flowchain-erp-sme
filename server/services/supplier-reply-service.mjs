// Supplier replies on a purchase order (docs/supplier-reply-dates-design.md,
// built as option A of docs/workflow-automation-design.md): a person pastes a
// reply, it is read once with no tools and checked in code
// (supplier-reply-reading.mjs), and a card offers the new promised dates.
// Recording runs the promised-dates command as the person who confirms, with
// the reply as its origin. Shapes: shared/supplier-reply-contract.mjs.
//
// Who may do what (#392 WA-3): the paster reads, the confirmer writes, and
// nobody else runs anything. Listing follows the order's read permission
// (readPurchaseOrder); pasting, recording, dismissing and "not now" need
// procurement.purchase_order.revise. A card stores ids, dates and quotes and
// is rendered for each reader: names and quantities from the order as that
// reader may read it now, never a price.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  SUPPLIER_REPLY_CONTRACT_VERSION, SUPPLIER_REPLY_EMAIL_ORDER_LIMIT, SUPPLIER_REPLY_LIMITS, SUPPLIER_REPLY_OPEN_STATES,
  supplierReplyCardSchema, supplierReplyDismissRequestSchema, supplierReplyNotNowRequestSchema, supplierReplyPasteRequestSchema, supplierReplyRecordRequestSchema,
} from '../../shared/supplier-reply-contract.mjs'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { ASSISTANT_V2_COST_LEDGER } from '../domain/ai-assistant-v2-controls.mjs'
import { createAssistantV2ModelClient } from '../domain/ai-assistant-v2-model/index.mjs'
import { providerRuntimeConfig } from '../domain/ai-runtime-provider-adapter-v2.mjs'
import { anthropicMessagesUsage } from '../domain/ai-runtime-provider-specific-adapters-v2.mjs'
import { aiCallCostMicros, aiUsagePrices, recordAiProviderCall } from '../domain/ai-usage-meter.mjs'
import { withAiWorkspaceAccess } from '../domain/ai-workspace-access.mjs'
import { addWorkdays } from '../domain/decision-items.mjs'
import { localDevelopmentEnabled } from '../domain/local-development-contract.mjs'
import { ITEM_SUPPLIER_NAMESPACE, mapItemSupplierRecord } from '../domain/master-data-commands.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { procurementReadAccessFor } from '../domain/procurement-read-access.mjs'
import { emailOrdersToRead, orderNumberVariants, orderNumbersNamed, orderSequenceMentions } from '../domain/supplier-reply-orders.mjs'
import { SUPPLIER_REPLY_ORDER_STATES, checkReplyReading, cleanSupplierReply, daysBetween, readSupplierReply, supplierReplyInstructionsIgnored, supplierReplyPromptTokens } from '../domain/supplier-reply-reading.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const REVISE = 'procurement.purchase_order.revise'
// A reply is received within this many days before today (#394 review).
const SUPPLIER_REPLY_RECEIVED_WITHIN_DAYS = 60
// "Not now" puts the card back after this many workdays, as a chased overdue
// order comes back (DECISION_RETURN.chasedWorkdays).
const NOT_NOW_WORKDAYS = 3

export class SupplierReplyError extends Error {
  constructor(code, message, status = 400, details = []) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}
const fail = (code, message, status, details) => { throw new SupplierReplyError(code, message, status, details) }

// The request body checked against its schema; a 422 naming each field.
function parsed(schema, body) {
  const result = schema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
  if (!result.success) fail('SUPPLIER_REPLY_INVALID', 'The request does not match what this route takes.', 422, result.error.issues.slice(0, 10).map((issue) => ({ field: issue.path.join('.') || null, code: issue.code })))
  return result.data
}

// The supplier's own code for each line's item, from the order supplier's
// active item-supplier links, by line id; empty when none can be read.
async function supplierSkusOf(client, tenantId, order) {
  const supplierId = text(order.supplierId)
  const keys = [...new Set(array(order.lines).map((line) => text(line.itemId)).filter(Boolean).map((itemId) => `${itemId}::${supplierId}`))]
  if (!supplierId || !keys.length || typeof client?.runtimeRecord?.findMany !== 'function') return new Map()
  try {
    const records = await client.runtimeRecord.findMany({ where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: { in: keys } }, select: { id: true, payload: true } })
    const byItem = new Map(records.map((record) => mapItemSupplierRecord(record)).filter((link) => link.active && link.supplierSku).map((link) => [text(link.itemId), text(link.supplierSku)]))
    return new Map(array(order.lines).filter((line) => byItem.has(text(line.itemId))).map((line) => [line.purchaseOrderLineId || line.id, byItem.get(text(line.itemId))]))
  } catch {
    return new Map()
  }
}

// A fixed reader for browser specs and local walkthroughs, never for a
// deployment: FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED names a JSON file holding a
// reading, or { "readings": [{ "match": "text in the reply", "reading": {...} }] }
// (the first match wins; the last entry otherwise). Only under NODE_ENV=test
// or controlled local development; the AI switch and cap still apply, and the
// file counts as a provider, as a recorded assistant transcript does.
export function supplierReplyScriptedClient(env = {}) {
  const file = text(env.FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED)
  if (!file || !(text(env.NODE_ENV) === 'test' || localDevelopmentEnabled(env))) return null
  return {
    async *stream({ messages }) {
      const script = JSON.parse(readFileSync(file, 'utf8'))
      const asked = String(array(messages)[0]?.content ?? '')
      const entries = Array.isArray(script?.readings) ? script.readings : [{ reading: script }]
      const picked = entries.find((entry) => entry.match && asked.includes(entry.match)) || entries.at(-1)
      yield { type: 'text_delta', text: JSON.stringify(picked?.reading ?? {}) }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, content: [] }
    },
  }
}

// The order as the steps read it (supplierReplyOrderSchema): every line with
// a reference, the open ones offered to the model.
export function supplierReplyOrderSnapshot(order, supplierSkus = new Map()) {
  return {
    id: order.id,
    number: text(order.number) || order.id,
    supplierName: text(order.supplierSnapshot?.supplierName) || null,
    status: text(order.status),
    lines: array(order.lines).map((line, at) => ({
      ref: `L${at + 1}`,
      purchaseOrderLineId: line.purchaseOrderLineId || line.id,
      sku: text(line.sku) || null,
      supplierSku: supplierSkus.get(line.purchaseOrderLineId || line.id) || null,
      itemName: text(line.itemName) || null,
      remaining: Number.isFinite(Number(line.remainingQuantity)) ? Number(line.remainingQuantity) : null,
      unit: text(line.unit) || null,
      promisedDate: line.promisedDate || null,
    })),
  }
}

// One model call as the reading makes it: the assistant's client with no
// tools, its text collected, its usage counted in the workspace's month.
// A call the provider reports no usage for is metered at its reservation
// estimate (the prompt, and the whole output allowance), never as free.
// signal: the request's, joined with a deadline (READING_DEADLINE_MS), so a
// stream that stalls ends as failed and the reply is still kept.
const READING_DEADLINE_MS = 45_000
async function streamedCall(client, { system, messages, maxTokens }, signal, estimate, deadlineMs = READING_DEADLINE_MS) {
  let answer = ''
  let usage = null
  const deadline = AbortSignal.timeout(deadlineMs)
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    // The signal ends a stream that stalls; { deadline } bounds the resilient
    // client's wait for a first event and its one retry.
    for await (const event of client.stream({ system, messages, tools: [], maxTokens }, stop, { deadline: Date.now() + deadlineMs })) {
      if (stop.aborted) throw Object.assign(new Error('The reading was stopped.'), { name: 'AbortError' })
      if (event?.type === 'text_delta') answer += event.text || ''
      if (event?.type === 'message_end') {
        usage = anthropicMessagesUsage({ usage: event.usage })
        if (!answer) answer = array(event.content).filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
      }
    }
  } catch (error) {
    await recordAiProviderCall({ ok: false })
    throw error
  }
  const metered = usage || estimate || null
  await recordAiProviderCall({ ok: true, usage: metered })
  return { text: answer, usage: metered }
}

export function createSupplierReplyService({ prisma = null, env = process.env, procurement, now = () => new Date(), idFactory = randomUUID, ledger = ASSISTANT_V2_COST_LEDGER, modelClient, readingDeadlineMs = READING_DEADLINE_MS } = {}) {
  if (!procurement?.readPurchaseOrder || !procurement?.revisePromisedDates) throw new Error('The supplier reply service needs the procurement command service.')
  const db = async () => prisma || getPrismaClient(env)
  const actorOf = async (client, context) => resolveProvisionedActor(client, context?.identity || context)
  const todayOf = async (client, tenantId) => {
    const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
    return tenantCalendarDay(now(), tenant?.timezone || undefined)
  }
  const readOrder = (orderId, context, access) => procurement.readPurchaseOrder(orderId, context, { includePrices: false, includePartner: true })

  // The card for one reader: the stored check joined with the order as this
  // reader reads it now.
  function cardOf(row, { order, access, actor, today, skus = new Map() }) {
    const lines = new Map(array(order.lines).map((line) => [line.purchaseOrderLineId || line.id, line]))
    const orderOpen = SUPPLIER_REPLY_ORDER_STATES.includes(text(order.status))
    // A reading's line keeps currentDate as the date it was read against; the
    // order's date now is in formLines. They differ when the dates changed on
    // the order meanwhile: recording the proposal is then refused
    // (SUPPLIER_REPLY_STALE). Days late count from the order's date now.
    const view = (lineId, fields) => {
      const line = lines.get(lineId) || {}
      const remaining = Number.isFinite(Number(line.remainingQuantity)) ? Number(line.remainingQuantity) : null
      const current = line.promisedDate || null
      const late = orderOpen && remaining > 0 && current && today && current < today ? daysBetween(current, today) : null
      return { sku: text(line.sku) || null, supplierSku: skus.get(lineId) || null, itemName: text(line.itemName) || null, remaining, unit: text(line.unit) || null, overdueDays: late, ...fields }
    }
    const check = row.check || null
    // Open and the order's active card: an outage paste beside an open card
    // does not take its place (#394 review), so it is not decided here.
    const open = SUPPLIER_REPLY_OPEN_STATES.includes(row.state) && Boolean(row.activeKey)
    const card = {
      contractVersion: SUPPLIER_REPLY_CONTRACT_VERSION,
      id: row.id,
      purchaseOrderId: order.id,
      purchaseOrderNumber: text(order.number) || order.id,
      orderVersion: Number(order.version) || 0,
      // As the order shows it: a purchase order's supplier is not hidden by
      // role (procurement-read-access.mjs hides invoice suppliers only).
      supplierName: text(order.supplierSnapshot?.supplierName) || null,
      source: row.source,
      receivedOn: row.receivedOn,
      createdAt: new Date(row.createdAt).toISOString(),
      state: row.state,
      readingStatus: row.readingStatus,
      replyKind: check?.replyKind ?? null,
      text: row.text,
      quotedTextHidden: Boolean(row.quotedTextHidden),
      quotedText: row.quotedText || null,
      lines: array(check?.lines).map((line) => view(line.purchaseOrderLineId, line)),
      flags: array(check?.flags),
      reason: check?.reason ?? null,
      instructionsIgnored: Boolean(row.instructionsIgnored),
      formLines: array(order.lines).filter((line) => Number(line.remainingQuantity) > 0).map((line) => {
        const { sku, supplierSku, itemName, remaining, unit, overdueDays } = view(line.purchaseOrderLineId || line.id, {})
        return { purchaseOrderLineId: line.purchaseOrderLineId || line.id, sku, supplierSku, itemName, remaining, unit, currentDate: line.promisedDate || null, overdueDays }
      }),
      canDecide: open && orderOpen && can({ actor, permission: REVISE, tenantId: actor.tenantId }),
      notNowUntil: row.notNowUntil || null,
      decision: row.decision ? {
        option: row.decision, reason: row.reasonCode || null, note: row.note || null, decidedById: row.decidedById,
        decidedAt: new Date(row.decidedAt).toISOString(), editedLines: Number(row.editedLines) || 0, revisionIds: array(row.revisionIds),
      } : null,
      supersededById: row.supersededById || null,
    }
    // An email that named several orders: which ones, and this card's.
    const email = row.usage?.email
    if (Array.isArray(email?.orders) && email.orders.length) {
      card.emailOrders = email.orders.slice(0, 20).map((item) => ({ number: text(item.number), status: item.purchaseOrderId && item.purchaseOrderId === order.id ? 'this' : item.why || 'read' }))
    }
    return supplierReplyCardSchema.parse(card)
  }

  // The reading, inside the workspace's AI access: the opt-in and the monthly
  // cap apply, and each call's estimate is held in the assistant's cost
  // ledger first. Off, over the cap or without a model: an outage code.
  async function readWithModel({ client, context, tenantId, snapshot, cleaned, receivedOn, today, signal }) {
    const scripted = modelClient === undefined ? supplierReplyScriptedClient(env) : null
    const accessEnv = scripted ? { ...env, FLOWCHAIN_AI_ASSISTANT_MODE: 'assistant_v2', FLOWCHAIN_AI_ASSISTANT_SCRIPTED: text(env.FLOWCHAIN_SUPPLIER_REPLY_SCRIPTED) } : env
    return withAiWorkspaceAccess({ identity: context?.identity || context, env: accessEnv, aiWorkspacePrisma: client }, async (scoped) => {
      const status = scoped.aiWorkspaceAccessStatus
      if (status !== 'on') return { readingStatus: status === 'no_provider' ? 'no_provider' : status === 'over_cap' ? 'over_cap' : 'ai_off', reading: null, calls: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      let model = scripted || modelClient
      if (model === undefined) {
        try { model = createAssistantV2ModelClient(scoped.env) } catch { model = null }
      }
      if (!model) return { readingStatus: 'no_provider', reading: null, calls: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      const prices = aiUsagePrices(scoped.env)
      const provider = providerRuntimeConfig(scoped.env).kind || null
      const modelName = text(scoped.env.FLOWCHAIN_AI_PROVIDER_MODEL) || null
      // Both calls of a reading are held at once, at their worst case.
      const reserve = async (call) => {
        const micros = aiCallCostMicros({ inputTokens: supplierReplyPromptTokens(call), outputTokens: call.maxTokens }, prices) * Math.max(1, Number(call.calls) || 1)
        const hold = ledger.reserve(tenantId, scoped.aiWorkspaceAccess, { micros })
        return hold.ok ? hold : { ok: false, code: 'over_cap' }
      }
      const callModel = async (call) => ({ ...(await streamedCall(model, call, signal, { inputTokens: supplierReplyPromptTokens(call), outputTokens: call.maxTokens }, readingDeadlineMs)), provider, model: modelName })
      return readSupplierReply({ order: snapshot, text: cleaned.text, receivedOn, today, callModel, reserve })
    })
  }

  async function pasteReply(orderId, body, context, { signal } = {}) {
    const input = parsed(supplierReplyPasteRequestSchema, body)
    const client = await db()
    const actor = await actorOf(client, context)
    assertAuthorized({ actor, permission: REVISE, tenantId: actor.tenantId })
    const access = procurementReadAccessFor(actor)
    const order = await readOrder(orderId, context, access)
    if (!SUPPLIER_REPLY_ORDER_STATES.includes(text(order.status))) fail('SUPPLIER_REPLY_ORDER_NOT_OPEN', 'Supplier replies are recorded on issued or partly received purchase orders.', 409, [{ field: 'status', code: text(order.status) }])
    const today = await todayOf(client, actor.tenantId)
    const receivedOn = input.receivedOn || today
    if (receivedOn > today) fail('SUPPLIER_REPLY_RECEIVED_IN_FUTURE', 'The reply cannot be received after today.', 422, [{ field: 'receivedOn' }])
    // An old reply would anchor relative dates in the past (#394 review).
    if (daysBetween(receivedOn, today) > SUPPLIER_REPLY_RECEIVED_WITHIN_DAYS) fail('SUPPLIER_REPLY_RECEIVED_TOO_EARLY', `The reply must be received within the last ${SUPPLIER_REPLY_RECEIVED_WITHIN_DAYS} days.`, 422, [{ field: 'receivedOn' }])
    const cleaned = cleanSupplierReply(input.text)
    if (!cleaned.text) fail('SUPPLIER_REPLY_EMPTY', 'Nothing is left of the reply once the quoted earlier message is removed.', 422, [{ field: 'text' }])
    const skus = await supplierSkusOf(client, actor.tenantId, order)
    const snapshot = supplierReplyOrderSnapshot(order, skus)
    // An email about several orders is read on each (pasteSeveral); with one
    // order named, the paste is read as before. An order number written
    // another way (PO 202611-0013, 0013) counts when it matches exactly one
    // of the supplier's orders.
    // An order named by its sequence alone ("Order 14", 订单14) is checked
    // against the supplier's open orders (knownOrderSequenceWritten), from the
    // same lookup with each order's status.
    const variants = orderNumberVariants(cleaned.text, snapshot.number)
    const bySequence = orderSequenceMentions(cleaned.text).length > 0
    const supplierRows = (variants || bySequence) && text(order.supplierId)
      // Closed orders stay in: they are other orders too. Newest first, in a
      // stable order, so the same 500 are matched on every paste.
      ? (await client.purchaseOrder.findMany({ where: { tenantId: actor.tenantId, supplierId: text(order.supplierId) }, select: { number: true, status: true }, orderBy: [{ number: 'desc' }, { id: 'asc' }], take: 500 })).filter((row) => text(row.number))
      : []
    const known = variants ? supplierRows.map((row) => text(row.number)) : []
    const supplierOrders = bySequence ? supplierRows.map((row) => ({ number: text(row.number), status: text(row.status) })) : null
    const named = orderNumbersNamed(cleaned.text, snapshot.number, known)
    if (named.length >= 2) return pasteSeveral({ client, actor, access, context, order, snapshot, skus, cleaned, input, receivedOn, today, named, known, signal })
    const startedAt = Date.now()
    const read = await readWithModel({ client, context, tenantId: actor.tenantId, snapshot, cleaned, receivedOn, today, signal })
    // The check tells the email's numbers from the same supplier orders.
    const check = read.readingStatus === 'read' ? checkReplyReading({ order: snapshot, text: cleaned.text, receivedOn, reading: read.reading, orderNumbers: known, supplierOrders }) : null
    const state = check ? check.state : 'needs_you'
    const id = idFactory()
    const open = SUPPLIER_REPLY_OPEN_STATES.includes(state)
    // A later reply replaces the order's open card (#392 §2) only when it was
    // read and is itself open: an outage, an auto-reply or nothing to record
    // does not push a proposal aside (#394 review). Without an open card, an
    // open reply (an outage's manual form too) becomes the card.
    const takesOver = open && read.readingStatus === 'read'
    let superseded = []
    let active = false
    try {
      await client.$transaction(async (tx) => {
        const previous = await tx.supplierReply.findMany({ where: { tenantId: actor.tenantId, purchaseOrderId: order.id, activeKey: { not: null } }, select: { id: true } })
        if (takesOver) superseded = previous.map((row) => row.id)
        if (superseded.length) await tx.supplierReply.updateMany({ where: { tenantId: actor.tenantId, id: { in: superseded } }, data: { state: 'superseded', activeKey: null, supersededById: id } })
        active = open && (takesOver || !previous.length)
        await tx.supplierReply.create({
          data: {
            id, tenantId: actor.tenantId, purchaseOrderId: order.id, supplierId: text(order.supplierId) || null, activeKey: active ? order.id : null,
            source: 'paste', receivedOn, text: cleaned.text, quotedTextHidden: cleaned.quotedTextHidden, quotedText: cleaned.quoted, state, readingStatus: read.readingStatus,
            provider: read.provider || null, model: read.model || null, promptVersion: read.promptVersion || null, reading: read.reading || null, check: check || null,
            usage: { calls: read.calls, inputTokens: read.usage?.inputTokens || 0, outputTokens: read.usage?.outputTokens || 0, ms: Date.now() - startedAt, invisibleRemoved: cleaned.invisibleRemoved, issues: read.issues || null },
            instructionsIgnored: supplierReplyInstructionsIgnored(input.text), createdById: actor.user.id,
          },
        })
        // Codes and ids only: the reply text stays on its own row.
        await tx.auditLog.create({
          data: {
            id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_service', module: 'procurement', action: 'supplier_reply_pasted',
            entityType: 'PurchaseOrder', entityId: order.id, summary: `Supplier reply on purchase order ${snapshot.number}: ${state}.`,
            metadata: { replyId: id, state, readingStatus: read.readingStatus, calls: read.calls, lines: array(check?.lines).map((line) => line.outcome), superseded, active },
          },
        })
      })
    } catch (error) {
      if (error?.code === 'P2002') fail('SUPPLIER_REPLY_CONFLICT', 'Another reply was pasted on this order at the same time. Reload and try again.', 409)
      throw error
    }
    const row = await client.supplierReply.findFirst({ where: { id, tenantId: actor.tenantId } })
    return { reply: cardOf(row, { order, access, actor, today, skus }) }
  }

  // An email that names two or more orders in this order's numbering
  // (supplier-reply-orders.mjs, assessment §9): read on this order and on each
  // other named order that is open and has this order's supplier, at most
  // SUPPLIER_REPLY_EMAIL_ORDER_LIMIT in all, each against its own lines; the
  // check keeps each order to its own part of the text. One reply row per
  // order read, each its order's card as a single paste makes it (the same
  // supersede rule per order), each keeping the email's orders (usage.email)
  // for the card's notice. The others are listed, not read.
  async function pasteSeveral({ client, actor, access, context, order, snapshot, skus, cleaned, input, receivedOn, today, named, known = [], signal }) {
    const upper = (value) => text(value).toUpperCase()
    const others = named.filter((number) => number !== upper(snapshot.number))
    const found = await client.purchaseOrder.findMany({ where: { tenantId: actor.tenantId, number: { in: others } }, select: { id: true, number: true, status: true, supplierId: true } })
    const byNumber = new Map(found.map((row) => [upper(row.number), row]))
    const choice = emailOrdersToRead({
      named, pastedOn: snapshot.number, openStates: SUPPLIER_REPLY_ORDER_STATES, limit: SUPPLIER_REPLY_EMAIL_ORDER_LIMIT,
      orders: [{ number: snapshot.number, status: text(order.status), supplier: text(order.supplierId) || null }, ...found.map((row) => ({ number: row.number, status: text(row.status), supplier: text(row.supplierId) || null }))],
    })
    const notRead = [...choice.notRead]
    const targets = [{ order, snapshot, skus }]
    for (const number of choice.read.slice(1)) {
      // Read as this reader may read it; an order the reader cannot open is
      // not found, as the routes answer.
      const other = await readOrder(byNumber.get(number).id, context, access).catch(() => null)
      if (!other) { notRead.push({ number, why: 'unknown' }); continue }
      const otherSkus = await supplierSkusOf(client, actor.tenantId, other)
      targets.push({ order: other, snapshot: supplierReplyOrderSnapshot(other, otherSkus), skus: otherSkus })
    }
    const emailRead = targets.map((target) => upper(target.snapshot.number))
    // Another order that already has an open card keeps it: a paste never
    // replaces another order's card, as an emailed reply never does (#425).
    // That order is not read, and the card lists it as kept.
    const withOpenCard = new Set((await client.supplierReply.findMany({ where: { tenantId: actor.tenantId, purchaseOrderId: { in: targets.slice(1).map((target) => target.order.id) }, activeKey: { not: null } }, select: { purchaseOrderId: true } })).map((row) => row.purchaseOrderId))
    for (const target of targets.slice(1)) if (withOpenCard.has(target.order.id)) notRead.push({ number: upper(target.snapshot.number), why: 'open_card_kept' })
    const toRead = targets.filter((target, at) => at === 0 || !withOpenCard.has(target.order.id))
    const startedAt = Date.now()
    const readings = await Promise.all(toRead.map(async (target) => {
      const read = await readWithModel({ client, context, tenantId: actor.tenantId, snapshot: target.snapshot, cleaned, receivedOn, today, signal })
      const check = read.readingStatus === 'read' ? checkReplyReading({ order: target.snapshot, text: cleaned.text, receivedOn, reading: read.reading, emailRead, orderNumbers: known }) : null
      return { ...target, read, check, ms: Date.now() - startedAt, id: idFactory() }
    }))
    const email = {
      orders: [
        ...readings.map((row) => ({ number: upper(row.snapshot.number), purchaseOrderId: row.order.id, why: null })),
        ...notRead.map((row) => ({ number: row.number, purchaseOrderId: null, why: row.why })),
      ].slice(0, 20),
    }
    const instructionsIgnored = supplierReplyInstructionsIgnored(input.text)
    try {
      await client.$transaction(async (tx) => {
        for (const row of readings) {
          const state = row.check ? row.check.state : 'needs_you'
          const open = SUPPLIER_REPLY_OPEN_STATES.includes(state)
          // Only the order pasted on may replace its open card; on another
          // order a card that opened meanwhile is kept, and this reply waits.
          const takesOver = open && row.read.readingStatus === 'read' && row.order.id === order.id
          const previous = await tx.supplierReply.findMany({ where: { tenantId: actor.tenantId, purchaseOrderId: row.order.id, activeKey: { not: null } }, select: { id: true } })
          const superseded = takesOver ? previous.map((item) => item.id) : []
          if (superseded.length) await tx.supplierReply.updateMany({ where: { tenantId: actor.tenantId, id: { in: superseded } }, data: { state: 'superseded', activeKey: null, supersededById: row.id } })
          const active = open && (takesOver || !previous.length)
          await tx.supplierReply.create({
            data: {
              id: row.id, tenantId: actor.tenantId, purchaseOrderId: row.order.id, supplierId: text(row.order.supplierId) || null, activeKey: active ? row.order.id : null,
              source: 'paste', receivedOn, text: cleaned.text, quotedTextHidden: cleaned.quotedTextHidden, quotedText: cleaned.quoted, state, readingStatus: row.read.readingStatus,
              provider: row.read.provider || null, model: row.read.model || null, promptVersion: row.read.promptVersion || null, reading: row.read.reading || null, check: row.check || null,
              usage: { calls: row.read.calls, inputTokens: row.read.usage?.inputTokens || 0, outputTokens: row.read.usage?.outputTokens || 0, ms: row.ms, invisibleRemoved: cleaned.invisibleRemoved, issues: row.read.issues || null, email },
              instructionsIgnored, createdById: actor.user.id,
            },
          })
          await tx.auditLog.create({
            data: {
              id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_service', module: 'procurement', action: 'supplier_reply_pasted',
              entityType: 'PurchaseOrder', entityId: row.order.id, summary: `Supplier reply on purchase order ${row.snapshot.number}, from an email naming ${named.length} orders: ${state}.`,
              metadata: { replyId: row.id, state, readingStatus: row.read.readingStatus, calls: row.read.calls, lines: array(row.check?.lines).map((line) => line.outcome), superseded, active, emailOrders: email.orders.map((item) => item.number) },
            },
          })
        }
      })
    } catch (error) {
      if (error?.code === 'P2002') fail('SUPPLIER_REPLY_CONFLICT', 'Another reply was pasted on this order at the same time. Reload and try again.', 409)
      throw error
    }
    const row = await client.supplierReply.findFirst({ where: { id: readings[0].id, tenantId: actor.tenantId } })
    return { reply: cardOf(row, { order, access, actor, today, skus }) }
  }

  async function listReplies(orderId, context) {
    const client = await db()
    const actor = await actorOf(client, context)
    const access = procurementReadAccessFor(actor)
    // The order's read permission and tenant: readPurchaseOrder refuses first.
    const order = await readOrder(orderId, context, access)
    const today = await todayOf(client, actor.tenantId)
    const rows = await client.supplierReply.findMany({ where: { tenantId: actor.tenantId, purchaseOrderId: order.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: SUPPLIER_REPLY_LIMITS.listed })
    const skus = await supplierSkusOf(client, actor.tenantId, order)
    return { replies: rows.map((row) => cardOf(row, { order, access, actor, today, skus })) }
  }

  // The open reply on this order, for a decision by someone who may revise it.
  async function openReply(client, orderId, replyId, context) {
    const actor = await actorOf(client, context)
    assertAuthorized({ actor, permission: REVISE, tenantId: actor.tenantId })
    const access = procurementReadAccessFor(actor)
    const order = await readOrder(orderId, context, access)
    const row = await client.supplierReply.findFirst({ where: { id: text(replyId), tenantId: actor.tenantId, purchaseOrderId: order.id } })
    if (!row) fail('SUPPLIER_REPLY_NOT_FOUND', 'The supplier reply was not found on this order.', 404)
    if (!SUPPLIER_REPLY_OPEN_STATES.includes(row.state) || !row.activeKey) fail('SUPPLIER_REPLY_NOT_OPEN', 'This supplier reply was already decided or replaced.', 409, [{ field: 'state', code: row.activeKey ? row.state : (SUPPLIER_REPLY_OPEN_STATES.includes(row.state) ? 'not_active' : row.state) }])
    return { actor, access, order, row }
  }

  // The revisions an earlier run of this reply's record wrote (their audit
  // rows carry the reply as origin), for a record retried after them.
  async function revisionsFromReply(client, tenantId, replyId) {
    const rows = await client.auditLog.findMany({ where: { tenantId, action: 'purchase_order_promise_revised', metadata: { path: ['origin', 'id'], equals: replyId } }, select: { metadata: true } })
    return rows.map((entry) => text(entry.metadata?.revisionId)).filter(Boolean)
  }

  // Puts a claimed card back after its record failed; when another reply has
  // become the order's card meanwhile, this one is replaced by it.
  async function reopenCard(client, tenantId, row) {
    try {
      await client.supplierReply.updateMany({ where: { id: row.id, tenantId, activeKey: null, state: 'recorded' }, data: { activeKey: row.purchaseOrderId, state: row.state, decision: null, decidedById: null, decidedAt: null, editedLines: 0 } })
    } catch (error) {
      if (error?.code !== 'P2002') throw error
      const current = await client.supplierReply.findFirst({ where: { tenantId, purchaseOrderId: row.purchaseOrderId, activeKey: { not: null } }, select: { id: true } })
      await client.supplierReply.updateMany({ where: { id: row.id, tenantId }, data: { state: 'superseded', decision: null, decidedById: null, decidedAt: null, supersededById: current?.id || null } })
    }
  }

  // Closes an open card, once: a card someone else closed meanwhile is refused.
  async function closeCard(client, { actor, row }, data, audit) {
    return client.$transaction(async (tx) => {
      const closed = await tx.supplierReply.updateMany({ where: { id: row.id, tenantId: actor.tenantId, activeKey: { not: null } }, data: { activeKey: null, decidedById: actor.user.id, decidedAt: now(), ...data } })
      if (closed.count !== 1) fail('SUPPLIER_REPLY_NOT_OPEN', 'This supplier reply was already decided or replaced.', 409)
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_service', module: 'procurement', entityType: 'PurchaseOrder', entityId: row.purchaseOrderId, ...audit } })
    })
  }

  async function recordReply(orderId, replyId, body, context) {
    const input = parsed(supplierReplyRecordRequestSchema, body)
    const client = await db()
    const { actor, access, order, row } = await openReply(client, orderId, replyId, context)
    const proposed = array(row.check?.lines).filter((line) => line.outcome === 'proposed' && line.purchaseOrderLineId && line.proposedDate)
    const proposal = new Map(proposed.map((line) => [line.purchaseOrderLineId, line.proposedDate]))
    const lines = input.lines || proposed.map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, promisedDate: line.proposedDate }))
    if (!lines.length) fail('SUPPLIER_REPLY_NO_DATES', 'Enter at least one line\'s new promised date.', 422, [{ field: 'lines' }])
    const editedLines = lines.filter((line) => proposal.get(line.purchaseOrderLineId) !== line.promisedDate).length
    // A proposal read against dates that have changed on the order since is
    // stale: recording it would overwrite the newer date (#394 review). Lines
    // the person entered themselves, seeing the current date, are theirs.
    const pasted = new Map(array(row.check?.lines).filter((line) => line.purchaseOrderLineId).map((line) => [line.purchaseOrderLineId, line.currentDate ?? null]))
    const nowDates = new Map(array(order.lines).map((line) => [line.purchaseOrderLineId || line.id, line.promisedDate || null]))
    // A line already at the proposed date is not stale: an earlier run of this
    // record wrote it.
    const stale = lines.filter((given) => pasted.has(given.purchaseOrderLineId) && pasted.get(given.purchaseOrderLineId) !== (nowDates.get(given.purchaseOrderLineId) ?? null) && nowDates.get(given.purchaseOrderLineId) !== given.promisedDate && (!input.lines || proposal.get(given.purchaseOrderLineId) === given.promisedDate))
    if (stale.length) fail('SUPPLIER_REPLY_STALE', 'The promised dates changed on the order after this reply was pasted. Check the current dates before recording.', 409, stale.map((given) => ({ purchaseOrderLineId: given.purchaseOrderLineId, pastedDate: pasted.get(given.purchaseOrderLineId), currentDate: nowDates.get(given.purchaseOrderLineId) ?? null })))
    // The reason the revision keeps: the supplier's own words, with the reply date.
    const quotes = [...new Set(array(row.check?.lines).filter((line) => line.quote && lines.some((given) => given.purchaseOrderLineId === line.purchaseOrderLineId)).map((line) => line.quote))]
    const words = quotes.length ? ` "${quotes.join(' / ')}"` : ''
    const reason = `Supplier reply of ${row.receivedOn}:${words}`.slice(0, 600)
    // Claim the card first, so a supersede or dismissal cannot slip between
    // the dates written and the card closed (#394 review); put it back if the
    // command fails.
    const claimed = await client.supplierReply.updateMany({ where: { id: row.id, tenantId: actor.tenantId, activeKey: { not: null } }, data: { activeKey: null, state: 'recorded', decision: 'recorded', decidedById: actor.user.id, decidedAt: now(), editedLines } })
    if (claimed.count !== 1) fail('SUPPLIER_REPLY_NOT_OPEN', 'This supplier reply was already decided or replaced.', 409)
    let revisionIds
    try {
      const result = await procurement.revisePromisedDates(order.id, {
        expectedVersion: input.expectedVersion,
        lines,
        reason,
        idempotencyKey: input.idempotencyKey || `supplier-reply:${row.id}:v${input.expectedVersion}`,
        origin: { type: 'supplier_reply', id: row.id },
      }, context)
      revisionIds = array(result?.revisionIds)
    } catch (error) {
      // These dates were written by an earlier run of this record: recorded.
      const earlier = error?.code === 'PROMISED_DATE_UNCHANGED' ? await revisionsFromReply(client, actor.tenantId, row.id) : []
      if (!earlier.length) {
        await reopenCard(client, actor.tenantId, row)
        throw error
      }
      revisionIds = earlier
    }
    await client.$transaction([
      client.supplierReply.updateMany({ where: { id: row.id, tenantId: actor.tenantId }, data: { revisionIds } }),
      client.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_service', module: 'procurement', entityType: 'PurchaseOrder', entityId: row.purchaseOrderId, action: 'supplier_reply_recorded', summary: `Promised dates recorded from a supplier reply on purchase order ${text(order.number) || order.id}.`, metadata: { replyId: row.id, lines: lines.length, editedLines, revisionIds } } }),
    ])
    const fresh = await readOrder(order.id, context, access)
    const today = await todayOf(client, actor.tenantId)
    const updated = await client.supplierReply.findFirst({ where: { id: row.id, tenantId: actor.tenantId } })
    const skus = await supplierSkusOf(client, actor.tenantId, fresh)
    return { reply: cardOf(updated, { order: fresh, access, actor, today, skus }), purchaseOrder: { id: fresh.id, version: Number(fresh.version) || 0 } }
  }

  async function dismissReply(orderId, replyId, body, context) {
    const input = parsed(supplierReplyDismissRequestSchema, body)
    const client = await db()
    const opened = await openReply(client, orderId, replyId, context)
    const note = text(input.note) || null
    await closeCard(client, opened, { state: 'not_recorded', decision: 'not_recorded', reasonCode: input.reason, note }, {
      action: 'supplier_reply_dismissed',
      summary: `A supplier reply on purchase order ${text(opened.order.number) || opened.order.id} was not recorded: ${input.reason}.`,
      metadata: { replyId: opened.row.id, reason: input.reason, noted: Boolean(note) },
    })
    const today = await todayOf(client, opened.actor.tenantId)
    const updated = await client.supplierReply.findFirst({ where: { id: opened.row.id, tenantId: opened.actor.tenantId } })
    const skus = await supplierSkusOf(client, opened.actor.tenantId, opened.order)
    return { reply: cardOf(updated, { ...opened, today, skus }) }
  }

  // "Not now": the card stays open and comes back after three workdays.
  async function notNowReply(orderId, replyId, body, context) {
    parsed(supplierReplyNotNowRequestSchema, body)
    const client = await db()
    const opened = await openReply(client, orderId, replyId, context)
    const today = await todayOf(client, opened.actor.tenantId)
    const until = addWorkdays(today, NOT_NOW_WORKDAYS)
    const updated = await client.supplierReply.updateMany({ where: { id: opened.row.id, tenantId: opened.actor.tenantId, activeKey: { not: null } }, data: { notNowUntil: until } })
    if (updated.count !== 1) fail('SUPPLIER_REPLY_NOT_OPEN', 'This supplier reply was already decided or replaced.', 409)
    await client.auditLog.create({ data: { id: idFactory(), tenantId: opened.actor.tenantId, actorId: opened.actor.user.id, source: 'supplier_reply_service', module: 'procurement', action: 'supplier_reply_not_now', entityType: 'PurchaseOrder', entityId: opened.order.id, summary: `A supplier reply on purchase order ${text(opened.order.number) || opened.order.id} was set aside until ${until}.`, metadata: { replyId: opened.row.id, until } } })
    const row = await client.supplierReply.findFirst({ where: { id: opened.row.id, tenantId: opened.actor.tenantId } })
    const skus = await supplierSkusOf(client, opened.actor.tenantId, opened.order)
    return { reply: cardOf(row, { ...opened, today, skus }) }
  }

  return { pasteReply, listReplies, recordReply, dismissReply, notNowReply }
}
