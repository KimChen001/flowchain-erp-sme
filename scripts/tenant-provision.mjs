// Provision one production tenant: the workspace, its first administrator,
// one warehouse, the standard payment terms and the default roles and
// permissions. Run by the operator
// against the deployment's own DATABASE_URL, for example in a Render shell:
//
//   npm run tenant:provision -- --tenant-id=acme --company-name="Acme Inc." --admin-email=owner@acme.com --admin-name="Pat Lee"
//
// It is idempotent: a second run with the same flags changes nothing. Existing
// rows are never modified, except the tenant's own profile fields when
// --update-existing is passed, and then only the fields given as flags. It
// creates no LOCAL-DEMO records and no example users, and never prints
// connection strings or secrets.
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { backfillTenantAuthorization } from '../server/auth/authorization-backfill.mjs'
import { ensureStandardPaymentTerms } from '../server/domain/standard-payment-terms.mjs'
import { disconnectPrismaClient, getPrismaClient } from '../server/persistence/prisma-client.mjs'

// New workspaces default to the US trial profile; each value can be overridden.
export const US_TENANT_DEFAULTS = Object.freeze({
  country: 'US',
  locale: 'en-US',
  currency: 'USD',
  timezone: 'America/New_York',
  language: 'en-US',
})

const REQUIRED_FLAGS = ['tenant-id', 'company-name', 'admin-email']
const OPTIONAL_FLAGS = ['admin-name', 'warehouse-code', 'warehouse-name', 'country', 'locale', 'currency', 'timezone', 'language']
const BOOLEAN_FLAGS = ['update-existing']
const TENANT_FIELDS = [
  ['company-name', 'name'],
  ['country', 'countryCode'],
  ['locale', 'locale'],
  ['currency', 'currency'],
  ['timezone', 'timezone'],
  ['language', 'defaultLanguage'],
]

export class TenantProvisionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TenantProvisionError'
    this.code = 'TENANT_PROVISION_INVALID'
  }
}

