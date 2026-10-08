import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { defaultRoleTemplates } from '../../server/auth/permission-catalog.mjs'
import { STANDARD_PAYMENT_TERMS } from '../../server/domain/standard-payment-terms.mjs'

const execFileAsync = promisify(execFile)
const script = resolve(import.meta.dirname, '../../scripts/tenant-provision.mjs')
const databasePassword = decodeURIComponent(new URL(process.env.DATABASE_URL_TEST || 'postgresql://x:y@h/d').password)

// Run the real CLI the way an operator would on Render: production profile,
// the service's DATABASE_URL, no test switches.
async function provision(args, extraEnv = {}) {
  const env = { ...process.env, NODE_ENV: 'production', FLOWCHAIN_DEPLOYMENT_PROFILE: 'production', ...extraEnv }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { env })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }
  }
}

const assertNoSecrets = ({ stdout, stderr }) => {
  const output = `${stdout}\n${stderr}`
  assert.doesNotMatch(output, /postgres(ql)?:\/\//i)
  assert.ok(!output.includes(databasePassword), 'database password printed')
  for (const key of ['FLOWCHAIN_LOCAL_SESSION_SECRET', 'FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET']) {
    if (process.env[key]) assert.ok(!output.includes(process.env[key]), `${key} printed`)
  }
}

// Every row the script can create or touch, with its timestamps, so a rerun
// that rewrites anything shows up as a difference.
async function snapshot(prisma, tenantId) {
  const order = { orderBy: { id: 'asc' } }
  const [tenant, users, warehouses, scopes, roles, grants, assignments, audits, paymentTerms] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId } }),
    prisma.user.findMany({ where: { tenantId }, ...order }),
    prisma.warehouse.findMany({ where: { tenantId }, ...order }),
    prisma.userWarehouseScope.findMany({ where: { tenantId }, ...order }),
    prisma.tenantRole.findMany({ where: { tenantId }, ...order }),
    prisma.tenantRolePermission.findMany({ where: { tenantId }, ...order }),
    prisma.userRoleAssignment.findMany({ where: { tenantId }, ...order }),
    prisma.auditLog.findMany({ where: { tenantId }, ...order }),
    prisma.paymentTerm.findMany({ where: { tenantId }, ...order }),
  ])
  return JSON.parse(JSON.stringify({ tenant, users, warehouses, scopes, roles, grants, assignments, audits, paymentTerms }))
}

test('tenant:provision refuses to run without the tenant, company and administrator', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  try {
    for (const args of [
      [],
      ['--tenant-id=refused-tenant', '--company-name=Refused Inc.'],
      ['--tenant-id=refused-tenant', '--admin-email=owner@refused.example'],
      ['--company-name=Refused Inc.', '--admin-email=owner@refused.example'],
      ['--tenant-id=refused-tenant', '--company-name=Refused Inc.', '--admin-email=owner@refused.example', '--admin-emial=typo@refused.example'],
      ['--tenant-id=Refused Tenant', '--company-name=Refused Inc.', '--admin-email=owner@refused.example'],
      ['--tenant-id=refused-tenant', '--company-name=Refused Inc.', '--admin-email=owner@refused.example', '--timezone=Mars/Olympus'],
    ]) {
      const result = await provision(args)
      assert.equal(result.code, 2, JSON.stringify(args))
      assert.match(result.stderr, /tenant:provision: /)
      assertNoSecrets(result)
    }
    const missing = await provision(['--tenant-id=refused-tenant'])
    assert.match(missing.stderr, /Refusing to run without --company-name, --admin-email\./)
    assert.equal(await prisma.tenant.count({ where: { id: 'refused-tenant' } }), 0)
  } finally {
    await prisma.$disconnect()
  }
})

