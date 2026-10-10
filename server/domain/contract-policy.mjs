import { can } from '../auth/authorization-service.mjs'
import { capabilityForEnvironment } from './capability-registry.mjs'
import { receivingDecimalString, receivingDecimalUnits } from './receiving-transaction-policy.mjs'
import {
  CONTRACT_DEFAULT_REMINDER_DAYS,
  CONTRACT_MAX_NOTICE_DAYS,
  CONTRACT_MAX_REMINDER_DAYS,
  CONTRACT_RENEWALS,
  CONTRACT_TYPES,
  contractCalendarDay,
  contractShownState,
} from '../../shared/contract-status.mjs'

// Contract records (docs/contracts-module-design.md, K1): the rules the
// commands and reads share. Codes, not words, go to the client; the pages
// write the words.

export const CONTRACT_PERMISSIONS = Object.freeze({
  read: 'contracts.contract.read',
  manage: 'contracts.contract.manage',
  // The total value (and, in K2, price lines) follows the price permission,
  // as prices on purchase orders and reference prices do.
  prices: 'procurement.prices.read',
})
export const CONTRACT_CAPABILITY = 'contracts'
// Signed files: PDFs and images, 20 MB each (D5).
export const CONTRACT_FILE_MIME_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
export const CONTRACT_FILE_MAX_BYTES = 20 * 1024 * 1024

const LIMITS = Object.freeze({ title: 200, externalReference: 100, notes: 4000, paymentTermsId: 64, terminationReason: 1000 })
const MAX_TOTAL_VALUE_UNITS = 10n ** 14n * 10_000n
const currencies = new Set(Intl.supportedValuesOf?.('currency') || ['USD', 'EUR', 'CNY'])
const text = (value) => String(value ?? '').trim()

export class ContractError extends Error {
  constructor(code, message, status = 400, details = [], extra = {}) {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.status = status
    this.details = details
    Object.assign(this, extra)
  }
}

export const contractFail = (code, message, status = 400, details = [], extra = {}) => { throw new ContractError(code, message, status, details, extra) }

export function contractsEnabled(env = process.env) {
  return Boolean(capabilityForEnvironment(CONTRACT_CAPABILITY, env)?.enabled)
}

export function assertContractsEnabled(env = process.env) {
  if (!contractsEnabled(env)) contractFail('CONTRACTS_CAPABILITY_NOT_AVAILABLE', 'Contracts require database persistence and explicit enablement.', 409, [], { capability: CONTRACT_CAPABILITY })
}

// What this reader may do with contracts and see on them.
export function contractAccessFor(actor) {
  const allowed = (permission) => Boolean(actor?.tenantId) && can({ actor, permission, tenantId: actor.tenantId })
  return {
    read: allowed(CONTRACT_PERMISSIONS.read),
    manage: allowed(CONTRACT_PERMISSIONS.manage),
    prices: allowed(CONTRACT_PERMISSIONS.prices),
    userId: text(actor?.user?.id || actor?.userId) || null,
  }
}

// The fields a person enters, checked without the database. Only the fields
// present in the input are returned; on create the required ones must be
// there. An empty optional field clears it (null). Days are YYYY-MM-DD.
export const CONTRACT_INPUT_FIELDS = Object.freeze([
  'title', 'externalReference', 'type', 'supplierId', 'ownerId', 'startDate', 'endDate', 'signedOn',
  'renewal', 'noticeDays', 'reminderDays', 'paymentTermsId', 'currency', 'totalValue', 'notes',
])
const DAY_FIELDS = new Set(['startDate', 'endDate', 'signedOn'])

