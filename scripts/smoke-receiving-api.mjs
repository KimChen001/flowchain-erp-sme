import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import EmbeddedPostgres from 'embedded-postgres'
import { createPrismaClient } from '../server/persistence/prisma-client.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const node = process.execPath
const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
const tenantId = 'tenant-receiving-api-smoke'
const email = 'receiving-smoke@flowchain.invalid'
const actorId = `USR-${createHash('sha256').update(email).digest('hex').slice(0, 16)}`

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer().on('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
  })
}

async function waitFor(url, timeout = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try { const response = await fetch(url); if (response.ok) return }
    catch { /* server is starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('API server did not become ready')
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function startApi(env) {
  const child = spawn(node, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => { const safe = String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]'); if (safe.trim()) process.stderr.write(safe) })
  return child
}

async function request(base, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const payload = await response.json()
  if (!response.ok) throw new Error(`${method} ${path} failed: ${payload.code || response.status} ${payload.message || payload.error || ''}`)
  return payload
}

async function login(base) {
  const result = await request(base, '/api/auth/login', { method: 'POST', body: { email, name: 'Receiving Smoke Manager', company: 'FlowChain Test' } })
  assert.equal(result.user.id, actorId)
  assert.equal(result.user.tenantId, tenantId)
  return result.token
}

async function main() {
  const pgPort = await freePort()
  const apiPort = await freePort()
  const password = `local-${randomUUID()}`
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-receiving-api-'))
  const database = 'flowchain_receiving_api_smoke_test'
  const url = `postgresql://flowchain_smoke:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`
  const pg = new EmbeddedPostgres({ databaseDir: directory, user: 'flowchain_smoke', password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} })
  let api
  let prisma
  const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: 'true', FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false', FLOWCHAIN_LOCAL_SESSION_SECRET: `smoke-${randomUUID()}`, FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: 'local', FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, 'attachments'), FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: 'true', FLOWCHAIN_COMMIT_SHA: 'receiving-api-smoke', FLOWCHAIN_BRANCH: 'test/receiving-api-smoke', FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: 'false', SCM_API_PORT: String(apiPort), NODE_ENV: 'production' }
  const base = `http://127.0.0.1:${apiPort}`
  try {
    await pg.initialise(); await pg.start(); await pg.createDatabase(database)
    await execFileAsync(node, [prismaCli, 'migrate', 'deploy'], { cwd: root, env, maxBuffer: 10 * 1024 * 1024 })
    prisma = await createPrismaClient(env)
    await prisma.tenant.create({ data: { id: tenantId, name: 'Receiving API Smoke' } })
    await prisma.user.create({ data: { id: actorId, tenantId, email, name: 'Receiving Smoke Manager', role: 'manager' } })
    await prisma.warehouse.create({ data: { id: 'smoke-warehouse', tenantId, code: 'SMOKE-WH', name: 'Smoke Warehouse', status: 'active' } })
    await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: actorId, warehouseId: 'smoke-warehouse', accessLevel: 'operate' } })
    await prisma.item.create({ data: { id: 'smoke-item', tenantId, sku: 'SMOKE-SKU', name: 'Smoke Item', unit: 'EA' } })
    await prisma.purchaseOrder.create({ data: { id: 'smoke-po', tenantId, status: 'issued', supplierName: 'Smoke Supplier', currency: 'CNY', lines: { create: [{ id: 'smoke-po-line', itemId: 'smoke-item', sku: 'SMOKE-SKU', itemName: 'Smoke Item', orderedQuantity: '10', receivedQuantity: '0', unit: 'EA' }] } } })
    await prisma.receivingDocument.create({ data: { id: 'smoke-grn', tenantId, documentNumber: 'GRN-SMOKE-001', poId: 'smoke-po', supplierName: 'Smoke Supplier', status: 'receiving', workflowStatus: 'approved', postingStatus: 'unposted', warehouseId: 'smoke-warehouse', receiver: 'Receiving Smoke Manager', currency: 'CNY', lines: { create: [{ id: 'smoke-grn-line', purchaseOrderLineId: 'smoke-po-line', itemId: 'smoke-item', sku: 'SMOKE-SKU', itemName: 'Smoke Item', acceptedQty: '4', rejectedQty: '0', unit: 'EA', warehouseId: 'smoke-warehouse', location: 'A-01', locationKey: 'a-01' }] } } })

    api = startApi(env); await waitFor(`${base}/api/health`)
    const unprovisioned = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'unknown@example.com', name: 'Unknown', company: 'Forged', role: 'admin', tenantId: 'forged' }) })
    assert.equal(unprovisioned.status, 403); assert.equal((await unprovisioned.json()).code, 'USER_NOT_PROVISIONED')
    let token = await login(base)
    assert.equal((await request(base, '/api/me/profile', { token })).role, 'manager')
    const detail = await request(base, '/api/procurement/receiving/smoke-grn', { token })
    assert.equal(detail.receivingDocument.postingStatus, 'unposted')
    assert.equal(detail.purchaseOrder.fulfillmentStatus, 'not_received')
    const preview = await request(base, '/api/procurement/receiving/smoke-grn/impact-preview?operation=post', { token })
    assert.equal(preview.allowed, true); assert.equal(preview.inventoryImpacts[0].onHandAfter, '4.0000')
    const postKey = `smoke-post-${randomUUID()}`
    const posted = await request(base, '/api/procurement/receiving/smoke-grn/post', { token, method: 'POST', body: { idempotencyKey: postKey, expectedVersion: detail.receivingDocument.version } })
    assert.equal(posted.receivingDocument.postingStatus, 'posted')
    const replay = await request(base, '/api/procurement/receiving/smoke-grn/post', { token, method: 'POST', body: { idempotencyKey: postKey, expectedVersion: detail.receivingDocument.version } })
    assert.equal(replay.idempotentReplay, true)
    assert.equal((await request(base, '/api/procurement/receiving/smoke-grn', { token })).purchaseOrder.fulfillmentStatus, 'partially_received')
    assert.equal((await request(base, '/api/procurement/receiving/smoke-grn/evidence', { token })).events.some((event) => event.event === 'receiving_posted'), true)
    assert.equal((await request(base, '/api/procurement/receiving/smoke-grn/links', { token })).links.find((link) => link.label === 'Movements').count, 1)
    assert.equal((await request(base, '/api/procurement/receiving/smoke-grn/reconciliation', { token })).status, 'matched')
    const reversePreview = await request(base, '/api/procurement/receiving/smoke-grn/impact-preview?operation=reverse', { token })
    assert.equal(reversePreview.allowed, true)
    await request(base, '/api/procurement/receiving/smoke-grn/reverse', { token, method: 'POST', body: { idempotencyKey: `smoke-reverse-${randomUUID()}`, reason: 'API smoke verification' } })
    const finalDetail = await request(base, '/api/procurement/receiving/smoke-grn', { token })
    assert.equal(finalDetail.receivingDocument.postingStatus, 'reversed'); assert.equal(finalDetail.purchaseOrder.fulfillmentStatus, 'not_received')
    assert.equal(await prisma.inventoryMovement.count({ where: { tenantId } }), 2)
    assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId } })).onHandQuantity.toString(), '0')
    assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: 'smoke-po-line' } })).receivedQuantity.toString(), '0')
    assert.equal(await prisma.auditLog.count({ where: { tenantId, entityType: 'ReceivingDocument' } }), 2)
    assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId, status: 'completed' } }), 2)
    const retiredImport = await fetch(`${base}/api/imports/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ importType: 'items', fileName: 'pilot-items.csv', rows: [{ sku: 'SMOKE-IMPORTED-SKU' }] }) })
    assert.equal(retiredImport.status, 501)
    assert.equal((await retiredImport.json()).code, 'FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED')
    assert.equal(await prisma.importBatch.count({ where: { tenantId } }), 0)
    assert.equal(await prisma.item.count({ where: { tenantId, sku: 'SMOKE-IMPORTED-SKU' } }), 0)
    const movementExport = await request(base, '/api/pilot/exports/inventory_movements', { token })
    assert.equal(movementExport.rowCount, 2); assert.equal(movementExport.tenantScoped, true)

    await stop(api); api = startApi(env); await waitFor(`${base}/api/health`); token = await login(base)
    const persisted = await request(base, '/api/procurement/receiving/smoke-grn', { token })
    assert.equal(persisted.receivingDocument.postingStatus, 'reversed')
    assert.equal((await request(base, '/api/procurement/receiving/smoke-grn/evidence', { token })).events.some((event) => event.event === 'receiving_reversed'), true)
    console.log('Receiving API smoke: PASS (real server, PostgreSQL, restart persistence)')
  } finally {
    await stop(api); await prisma?.$disconnect().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => { console.error(`Receiving API smoke: FAIL\n${String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')}`); process.exit(1) })