test('tenant:provision creates a US tenant, one administrator and one warehouse, then a rerun is a no-op', async () => {
  const tenantId = 'provision-us-trial'
  const args = [`--tenant-id=${tenantId}`, '--company-name=Harbor Supply Co.', '--admin-email=Owner@HarborSupply.example', '--admin-name=Pat Lee']
  const prisma = await createPrismaClient(process.env)
  try {
    const first = await provision(args, { FLOWCHAIN_DEFAULT_TENANT_ID: tenantId })
    assert.equal(first.code, 0, first.stderr)
    assertNoSecrets(first)
    assert.match(first.stdout, /tenant provision-us-trial \(Harbor Supply Co\.\): created/)
    assert.match(first.stdout, /administrator owner@harborsupply\.example \(USR-[0-9a-f-]+\): created/)
    assert.match(first.stdout, /result: changes applied/)

    const created = await snapshot(prisma, tenantId)
    assert.deepEqual(
      [created.tenant.name, created.tenant.countryCode, created.tenant.locale, created.tenant.currency, created.tenant.timezone, created.tenant.defaultLanguage],
      ['Harbor Supply Co.', 'US', 'en-US', 'USD', 'America/New_York', 'en-US'],
    )
    // Only the administrator: no example users such as kim@example.com.
    assert.deepEqual(created.users.map(user => [user.email, user.name, user.role, user.status]), [['owner@harborsupply.example', 'Pat Lee', 'admin', 'active']])
    assert.deepEqual(created.warehouses.map(warehouse => [warehouse.code, warehouse.name]), [['MAIN', 'Main Warehouse']])
    assert.equal(created.users[0].defaultWarehouseId, created.warehouses[0].id)
    assert.deepEqual(created.scopes.map(scope => [scope.userId, scope.warehouseId, scope.accessLevel]), [[created.users[0].id, created.warehouses[0].id, 'operate']])
    assert.deepEqual(created.roles.map(role => role.roleKey).sort(), defaultRoleTemplates.map(role => role.roleKey).sort())
    const adminRole = created.roles.find(role => role.roleKey === 'workspace-administrator')
    assert.deepEqual(created.assignments.map(row => [row.userId, row.roleId, row.status]), [[created.users[0].id, adminRole.id, 'active']])
    assert.equal(created.grants.length, defaultRoleTemplates.reduce((sum, role) => sum + role.permissions.length, 0))
    // The standard payment terms, so a supplier file that says NET30 imports.
    assert.match(first.stdout, /payment terms created: 5/)
    assert.deepEqual(
      created.paymentTerms.map(term => [term.code, term.name, term.days]).sort(),
      [['DUE', 'Due on receipt', 0], ['NET15', 'Net 15', 15], ['NET30', 'Net 30', 30], ['NET45', 'Net 45', 45], ['NET60', 'Net 60', 60]],
    )

    // No LOCAL-DEMO or other business data.
    for (const model of ['supplier', 'item', 'purchaseOrder', 'inventoryBalance']) {
      assert.equal(await prisma[model].count({ where: { tenantId } }), 0, model)
    }

    const second = await provision(args, { FLOWCHAIN_DEFAULT_TENANT_ID: tenantId })
    assert.equal(second.code, 0, second.stderr)
    assertNoSecrets(second)
    assert.match(second.stdout, /tenant provision-us-trial \(Harbor Supply Co\.\): already exists, unchanged/)
    assert.match(second.stdout, /roles created: 0, permission grants created: 0, role assignments created: 0/)
    assert.match(second.stdout, /payment terms created: 0/)
    assert.match(second.stdout, /result: nothing to do, everything already provisioned/)
    assert.deepEqual(await snapshot(prisma, tenantId), created)
  } finally {
    await prisma.$disconnect()
  }
})

