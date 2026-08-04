import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import EmbeddedPostgres from 'embedded-postgres'
import { createPrismaClient } from '../server/persistence/prisma-client.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const node = process.execPath
const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
const tenantId = 'tenant-receiving-browser'
const email = 'kim@example.com'
const actorId = `USR-${createHash('sha256').update(email).digest('hex').slice(0, 16)}`
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 18787)

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer().on('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
})

const pgPort = await freePort()
const password = `local-${randomUUID()}`
const directory = await mkdtemp(join(tmpdir(), 'flowchain-receiving-browser-'))
const database = 'flowchain_receiving_browser_test'
const url = `postgresql://flowchain_browser:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`
const pg = new EmbeddedPostgres({ databaseDir: directory, user: 'flowchain_browser', password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} })
let prisma
let server

async function cleanup() {
  await new Promise((resolveClose) => server?.close(resolveClose) || resolveClose())
  await prisma?.$disconnect().catch(() => {})
  await pg.stop().catch(() => {})
  await rm(directory, { recursive: true, force: true }).catch(() => {})
}

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database)
  Object.assign(process.env, { DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: 'true', FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false', FLOWCHAIN_LOCAL_SESSION_SECRET: `browser-${randomUUID()}`, FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: 'local', FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, 'attachments'), FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: 'true', FLOWCHAIN_COMMIT_SHA: 'receiving-browser-smoke', FLOWCHAIN_BRANCH: 'test/receiving-browser-smoke', FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: 'false', SCM_API_PORT: String(apiPort), NODE_ENV: 'production' })
  await execFileAsync(node, [prismaCli, 'migrate', 'deploy'], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 })
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.create({ data: { id: tenantId, name: 'Receiving Browser Tenant' } })
  await prisma.user.create({ data: { id: actorId, tenantId, email, name: 'Kim', role: 'manager', jobTitle: '供应链经理' } })
  await prisma.warehouse.create({ data: { id: 'browser-warehouse', tenantId, code: 'BROWSER-WH', name: 'Browser Warehouse', status: 'active' } })
  await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: actorId, warehouseId: 'browser-warehouse', accessLevel: 'operate' } })
  await prisma.item.create({ data: { id: 'browser-item', tenantId, sku: 'BROWSER-SKU', name: 'Browser Item', unit: 'EA' } })
  await prisma.purchaseOrder.create({ data: { id: 'browser-po', tenantId, status: 'issued', supplierName: 'Browser Supplier', currency: 'CNY', lines: { create: [{ id: 'browser-po-line', itemId: 'browser-item', sku: 'BROWSER-SKU', itemName: 'Browser Item', orderedQuantity: '10', receivedQuantity: '0', unit: 'EA' }] } } })
  await prisma.receivingDocument.create({ data: { id: 'browser-grn', tenantId, documentNumber: 'GRN-BROWSER-001', poId: 'browser-po', supplierName: 'Browser Supplier', status: 'receiving', workflowStatus: 'approved', postingStatus: 'unposted', warehouseId: 'browser-warehouse', receiver: 'Receiving Browser Manager', arrivedAt: new Date(), currency: 'CNY', lines: { create: [{ id: 'browser-grn-line', purchaseOrderLineId: 'browser-po-line', itemId: 'browser-item', sku: 'BROWSER-SKU', itemName: 'Browser Item', acceptedQty: '4', rejectedQty: '0', unit: 'EA', warehouseId: 'browser-warehouse', location: 'A-01', locationKey: 'a-01' }] } } })
  const { createScmServer } = await import('../server/scm-api.mjs')
  server = createScmServer()
  server.listen(apiPort, '127.0.0.1', () => console.log(`Receiving browser API ready on ${apiPort}`))
} catch (error) {
  console.error(String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]'))
  await cleanup(); process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await cleanup(); process.exit(0) })