export function contractFieldIssues(input = {}, { creating = false } = {}) {
  const values = {}
  const issues = []
  const issue = (field, code, message) => issues.push({ field, code, message })
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined
  const optionalText = (field) => {
    if (!has(field)) return
    const value = text(input[field])
    if (value.length > LIMITS[field]) issue(field, 'TOO_LONG', `Use at most ${LIMITS[field]} characters.`)
    values[field] = value || null
  }

  if (has('title') || creating) {
    const title = text(input.title)
    if (!title) issue('title', 'REQUIRED', 'Enter a title.')
    else if (title.length > LIMITS.title) issue('title', 'TOO_LONG', `Use at most ${LIMITS.title} characters.`)
    values.title = title
  }
  optionalText('externalReference')
  if (has('type') || creating) {
    const type = text(input.type)
    if (!CONTRACT_TYPES.includes(type)) issue('type', type ? 'INVALID' : 'REQUIRED', 'Choose a contract type.')
    values.type = type
  }
  if (has('supplierId') || creating) {
    const supplierId = text(input.supplierId)
    if (!supplierId) issue('supplierId', 'REQUIRED', 'Choose a supplier.')
    values.supplierId = supplierId
  }
  if (has('ownerId')) values.ownerId = text(input.ownerId) || null
  for (const field of DAY_FIELDS) {
    if (!has(field)) continue
    const raw = input[field] === null ? '' : text(input[field])
    if (!raw) { values[field] = null; continue }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? contractCalendarDay(raw) : ''
    if (!day) issue(field, 'DATE_INVALID', 'Enter a date as YYYY-MM-DD.')
    values[field] = day || null
  }
  if (has('renewal') || creating) {
    const renewal = has('renewal') ? text(input.renewal) : 'none'
    if (!CONTRACT_RENEWALS.includes(renewal)) issue('renewal', 'INVALID', 'Choose how the contract renews.')
    values.renewal = renewal
  }
  const days = (field, max, fallback) => {
    if (!has(field) && !creating) return
    const raw = has(field) && input[field] !== null && text(input[field]) !== '' ? input[field] : fallback
    const number = Number(raw)
    if (!Number.isInteger(number) || number < 0 || number > max) issue(field, 'WHOLE_NUMBER_REQUIRED', `Enter a whole number of days from 0 to ${max}.`)
    values[field] = Number.isInteger(number) ? number : null
  }
  days('noticeDays', CONTRACT_MAX_NOTICE_DAYS, 0)
  days('reminderDays', CONTRACT_MAX_REMINDER_DAYS, CONTRACT_DEFAULT_REMINDER_DAYS)
  if (has('paymentTermsId')) {
    const value = text(input.paymentTermsId)
    if (value.length > LIMITS.paymentTermsId) issue('paymentTermsId', 'TOO_LONG', `Use at most ${LIMITS.paymentTermsId} characters.`)
    values.paymentTermsId = value || null
  }
  if (has('currency')) {
    const currency = text(input.currency).toUpperCase()
    if (currency && (!/^[A-Z]{3}$/.test(currency) || !currencies.has(currency))) issue('currency', 'CURRENCY_INVALID', 'Choose a valid currency.')
    values.currency = currency || null
  }
  if (has('totalValue')) {
    const raw = input.totalValue === null ? '' : text(input.totalValue)
    if (!raw) values.totalValue = null
    else {
      let units = null
      try { units = /^\d+(?:\.\d+)?$/.test(raw) ? receivingDecimalUnits(raw) : null } catch { units = null }
      if (units === null || units < 0n || units >= MAX_TOTAL_VALUE_UNITS) issue('totalValue', 'AMOUNT_INVALID', 'Enter an amount of 0 or more with at most four decimal places.')
      values.totalValue = units === null ? null : receivingDecimalString(units)
    }
  }
  optionalText('notes')
  return { values, issues }
}

// Checks across fields once input and the stored contract are merged.
export function contractMergedIssues(merged) {
  const issues = []
  if (merged.startDate && merged.endDate && merged.endDate < merged.startDate) issues.push({ field: 'endDate', code: 'END_BEFORE_START', message: 'The end date must be on or after the start date.' })
  if (merged.status === 'active') {
    for (const field of ['signedOn', 'startDate']) if (!merged[field]) issues.push({ field, code: 'REQUIRED', message: 'An active contract needs its signed date and start date.' })
  }
  return issues
}

