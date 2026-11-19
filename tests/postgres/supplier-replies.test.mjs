import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createSupplierReplyService } from '../../server/services/supplier-reply-service.mjs'
import { supplierReplyCardSchema } from '../../shared/supplier-reply-contract.mjs'

// Supplier replies (docs/supplier-reply-dates-design.md) in a real database:
// the routes through the real server with AI off (the reply is kept, the
// manual form records the dates, and the chased overdue item on Today closes),
// and the reading path with a mocked model (proposal, a reply that supersedes
// another, dismissal, not now, permissions, the usage meter and the cap).
// The promised-dates command takes the reply as its origin: the revisions say
// supplier_reply, the audit rows carry the reply id, and the original promise
// stays. No real model is called.
const tenantA = 'supplier-replies-a'
const tenantB = 'supplier-replies-b'
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000)
const iso = (date) => date.toISOString().slice(0, 10)

async function seedTenant(prisma, tenantId, tag, { aiOn = true } = {}) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}`, ...(aiOn ? { operationalSettings: { ai: { modelAssistEnabled: true } } } : {}) } })
  await prisma.user.createMany({ data: [
    { id: `${tenantId}-manager`, tenantId, email: `reply-manager-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' },
    { id: `${tenantId}-buyer`, tenantId, email: `reply-buyer-${tag.toLowerCase()}@example.com`, name: `Buyer ${tag}`, role: 'buyer' },
    { id: `${tenantId}-viewer`, tenantId, email: `reply-viewer-${tag.toLowerCase()}@example.com`, name: `Viewer ${tag}`, role: 'viewer' },
  ] })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Acme ${tag}`, metadata: { email: `orders-${tag.toLowerCase()}@example.com`, contactName: `Pat ${tag}` } } })
  // Issued 30 days ago, promised 5 days ago: overdue. Two lines, one partly received.
  const promised = iso(dayOffset(-5))
  await prisma.purchaseOrder.create({ data: {
    id: `PO-${tag}`, number: `PO-202611-00${tag === 'A' ? '12' : '13'}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Acme ${tag}`, status: 'partially_received', currency: 'USD', amount: '400.0000',
    expectedDate: dayOffset(-5), issuedAt: dayOffset(-30),
    lines: { create: [
      { id: `PO-${tag}-L1`, itemId: `ITEM-${tag}-1040`, sku: 'SKU-1040', itemName: 'Bracket', orderedQuantity: '100.0000', receivedQuantity: '40.0000', unit: 'pcs', unitPrice: '2.5000', amount: '250.0000', originalPromisedDate: dayOffset(-5), metadata: { promisedDate: promised } },
      { id: `PO-${tag}-L2`, sku: 'SKU-2210', itemName: 'Hinge', orderedQuantity: '20.0000', receivedQuantity: '0.0000', unit: 'pcs', unitPrice: '7.5000', amount: '150.0000', originalPromisedDate: dayOffset(-5), metadata: { promisedDate: promised } },
    ] },
  } })
  // The supplier's own code for the bracket, on its item-supplier link.
  await prisma.runtimeRecord.create({ data: { id: `ISR-${tag}`, tenantId, namespace: 'master-data.item-suppliers', recordKey: `ITEM-${tag}-1040::SUP-${tag}`, payload: { itemId: `ITEM-${tag}-1040`, supplierId: `SUP-${tag}`, supplierSku: `ACM-55${tag}`, active: true, approved: true } } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-manager` })
}