export function parseProvisionArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const match = String(argv[index]).match(/^--([a-z-]+)(?:=(.*))?$/s)
    if (!match) throw new TenantProvisionError(`Unexpected argument: ${argv[index]}`)
    const [, name, inline] = match
    if (BOOLEAN_FLAGS.includes(name)) {
      if (inline !== undefined) throw new TenantProvisionError(`--${name} takes no value.`)
      values.set(name, true)
      continue
    }
    if (![...REQUIRED_FLAGS, ...OPTIONAL_FLAGS].includes(name)) throw new TenantProvisionError(`Unknown flag: --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined || String(value).startsWith('--')) throw new TenantProvisionError(`--${name} needs a value.`)
    values.set(name, String(value).trim())
  }

  const missing = REQUIRED_FLAGS.filter(name => !values.get(name))
  if (missing.length) throw new TenantProvisionError(`Refusing to run without ${missing.map(name => `--${name}`).join(', ')}.`)

  const tenantId = values.get('tenant-id')
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(tenantId)) throw new TenantProvisionError('--tenant-id must be 3-64 lowercase letters, digits or hyphens.')
  const adminEmail = values.get('admin-email').toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new TenantProvisionError('--admin-email is not a valid email address.')

  const pick = name => values.get(name) || US_TENANT_DEFAULTS[name]
  const profile = {
    name: values.get('company-name'),
    countryCode: pick('country').toUpperCase(),
    locale: pick('locale'),
    currency: pick('currency').toUpperCase(),
    timezone: pick('timezone'),
    defaultLanguage: pick('language'),
  }
  if (!/^[A-Z]{2}$/.test(profile.countryCode)) throw new TenantProvisionError('--country must be a two-letter ISO country code.')
  if (!/^[A-Z]{3}$/.test(profile.currency)) throw new TenantProvisionError('--currency must be a three-letter ISO currency code.')
  for (const [flag, value] of [['locale', profile.locale], ['language', profile.defaultLanguage]]) {
    try { Intl.getCanonicalLocales(value) } catch { throw new TenantProvisionError(`--${flag} is not a valid locale.`) }
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: profile.timezone }) } catch { throw new TenantProvisionError('--timezone is not a valid IANA time zone.') }

  const warehouseCode = (values.get('warehouse-code') || 'MAIN').toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(warehouseCode)) throw new TenantProvisionError('--warehouse-code must be up to 32 letters, digits, hyphens or underscores.')

  return {
    tenantId,
    profile,
    // Only these tenant fields may be changed on an existing tenant.
    explicitTenantFields: TENANT_FIELDS.filter(([flag]) => values.has(flag)).map(([, field]) => field),
    updateExisting: values.get('update-existing') === true,
    adminEmail,
    adminName: values.get('admin-name') || 'Workspace Administrator',
    warehouseCode,
    warehouseName: values.get('warehouse-name') || 'Main Warehouse',
  }
}

export async function provisionTenant(prisma, options) {
  const { tenantId, profile, explicitTenantFields, updateExisting, adminEmail, adminName, warehouseCode, warehouseName } = options
  const report = await prisma.$transaction(async tx => {
    const result = { tenant: null, warehouse: null, admin: null, notes: [], changed: false }
    let tenant = await tx.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) {
      tenant = await tx.tenant.create({ data: { id: tenantId, ...profile } })
      result.tenant = 'created'
    } else {
      const differing = explicitTenantFields.filter(field => tenant[field] !== profile[field])
      if (differing.length && updateExisting) {
        tenant = await tx.tenant.update({
          where: { id: tenantId },
          data: { ...Object.fromEntries(differing.map(field => [field, profile[field]])), version: { increment: 1 } },
        })
        result.tenant = `updated ${differing.join(', ')}`
      } else {
        result.tenant = 'already exists, unchanged'
        if (differing.length) result.notes.push(`Kept the stored tenant ${differing.join(', ')}; pass --update-existing to change them.`)
      }
    }

    let warehouse = await tx.warehouse.findUnique({ where: { tenantId_code: { tenantId, code: warehouseCode } } })
    if (!warehouse) {
      warehouse = await tx.warehouse.create({ data: { id: `WH-${randomUUID()}`, tenantId, code: warehouseCode, name: warehouseName, status: 'active' } })
      result.warehouse = 'created'
    } else {
      result.warehouse = 'already exists, unchanged'
    }

    let admin = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email: adminEmail } } })
    if (!admin) {
      admin = await tx.user.create({ data: { id: `USR-${randomUUID()}`, tenantId, email: adminEmail, name: adminName, role: 'admin', status: 'active', defaultWarehouseId: warehouse.id } })
      result.admin = 'created'
      await tx.userWarehouseScope.create({ data: { id: randomUUID(), tenantId, userId: admin.id, warehouseId: warehouse.id, accessLevel: 'operate' } })
    } else {
      result.admin = 'already exists, unchanged'
      if (admin.role !== 'admin' || admin.status !== 'active') {
        result.notes.push(`The existing user ${adminEmail} is ${admin.role} / ${admin.status}; this script does not change it; change it from the Settings page if needed.`)
      }
    }

    // Only a workspace with no payment terms gets the standard ones.
    result.paymentTermsCreated = await ensureStandardPaymentTerms(tx, tenantId)

    result.changed = [result.tenant, result.warehouse, result.admin].some(state => state !== 'already exists, unchanged') || result.paymentTermsCreated > 0
    if (result.changed) {
      await tx.auditLog.create({ data: {
        id: randomUUID(), tenantId, actorId: admin.id, source: 'tenant_provision', module: 'settings',
        action: 'tenant_provisioned', entityType: 'Tenant', entityId: tenantId,
        summary: `Tenant provisioning: tenant ${result.tenant}; warehouse ${warehouseCode} ${result.warehouse}; administrator ${result.admin}; payment terms created ${result.paymentTermsCreated}.`,
        metadata: { tenant: result.tenant, warehouseId: warehouse.id, warehouse: result.warehouse, adminUserId: admin.id, admin: result.admin, paymentTermsCreated: result.paymentTermsCreated, timestamp: new Date().toISOString() },
      } })
    }
    return { ...result, tenantRecord: tenant, warehouseId: warehouse.id, adminId: admin.id }
  })

  // Same role and permission provisioning as pilot:setup and the lazy
  // authorization path; it only creates missing templates and assignments.
  const authorization = await backfillTenantAuthorization(prisma, tenantId, { actorId: report.adminId })
  const changed = report.changed || Boolean(authorization.createdRoles || authorization.createdGrants || authorization.createdAssignments)
  return { ...report, authorization, changed }
}

export function formatProvisionReport(options, report, env = process.env) {
  const tenant = report.tenantRecord
  const lines = [
    'FlowChain tenant provisioning',
    `tenant ${tenant.id} (${tenant.name}): ${report.tenant}`,
    `  country ${tenant.countryCode}, locale ${tenant.locale}, currency ${tenant.currency}, time zone ${tenant.timezone}, language ${tenant.defaultLanguage}`,
    `warehouse ${options.warehouseCode} (${report.warehouseId}): ${report.warehouse}`,
    `administrator ${options.adminEmail} (${report.adminId}): ${report.admin}`,
    `payment terms created: ${report.paymentTermsCreated}`,
    `roles created: ${report.authorization.createdRoles}, permission grants created: ${report.authorization.createdGrants}, role assignments created: ${report.authorization.createdAssignments}`,
    ...report.notes.map(note => `note: ${note}`),
  ]
  const configuredTenant = String(env.FLOWCHAIN_DEFAULT_TENANT_ID || '').trim()
  if (configuredTenant && configuredTenant !== tenant.id) {
    lines.push(`note: FLOWCHAIN_DEFAULT_TENANT_ID is ${configuredTenant}, so the app will not serve ${tenant.id} until that variable matches.`)
  } else if (!configuredTenant) {
    lines.push(`note: set FLOWCHAIN_DEFAULT_TENANT_ID=${tenant.id} on the service so the app serves this tenant.`)
  }
  lines.push(report.changed ? 'result: changes applied' : 'result: nothing to do, everything already provisioned')
  return lines.join('\n')
}

// Driver and connection errors can quote the connection string.
const redact = message => String(message || '').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted connection string]')

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options
  try {
    options = parseProvisionArgs(argv)
  } catch (error) {
    console.error(`tenant:provision: ${error.message}`)
    console.error('Usage: npm run tenant:provision -- --tenant-id=<id> --company-name="<name>" --admin-email=<email> [--admin-name="<name>"] [--warehouse-code=MAIN] [--warehouse-name="Main Warehouse"] [--country=US] [--locale=en-US] [--currency=USD] [--timezone=America/New_York] [--language=en-US] [--update-existing]')
    return 2
  }
  if (!String(env.DATABASE_URL || '').trim()) {
    console.error('tenant:provision: DATABASE_URL is not set. Run this where the service environment is available, such as the Render shell.')
    return 2
  }
  try {
    const prisma = await getPrismaClient(env)
    const report = await provisionTenant(prisma, options)
    console.log(formatProvisionReport(options, report, env))
    return 0
  } catch (error) {
    console.error(`tenant:provision failed: ${redact(error?.message)}`)
    return 1
  } finally {
    await disconnectPrismaClient().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