export const assertNoIssues = (issues) => {
  if (issues.length) contractFail('VALIDATION_ERROR', 'Check the highlighted fields.', 422, issues)
}

// A stored row's fields in their entered form, for audit before/after and
// comparisons: days as YYYY-MM-DD, the value as a four-place decimal string.
export function contractSnapshot(row = {}) {
  const day = (value) => contractCalendarDay(value) || null
  const decimal = (value) => (value === null || value === undefined ? null : receivingDecimalString(receivingDecimalUnits(String(value))))
  return {
    title: row.title ?? null,
    externalReference: row.externalReference ?? null,
    type: row.type ?? null,
    supplierId: row.supplierId ?? null,
    ownerId: row.ownerId ?? null,
    startDate: day(row.startDate),
    endDate: day(row.endDate),
    signedOn: day(row.signedOn),
    renewal: row.renewal ?? null,
    noticeDays: row.noticeDays ?? null,
    reminderDays: row.reminderDays ?? null,
    paymentTermsId: row.paymentTermsId ?? null,
    currency: row.currency ?? null,
    totalValue: decimal(row.totalValue),
    notes: row.notes ?? null,
  }
}

export const storedDay = (day) => (day ? new Date(`${day}T00:00:00.000Z`) : null)

const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null)

// A contract as the API returns it, with its shown state on the workspace
// day. The row includes supplier, owner, renews and renewals.
export function contractView(row, { today }) {
  const snapshot = contractSnapshot(row)
  const renewals = (row.renewals || []).map((renewal) => ({ id: renewal.id, number: renewal.number, status: renewal.status, activatedAt: iso(renewal.activatedAt) }))
  const renewalActivated = renewals.some((renewal) => renewal.activatedAt)
  const shown = contractShownState({ status: row.status, renewal: row.renewal, endDate: snapshot.endDate, noticeDays: row.noticeDays, reminderDays: row.reminderDays, terminatedOn: row.terminatedOn }, { today, renewalActivated })
  return {
    id: row.id,
    number: row.number,
    ...snapshot,
    counterpartyType: row.counterpartyType,
    supplier: row.supplier ? { id: row.supplier.id, code: row.supplier.code ?? null, name: row.supplier.name } : null,
    owner: row.owner ? { id: row.owner.id, name: row.owner.name } : null,
    status: row.status,
    ...shown,
    renewsContract: row.renews ? { id: row.renews.id, number: row.renews.number } : null,
    renewals,
    terminatedOn: contractCalendarDay(row.terminatedOn) || null,
    terminationReason: row.terminationReason ?? null,
    version: row.version,
    createdById: row.createdById ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    activatedAt: iso(row.activatedAt),
    activatedById: row.activatedById ?? null,
    terminatedAt: iso(row.terminatedAt),
    restrictedFields: [],
  }
}

// Without procurement.prices.read the total value is null, never 0, and is
// named in restrictedFields, as a reference price is (maskReferencePrice).
export function maskContract(view, access) {
  if (!view || access?.prices) return view
  return { ...view, totalValue: null, restrictedFields: [...new Set([...(view.restrictedFields || []), 'totalValue'])] }
}

// An audit row's details as a reader may see them: no command bookkeeping,
// and no total value without the price permission.
export function contractHistoryDetails(metadata, access) {
  const { commandType: _commandType, idempotencyKey: _idempotencyKey, ...details } = metadata && typeof metadata === 'object' ? metadata : {}
  if (access?.prices) return details
  const hideValue = (snapshot) => (snapshot && typeof snapshot === 'object' && 'totalValue' in snapshot ? { ...snapshot, totalValue: null } : snapshot)
  const output = { ...details }
  if (output.changes?.totalValue) output.changes = { ...output.changes, totalValue: { before: null, after: null, restricted: true } }
  for (const key of ['before', 'after']) if (output[key]) output[key] = hideValue(output[key])
  return output
}