async function request(port, method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = text
        try { payload = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: res.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

const AI_KEYS = ['FLOWCHAIN_AI_PROVIDER_KIND', 'FLOWCHAIN_AI_RUNTIME_MODE', 'FLOWCHAIN_AI_ASSISTANT_MODE', 'FLOWCHAIN_AI_ASSISTANT_SCRIPTED', 'FLOWCHAIN_KNOWLEDGE_PROVIDER', 'FLOWCHAIN_AI_PROVIDER_API_KEY', 'FLOWCHAIN_AI_PROVIDER_ENDPOINT', 'FLOWCHAIN_DEFAULT_TENANT_ID']

test('the routes with AI off: the reply is kept, the manual form records the dates from it, and the chased item on Today closes', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previous = Object.fromEntries(AI_KEYS.map((key) => [key, process.env[key]]))
  for (const key of AI_KEYS) delete process.env[key]
  process.env.FLOWCHAIN_AI_RUNTIME_MODE = 'local'
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantA
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const signIn = async (email) => {
      const login = await request(port, 'POST', '/api/auth/login', { body: { email } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      return { Authorization: `Bearer ${login.payload.token}` }
    }
    const asBuyer = await signIn('reply-buyer-a@example.com')
    const asViewer = await signIn('reply-viewer-a@example.com')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantB
    const asOther = await signIn('reply-buyer-b@example.com')
    const path = '/api/procurement/orders/PO-A/supplier-replies'

    // Today raises the overdue order; the buyer chases it.
    const home = await request(port, 'GET', '/api/home/overview', { headers: asBuyer })
    assert.ok(home.payload.decisions.waiting.some((entry) => entry.key === 'purchase_order_overdue:PO-A'), JSON.stringify(home.payload.decisions))
    assert.equal((await request(port, 'POST', '/api/decision-items/decide', { headers: asBuyer, body: { key: 'purchase_order_overdue:PO-A', option: 'chased' } })).status, 200)

    // Pasted with no model: kept, needs the person, the manual form offered.
    const reply = 'Hi, the balance ships on 28 November.\n\nOn Mon, 10 Nov 2026, Buyer A wrote:\n> Please confirm PO-202611-0012.'
    const pasted = await request(port, 'POST', path, { headers: asBuyer, body: { text: reply } })
    assert.equal(pasted.status, 201, JSON.stringify(pasted.payload))
    const card = pasted.payload.reply
    assert.ok(supplierReplyCardSchema.safeParse(card).success)
    assert.deepEqual([card.state, card.readingStatus, card.text, card.quotedTextHidden, card.canDecide], ['needs_you', 'no_provider', 'Hi, the balance ships on 28 November.', true, true])
    assert.match(card.quotedText, /^On Mon, 10 Nov 2026, Buyer A wrote:/)
    assert.deepEqual(card.formLines.map((line) => line.supplierSku), ['ACM-55A', null])
    // Five days late, give or take the workspace day against the UTC day.
    assert.deepEqual(card.formLines.map((line) => [line.sku, line.remaining, line.overdueDays >= 4 && line.overdueDays <= 6]), [['SKU-1040', 60, true], ['SKU-2210', 20, true]])
    assert.equal(card.supplierName, 'Acme A')

    // The viewer reads it but may not decide or paste; another workspace sees nothing.
    const listed = await request(port, 'GET', path, { headers: asViewer })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.payload.replies.map((row) => [row.id, row.canDecide]), [[card.id, false]])
    assert.equal((await request(port, 'POST', path, { headers: asViewer, body: { text: 'x' } })).status, 403)
    assert.equal((await request(port, 'GET', path, { headers: asOther })).status, 404)
    assert.equal((await request(port, 'POST', `${path}/${card.id}/dismiss`, { headers: asOther, body: { reason: 'wrong_reading' } })).status, 404)
    assert.equal((await request(port, 'GET', path)).status, 401)
    // A bad request names its field.
    const bad = await request(port, 'POST', path, { headers: asBuyer, body: { text: '' } })
    assert.deepEqual([bad.status, bad.payload.code, bad.payload.details[0].field], [422, 'SUPPLIER_REPLY_INVALID', 'text'])

    // Recording from the manual form: a stale version is refused, then the dates go in.
    const newDate = iso(dayOffset(10))
    const lines = [{ purchaseOrderLineId: 'PO-A-L1', promisedDate: newDate }, { purchaseOrderLineId: 'PO-A-L2', promisedDate: newDate }]
    const stale = await request(port, 'POST', `${path}/${card.id}/record`, { headers: asBuyer, body: { expectedVersion: card.orderVersion + 5, lines } })
    assert.deepEqual([stale.status, stale.payload.code], [409, 'SYNC_VERSION_CONFLICT'])
    const recorded = await request(port, 'POST', `${path}/${card.id}/record`, { headers: asBuyer, body: { expectedVersion: card.orderVersion, lines } })
    assert.equal(recorded.status, 200, JSON.stringify(recorded.payload))
    assert.deepEqual([recorded.payload.reply.state, recorded.payload.reply.decision.option, recorded.payload.reply.decision.editedLines, recorded.payload.reply.canDecide], ['recorded', 'recorded', 2, false])
    assert.ok(recorded.payload.purchaseOrder.version > card.orderVersion)

    // The revisions say where they came from; the original promise stays.
    const revisions = await prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId: tenantA, purchaseOrderId: 'PO-A' }, orderBy: { purchaseOrderLineId: 'asc' } })
    assert.deepEqual(revisions.map((row) => [row.purchaseOrderLineId, iso(row.newDate), row.source]), [['PO-A-L1', newDate, 'supplier_reply'], ['PO-A-L2', newDate, 'supplier_reply']])
    assert.match(revisions[0].reason, /^Supplier reply of \d{4}-\d{2}-\d{2}/)
    assert.deepEqual(recorded.payload.reply.decision.revisionIds.sort(), revisions.map((row) => row.id).sort())
    const lineAudit = await prisma.auditLog.findMany({ where: { tenantId: tenantA, action: 'purchase_order_promise_revised' } })
    assert.ok(lineAudit.length === 2 && lineAudit.every((row) => row.metadata.origin?.type === 'supplier_reply' && row.metadata.origin.id === card.id))
    const orderLines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: 'PO-A' }, orderBy: { id: 'asc' } })
    assert.deepEqual(orderLines.map((line) => iso(line.originalPromisedDate)), [iso(dayOffset(-5)), iso(dayOffset(-5))])

    // Decided once: a second record or a dismissal is refused.
    assert.equal((await request(port, 'POST', `${path}/${card.id}/record`, { headers: asBuyer, body: { expectedVersion: recorded.payload.purchaseOrder.version, lines } })).payload.code, 'SUPPLIER_REPLY_NOT_OPEN')

    // The order is no longer overdue, so Today's chased item closes (planDecisionSync).
    const after = await request(port, 'GET', '/api/home/overview', { headers: asBuyer })
    assert.ok(!after.payload.decisions.waiting.some((entry) => entry.key === 'purchase_order_overdue:PO-A'))
    const item = await prisma.decisionItem.findFirst({ where: { tenantId: tenantA, kind: 'purchase_order_overdue', recordId: 'PO-A' } })
    assert.deepEqual([item.state, item.activeKey], ['resolved', null])
    // Nothing on another workspace's order changed.
    assert.equal(await prisma.purchaseOrderPromiseRevision.count({ where: { tenantId: tenantB } }), 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await prisma.$disconnect()
  }
})