test('tenant:provision leaves an existing tenant, its users and warehouses as they are', async () => {
  const tenantId = 'provision-existing'
  const prisma = await createPrismaClient(process.env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Existing Trading Ltd.', countryCode: 'CN', locale: 'zh-CN', currency: 'CNY', timezone: 'Asia/Shanghai', defaultLanguage: 'zh-CN', operationalSettings: { numbering: 'kept' } } })
    await prisma.warehouse.create({ data: { id: 'provision-existing-wh', tenantId, code: 'SH01', name: 'Shanghai DC', status: 'active' } })
    await prisma.user.create({ data: { id: 'provision-existing-manager', tenantId, email: 'lead@existing.example', name: 'Existing Lead', role: 'manager', status: 'active', defaultWarehouseId: 'provision-existing-wh' } })
    await prisma.paymentTerm.create({ data: { id: 'provision-existing-term', tenantId, code: 'MONTH-END', name: 'Month end + 30', days: 30 } })
    const before = await snapshot(prisma, tenantId)

    // The administrator email already belongs to a manager, and the flags ask
    // for a different name and currency without --update-existing.
    const args = [`--tenant-id=${tenantId}`, '--company-name=Renamed Inc.', '--currency=USD', '--admin-email=lead@existing.example', '--warehouse-code=SH01']
    const kept = await provision(args, { FLOWCHAIN_DEFAULT_TENANT_ID: 'another-tenant' })
    assert.equal(kept.code, 0, kept.stderr)
    assertNoSecrets(kept)
    assert.match(kept.stdout, /note: Kept the stored tenant name, currency; pass --update-existing to change them\./)
    assert.match(kept.stdout, /note: The existing user lead@existing\.example is manager \/ active; this script does not change it;/)
    assert.match(kept.stdout, /note: FLOWCHAIN_DEFAULT_TENANT_ID is another-tenant/)
    const after = await snapshot(prisma, tenantId)
    assert.deepEqual(after.tenant, before.tenant)
    // The backfill only records when the user's roles were first assigned.
    const withoutRoleMark = (users) => users.map(({ rolesAssignedAt, updatedAt, ...user }) => user)
    assert.deepEqual(withoutRoleMark(after.users), withoutRoleMark(before.users))
    assert.ok(after.users.every((user) => user.rolesAssignedAt))
    assert.deepEqual(after.warehouses, before.warehouses)
    assert.deepEqual(after.scopes, before.scopes)
    // A workspace that has payment terms keeps exactly those.
    assert.match(kept.stdout, /payment terms created: 0/)
    assert.deepEqual(after.paymentTerms, before.paymentTerms)
    // Only missing role templates and role assignments are added, exactly as
    // the app's lazy authorization backfill would on the first request.
    assert.equal(after.roles.length, defaultRoleTemplates.length)

    // --update-existing changes only the tenant fields given as flags.
    const updated = await provision([...args, '--update-existing'])
    assert.equal(updated.code, 0, updated.stderr)
    assert.match(updated.stdout, /: updated name, currency/)
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    assert.deepEqual(
      [tenant.name, tenant.currency, tenant.countryCode, tenant.locale, tenant.timezone, tenant.defaultLanguage, tenant.version],
      ['Renamed Inc.', 'USD', 'CN', 'zh-CN', 'Asia/Shanghai', 'zh-CN', before.tenant.version + 1],
    )
    assert.deepEqual(tenant.operationalSettings, { numbering: 'kept' })
    assert.deepEqual(withoutRoleMark(JSON.parse(JSON.stringify(await prisma.user.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })))), withoutRoleMark(before.users))
  } finally {
    await prisma.$disconnect()
  }
})

test('the standard payment terms migration fills only workspaces with no payment terms', async () => {
  const prisma = await createPrismaClient(process.env)
  const empty = 'terms-backfill-empty'
  const kept = 'terms-backfill-kept'
  try {
    await prisma.tenant.create({ data: { id: empty, name: 'Created before the standard terms' } })
    await prisma.tenant.create({ data: { id: kept, name: 'Has its own terms' } })
    await prisma.paymentTerm.create({ data: { id: 'terms-backfill-own', tenantId: kept, code: 'NET30', name: 'Thirty days', days: 30 } })
    const migration = readFileSync(new URL('../../prisma/migrations/20261007010000_standard_payment_terms/migration.sql', import.meta.url), 'utf8')
    const terms = async tenantId => (await prisma.paymentTerm.findMany({ where: { tenantId }, orderBy: { code: 'asc' } })).map(term => [term.code, term.name, term.days])
    for (let run = 0; run < 2; run += 1) {
      await prisma.$executeRawUnsafe(migration)
      // The same list as tenant:provision, and a second run adds nothing.
      assert.deepEqual(await terms(empty), STANDARD_PAYMENT_TERMS.map(term => [term.code, term.name, term.days]))
      assert.deepEqual(await terms(kept), [['NET30', 'Thirty days', 30]])
    }
  } finally {
    await prisma.paymentTerm.deleteMany({ where: { tenantId: { in: [empty, kept] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [empty, kept] } } })
    await prisma.$disconnect()
  }
})
