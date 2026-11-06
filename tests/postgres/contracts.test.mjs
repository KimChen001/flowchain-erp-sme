import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import pg from 'pg'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { resolveAuthorizationContext } from '../../server/auth/authorization-service.mjs'
import { defaultRoleTemplates } from '../../server/auth/permission-catalog.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { tenantCalendarDay } from '../../server/domain/tenant-calendar-day.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { addContractDays } from '../../shared/contract-status.mjs'

// Contract records (docs/contracts-module-design.md, K1) against PostgreSQL:
// commands with versions, idempotent retries and audit rows; the activate,
// renew and terminate lifecycle; signed files staged and downloaded without
// mobile operations; the total value hidden without the price permission;
// workspaces kept apart; and the contracts Today lists.
const tenant = 'tenant-contracts'
const otherTenant = 'tenant-contracts-other'
const permissionsMigration = '20261009120100_contract_permissions'
const ENV_KEYS = ['FLOWCHAIN_DEFAULT_TENANT_ID', 'FLOWCHAIN_ENABLE_CONTRACTS', 'FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS', 'FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW']
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const PDF = Buffer.from('%PDF-1.4\n% FlowChain contract test file\n%%EOF\n')
const today = tenantCalendarDay(new Date(), 'America/New_York')
const day = (offset) => addContractDays(today, offset)

let prisma
let server
let port
const as = {}

async function request(method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const bytes = Buffer.concat(chunks)
        let payload = bytes.toString('utf8')
        try { payload = JSON.parse(payload) } catch { /* keep text */ }
        resolve({ status: res.statusCode, payload, bytes, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

async function signIn(tenantId, email, name) {
  process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
  const login = await request('POST', '/api/auth/login', { body: { email, name, company: 'Contracts workspace' } })
  assert.equal(login.status, 200, JSON.stringify(login.payload))
  const headers = { Authorization: `Bearer ${login.payload.token}` }
  return (method, path, body, extraHeaders = {}) => request(method, path, { headers: { ...headers, ...extraHeaders }, body })
}

const userId = (key) => `${tenant}-${key}`
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.payload)); return response.payload }
const codeOf = (response) => [response.status, response.payload?.code]
const stage = (signedIn, { fileName = 'signed.pdf', mimeType = 'application/pdf', bytes = PDF, purpose = 'contract' } = {}) =>
  signedIn('POST', '/api/uploads/stage', { purpose, fileName, mimeType, contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })

before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.createMany({ data: [{ id: tenant, name: 'Contracts workspace', currency: 'USD', timezone: 'America/New_York' }, { id: otherTenant, name: 'Other workspace', currency: 'USD' }] })
  // Legacy roles; the first request backfills each into its default role.
  const people = { manager: 'manager', buyer: 'buyer', finance: 'finance-specialist', viewer: 'viewer', noaccess: 'viewer' }
  for (const [key, role] of Object.entries(people)) {
    await prisma.user.create({ data: { id: userId(key), tenantId: tenant, email: `${key}-contracts@example.com`, name: `Contracts ${key}`, role } })
  }
  await prisma.user.create({ data: { id: `${otherTenant}-buyer`, tenantId: otherTenant, email: 'buyer-other-contracts@example.com', name: 'Other buyer', role: 'buyer' } })
  // The supplier's business owner is the finance specialist, so a new
  // contract's owner is not simply whoever created it.
  await prisma.supplier.create({ data: { id: 'SUP-CA', tenantId: tenant, code: 'SUP-CA', name: 'Acme Packaging', businessOwnerId: userId('finance'), metadata: { defaultCurrency: 'USD', version: 1 } } })
  await prisma.supplier.create({ data: { id: 'SUP-CB', tenantId: tenant, code: 'SUP-CB', name: 'Beta 100% Freight', metadata: { defaultCurrency: 'USD', version: 1 } } })
  await prisma.supplier.create({ data: { id: 'SUP-CO', tenantId: otherTenant, code: 'SUP-CO', name: 'Other Supplier', metadata: { defaultCurrency: 'USD', version: 1 } } })
  await prisma.paymentTerm.create({ data: { id: 'PT-C-NET30', tenantId: tenant, code: 'NET30', name: 'Net 30', days: 30 } })
  await backfillTenantAuthorization(prisma, tenant)
  // A role without any contract code.
  await prisma.tenantRole.create({ data: { id: `${tenant}-no-contracts`, tenantId: tenant, roleKey: 'no-contracts', name: 'No contracts' } })
  await prisma.tenantRolePermission.create({ data: { id: `${tenant}-no-contracts-po`, tenantId: tenant, roleId: `${tenant}-no-contracts`, permissionCode: 'procurement.purchase_order.read' } })
  await prisma.userRoleAssignment.deleteMany({ where: { userId: userId('noaccess') } })
  await prisma.userRoleAssignment.create({ data: { id: `${tenant}-noaccess-role`, tenantId: tenant, userId: userId('noaccess'), roleId: `${tenant}-no-contracts` } })

  process.env.FLOWCHAIN_ENABLE_CONTRACTS = 'true'
  server = createScmServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  for (const key of Object.keys(people)) as[key] = await signIn(tenant, `${key}-contracts@example.com`, `Contracts ${key}`)
  as.other = await signIn(otherTenant, 'buyer-other-contracts@example.com', 'Other buyer')
  process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenant
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await prisma?.$disconnect()
  await disconnectPrismaClient().catch(() => {})
})

