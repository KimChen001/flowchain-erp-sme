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
  SUPPLIER_REPLY_CONTRACT_VERSION, SUPPLIER_REPLY_LIMITS, SUPPLIER_REPLY_OPEN_STATES,
  supplierReplyCardSchema, supplierReplyDismissRequestSchema, supplierReplyNotNowRequestSchema, supplierReplyPasteRequestSchema, supplierReplyRecordRequestSchema,
} from '../../shared/supplier-reply-contract.mjs'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { aiInjectionDetected } from '../domain/ai-injection-guard.mjs'
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
import { SUPPLIER_REPLY_ORDER_STATES, checkReplyReading, cleanSupplierReply, daysBetween, readSupplierReply, supplierReplyPromptTokens } from '../domain/supplier-reply-reading.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const REVISE = 'procurement.purchase_order.revise'
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
async function streamedCall(client, { system, messages, maxTokens }, signal) {
  let answer = ''
  let usage = null
  try {
    for await (const event of client.stream({ system, messages, tools: [], maxTokens }, signal)) {
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
  await recordAiProviderCall({ ok: true, usage })
  return { text: answer, usage }
}

export function createSupplierReplyService({ prisma = null, env = process.env, procurement, now = () => new Date(), idFactory = randomUUID, ledger = ASSISTANT_V2_COST_LEDGER, modelClient } = {}) {
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
    const view = (lineId, fields) => {
      const line = lines.get(lineId) || {}
      const remaining = Number.isFinite(Number(line.remainingQuantity)) ? Number(line.remainingQuantity) : null
      const current = line.promisedDate || fields.currentDate || null
      const late = orderOpen && remaining > 0 && current && today && current < today ? daysBetween(current, today) : null
      return { sku: text(line.sku) || null, supplierSku: skus.get(lineId) || null, itemName: text(line.itemName) || null, remaining, unit: text(line.unit) || null, overdueDays: late, ...fields }
    }
    const check = row.check || null
    const open = SUPPLIER_REPLY_OPEN_STATES.includes(row.state)
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
      const reserve = async (call) => {
        const micros = aiCallCostMicros({ inputTokens: supplierReplyPromptTokens(call), outputTokens: call.maxTokens }, prices)
        const hold = ledger.reserve(tenantId, scoped.aiWorkspaceAccess, { micros })
        return hold.ok ? hold : { ok: false, code: 'over_cap' }
      }
      const callModel = async (call) => ({ ...(await streamedCall(model, call, signal)), provider, model: modelName })
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
    const cleaned = cleanSupplierReply(input.text)
    if (!cleaned.text) fail('SUPPLIER_REPLY_EMPTY', 'Nothing is left of the reply once the quoted earlier message is removed.', 422, [{ field: 'text' }])
    const skus = await supplierSkusOf(client, actor.tenantId, order)
    const snapshot = supplierReplyOrderSnapshot(order, skus)
    const startedAt = Date.now()
    const read = await readWithModel({ client, context, tenantId: actor.tenantId, snapshot, cleaned, receivedOn, today, signal })
    const check = read.readingStatus === 'read' ? checkReplyReading({ order: snapshot, text: cleaned.text, receivedOn, reading: read.reading }) : null
    const state = check ? check.state : 'needs_you'
    const id = idFactory()
    const open = SUPPLIER_REPLY_OPEN_STATES.includes(state)
    let superseded = []
    try {
      await client.$transaction(async (tx) => {
        // A later reply replaces the order's open card (#392 §2).
        const previous = await tx.supplierReply.findMany({ where: { tenantId: actor.tenantId, purchaseOrderId: order.id, activeKey: { not: null } }, select: { id: true } })
        superseded = previous.map((row) => row.id)
        if (superseded.length) await tx.supplierReply.updateMany({ where: { tenantId: actor.tenantId, id: { in: superseded } }, data: { state: 'superseded', activeKey: null, supersededById: id } })
        await tx.supplierReply.create({
          data: {
            id, tenantId: actor.tenantId, purchaseOrderId: order.id, supplierId: text(order.supplierId) || null, activeKey: open ? order.id : null,
            source: 'paste', receivedOn, text: cleaned.text, quotedTextHidden: cleaned.quotedTextHidden, quotedText: cleaned.quoted, state, readingStatus: read.readingStatus,
            provider: read.provider || null, model: read.model || null, promptVersion: read.promptVersion || null, reading: read.reading || null, check: check || null,
            usage: { calls: read.calls, inputTokens: read.usage?.inputTokens || 0, outputTokens: read.usage?.outputTokens || 0, ms: Date.now() - startedAt, invisibleRemoved: cleaned.invisibleRemoved, issues: read.issues || null },
            instructionsIgnored: aiInjectionDetected(cleaned.text), createdById: actor.user.id,
          },
        })
        // Codes and ids only: the reply text stays on its own row.
        await tx.auditLog.create({
          data: {
            id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'supplier_reply_service', module: 'procurement', action: 'supplier_reply_pasted',
            entityType: 'PurchaseOrder', entityId: order.id, summary: `Supplier reply on purchase order ${snapshot.number}: ${state}.`,
            metadata: { replyId: id, state, readingStatus: read.readingStatus, calls: read.calls, lines: array(check?.lines).map((line) => line.outcome), superseded },
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
    if (!SUPPLIER_REPLY_OPEN_STATES.includes(row.state)) fail('SUPPLIER_REPLY_NOT_OPEN', 'This supplier reply was already decided or replaced.', 409, [{ field: 'state', code: row.state }])
    return { actor, access, order, row }
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
    // The reason the revision keeps: the supplier's own words, with the reply date.
    const quotes = [...new Set(array(row.check?.lines).filter((line) => line.quote && lines.some((given) => given.purchaseOrderLineId === line.purchaseOrderLineId)).map((line) => line.quote))]
    const words = quotes.length ? ` "${quotes.join(' / ')}"` : ''
    const reason = `Supplier reply of ${row.receivedOn}:${words}`.slice(0, 600)
    const result = await procurement.revisePromisedDates(order.id, {
      expectedVersion: input.expectedVersion,
      lines,
      reason,
      idempotencyKey: input.idempotencyKey || `supplier-reply:${row.id}:v${input.expectedVersion}`,
      origin: { type: 'supplier_reply', id: row.id },
    }, context)
    const revisionIds = array(result?.revisionIds)
    await closeCard(client, { actor, row }, { state: 'recorded', decision: 'recorded', editedLines, revisionIds }, {
      action: 'supplier_reply_recorded',
      summary: `Promised dates recorded from a supplier reply on purchase order ${text(order.number) || order.id}.`,
      metadata: { replyId: row.id, lines: lines.length, editedLines, revisionIds },
    })
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
