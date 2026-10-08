import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createOperationalFinanceCommandService } from '../../server/domain/operational-finance-command-service.mjs'
import { readOutbox } from '../../server/mail/outbox-mailer.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// Approval emails through the real server: the document commands the pages
// call, the local outbox standing in for the mail provider, and the rows
// PostgreSQL holds. Only the approvers of the waiting document hear of it,
// each once, in their own language, with the document type, number and link.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/approval-email.test.mjs

const tenantA = 'tenant-approval-email-a'
const tenantB = 'tenant-approval-email-b'
const user = (key, extra = {}) => ({ id: `ae-${key}`, email: `${key}@approval-email.invalid`, name: `User ${key}`, role: 'manager', ...extra })
const users = {
  submitter: user('submitter'),
  approverEn: user('approver-en'),
  approverZh: user('approver-zh', { languagePreference: 'zh-CN' }),
  optedOut: user('opted-out', { approvalEmailsEnabled: false }),
  disabled: user('disabled', { status: 'disabled' }),
  viewer: user('viewer', { role: 'viewer' }),
  finance: user('finance', { role: 'finance-specialist' }),
}
const managerB = user('manager-b')
const warehouse = 'ae-wh-a'
const supplier = 'ae-supplier'
const item = { id: 'ae-item', sku: 'AE-SKU', name: 'Approval Pallet Wrap' }
const tolerances = { review: { quantityTolerance: '0.0000', pricePercentageTolerance: '0.0000', priceAbsoluteTolerance: '0.0000', amountTolerance: '0.0000' } }
const identity = { authenticated: true, tenantId: tenantA, userId: users.submitter.id, role: 'manager' }

let prisma
let directory
let outboxPath
let server
let base
const tokens = {}
const logLines = []
const logger = { info: (line) => logLines.push(String(line)), warn: (line) => logLines.push(String(line)), error: (line) => logLines.push(String(line)) }