test('the reading with a mocked model: a proposal recorded as proposed, a reply superseded, a dismissal, not now, the meter and the cap', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  const tenantC = 'supplier-replies-c'
  const tenantD = 'supplier-replies-d'
  try {
    await seedTenant(prisma, tenantC, 'C')
    await seedTenant(prisma, tenantD, 'D', { aiOn: false })
    // A recorded transcript counts as a provider (aiProviderConfigured); the
    // client itself is the stand-in below, so nothing leaves the process.
    const env = { ...process.env, FLOWCHAIN_AI_ASSISTANT_MODE: 'assistant_v2', FLOWCHAIN_AI_ASSISTANT_SCRIPTED: 'not-read.json', FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required', FLOWCHAIN_AI_MONTHLY_CAP_USD: '5' }
    const procurement = createDbProcurementCommandService({ prisma, env })
    const calls = []
    let answers = []
    const modelClient = {
      async *stream(request) {
        calls.push(request)
        const next = answers.shift()
        yield { type: 'text_delta', text: typeof next === 'string' ? next : JSON.stringify(next) }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { input_tokens: 900, output_tokens: 80 }, content: [] }
      },
    }
    const service = (overrides = {}) => createSupplierReplyService({ prisma, env: { ...env, ...(overrides.env || {}) }, procurement, modelClient })
    const as = (tenantId, who) => ({ identity: { authenticated: true, tenantId, userId: `${tenantId}-${who}`, role: who === 'buyer' ? 'buyer' : who } })
    const buyer = as(tenantC, 'buyer')
    const newDate = iso(dayOffset(12))
    const said = `We can ship the balance on ${newDate}. Unit price rises 4% from next month.`

    // 1. A proposal for both open lines, with the price change flagged.
    answers = [{ replyKind: 'dates', lines: [{ line: 'L1', date: newDate, quote: `We can ship the balance on ${newDate}.`, dateKind: 'stated' }, { line: 'L2', date: newDate, quote: `We can ship the balance on ${newDate}.`, dateKind: 'stated' }], flags: [{ kind: 'price_change', quote: 'Unit price rises 4% from next month.' }], reason: null }]
    const first = (await service().pasteReply('PO-C', { text: said }, buyer)).reply
    assert.deepEqual([first.state, first.readingStatus, first.lines.map((line) => [line.sku, line.outcome, line.proposedDate]), first.flags.map((flag) => flag.kind)], ['proposed', 'read', [['SKU-1040', 'proposed', newDate], ['SKU-2210', 'proposed', newDate]], ['price_change']])
    assert.equal(calls.length, 1)
    assert.deepEqual([calls[0].tools, calls[0].maxTokens], [[], 1000])
    assert.doesNotMatch(calls[0].messages[0].content, /unitPrice|2\.5|7\.5/, 'no price reaches the model')
    assert.match(calls[0].messages[0].content, /"supplierSku":"ACM-55C"/)
    assert.equal(first.lines[0].supplierSku, 'ACM-55C')
    const usage = await prisma.aiUsageMonthly.findFirst({ where: { tenantId: tenantC } })
    assert.deepEqual([usage.calls, usage.inputUnits, usage.outputUnits], [1, 900, 80])
    const stored = await prisma.supplierReply.findFirst({ where: { id: first.id } })
    assert.deepEqual([stored.promptVersion, stored.usage.calls, stored.activeKey, stored.createdById], ['supplier-reply-read-1', 1, 'PO-C', `${tenantC}-buyer`])

    // 2. A second reply supersedes the open card.
    answers = [{ replyKind: 'no_date', lines: [], flags: [], reason: null }, { replyKind: 'no_date', lines: [], flags: [], reason: null }]
    const second = (await service().pasteReply('PO-C', { text: 'Thanks, we are checking with the warehouse.' }, buyer)).reply
    assert.equal(second.state, 'nothing_to_record')
    const replaced = await prisma.supplierReply.findFirst({ where: { id: first.id } })
    assert.deepEqual([replaced.state, replaced.activeKey, replaced.supersededById], ['superseded', null, second.id])
    await assert.rejects(() => service().recordReply('PO-C', first.id, { expectedVersion: first.orderVersion }, buyer), { code: 'SUPPLIER_REPLY_NOT_OPEN' })

    // 3. A fresh proposal recorded as proposed: no lines edited.
    answers = [{ replyKind: 'dates', lines: [{ line: 'L1', date: newDate, quote: `We can ship the balance on ${newDate}.`, dateKind: 'stated' }], flags: [], reason: null }]
    const third = (await service().pasteReply('PO-C', { text: said }, buyer)).reply
    const recorded = await service().recordReply('PO-C', third.id, { expectedVersion: third.orderVersion }, buyer)
    assert.deepEqual([recorded.reply.state, recorded.reply.decision.editedLines, recorded.reply.decision.revisionIds.length], ['recorded', 0, 1])
    const revision = await prisma.purchaseOrderPromiseRevision.findFirst({ where: { tenantId: tenantC, purchaseOrderLineId: 'PO-C-L1' } })
    assert.deepEqual([iso(revision.newDate), revision.source], [newDate, 'supplier_reply'])
    assert.match(revision.reason, new RegExp(`"We can ship the balance on ${newDate}\\."`))

    // 4. Dismissal needs a known reason, and a note with "other".
    answers = [{ replyKind: 'dates', lines: [{ line: 'L2', date: newDate, quote: `We can ship the balance on ${newDate}.`, dateKind: 'stated' }], flags: [], reason: null }]
    const fourth = (await service().pasteReply('PO-C', { text: said }, buyer)).reply
    await assert.rejects(() => service().dismissReply('PO-C', fourth.id, { reason: 'other' }, buyer), { code: 'SUPPLIER_REPLY_INVALID' })
    // "Not now" keeps it open and sets it aside.
    const aside = (await service().notNowReply('PO-C', fourth.id, {}, buyer)).reply
    assert.deepEqual([aside.state, aside.canDecide, Boolean(aside.notNowUntil)], ['proposed', true, true])
    const dismissed = (await service().dismissReply('PO-C', fourth.id, { reason: 'other', note: 'Confirmed by phone instead.' }, buyer)).reply
    assert.deepEqual([dismissed.state, dismissed.decision.reason, dismissed.decision.note], ['not_recorded', 'other', 'Confirmed by phone instead.'])

    // 5. Permissions: a viewer may read, not paste; another workspace's order is not found.
    await assert.rejects(() => service().pasteReply('PO-C', { text: said }, as(tenantC, 'viewer')), { code: 'AUTHORIZATION_PERMISSION_DENIED' })
    assert.equal((await service().listReplies('PO-C', as(tenantC, 'viewer'))).replies.length, 4)
    await assert.rejects(() => service().listReplies('PO-C', as(tenantD, 'buyer')), { code: 'PURCHASE_ORDER_NOT_FOUND' })

    // 6. Outages: the workspace's AI is off, or the cap is spent; the reply is
    // kept for the manual form and no model is called.
    calls.length = 0
    const off = (await service().pasteReply('PO-D', { text: said }, as(tenantD, 'buyer'))).reply
    assert.deepEqual([off.state, off.readingStatus], ['needs_you', 'ai_off'])
    const spent = (await service({ env: { FLOWCHAIN_AI_MONTHLY_CAP_USD: '0' } }).pasteReply('PO-C', { text: said }, buyer)).reply
    assert.deepEqual([spent.state, spent.readingStatus], ['needs_you', 'over_cap'])
    assert.equal(calls.length, 0)
    // A schema failure twice: two calls, then the person.
    answers = ['{"replyKind":"maybe"}', 'still not json']
    const invalid = (await service().pasteReply('PO-C', { text: said }, buyer)).reply
    assert.deepEqual([invalid.state, invalid.readingStatus, calls.length], ['needs_you', 'invalid', 2])
  } finally {
    await prisma.$disconnect()
  }
})