const draftInput = (overrides = {}) => ({ title: '2026 packaging supply agreement', type: 'purchase_agreement', supplierId: 'SUP-CA', externalReference: 'ACME-2026-07', startDate: day(-30), endDate: day(335), renewal: 'none', paymentTermsId: 'NET30', currency: 'USD', totalValue: '120000', ...overrides })

test('with the capability off every contract route answers 409; on, the workspace starts with none', async () => {
  process.env.FLOWCHAIN_ENABLE_CONTRACTS = 'false'
  try {
    assert.deepEqual(codeOf(await as.manager('GET', '/api/contracts')), [409, 'CONTRACTS_CAPABILITY_NOT_AVAILABLE'])
    assert.deepEqual(codeOf(await as.manager('POST', '/api/contracts', draftInput())), [409, 'CONTRACTS_CAPABILITY_NOT_AVAILABLE'])
  } finally {
    process.env.FLOWCHAIN_ENABLE_CONTRACTS = 'true'
  }
  const list = ok(await as.manager('GET', '/api/contracts'))
  assert.deepEqual([list.total, list.counts.all, list.today], [0, 0, today])
})

let main
test('a buyer creates a draft; a retry with the same key replays it; the owner is the supplier\'s business owner', async () => {
  const created = ok(await as.buyer('POST', '/api/contracts', { ...draftInput(), idempotencyKey: 'contracts-create-1' }), 201)
  main = created.contract
  assert.match(main.number, /^CT-[0-9A-F]{8}$/)
  assert.deepEqual([main.status, main.state, main.version, main.owner?.id, main.supplier?.name, main.totalValue, main.currency, main.startDate, main.endDate, created.idempotentReplay],
    ['draft', 'draft', 1, userId('finance'), 'Acme Packaging', '120000.0000', 'USD', day(-30), day(335), false])
  const replay = ok(await as.buyer('POST', '/api/contracts', { ...draftInput(), idempotencyKey: 'contracts-create-1' }), 201)
  assert.deepEqual([replay.contract.id, replay.idempotentReplay], [main.id, true])
  assert.deepEqual(codeOf(await as.buyer('POST', '/api/contracts', { ...draftInput({ title: 'Other' }), idempotencyKey: 'contracts-create-1' })), [409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'])
  assert.equal(await prisma.contract.count({ where: { tenantId: tenant } }), 1)
  // Stored as the calendar day entered, at 00:00 UTC.
  const stored = await prisma.contract.findUnique({ where: { id: main.id } })
  assert.equal(stored.endDate.toISOString(), `${day(335)}T00:00:00.000Z`)
  const audit = await prisma.auditLog.findMany({ where: { tenantId: tenant, entityType: 'Contract', entityId: main.id } })
  assert.deepEqual(audit.map((row) => [row.action, row.actorId, row.module]), [['contract_created', userId('buyer'), 'contracts']])
  assert.equal(audit[0].metadata.after.totalValue, '120000.0000')
})

test('create checks the fields and that every reference is of this workspace; readers cannot create', async () => {
  const fields = (response) => [response.status, response.payload.code, (response.payload.details || []).map((detail) => `${detail.field}:${detail.code}`).sort()]
  assert.deepEqual(fields(await as.buyer('POST', '/api/contracts', { type: 'nda' })), [422, 'VALIDATION_ERROR', ['supplierId:REQUIRED', 'title:REQUIRED']])
  assert.deepEqual(fields(await as.buyer('POST', '/api/contracts', draftInput({ supplierId: 'SUP-CO' }))), [422, 'VALIDATION_ERROR', ['supplierId:SUPPLIER_NOT_FOUND']])
  assert.deepEqual(fields(await as.buyer('POST', '/api/contracts', draftInput({ ownerId: `${otherTenant}-buyer` }))), [422, 'VALIDATION_ERROR', ['ownerId:OWNER_NOT_FOUND']])
  assert.deepEqual(fields(await as.buyer('POST', '/api/contracts', draftInput({ paymentTermsId: 'NET90' }))), [422, 'VALIDATION_ERROR', ['paymentTermsId:PAYMENT_TERM_NOT_FOUND']])
  assert.deepEqual(fields(await as.buyer('POST', '/api/contracts', draftInput({ startDate: day(10), endDate: day(5) }))), [422, 'VALIDATION_ERROR', ['endDate:END_BEFORE_START']])
  assert.deepEqual(fields(await as.buyer('POST', '/api/contracts', draftInput({ endDate: '2026-02-30' }))), [422, 'VALIDATION_ERROR', ['endDate:DATE_INVALID']])
  for (const reader of ['finance', 'viewer', 'noaccess']) {
    const denied = await as[reader]('POST', '/api/contracts', draftInput())
    assert.deepEqual([denied.status, denied.payload.permission], [403, 'contracts.contract.manage'], reader)
  }
  // A total value without a currency takes the workspace's.
  const priced = ok(await as.manager('POST', '/api/contracts', draftInput({ currency: '', totalValue: '500', title: 'Workspace currency' })), 201)
  assert.equal(priced.contract.currency, 'USD')
  ok(await as.manager('DELETE', `/api/contracts/${priced.contract.id}?expectedVersion=1`))
})

test('a draft is fully editable, with before and after audited; a stale version is refused; a resend replays', async () => {
  const update = { expectedVersion: 1, supplierId: 'SUP-CB', title: '2026 freight and packaging agreement', notes: 'Price review in May' }
  const updated = ok(await as.buyer('PATCH', `/api/contracts/${main.id}`, update))
  assert.deepEqual([updated.contract.version, updated.contract.supplier.id, updated.contract.title, updated.idempotentReplay], [2, 'SUP-CB', update.title, false])
  // The same request again (no key) is the same command: a replay, not a conflict.
  const resent = ok(await as.buyer('PATCH', `/api/contracts/${main.id}`, update))
  assert.deepEqual([resent.contract.version, resent.idempotentReplay], [2, true])
  const stale = await as.manager('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 1, notes: 'Stale screen' })
  assert.deepEqual([stale.status, stale.payload.code, stale.payload.expectedVersion, stale.payload.currentVersion], [409, 'VERSION_CONFLICT', 1, 2])
  assert.deepEqual(codeOf(await as.manager('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 2, notes: 'Price review in May' })), [422, 'CONTRACT_UNCHANGED'])
  const row = await prisma.auditLog.findFirst({ where: { tenantId: tenant, entityId: main.id, action: 'contract_updated' } })
  assert.deepEqual(row.metadata.changes, {
    supplierId: { before: 'SUP-CA', after: 'SUP-CB' },
    title: { before: '2026 packaging supply agreement', after: '2026 freight and packaging agreement' },
    notes: { before: null, after: 'Price review in May' },
  })
  main = updated.contract
})

test('two people saving the same version at once: one wins, the other gets a conflict', async () => {
  const [first, second] = await Promise.all([
    as.buyer('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 2, notes: 'Saved by the buyer' }),
    as.manager('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 2, notes: 'Saved by the manager' }),
  ])
  assert.deepEqual([first.status, second.status].sort(), [200, 409])
  const loser = first.status === 409 ? first : second
  assert.ok(['VERSION_CONFLICT', 'TRANSACTION_CONFLICT'].includes(loser.payload.code), loser.payload.code)
  const stored = await prisma.contract.findUnique({ where: { id: main.id } })
  assert.equal(stored.version, 3)
  assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant, entityId: main.id, action: 'contract_updated' } }), 2)
  main = ok(await as.manager('GET', `/api/contracts/${main.id}`)).contract
})

test('activation needs the signed and start dates and a signed date not after today; an active contract keeps its supplier and type', async () => {
  const fields = (response) => [response.status, (response.payload.details || []).map((detail) => `${detail.field}:${detail.code}`)]
  assert.deepEqual(fields(await as.buyer('POST', `/api/contracts/${main.id}/activate`, { expectedVersion: 3 })), [422, ['signedOn:REQUIRED']])
  assert.deepEqual(fields(await as.buyer('POST', `/api/contracts/${main.id}/activate`, { expectedVersion: 3, signedOn: day(1) })), [422, ['signedOn:SIGNED_ON_IN_FUTURE']])
  assert.equal((await as.finance('POST', `/api/contracts/${main.id}/activate`, { expectedVersion: 3, signedOn: day(-31) })).status, 403)
  const activated = ok(await as.buyer('POST', `/api/contracts/${main.id}/activate`, { expectedVersion: 3, signedOn: day(-31) }))
  assert.deepEqual([activated.contract.status, activated.contract.state, activated.contract.signedOn, activated.contract.version], ['active', 'active', day(-31), 4])
  assert.ok(activated.contract.activatedAt)
  assert.deepEqual(codeOf(await as.buyer('POST', `/api/contracts/${main.id}/activate`, { expectedVersion: 4, signedOn: day(-31) })), [409, 'INVALID_STATE_TRANSITION'])
  const locked = await as.buyer('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 4, supplierId: 'SUP-CA', type: 'service_agreement' })
  assert.deepEqual([locked.status, locked.payload.code, locked.payload.details.map((detail) => detail.field)], [409, 'CONTRACT_FIELD_LOCKED', ['supplierId', 'type']])
  assert.deepEqual(codeOf(await as.buyer('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 4, signedOn: '' })), [422, 'VALIDATION_ERROR'])
  // Other terms change, audited before and after.
  const extended = ok(await as.buyer('PATCH', `/api/contracts/${main.id}`, { expectedVersion: 4, endDate: day(20), totalValue: '125000' }))
  assert.deepEqual([extended.contract.endDate, extended.contract.state, extended.contract.keyDate, extended.contract.version], [day(20), 'ending', day(20), 5])
  const change = await prisma.auditLog.findFirst({ where: { tenantId: tenant, entityId: main.id, action: 'contract_updated', metadata: { path: ['status'], equals: 'active' } } })
  assert.deepEqual(change.metadata.changes, { endDate: { before: day(335), after: day(20) }, totalValue: { before: '120000.0000', after: '125000.0000' } })
  main = extended.contract
})

test('the total value is hidden from readers without procurement.prices.read, in the list, the detail and the history', async () => {
  for (const reader of ['viewer', 'finance']) {
    const list = ok(await as[reader]('GET', '/api/contracts'))
    const row = list.contracts.find((entry) => entry.id === main.id)
    assert.deepEqual([row.totalValue, row.restrictedFields, row.currency], [null, ['totalValue'], 'USD'], reader)
    const detail = ok(await as[reader]('GET', `/api/contracts/${main.id}`))
    assert.equal(detail.contract.totalValue, null)
    assert.equal(JSON.stringify(detail).includes('125000'), false, `${reader} detail leaks the value`)
    assert.equal(JSON.stringify(detail).includes('120000'), false, `${reader} history leaks the value`)
    assert.deepEqual(detail.access, { manage: false, prices: false })
  }
  const manager = ok(await as.manager('GET', `/api/contracts/${main.id}`))
  assert.equal(manager.contract.totalValue, '125000.0000')
  assert.deepEqual(manager.contract.history.map((entry) => entry.action), ['contract_updated', 'contract_activated', 'contract_updated', 'contract_updated', 'contract_created'])
  assert.deepEqual(manager.contract.history[0].details.changes.totalValue, { before: '120000.0000', after: '125000.0000' })
  assert.equal('idempotencyKey' in manager.contract.history[0].details, false)
  assert.deepEqual(codeOf(await as.noaccess('GET', '/api/contracts')), [403, 'AUTHORIZATION_PERMISSION_DENIED'])
  assert.deepEqual(codeOf(await as.noaccess('GET', `/api/contracts/${main.id}`)), [403, 'AUTHORIZATION_PERMISSION_DENIED'])
})

test('the list searches number, reference, title and supplier with wildcards taken literally, and filters and counts by state', async () => {
  const other = ok(await as.buyer('POST', '/api/contracts', draftInput({ title: 'Mutual NDA', type: 'nda', externalReference: null, totalValue: null, currency: null, endDate: null })), 201).contract
  const ids = async (query) => ok(await as.manager('GET', `/api/contracts${query}`)).contracts.map((row) => row.id)
  assert.deepEqual(await ids(`?search=${encodeURIComponent(main.number.toLowerCase())}`), [main.id])
  assert.deepEqual(await ids('?search=acme-2026'), [main.id])
  assert.deepEqual(await ids('?search=mutual'), [other.id])
  assert.deepEqual(await ids('?search=acme%20packaging'), [other.id])
  assert.deepEqual(await ids(`?search=${encodeURIComponent('100%')}`), [main.id])
  assert.deepEqual(await ids(`?search=${encodeURIComponent('%')}`), [main.id])
  assert.deepEqual(await ids(`?search=${encodeURIComponent('_')}`), [])
  assert.deepEqual(await ids('?type=nda'), [other.id])
  assert.deepEqual(await ids('?state=ending'), [main.id])
  assert.deepEqual(await ids('?state=draft,ending&sort=key_date'), [main.id, other.id])
  assert.deepEqual(await ids('?supplierId=SUP-CB'), [main.id])
  // Both are owned by Acme's business owner; newest first.
  assert.deepEqual(await ids(`?ownerId=${userId('finance')}`), [other.id, main.id])
  assert.deepEqual(await ids(`?ownerId=${userId('buyer')}`), [])
  const page = ok(await as.manager('GET', '/api/contracts?pageSize=1&page=2'))
  assert.deepEqual([page.total, page.contracts.length, page.page], [2, 1, 2])
  const counts = ok(await as.manager('GET', '/api/contracts')).counts
  assert.deepEqual([counts.all, counts.draft, counts.ending, counts.active], [2, 1, 1, 0])
  assert.deepEqual(codeOf(await as.manager('GET', '/api/contracts?state=lost')), [422, 'VALIDATION_ERROR'])
  ok(await as.buyer('DELETE', `/api/contracts/${other.id}?expectedVersion=1`))
})

test('signed files stage, bind, download and are removed without mobile operations', async () => {
  process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = 'false'
  process.env.FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW = 'false'
  try {
    // Staging a contract file needs contracts.contract.manage, a PDF or image.
    const staged = ok(await stage(as.buyer), 201)
    assert.equal(staged.mimeType, 'application/pdf')
    const upload = await prisma.stagedUpload.findUnique({ where: { id: staged.uploadId } })
    assert.equal(upload.metadata.purpose, 'contract')
    assert.equal((await stage(as.finance)).status, 403)
    assert.deepEqual(codeOf(await stage(as.buyer, { fileName: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('notes') })), [422, 'UPLOAD_TYPE_NOT_ALLOWED'])
    // Other evidence still needs mobile operations or the settlement workflow.
    assert.deepEqual(codeOf(await stage(as.buyer, { purpose: '', fileName: 'proof.txt', mimeType: 'text/plain', bytes: Buffer.from('proof') })), [409, 'ATTACHMENT_CAPABILITY_NOT_AVAILABLE'])
    assert.deepEqual(codeOf(await as.buyer('GET', `/api/uploads/${staged.uploadId}/status`)), [409, 'ATTACHMENT_CAPABILITY_NOT_AVAILABLE'])

    // Someone else cannot bind my upload; I bind it once.
    assert.deepEqual(codeOf(await as.manager('POST', `/api/contracts/${main.id}/attachments`, { uploadId: staged.uploadId, expectedVersion: main.version })), [404, 'UPLOAD_NOT_FOUND'])
    const bound = ok(await as.buyer('POST', `/api/contracts/${main.id}/attachments`, { uploadId: staged.uploadId, expectedVersion: main.version }), 201)
    assert.equal(bound.contract.version, main.version + 1)
    main = bound.contract
    assert.deepEqual(codeOf(await as.buyer('POST', `/api/contracts/${main.id}/attachments`, { uploadId: staged.uploadId, expectedVersion: main.version })), [409, 'UPLOAD_NOT_BINDABLE'])
    const detail = ok(await as.viewer('GET', `/api/contracts/${main.id}`)).contract
    assert.deepEqual(detail.files.map((file) => [file.id, file.fileName, file.mimeType, file.sizeBytes, file.createdBy.name]), [[bound.attachmentId, 'signed.pdf', 'application/pdf', PDF.length, 'Contracts buyer']])
    assert.equal(detail.files[0].downloadUrl, `/api/attachments/${bound.attachmentId}/download`)
    assert.equal(detail.history[0].action, 'contract_file_added')

    // Readers download it; a role without contracts and another workspace cannot.
    const download = await as.viewer('GET', detail.files[0].downloadUrl)
    assert.equal(download.status, 200)
    assert.deepEqual(download.bytes, PDF)
    assert.equal(download.headers['cache-control'], 'private, no-store')
    assert.equal((await as.noaccess('GET', detail.files[0].downloadUrl)).status, 403)
    assert.deepEqual(codeOf(await as.other('GET', detail.files[0].downloadUrl)), [404, 'ATTACHMENT_NOT_FOUND'])
    const downloaded = await prisma.auditLog.findFirst({ where: { tenantId: tenant, action: 'attachment_downloaded', entityId: bound.attachmentId } })
    assert.deepEqual([downloaded.entityType, downloaded.module, downloaded.actorId], ['ContractAttachment', 'contracts', userId('viewer')])

    // Removing needs manage and the current version; the file is then gone.
    assert.equal((await as.finance('DELETE', `/api/contracts/${main.id}/attachments/${bound.attachmentId}?expectedVersion=${main.version}`)).status, 403)
    const removed = ok(await as.manager('DELETE', `/api/contracts/${main.id}/attachments/${bound.attachmentId}?expectedVersion=${main.version}`))
    main = removed.contract
    assert.deepEqual(codeOf(await as.viewer('GET', detail.files[0].downloadUrl)), [404, 'ATTACHMENT_NOT_FOUND'])
    assert.deepEqual(ok(await as.viewer('GET', `/api/contracts/${main.id}`)).contract.files, [])
    const actions = (await prisma.auditLog.findMany({ where: { tenantId: tenant, entityId: main.id, action: { in: ['contract_file_added', 'contract_file_removed'] } }, orderBy: { createdAt: 'asc' } })).map((row) => row.action)
    assert.deepEqual(actions, ['contract_file_added', 'contract_file_removed'])
    const stored = await prisma.contractAttachment.findUnique({ where: { id: bound.attachmentId } })
    assert.deepEqual([stored.status, stored.deletedById], ['deleted', userId('manager')])
  } finally {
    process.env.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS = previousEnv.FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS
    process.env.FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW = previousEnv.FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW
  }
  // With mobile operations back on, receiving evidence stages as before.
  const evidence = await stage(as.buyer, { purpose: '', fileName: 'proof.txt', mimeType: 'text/plain', bytes: Buffer.from('receiving proof') })
  assert.equal(evidence.status, 201, JSON.stringify(evidence.payload))
})

test('renew starts one prefilled draft; activating it shows the old contract renewed; terminate needs a date and reason', async () => {
  assert.deepEqual(codeOf(await as.buyer('POST', `/api/contracts/${main.id}/renew`, { expectedVersion: main.version - 1 })), [409, 'VERSION_CONFLICT'])
  const renewal = ok(await as.buyer('POST', `/api/contracts/${main.id}/renew`, { expectedVersion: main.version }), 201).contract
  assert.deepEqual([renewal.status, renewal.renewsContract?.id, renewal.supplier.id, renewal.type, renewal.title, renewal.startDate, renewal.endDate, renewal.signedOn, renewal.totalValue, renewal.paymentTermsId, renewal.externalReference],
    ['draft', main.id, 'SUP-CB', 'purchase_agreement', main.title, day(21), null, null, '125000.0000', 'NET30', null])
  const again = await as.buyer('POST', `/api/contracts/${main.id}/renew`, { expectedVersion: main.version })
  assert.deepEqual([again.status, again.payload.code, again.payload.renewalId], [409, 'CONTRACT_RENEWAL_EXISTS', renewal.id])
  assert.deepEqual(codeOf(await as.buyer('POST', `/api/contracts/${renewal.id}/renew`, { expectedVersion: 1 })), [409, 'CONTRACT_NOT_RENEWABLE'])
  const oldHistory = ok(await as.manager('GET', `/api/contracts/${main.id}`)).contract
  assert.deepEqual([oldHistory.history[0].action, oldHistory.history[0].details.renewalId, oldHistory.state, oldHistory.renewals.map((row) => row.id)], ['contract_renewed', renewal.id, 'ending', [renewal.id]])

  const activated = ok(await as.buyer('POST', `/api/contracts/${renewal.id}/activate`, { expectedVersion: 1, signedOn: today, startDate: day(21) })).contract
  assert.deepEqual([activated.status, activated.state], ['active', 'active'])
  const old = ok(await as.viewer('GET', `/api/contracts/${main.id}`)).contract
  assert.deepEqual([old.status, old.state, old.renewals[0].number], ['active', 'renewed', renewal.number])

  const fields = (response) => [response.status, (response.payload.details || []).map((detail) => `${detail.field}:${detail.code}`).sort()]
  assert.deepEqual(fields(await as.buyer('POST', `/api/contracts/${renewal.id}/terminate`, { expectedVersion: 2 })), [422, ['reason:REQUIRED', 'terminatedOn:REQUIRED']])
  assert.deepEqual(fields(await as.buyer('POST', `/api/contracts/${renewal.id}/terminate`, { expectedVersion: 2, terminatedOn: day(-1), reason: 'Supplier closed' })), [422, ['terminatedOn:BEFORE_SIGNED_ON']])
  const terminated = ok(await as.buyer('POST', `/api/contracts/${renewal.id}/terminate`, { expectedVersion: 2, terminatedOn: today, reason: 'Supplier closed the plant' })).contract
  assert.deepEqual([terminated.status, terminated.state, terminated.terminatedOn, terminated.terminationReason, terminated.keyDate], ['terminated', 'terminated', today, 'Supplier closed the plant', today])
  assert.deepEqual(codeOf(await as.buyer('POST', `/api/contracts/${renewal.id}/terminate`, { expectedVersion: 3, terminatedOn: today, reason: 'Again' })), [409, 'INVALID_STATE_TRANSITION'])
  assert.deepEqual(codeOf(await as.buyer('PATCH', `/api/contracts/${renewal.id}`, { expectedVersion: 3, notes: 'Late note' })), [409, 'CONTRACT_NOT_EDITABLE'])
  assert.deepEqual(codeOf(await as.buyer('DELETE', `/api/contracts/${renewal.id}?expectedVersion=3`)), [409, 'CONTRACT_NOT_DRAFT'])
  const actions = (await prisma.auditLog.findMany({ where: { tenantId: tenant, entityId: renewal.id }, orderBy: { createdAt: 'asc' } })).map((row) => row.action)
  assert.deepEqual(actions, ['contract_created', 'contract_activated', 'contract_terminated'])
})

test('a draft is deleted with its files, audited; nothing else is deleted', async () => {
  const draft = ok(await as.buyer('POST', '/api/contracts', draftInput({ title: 'Quality agreement', type: 'quality_agreement' })), 201).contract
  const staged = ok(await stage(as.buyer, { fileName: 'quality.png', mimeType: 'image/png', bytes: Buffer.from('png-bytes') }), 201)
  const withFile = ok(await as.buyer('POST', `/api/contracts/${draft.id}/attachments`, { uploadId: staged.uploadId, expectedVersion: 1 }), 201)
  assert.deepEqual(codeOf(await as.buyer('DELETE', `/api/contracts/${draft.id}?expectedVersion=1`)), [409, 'VERSION_CONFLICT'])
  assert.equal((await as.finance('DELETE', `/api/contracts/${draft.id}?expectedVersion=2`)).status, 403)
  const deleted = ok(await as.buyer('DELETE', `/api/contracts/${draft.id}`, { expectedVersion: 2 }))
  assert.deepEqual([deleted.deleted, deleted.contractId, deleted.number], [true, draft.id, draft.number])
  assert.equal(await prisma.contract.findUnique({ where: { id: draft.id } }), null)
  assert.equal(await prisma.contractAttachment.count({ where: { id: withFile.attachmentId } }), 0)
  const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenant, entityId: draft.id, action: 'contract_draft_deleted' } })
  assert.deepEqual([audit.actorId, audit.metadata.number, audit.metadata.files.map((file) => file.fileName)], [userId('buyer'), draft.number, ['quality.png']])
  assert.deepEqual(codeOf(await as.buyer('GET', `/api/contracts/${draft.id}`)), [404, 'CONTRACT_NOT_FOUND'])
})

test('another workspace sees, changes and references none of these contracts', async () => {
  assert.deepEqual(ok(await as.other('GET', '/api/contracts')).contracts, [])
  assert.deepEqual(codeOf(await as.other('GET', `/api/contracts/${main.id}`)), [404, 'CONTRACT_NOT_FOUND'])
  assert.deepEqual(codeOf(await as.other('PATCH', `/api/contracts/${main.id}`, { expectedVersion: main.version, notes: 'x' })), [404, 'CONTRACT_NOT_FOUND'])
  assert.deepEqual(codeOf(await as.other('POST', `/api/contracts/${main.id}/renew`, { expectedVersion: main.version })), [404, 'CONTRACT_NOT_FOUND'])
  const created = await as.other('POST', '/api/contracts', draftInput({ supplierId: 'SUP-CA', paymentTermsId: null }))
  assert.deepEqual([created.status, created.payload.details?.[0]?.field], [422, 'supplierId'])
  const own = ok(await as.other('POST', '/api/contracts', draftInput({ supplierId: 'SUP-CO', paymentTermsId: null })), 201).contract
  assert.equal((await prisma.contract.findUnique({ where: { id: own.id } })).tenantId, otherTenant)
  assert.equal(ok(await as.manager('GET', '/api/contracts')).contracts.some((row) => row.id === own.id), false)
  // The database refuses a contract pointing at another workspace's supplier.
  await assert.rejects(() => prisma.contract.create({ data: { id: 'C-CROSS', tenantId: tenant, number: 'CT-0000ABCD', title: 'Cross', type: 'other', supplierId: 'SUP-CO', createdById: userId('buyer') } }))
})

test('Today lists contracts with notice due, ending and past their end, for the owner and for managers', async () => {
  const make = async (input, activate) => {
    const created = ok(await as.manager('POST', '/api/contracts', draftInput({ externalReference: null, ...input })), 201).contract
    return ok(await as.manager('POST', `/api/contracts/${created.id}/activate`, { expectedVersion: 1, signedOn: activate })).contract
  }
  const ending = await make({ title: 'Ending soon', startDate: day(-200), endDate: day(10), ownerId: userId('finance') }, day(-200))
  const notice = await make({ title: 'Notice due', startDate: day(-200), endDate: day(100), renewal: 'automatic', noticeDays: 60, ownerId: userId('buyer') }, day(-200))
  const pastEnd = await make({ title: 'Past its end', startDate: day(-400), endDate: day(-3), renewal: 'automatic', ownerId: userId('finance') }, day(-400))
  const later = await make({ title: 'Ends next year', startDate: day(-10), endDate: day(300), ownerId: userId('finance') }, day(-10))
  assert.deepEqual([ending.state, notice.state, notice.keyDate, pastEnd.state, later.state], ['ending', 'notice_due', day(40), 'past_end', 'active'])

  const rowsFor = async (signedIn) => {
    const home = ok(await signedIn('GET', '/api/home/overview'))
    assert.deepEqual(home.limitations.filter((code) => code.includes('contracts')), [])
    return home.workItems.filter((item) => item.entityType === 'contract')
  }
  // The manager manages contracts: every one, ordered by date.
  const managerRows = await rowsFor(as.manager)
  const ours = managerRows.filter((item) => [ending.id, notice.id, pastEnd.id, later.id].includes(item.recordId))
  assert.deepEqual(ours.map((item) => [item.kind, item.recordId, item.date, item.dateKind, item.overdueDays]), [
    ['contract_past_end', pastEnd.id, day(-3), 'ended', 3],
    ['contract_ending', ending.id, day(10), 'ends', 0],
    ['contract_notice_due', notice.id, day(40), 'notice_by', 0],
  ])
  const endingRow = ours.find((item) => item.recordId === ending.id)
  assert.deepEqual([endingRow.label, endingRow.name, endingRow.href, endingRow.detail.title], [ending.number, 'Acme Packaging', `/app/contracts/${ending.id}`, 'Ending soon'])
  // The finance specialist reads contracts and owns two of them.
  assert.deepEqual((await rowsFor(as.finance)).map((item) => item.recordId).filter((id) => [ending.id, notice.id, pastEnd.id].includes(id)).sort(), [ending.id, pastEnd.id].sort())
  // The viewer owns none; a role without contracts is told they are not listed.
  assert.deepEqual(await rowsFor(as.viewer), [])
  const noaccess = ok(await as.noaccess('GET', '/api/home/overview'))
  assert.deepEqual([noaccess.workItems.some((item) => item.entityType === 'contract'), noaccess.hidden.includes('contracts')], [false, true])
  // Another workspace's Today has none of them.
  assert.deepEqual(await rowsFor(as.other), [])
  // With the capability off, Today reads no contracts.
  process.env.FLOWCHAIN_ENABLE_CONTRACTS = 'false'
  try {
    const off = ok(await as.manager('GET', '/api/home/overview'))
    assert.equal(off.workItems.some((item) => item.entityType === 'contract'), false)
  } finally {
    process.env.FLOWCHAIN_ENABLE_CONTRACTS = 'true'
  }
})

test('the contract permissions migration grants the codes to existing default roles, once', async () => {
  const existing = 'tenant-contracts-existing'
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST })
  const migration = readFileSync(new URL(`../../prisma/migrations/${permissionsMigration}/migration.sql`, import.meta.url), 'utf8')
  const grants = async () => (await prisma.tenantRolePermission.findMany({ where: { tenantId: existing }, include: { role: true }, orderBy: { id: 'asc' } }))
    .map(({ id, roleId, permissionCode, role }) => ({ id, roleId, permissionCode, roleKey: role.roleKey }))
  const contractGrants = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.roleKey))].sort().map((roleKey) => [roleKey, rows.filter((row) => row.roleKey === roleKey && row.permissionCode.startsWith('contracts.')).map((row) => row.permissionCode).sort()]))
  const catalogConstraint = async () => (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'TenantRolePermission_permissionCode_catalog_check'`)).rows[0].definition
  try {
    await client.connect()
    // Default roles as a workspace had them before contracts existed.
    await prisma.tenant.create({ data: { id: existing, name: 'Existing workspace' } })
    await prisma.user.create({ data: { id: `${existing}-admin`, tenantId: existing, email: 'admin-contracts-existing@example.com', name: 'Existing Admin', role: 'admin' } })
    await backfillTenantAuthorization(prisma, existing)
    await prisma.tenantRolePermission.deleteMany({ where: { tenantId: existing, permissionCode: { startsWith: 'contracts.' } } })
    const before = await grants()
    const admin = () => resolveAuthorizationContext({ authenticated: true, tenantId: existing, userId: `${existing}-admin` }, { prisma, performLegacyBackfill: false })
    assert.equal((await admin()).permissionCodes.has('contracts.contract.manage'), false)

    await client.query(migration)

    const afterRows = await grants()
    const expected = Object.fromEntries(defaultRoleTemplates.map((template) => [template.roleKey, template.permissions.filter((code) => code.startsWith('contracts.')).sort()]).sort(([a], [b]) => a.localeCompare(b)))
    assert.deepEqual(contractGrants(afterRows), expected)
    assert.deepEqual(afterRows.filter((row) => !row.permissionCode.startsWith('contracts.')), before)
    assert.ok((await admin()).permissionCodes.has('contracts.contract.manage'))
    const constraint = await catalogConstraint()
    await client.query(migration)
    assert.deepEqual(await grants(), afterRows)
    assert.equal(await catalogConstraint(), constraint)
    assert.equal(constraint.split("'contracts.contract.read'").length - 1, 1)
    const role = await prisma.tenantRole.findFirst({ where: { tenantId: existing, roleKey: 'read-only-viewer' } })
    await assert.rejects(() => prisma.tenantRolePermission.create({ data: { id: `${existing}-unknown`, tenantId: existing, roleId: role.id, permissionCode: 'contracts.contract.approve' } }))
  } finally {
    await client.end().catch(() => {})
  }
})