async function api(token, method, path, body, target = base) {
  const response = await fetch(`${target}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
const describe = (result) => `${result.status} ${JSON.stringify(result.body)}`

async function listen(instance) {
  await new Promise((done) => instance.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${instance.address().port}`
}
const close = (instance) => new Promise((done) => instance.close(done))

async function login(account) {
  const result = await api(null, 'POST', '/api/auth/login', { email: account.email, name: account.name, company: 'Approval Email' })
  assert.equal(result.status, 200, describe(result))
  return result.body.token
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const approvalMessages = async () => (await readOutbox(outboxPath)).filter((message) => message.tag === 'approval-waiting')

// The approval emails an action produced: waits for the expected number,
// then a little longer so an extra or duplicate email would be seen too.
async function emailsAfter(action, expected) {
  const before = (await approvalMessages()).length
  const result = await action()
  for (let attempt = 0; attempt < 100 && (await approvalMessages()).length < before + expected; attempt += 1) await pause(50)
  await pause(400)
  return { result, messages: (await approvalMessages()).slice(before) }
}

async function waitFor(read, ready, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read()
    if (ready(value)) return value
    await pause(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const noticeAudits = (entityId) => prisma.auditLog.findMany({ where: { tenantId: tenantA, source: 'approval_notifications', entityId }, orderBy: { createdAt: 'asc' } })

const byRecipient = (messages) => [...messages].sort((a, b) => a.to.localeCompare(b.to))
function assertOnlyTypeNumberAndLink(message, link, forbidden = []) {
  assert.equal(message.tag, 'approval-waiting')
  assert.ok(message.text.includes(link), `${message.to} gets ${link}`)
  assert.deepEqual([...new Set(message.text.match(/https?:\/\/\S+/g))], [link])
  for (const value of forbidden) assert.equal(`${message.subject}${message.text}${message.html}`.includes(value), false, `${value} is not in the email`)
}

async function seedPurchaseRequest(id) {
  await prisma.purchaseRequest.create({ data: {
    id, tenantId: tenantA, status: 'draft', requester: users.submitter.id, currency: 'USD', amount: '125.0000',
    supplierId: supplier, supplierName: 'Approval Supply Co.',
    metadata: { version: 1, requesterId: users.submitter.id, departmentId: 'operations' },
    lines: { create: [{ id: `${id}-L1`, itemId: item.id, sku: item.sku, itemName: item.name, quantity: '10', unit: 'EA', unitPrice: '12.5', amount: '125', metadata: { supplierId: supplier, targetWarehouseId: warehouse, currency: 'USD' } }] },
  } })
}

test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  directory = await mkdtemp(join(tmpdir(), 'flowchain-approval-email-test-'))
  outboxPath = join(directory, 'outbox.json')
  Object.assign(process.env, {
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantA,
    FLOWCHAIN_LOCAL_SESSION_SECRET: `approval-email-${randomUUID()}-secret`,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false',
    FLOWCHAIN_MAIL_PROVIDER: 'outbox',
    FLOWCHAIN_MAIL_OUTBOX_PATH: outboxPath,
    FLOWCHAIN_PUBLIC_BASE_URL: 'https://flowchain.test',
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true',
    FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true',
    // The test runner turns approval emails off for every other suite.
    FLOWCHAIN_APPROVAL_EMAILS: 'on',
  })
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.create({ data: { id: tenantA, name: 'Approval Email A', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: tolerances } })
  await prisma.tenant.create({ data: { id: tenantB, name: 'Approval Email B' } })
  for (const account of Object.values(users)) await prisma.user.create({ data: { ...account, tenantId: tenantA } })
  await prisma.user.create({ data: { ...managerB, tenantId: tenantB } })
  await backfillTenantAuthorization(prisma, tenantA, { actorId: users.submitter.id })
  await backfillTenantAuthorization(prisma, tenantB, { actorId: managerB.id })
  await prisma.warehouse.create({ data: { id: warehouse, tenantId: tenantA, code: 'AE-A', name: 'Approval Warehouse', status: 'active' } })
  await prisma.warehouse.create({ data: { id: 'ae-wh-b', tenantId: tenantB, code: 'AE-B', name: 'Other Warehouse', status: 'active' } })
  // Adjustments go to approvers who may operate every warehouse on the lines.
  for (const [account, accessLevel, tenantId, warehouseId] of [[users.submitter, 'operate', tenantA, warehouse], [users.approverEn, 'operate', tenantA, warehouse], [users.approverZh, 'read', tenantA, warehouse], [managerB, 'operate', tenantB, 'ae-wh-b']])
    await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: account.id, warehouseId, accessLevel } })
  await prisma.supplier.create({ data: { id: supplier, tenantId: tenantA, code: 'AE-SUP', name: 'Approval Supply Co.', status: 'active' } })
  await prisma.item.create({ data: { id: item.id, tenantId: tenantA, sku: item.sku, name: item.name, unit: 'EA', status: 'active', preferredSupplierId: supplier } })

  server = createScmServer({ errorLogger: logger })
  base = await listen(server)
  tokens.submitter = await login(users.submitter)
  tokens.viewer = await login(users.viewer)
})

