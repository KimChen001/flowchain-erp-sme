import { can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

// Master data is readable by every signed-in role, because every form picks
// items and suppliers. Two parts of it are not:
//
//   a supplier's registration ID, tax ID, account holder and bank account
//   number need finance.partner_snapshot.read; without it they come back as
//   "****" plus the last four characters, which the save path recognises and
//   keeps unchanged;
//   a reference price on an item-supplier relationship needs
//   procurement.prices.read; without it the price is null, never 0.
//
// A record with anything hidden lists it in `restrictedFields`.

export const SUPPLIER_SENSITIVE_FIELDS = Object.freeze(['creditCode', 'taxIdentificationNumber', 'bankAccountName', 'bankAccountNumber'])

export function maskSensitiveValue(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.length > 4 ? `****${raw.slice(-4)}` : '****'
}

export const isMaskedValue = (value) => String(value ?? '').startsWith('****')

export function masterDataReadAccessFor(actor) {
  const allowed = (permission) => Boolean(actor?.tenantId) && can({ actor, permission, tenantId: actor.tenantId })
  return { partner: allowed('finance.partner_snapshot.read'), prices: allowed('procurement.prices.read') }
}

// The session identity when it already carries a resolved authorization
// context, else the actor the caller already resolved (a write resolves one to
// authorize itself), else the provisioned workspace user.
export async function masterDataReadAccess(ctx, resolvedActor = null) {
  if (ctx.masterDataReadAccess) return ctx.masterDataReadAccess
  const identity = ctx.identity
  const actor = identity?.authenticated && identity.complete && identity.permissionCodes
    ? identity
    : resolvedActor || await resolveProvisionedActor(await getPrismaClient(ctx.env || process.env), identity)
  return masterDataReadAccessFor(actor)
}

export function maskSupplier(supplier, access) {
  if (!supplier || access?.partner) return supplier
  const output = { ...supplier }
  const hidden = []
  for (const key of SUPPLIER_SENSITIVE_FIELDS) if (key in output) { output[key] = maskSensitiveValue(output[key]); hidden.push(key) }
  return { ...output, restrictedFields: [...new Set([...(supplier.restrictedFields || []), ...hidden])] }
}

export function maskReferencePrice(record, access) {
  if (!record || access?.prices || !('referencePrice' in record)) return record
  return { ...record, referencePrice: null, restrictedFields: [...new Set([...(record.restrictedFields || []), 'referencePrice'])] }
}