test.after(async () => {
  if (server) await close(server)
  await prisma?.$disconnect()
  await disconnectPrismaClient()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('a submitted PR emails its approvers once, in their language; a replay sends nothing and a resubmit sends again', async () => {
  await seedPurchaseRequest('PR-AE-1')
  const link = 'https://flowchain.test/app/procurement/requests/PR-AE-1'
  const submit = (expectedVersion, idempotencyKey) => api(tokens.submitter, 'POST', '/api/procurement/requests/PR-AE-1/submit', { expectedVersion, idempotencyKey })

  const first = await emailsAfter(() => submit(1, 'ae-pr-submit-1'), 2)
  assert.equal(first.result.status, 200, describe(first.result))
  assert.equal(first.result.body.idempotentReplay, false)
  const [english, chinese] = byRecipient(first.messages)
  assert.deepEqual(first.messages.map((message) => message.to).sort(), [users.approverEn.email, users.approverZh.email],
    'not the submitter, the opted-out, disabled, viewer or finance users, nor another workspace')
  assert.equal(english.subject, 'Purchase request PR-AE-1 is waiting for approval')
  assert.equal(chinese.subject, '采购申请 PR-AE-1 等待审批')
  for (const message of first.messages) assertOnlyTypeNumberAndLink(message, link, ['125', '12.5', 'Approval Supply', item.name, item.sku, users.submitter.name])

  const audits = await waitFor(() => noticeAudits('PR-AE-1'), (rows) => rows.length === 1, 'the notice audit row')
  assert.equal(audits[0].action, 'approval_email_sent')
  assert.equal(audits[0].entityType, 'ApprovalEmail')
  assert.equal(audits[0].actorId, null)
  assert.deepEqual(audits[0].metadata.recipientUserIds, [users.approverEn.id, users.approverZh.id])
  assert.deepEqual(audits[0].metadata.failedUserIds, [])
  assert.equal(JSON.stringify(audits).includes('@approval-email.invalid'), false, 'the audit names people by id')

  const replay = await emailsAfter(() => submit(1, 'ae-pr-submit-1'), 0)
  assert.equal(replay.result.status, 200, describe(replay.result))
  assert.equal(replay.result.body.idempotentReplay, true)
  assert.deepEqual(replay.messages, [], 'a replayed submit sends nothing')

  const withdrawn = await emailsAfter(() => api(tokens.submitter, 'POST', '/api/procurement/requests/PR-AE-1/withdraw', { expectedVersion: 2, idempotencyKey: 'ae-pr-withdraw-1' }), 0)
  assert.equal(withdrawn.result.status, 200, describe(withdrawn.result))
  assert.deepEqual(withdrawn.messages, [])
  const again = await emailsAfter(() => submit(3, 'ae-pr-submit-2'), 2)
  assert.equal(again.result.status, 200, describe(again.result))
  assert.deepEqual(again.messages.map((message) => message.to).sort(), [users.approverEn.email, users.approverZh.email])
  await waitFor(() => noticeAudits('PR-AE-1'), (rows) => rows.length === 2, 'the second notice audit row')
})

test('a submitted PO is announced by its order number and links to its page', async () => {
  await prisma.purchaseOrder.create({ data: {
    id: 'po-ae-1', tenantId: tenantA, status: 'draft', supplierId: supplier, supplierName: 'Approval Supply Co.', amount: '250.0000', currency: 'USD', version: 0, metadata: { orderNumber: 'PO-AE-0001' },
    lines: { create: [{ id: 'po-ae-1-L1', itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: '20', receivedQuantity: '0', unit: 'EA', unitPrice: '12.5', amount: '250' }] },
  } })
  const submit = () => api(tokens.submitter, 'POST', '/api/procurement/orders/po-ae-1/submit', { expectedVersion: 0 })
  const first = await emailsAfter(submit, 2)
  assert.equal(first.result.status, 200, describe(first.result))
  const [english, chinese] = byRecipient(first.messages)
  assert.equal(english.subject, 'Purchase order PO-AE-0001 is waiting for approval')
  assert.equal(chinese.subject, '采购订单 PO-AE-0001 等待审批')
  for (const message of first.messages) assertOnlyTypeNumberAndLink(message, 'https://flowchain.test/app/procurement/orders/po-ae-1', ['250', 'Approval Supply', item.name])

  const replay = await emailsAfter(submit, 0)
  assert.equal(replay.result.status, 200, describe(replay.result))
  assert.equal(replay.result.body.idempotentReplay, true)
  assert.deepEqual(replay.messages, [])
})

test('a matched bill goes to whoever may approve bills, by its invoice number', async () => {
  await prisma.purchaseOrder.create({ data: { id: 'po-ae-bill', tenantId: tenantA, status: 'approved', supplierId: supplier, supplierName: 'Approval Supply Co.', currency: 'USD', amount: '100.0000', lines: { create: { id: 'po-ae-bill-L1', itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: '10.0000', receivedQuantity: '10.0000', unit: 'EA', unitPrice: '10.0000' } } } })
  await prisma.receivingDocument.create({ data: { id: 'grn-ae-bill', tenantId: tenantA, documentNumber: 'GRN-AE-1', poId: 'po-ae-bill', supplierId: supplier, supplierName: 'Approval Supply Co.', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: users.submitter.id, warehouseId: warehouse, currency: 'USD', lines: { create: { id: 'grn-ae-bill-L1', purchaseOrderLineId: 'po-ae-bill-L1', itemId: item.id, sku: item.sku, itemName: item.name, acceptedQty: '10.0000', rejectedQty: '0.0000', unit: 'EA', warehouseId: warehouse, location: 'A-01', locationKey: 'a-01' } } } })
  const finance = createOperationalFinanceCommandService({ prisma, env: process.env })
  const bill = await finance.createSupplierInvoice({ invoiceNumber: 'AE-BILL-1', supplierId: supplier, currency: 'USD', invoiceDate: '2026-09-01', dueDate: '2026-10-01', totalAmount: '100.0000', idempotencyKey: 'ae-bill-create', lines: [{ purchaseOrderLineId: 'po-ae-bill-L1', receivingLineId: 'grn-ae-bill-L1', quantity: '10.0000', unitPrice: '10.0000', lineAmount: '100.0000', enteredTaxAmount: '0' }] }, { identity })
  await finance.submitSupplierInvoice(bill.entityId, { expectedVersion: 0, idempotencyKey: 'ae-bill-submit' }, { identity })

  const preview = await emailsAfter(() => api(tokens.submitter, 'POST', `/api/finance/supplier-invoices/${bill.entityId}/match-preview`, { expectedVersion: 1 }), 0)
  assert.equal(preview.result.status, 200, describe(preview.result))
  assert.deepEqual(preview.messages, [], 'a preview sends nothing')

  const match = () => api(tokens.submitter, 'POST', `/api/finance/supplier-invoices/${bill.entityId}/match`, { expectedVersion: 1, idempotencyKey: 'ae-bill-match' })
  const first = await emailsAfter(match, 3)
  assert.equal(first.result.status, 200, describe(first.result))
  assert.equal(first.result.body.invoice.status, 'matched')
  assert.deepEqual(first.messages.map((message) => message.to).sort(), [users.approverEn.email, users.approverZh.email, users.finance.email])
  const english = first.messages.find((message) => message.to === users.approverEn.email)
  assert.equal(english.subject, 'Supplier bill AE-BILL-1 is waiting for approval')
  assert.equal(first.messages.find((message) => message.to === users.approverZh.email).subject, '采购发票 AE-BILL-1 等待审批')
  for (const message of first.messages) assertOnlyTypeNumberAndLink(message, `https://flowchain.test/app/procurement/bills/${bill.entityId}`, ['100.00', 'Approval Supply', 'GRN-AE-1'])

  const replay = await emailsAfter(match, 0)
  assert.equal(replay.result.body.idempotentReplay, true)
  assert.deepEqual(replay.messages, [])
})

test('a bill with match exceptions waits for the last one to be approved; previews and a review that leaves one open send nothing', async () => {
  await prisma.purchaseOrder.create({ data: { id: 'po-ae-ex', tenantId: tenantA, status: 'approved', supplierId: supplier, supplierName: 'Approval Supply Co.', currency: 'USD', amount: '100.0000', lines: { create: { id: 'po-ae-ex-L1', itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: '10.0000', receivedQuantity: '10.0000', unit: 'EA', unitPrice: '10.0000' } } } })
  await prisma.receivingDocument.create({ data: { id: 'grn-ae-ex', tenantId: tenantA, documentNumber: 'GRN-AE-2', poId: 'po-ae-ex', supplierId: supplier, supplierName: 'Approval Supply Co.', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: users.submitter.id, warehouseId: warehouse, currency: 'USD', lines: { create: { id: 'grn-ae-ex-L1', purchaseOrderLineId: 'po-ae-ex-L1', itemId: item.id, sku: item.sku, itemName: item.name, acceptedQty: '10.0000', rejectedQty: '0.0000', unit: 'EA', warehouseId: warehouse, location: 'A-01', locationKey: 'a-01' } } } })
  const finance = createOperationalFinanceCommandService({ prisma, env: process.env })
  // Billed at 11 against an order price of 10: a price and an amount exception.
  const bill = await finance.createSupplierInvoice({ invoiceNumber: 'AE-BILL-2', supplierId: supplier, currency: 'USD', invoiceDate: '2026-09-01', dueDate: '2026-10-01', totalAmount: '110.0000', idempotencyKey: 'ae-bill2-create', lines: [{ purchaseOrderLineId: 'po-ae-ex-L1', receivingLineId: 'grn-ae-ex-L1', quantity: '10.0000', unitPrice: '11.0000', lineAmount: '110.0000', enteredTaxAmount: '0' }] }, { identity })
  await finance.submitSupplierInvoice(bill.entityId, { expectedVersion: 0, idempotencyKey: 'ae-bill2-submit' }, { identity })

  const matched = await emailsAfter(() => api(tokens.submitter, 'POST', `/api/finance/supplier-invoices/${bill.entityId}/match`, { expectedVersion: 1, idempotencyKey: 'ae-bill2-match' }), 0)
  assert.equal(matched.result.status, 200, describe(matched.result))
  assert.equal(matched.result.body.invoice.status, 'exception')
  assert.deepEqual(matched.messages, [], 'a bill with open exceptions is not waiting for approval')
  const exceptions = await prisma.financeMatchException.findMany({ where: { supplierInvoiceId: bill.entityId }, orderBy: { id: 'asc' } })
  assert.ok(exceptions.length >= 2, `expected at least two exceptions, got ${exceptions.length}`)
  const review = (exception, key) => api(tokens.submitter, 'POST', `/api/finance/match-exceptions/${exception.id}/review`, { expectedVersion: exception.version, decision: 'approved', resolution: 'Price agreed with the supplier', idempotencyKey: key })

  const previewed = await emailsAfter(() => api(tokens.submitter, 'POST', `/api/finance/match-exceptions/${exceptions[0].id}/review-preview`, { expectedVersion: exceptions[0].version, decision: 'approved', resolution: 'Price agreed with the supplier' }), 0)
  assert.equal(previewed.result.status, 200, describe(previewed.result))
  assert.deepEqual(previewed.messages, [], 'a review preview sends nothing')
  for (const [index, exception] of exceptions.slice(0, -1).entries()) {
    const reviewed = await emailsAfter(() => review(exception, `ae-bill2-review-${index}`), 0)
    assert.equal(reviewed.result.status, 200, describe(reviewed.result))
    assert.deepEqual(reviewed.messages, [], 'another exception is still open')
  }
  const last = await emailsAfter(() => review(exceptions.at(-1), 'ae-bill2-review-last'), 3)
  assert.equal(last.result.status, 200, describe(last.result))
  assert.deepEqual(last.messages.map((message) => message.to).sort(), [users.approverEn.email, users.approverZh.email, users.finance.email])
  assert.equal(last.messages.find((message) => message.to === users.approverEn.email).subject, 'Supplier bill AE-BILL-2 is waiting for approval')
  for (const message of last.messages) assertOnlyTypeNumberAndLink(message, `https://flowchain.test/app/procurement/bills/${bill.entityId}`, ['110.00', '11.00', 'Price agreed', 'GRN-AE-2'])
})

test('a new adjustment goes only to approvers who may operate its warehouse', async () => {
  const create = () => api(tokens.submitter, 'POST', '/api/inventory/adjustments', { idempotencyKey: 'ae-adj-1', adjustmentNumber: 'ADJ-AE-1', reasonCode: 'found_stock', lines: [{ itemId: item.id, warehouseId: warehouse, location: 'A-01', adjustmentQuantity: '2' }] })
  const first = await emailsAfter(create, 1)
  assert.equal(first.result.status, 201, describe(first.result))
  assert.deepEqual(first.messages.map((message) => message.to), [users.approverEn.email], 'read access to the warehouse is not enough')
  assert.equal(first.messages[0].subject, 'Inventory adjustment ADJ-AE-1 is waiting for approval')
  assertOnlyTypeNumberAndLink(first.messages[0], `https://flowchain.test/app/inventory/adjustments/${first.result.body.entityId}`, [item.sku, item.name, 'A-01'])

  const replay = await emailsAfter(create, 0)
  assert.equal(replay.result.status, 201, describe(replay.result))
  assert.equal(replay.result.body.idempotentReplay, true)
  assert.deepEqual(replay.messages, [])
})

test('with the kill switch nothing is sent; with a failing provider the command still succeeds and only a log line says so', async () => {
  await seedPurchaseRequest('PR-AE-OFF')
  process.env.FLOWCHAIN_APPROVAL_EMAILS = 'off'
  try {
    const off = await emailsAfter(() => api(tokens.submitter, 'POST', '/api/procurement/requests/PR-AE-OFF/submit', { expectedVersion: 1, idempotencyKey: 'ae-pr-off' }), 0)
    assert.equal(off.result.status, 200, describe(off.result))
    assert.deepEqual(off.messages, [])
  } finally {
    process.env.FLOWCHAIN_APPROVAL_EMAILS = 'on'
  }

  const failing = createScmServer({
    errorLogger: logger,
    mailer: { send: async () => { throw Object.assign(new Error('provider down'), { code: 'MAIL_DELIVERY_FAILED', provider: 'postmark', status: 503, providerCode: '406' }) } },
  })
  const failingBase = await listen(failing)
  try {
    await seedPurchaseRequest('PR-AE-FAIL')
    const before = (await approvalMessages()).length
    const submitted = await api(tokens.submitter, 'POST', '/api/procurement/requests/PR-AE-FAIL/submit', { expectedVersion: 1, idempotencyKey: 'ae-pr-fail' }, failingBase)
    assert.equal(submitted.status, 200, describe(submitted))
    assert.equal((await prisma.purchaseRequest.findUnique({ where: { id: 'PR-AE-FAIL' } })).status, 'submitted')
    const [audit] = await waitFor(() => noticeAudits('PR-AE-FAIL'), (rows) => rows.length === 1, 'the failed notice audit row')
    assert.deepEqual(audit.metadata.recipientUserIds, [])
    assert.deepEqual(audit.metadata.failedUserIds, [users.approverEn.id, users.approverZh.id])
    const failures = logLines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((entry) => entry?.event === 'approval_email_failed' && entry.documentId === 'PR-AE-FAIL')
    assert.deepEqual(failures.map((entry) => entry.userId).sort(), [users.approverEn.id, users.approverZh.id])
    assert.equal(failures[0].providerCode, '406')
    assert.equal(JSON.stringify(failures).includes('@approval-email.invalid'), false, 'logs name people by id')
    assert.equal((await approvalMessages()).length, before)
  } finally {
    await close(failing)
  }
})

test('each user turns approval emails on or off in their profile; anything but true or false is refused', async () => {
  const profile = await api(tokens.viewer, 'GET', '/api/me/profile')
  assert.equal(profile.status, 200, describe(profile))
  assert.equal(profile.body.approvalEmailsEnabled, true, 'on by default')
  const fields = { name: users.viewer.name, jobTitle: 'Reviewer' }

  const off = await api(tokens.viewer, 'PATCH', '/api/me/profile', { ...fields, version: profile.body.version, approvalEmailsEnabled: false })
  assert.equal(off.status, 200, describe(off))
  assert.equal(off.body.approvalEmailsEnabled, false)
  const kept = await api(tokens.viewer, 'PATCH', '/api/me/profile', { ...fields, version: off.body.version })
  assert.equal(kept.status, 200, describe(kept))
  assert.equal(kept.body.approvalEmailsEnabled, false, 'a save without the field keeps the choice')
  for (const value of ['false', 0, null]) {
    const invalid = await api(tokens.viewer, 'PATCH', '/api/me/profile', { ...fields, version: kept.body.version, approvalEmailsEnabled: value })
    assert.equal(invalid.status, 400, describe(invalid))
    assert.equal(invalid.body.code, 'INVALID_PREFERENCE')
  }
  const row = await prisma.user.findUnique({ where: { id: users.viewer.id } })
  assert.equal(row.approvalEmailsEnabled, false)
  assert.equal(row.version, kept.body.version, 'a refused change writes nothing')
  const on = await api(tokens.viewer, 'PATCH', '/api/me/profile', { ...fields, version: kept.body.version, approvalEmailsEnabled: true })
  assert.equal(on.status, 200, describe(on))
  assert.equal(on.body.approvalEmailsEnabled, true)
})
