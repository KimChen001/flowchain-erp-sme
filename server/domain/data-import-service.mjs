import { createHash, randomUUID } from 'node:crypto'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import {
  DATA_IMPORT_NO,
  DATA_IMPORT_STATUS_VALUES,
  DATA_IMPORT_TYPES,
  DATA_IMPORT_YES,
  dataImportColumns,
  mapDataImportHeaders,
} from '../../shared/data-import-columns.mjs'
import { createInventoryOperationsCommandService } from './inventory-operations-command-service.mjs'
import { inventoryStockRecordHasHistory } from './inventory-operations-policy.mjs'
import {
  CUSTOMER_NAMESPACE,
  ITEM_SUPPLIER_NAMESPACE,
  customerInputIssues,
  itemInputIssues,
  itemSupplierInputIssues,
  saveCustomerMaster,
  saveItemMaster,
  saveItemSupplier,
} from './master-data-commands.mjs'
import { hasWarehouseAccess, resolveProvisionedActor } from './pilot-identity.mjs'
import { parseCsvArtifact, parseXlsxArtifact } from './structured-intake-parser.mjs'
import { saveSupplierMaster, supplierCurrencyIssue, supplierInputIssues } from './supplier-master-command.mjs'

// CSV and XLSX import of items, suppliers, customers, item suppliers and
// opening stock through the manual-entry commands.
//
//   preview  parses the file, matches the headers, loads the existing keys and
//            lookups of the whole file (one query each, in the session's
//            workspace) and checks every row. It writes nothing.
//   commit   takes the rows the person confirmed, in chunks of up to 200,
//            checks them again and runs the same command a person would:
//            saveItemMaster, saveSupplierMaster, saveCustomerMaster or
//            saveItemSupplier with no id, each in its own transaction with
//            its own audit row. Opening stock becomes one draft
//            opening_balance adjustment per warehouse per chunk; a person
//            readies and posts it in the Inventory adjustments workbench.
//
// Create only: a row whose key already exists is skipped, never updated.
// Uploading the same file again cannot duplicate anything: the commands
// refuse duplicate keys, and each chunk is a BusinessCommandExecution whose
// completed result is replayed while it still holds.

export const DATA_IMPORT_CHUNK_SIZE = 200
export const DATA_IMPORT_MAX_COLUMNS = 50
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_ROWS = 2000
// An XLSX file unpacks to at most this many times its size; a plain export
// of 2,000 rows stays well inside it.
const MAX_UNPACKED_RATIO = 8
// A chunk still pending after this long was left by a crash and may be run
// again; rows it already wrote are skipped as existing.
const STALE_EXECUTION_MS = 5 * 60 * 1000

export class DataImportError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'DataImportError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const fail = (code, message, status = 400, details) => { throw new DataImportError(code, message, status, details) }
const text = (value) => String(value ?? '').trim()
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const locationKey = (value) => text(value).toLowerCase()
const positiveInteger = (value, fallback) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

export const DATA_IMPORT_PERMISSIONS = Object.freeze({
  items: 'master_data.item.manage',
  'item-suppliers': 'master_data.item.manage',
  suppliers: 'master_data.supplier.manage',
  customers: 'master_data.customer.manage',
  'opening-stock': 'inventory.adjustment.create',
})

export function dataImportLimits(env = process.env) {
  return {
    maxFileBytes: positiveInteger(env.FLOWCHAIN_DATA_IMPORT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxRows: positiveInteger(env.FLOWCHAIN_DATA_IMPORT_MAX_ROWS, DEFAULT_MAX_ROWS),
    maxColumns: DATA_IMPORT_MAX_COLUMNS,
  }
}

export function assertDataImportType(type) {
  if (!DATA_IMPORT_TYPES.includes(type)) fail('DATA_IMPORT_TYPE_UNSUPPORTED', 'Choose items, suppliers, customers, item suppliers or opening stock.', 404)
  return type
}

const commandTypeFor = (type) => `data_import_${type.replace(/-/g, '_')}`

// ---------------------------------------------------------------- parsing

const PARSER_ERRORS = {
  INTAKE_ARTIFACT_SIZE_LIMIT: ['DATA_IMPORT_FILE_TOO_LARGE', 413],
  INTAKE_RECORD_COUNT_LIMIT: ['DATA_IMPORT_TOO_MANY_ROWS', 413],
  INTAKE_COLUMN_LIMIT: ['DATA_IMPORT_TOO_MANY_COLUMNS', 413],
  INTAKE_XLSX_ZIP_BOMB: ['DATA_IMPORT_FILE_UNSAFE', 413],
  INTAKE_XLSX_SHEET_LIMIT: ['DATA_IMPORT_FILE_UNSAFE', 413],
  INTAKE_XLSX_SHEET_REQUIRED: ['DATA_IMPORT_SHEET_REQUIRED', 422],
  INTAKE_XLSX_HIDDEN_SHEET: ['DATA_IMPORT_SHEET_REQUIRED', 422],
  INTAKE_CSV_ENCODING_REQUIRED: ['DATA_IMPORT_ENCODING_REQUIRED', 422],
  INTAKE_CSV_ENCODING_UNSUPPORTED: ['DATA_IMPORT_ENCODING_REQUIRED', 422],
  INTAKE_HEADER_DUPLICATE: ['DATA_IMPORT_HEADER_DUPLICATE', 422],
  INTAKE_HEADER_MISSING: ['DATA_IMPORT_HEADER_MISSING', 422],
}

const cellText = (value) => (value === null || value === undefined ? '' : typeof value === 'string' ? value.trim() : String(value).trim())

// Parses an uploaded CSV or XLSX file within the import's limits. Returns the
// header row, the data rows as { rowNumber, cells } and the file's SHA-256.
export async function parseDataImportFile({ fileName, contentBase64, sheetName, encoding } = {}, limits) {
  if (typeof contentBase64 !== 'string' || !contentBase64) fail('DATA_IMPORT_FILE_REQUIRED', 'Choose a CSV or XLSX file.', 422)
  // Base64 is a third larger than the file, so the length alone can refuse
  // an oversized file before decoding it.
  if (contentBase64.length > Math.ceil(limits.maxFileBytes / 3) * 4 + 4) fail('DATA_IMPORT_FILE_TOO_LARGE', 'The file is larger than the import limit.', 413, { limitBytes: limits.maxFileBytes })
  const bytes = Buffer.from(contentBase64, 'base64')
  if (!bytes.length) fail('DATA_IMPORT_FILE_REQUIRED', 'Choose a CSV or XLSX file.', 422)
  if (bytes.length > limits.maxFileBytes) fail('DATA_IMPORT_FILE_TOO_LARGE', 'The file is larger than the import limit.', 413, { limitBytes: limits.maxFileBytes })
  const name = text(fileName)
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (/\.xls$/i.test(name) || (!zip && /\.(xlsx|xlsm)$/i.test(name))) fail('DATA_IMPORT_FILE_TYPE', 'Save the workbook as .xlsx or .csv, then choose it again.', 415)
  if (zip && name && !/\.(xlsx|xlsm)$/i.test(name)) fail('DATA_IMPORT_FILE_TYPE', 'Save the workbook as .xlsx or .csv, then choose it again.', 415)
  let parsed
  try {
    // Only the chosen sheet is read; a column with no header and no values
    // is left out; the row limit applies while the file is read.
    const shared = { dropEmptyColumns: true, maximumRecordCount: limits.maxRows }
    parsed = zip
      ? await parseXlsxArtifact(bytes, { ...shared, sheetName: text(sheetName) || undefined, readSelectedSheetOnly: true, maximumUncompressedBytes: limits.maxFileBytes * MAX_UNPACKED_RATIO })
      : parseCsvArtifact(bytes, { ...shared, encoding: text(encoding) || undefined })
  } catch (error) {
    if (error?.name !== 'IntakeError') throw error
    const details = { ...(error.details && typeof error.details === 'object' ? error.details : {}), reason: error.code }
    // A column with values but no header is named by its position.
    if (error.code === 'INTAKE_HEADER_MISSING' && Number.isInteger(details.column)) fail('DATA_IMPORT_HEADER_BLANK', `Column ${details.column} has no header. Give it a header or delete the column.`, 422, details)
    if (error.code === 'INTAKE_RECORD_COUNT_LIMIT') fail('DATA_IMPORT_TOO_MANY_ROWS', 'The file has more rows than one import takes. Split it into smaller files.', 413, { ...details, limit: limits.maxRows })
    const [code, status] = PARSER_ERRORS[error.code] || ['DATA_IMPORT_FILE_UNREADABLE', 422]
    fail(code, error.message, status, details)
  }
  if (parsed.headers.length > limits.maxColumns) fail('DATA_IMPORT_TOO_MANY_COLUMNS', 'The file has more columns than the import reads.', 413, { limit: limits.maxColumns })
  if (parsed.records.length > limits.maxRows) fail('DATA_IMPORT_TOO_MANY_ROWS', 'The file has more rows than one import takes. Split it into smaller files.', 413, { limit: limits.maxRows })
  if (!parsed.records.length) fail('DATA_IMPORT_NO_ROWS', 'The file has a header row but no data rows.', 422)
  return {
    fileSha256: sha256(bytes),
    sourceFormat: parsed.sourceFormat,
    sheetName: parsed.selectedSheet,
    sheetList: parsed.sheetList,
    headers: parsed.headers,
    rows: parsed.records.map((record) => ({ rowNumber: record.rowNumber, cells: parsed.headers.map((header) => cellText(record.source[header])) })),
  }
}

// ---------------------------------------------------------------- cell checks

const NUMBER = /^-?\d+(\.\d+)?$/

const issue = (field, code, message, params) => ({ field, code, message, ...(params ? { params } : {}) })

// A number cell must be digits with an optional decimal point, read the same
// in every interface language: no thousands separators, currency signs or
// exponents. Range checks stay with the command's own checks.
function numberCell(values, key, issues) {
  const raw = text(values[key])
  if (!raw) return undefined
  if (!NUMBER.test(raw)) {
    issues.push(issue(key, 'NUMBER_FORMAT', 'Write the number with digits and a decimal point only, without thousands separators or currency signs.'))
    return undefined
  }
  return raw
}

function yesNoCell(values, key, issues) {
  const raw = text(values[key]).toLocaleLowerCase('en-US')
  if (!raw) return undefined
  if (DATA_IMPORT_YES.includes(raw)) return true
  if (DATA_IMPORT_NO.includes(raw)) return false
  issues.push(issue(key, 'YES_NO_INVALID', 'Write Yes or No.'))
  return undefined
}

function statusCell(values, issues) {
  const raw = text(values.status).toLocaleLowerCase('en-US')
  if (!raw) return undefined
  for (const [status, labels] of Object.entries(DATA_IMPORT_STATUS_VALUES)) if (labels.includes(raw)) return status
  issues.push(issue('status', 'STATUS_INVALID', 'Write Active, Inactive or Draft.'))
  return undefined
}

// Command issues name the command's fields; the preview names the file's
// columns.
const COMMAND_FIELDS = {
  items: { baseUnit: 'unit', purchaseLeadTimeDays: 'leadTimeDays' },
  suppliers: { deliveryCycleDays: 'leadTimeDays' },
  customers: {},
  'item-suppliers': { supplierId: 'supplierCode' },
  'opening-stock': {},
}
const toColumnIssues = (type, issues) => issues.map((row) => ({ ...row, field: COMMAND_FIELDS[type][row.field] || row.field }))

const put = (target, key, value) => { if (value !== undefined) target[key] = value }

// ---------------------------------------------------------------- row checks

function keyFor(type, values, lookups) {
  if (type === 'items') return text(values.sku)
  if (type === 'suppliers') return text(values.supplierCode)
  if (type === 'customers') return text(values.code)
  if (type === 'item-suppliers') return text(values.sku) && text(values.supplierCode) ? `${text(values.sku)} · ${text(values.supplierCode)}` : ''
  const warehouse = lookups?.warehousesByCode?.get(text(values.warehouseCode))
  return text(values.sku) && text(values.warehouseCode) && text(values.location)
    ? `${text(values.sku)} · ${warehouse?.code || text(values.warehouseCode)} · ${locationKey(values.location)}`
    : ''
}

function checkItem(values, lookups) {
  const issues = []
  const input = { sku: text(values.sku), itemName: text(values.itemName), baseUnit: text(values.unit) }
  put(input, 'category', text(values.category) || undefined)
  put(input, 'specification', text(values.specification) || undefined)
  put(input, 'safetyStock', numberCell(values, 'safetyStock', issues))
  put(input, 'reorderPoint', numberCell(values, 'reorderPoint', issues))
  put(input, 'purchaseLeadTimeDays', numberCell(values, 'leadTimeDays', issues))
  put(input, 'batchManaged', yesNoCell(values, 'batchManaged', issues))
  put(input, 'serialManaged', yesNoCell(values, 'serialManaged', issues))
  put(input, 'status', statusCell(values, issues))
  issues.push(...toColumnIssues('items', itemInputIssues(input).issues))
  const existing = lookups.itemsBySku.get(input.sku)
  return { input, issues, existing: existing ? { entity: { type: 'item', id: existing.id, label: existing.sku } } : null }
}

function checkSupplier(values, lookups) {
  const issues = []
  const input = { supplierCode: text(values.supplierCode), supplierName: text(values.supplierName) }
  for (const key of ['contactName', 'telephone', 'email', 'address']) put(input, key, text(values[key]) || undefined)
  const currency = text(values.defaultCurrency).toUpperCase()
  if (currency) input.defaultCurrency = currency
  const termCode = text(values.paymentTermCode)
  if (termCode) {
    const term = lookups.paymentTermsByCode.get(termCode)
    if (term) input.paymentTermsId = term.id
    else issues.push(issue('paymentTermCode', 'PAYMENT_TERM_NOT_FOUND', 'No payment term has this code. Add it under Payment terms first.'))
  }
  const leadTime = numberCell(values, 'leadTimeDays', issues)
  if (leadTime !== undefined) input.deliveryCycleDays = Number(leadTime)
  put(input, 'status', statusCell(values, issues))
  const { issues: fieldIssues } = supplierInputIssues(input)
  issues.push(...toColumnIssues('suppliers', fieldIssues))
  // An empty currency becomes the workspace currency, as saveSupplierMaster does.
  const effectiveCurrency = currency || text(lookups.workspaceCurrency)
  const currencyIssue = supplierCurrencyIssue(effectiveCurrency)
  if (currencyIssue) issues.push(issue('defaultCurrency', currency ? 'CURRENCY_INVALID' : 'WORKSPACE_CURRENCY_MISSING', currency ? currencyIssue.message : 'Enter a currency; the workspace has none to use.'))
  const existing = lookups.suppliersByCode.get(input.supplierCode)
  return {
    input,
    issues,
    details: { currency: effectiveCurrency || null, currencySource: currency ? 'file' : 'workspace' },
    existing: existing ? { entity: { type: 'supplier', id: existing.id, label: existing.code } } : null,
  }
}

function checkCustomer(values, lookups) {
  const issues = []
  const input = { code: text(values.code), name: text(values.name) }
  for (const key of ['contact', 'phone', 'email', 'address', 'paymentTerms']) put(input, key, text(values[key]) || undefined)
  // Only a recorded currency: an empty cell stays empty.
  const currency = text(values.currency)
  if (currency) input.currency = currency
  put(input, 'status', statusCell(values, issues))
  const { issues: fieldIssues, values: checked } = customerInputIssues(input)
  issues.push(...toColumnIssues('customers', fieldIssues))
  const existing = lookups.customersByCode.get(input.code)
  return {
    input,
    issues,
    details: { currency: checked.currency || null },
    existing: existing ? { entity: { type: 'customer', id: text(existing.payload?.id) || existing.id, label: existing.recordKey } } : null,
  }
}

function checkItemSupplier(values, lookups) {
  const issues = []
  const item = lookups.itemsBySku.get(text(values.sku))
  if (!text(values.sku)) issues.push(issue('sku', 'SKU_REQUIRED', 'Enter a SKU.'))
  else if (!item) issues.push(issue('sku', 'ITEM_NOT_FOUND', 'No item has this SKU. Import or create the item first.'))
  const supplier = lookups.suppliersByCode.get(text(values.supplierCode)) || null
  const input = { supplierId: supplier?.id || '' }
  put(input, 'supplierSku', text(values.supplierSku) || undefined)
  put(input, 'referencePrice', numberCell(values, 'referencePrice', issues))
  const currency = text(values.currency)
  if (currency) input.currency = currency
  put(input, 'minimumOrderQuantity', numberCell(values, 'minimumOrderQuantity', issues))
  put(input, 'leadTimeDays', numberCell(values, 'leadTimeDays', issues))
  put(input, 'preferred', yesNoCell(values, 'preferred', issues))
  // A reference price with no currency takes the supplier's default
  // currency, as the manual form does; the preview shows it.
  const { issues: fieldIssues, values: checked } = itemSupplierInputIssues(input, { supplier })
  if (!text(values.supplierCode)) issues.push(issue('supplierCode', 'CODE_REQUIRED', 'Enter a supplier code.'), ...toColumnIssues('item-suppliers', fieldIssues.filter((row) => row.field !== 'supplierId')))
  else issues.push(...toColumnIssues('item-suppliers', fieldIssues))
  const existing = item && supplier ? lookups.itemSupplierKeys.get(`${item.id}::${supplier.id}`) : null
  // Saving a preferred link moves the item's preferred supplier, which the
  // import never changes: the person does that on the item.
  const current = item ? (lookups.preferredSuppliersByItemId.get(item.id) || []).find((entry) => entry.id !== supplier?.id) : null
  if (!existing && input.preferred && current) {
    issues.push(issue('preferred', 'PREFERRED_EXISTS', `This item already prefers ${current.code}. Change the preferred supplier on the item, or write No.`, { supplierCode: current.code }))
  }
  return {
    input,
    itemRef: item?.id || item?.sku || '',
    issues,
    details: { currency: checked.currency || null, currencySource: currency ? 'file' : 'supplier' },
    existing: existing ? { entity: { type: 'item_supplier', id: existing.id, label: `${item.sku} · ${supplier.code}` } } : null,
  }
}

function checkOpeningStock(values, lookups, actor) {
  const issues = []
  const sku = text(values.sku)
  const item = lookups.itemsBySku.get(sku)
  if (!sku) issues.push(issue('sku', 'SKU_REQUIRED', 'Enter a SKU.'))
  else if (!item) issues.push(issue('sku', 'ITEM_NOT_FOUND', 'No item has this SKU. Import or create the item first.'))
  else if (text(item.status || 'active') !== 'active') issues.push(issue('sku', 'ITEM_INACTIVE', 'This item is not active.'))
  const code = text(values.warehouseCode)
  const warehouse = lookups.warehousesByCode.get(code)
  const denied = Boolean(warehouse) && !hasWarehouseAccess(actor, [warehouse.id], 'operate')
  if (!code) issues.push(issue('warehouseCode', 'WAREHOUSE_REQUIRED', 'Enter a warehouse code.'))
  else if (!warehouse) issues.push(issue('warehouseCode', 'WAREHOUSE_NOT_FOUND', 'No warehouse has this code.'))
  else if (text(warehouse.status || 'active') !== 'active') issues.push(issue('warehouseCode', 'WAREHOUSE_INACTIVE', 'This warehouse is not active.'))
  else if (denied) issues.push(issue('warehouseCode', 'WAREHOUSE_SCOPE_DENIED', 'You cannot record stock in this warehouse. A workspace administrator can grant access.'))
  const location = text(values.location)
  if (!location) issues.push(issue('location', 'LOCATION_REQUIRED', 'Enter a location.'))
  else if (location.length > 120) issues.push(issue('location', 'LOCATION_TOO_LONG', 'A location has at most 120 characters.'))
  const quantity = numberCell(values, 'quantity', issues)
  if (!text(values.quantity)) issues.push(issue('quantity', 'QUANTITY_REQUIRED', 'Enter a quantity.'))
  else if (quantity !== undefined) {
    const [whole, fraction = ''] = quantity.replace(/^-/, '').split('.')
    if (quantity.startsWith('-') || /^0*(\.0*)?$/.test(quantity.replace(/^-/, ''))) issues.push(issue('quantity', 'QUANTITY_POSITIVE', 'Opening stock must be greater than zero.'))
    else if (fraction.replace(/0+$/, '').length > 4) issues.push(issue('quantity', 'QUANTITY_PRECISION', 'A quantity has at most four decimal places.'))
    else if (whole.replace(/^0+/, '').length > 14) issues.push(issue('quantity', 'NUMBER_TOO_LARGE', 'This quantity is too large.'))
  }
  // Nothing is ever converted: a unit, when given, must be the item's own.
  const unit = text(values.unit)
  if (unit && item && unit !== text(item.unit)) issues.push(issue('unit', 'UNIT_MISMATCH', `This item is kept in ${text(item.unit) || 'no unit'}. Convert the quantity before importing.`, { unit: text(item.unit) }))
  // Nothing about the stock in a warehouse the person cannot operate is
  // looked up or shown.
  const key = item && warehouse && location && !denied ? `${item.sku}|${warehouse.id}|${locationKey(location)}` : ''
  const balance = key ? lookups.balancesByKey.get(key) : null
  const draft = key ? lookups.openingDraftsByKey.get(key) : null
  let existing = null
  if (draft) existing = { reason: 'IN_OPENING_DRAFT', document: { type: 'inventory_adjustment', id: draft.id, number: draft.adjustmentNumber, workflowStatus: draft.workflowStatus } }
  else if (balance && balance.hasStock) existing = { reason: 'STOCK_RECORD_HAS_STOCK', entity: { type: 'inventory_balance', id: balance.id, label: `${item.sku} · ${warehouse.code} · ${balance.location || location}` } }
  else if (balance && balance.hasHistory) issues.push(issue('location', 'ADJUSTMENT_OPENING_BALANCE_EXISTS', 'This location already has stock history. Correct it with another adjustment reason in Inventory.'))
  return {
    input: item && warehouse ? { itemId: item.id, warehouseId: warehouse.id, location, adjustmentQuantity: quantity } : null,
    issues,
    warehouseId: warehouse?.id || '',
    details: {
      unit: text(item?.unit) || null,
      warehouseId: warehouse?.id || null,
      warehouseCode: warehouse?.code || code,
      warehouseName: warehouse?.name || null,
      location,
      quantity: quantity ?? null,
      stockRecord: denied || !item || !warehouse ? null : balance ? 'existing' : 'new',
    },
    existing,
  }
}

const CHECKS = {
  items: checkItem,
  suppliers: checkSupplier,
  customers: checkCustomer,
  'item-suppliers': checkItemSupplier,
  'opening-stock': checkOpeningStock,
}

// ---------------------------------------------------------------- service

export function createDataImportService({
  prisma,
  env = process.env,
  now = () => new Date(),
  idFactory = randomUUID,
  resolveActor = (client, identity) => resolveProvisionedActor(client, identity),
  commands = {},
} = {}) {
  if (!prisma) throw new Error('prisma is required')
  const limits = dataImportLimits(env)
  const run = {
    saveItemMaster, saveSupplierMaster, saveCustomerMaster, saveItemSupplier,
    createInventoryAdjustment: (input, context) => createInventoryOperationsCommandService({ prisma, env }).createAdjustment(input, context),
    ...commands,
  }

  // The provisioned user of the session's workspace, with the permission of
  // the manual form for this record type.
  async function authorize(type, context) {
    const identity = context?.identity || context
    if (!identity?.authenticated || !text(identity.tenantId)) fail('AUTHENTICATION_REQUIRED', 'Sign in to import data.', 401)
    const actor = await resolveActor(prisma, identity)
    assertAuthorized({ actor, permission: DATA_IMPORT_PERMISSIONS[type], tenantId: text(identity.tenantId) })
    if (type === 'opening-stock' && text(env.FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS).toLowerCase() !== 'true') {
      fail('DATA_IMPORT_OPENING_STOCK_UNAVAILABLE', 'Opening stock import needs inventory operations, which are not enabled.', 409)
    }
    return { actor, identity, tenantId: text(identity.tenantId), actorId: text(identity.userId) }
  }

  // The existing keys and lookups for a set of rows, one query each, always
  // in the session's workspace. Stock is looked up only in the warehouses
  // the person can operate.
  async function loadLookups(type, rows, tenantId, actor) {
    const distinct = (key) => [...new Set(rows.map((row) => text(row.values[key])).filter(Boolean))]
    const lookups = {
      itemsBySku: new Map(), suppliersByCode: new Map(), customersByCode: new Map(), paymentTermsByCode: new Map(),
      itemSupplierKeys: new Map(), preferredSuppliersByItemId: new Map(), warehousesByCode: new Map(), balancesByKey: new Map(), openingDraftsByKey: new Map(),
      workspaceCurrency: null,
    }
    const skus = ['items', 'item-suppliers', 'opening-stock'].includes(type) ? distinct('sku') : []
    if (skus.length) {
      const items = await prisma.item.findMany({ where: { tenantId, sku: { in: skus } }, select: { id: true, sku: true, name: true, unit: true, status: true, preferredSupplierId: true } })
      for (const item of items) lookups.itemsBySku.set(item.sku, item)
    }
    const supplierCodes = ['suppliers', 'item-suppliers'].includes(type) ? distinct('supplierCode') : []
    if (supplierCodes.length) {
      const suppliers = await prisma.supplier.findMany({ where: { tenantId, code: { in: supplierCodes } }, select: { id: true, code: true, status: true, metadata: true } })
      for (const supplier of suppliers) lookups.suppliersByCode.set(supplier.code, supplier)
    }
    if (type === 'suppliers') {
      const termCodes = distinct('paymentTermCode')
      if (termCodes.length) {
        const terms = await prisma.paymentTerm.findMany({ where: { tenantId, code: { in: termCodes } }, select: { id: true, code: true } })
        for (const term of terms) lookups.paymentTermsByCode.set(term.code, term)
      }
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { currency: true } })
      lookups.workspaceCurrency = tenant?.currency || null
    }
    if (type === 'customers') {
      const codes = distinct('code')
      if (codes.length) {
        const records = await prisma.runtimeRecord.findMany({ where: { tenantId, namespace: CUSTOMER_NAMESPACE, recordKey: { in: codes } }, select: { id: true, recordKey: true, payload: true } })
        for (const record of records) lookups.customersByCode.set(record.recordKey, record)
      }
    }
    if (type === 'item-suppliers') {
      const keys = [...new Set(rows.map((row) => {
        const item = lookups.itemsBySku.get(text(row.values.sku))
        const supplier = lookups.suppliersByCode.get(text(row.values.supplierCode))
        return item && supplier ? `${item.id}::${supplier.id}` : ''
      }).filter(Boolean))]
      if (keys.length) {
        const records = await prisma.runtimeRecord.findMany({ where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: { in: keys } }, select: { id: true, recordKey: true } })
        for (const record of records) lookups.itemSupplierKeys.set(record.recordKey, record)
      }
      // The current preferred suppliers of each item a row marks preferred:
      // the item's own and any link marked preferred, all of which saving
      // a preferred link would change.
      const preferredItems = [...new Set(rows.filter((row) => DATA_IMPORT_YES.includes(text(row.values.preferred).toLocaleLowerCase('en-US')))
        .map((row) => lookups.itemsBySku.get(text(row.values.sku))?.id).filter(Boolean))]
      if (preferredItems.length) {
        const preferredIds = new Map(preferredItems.map((id) => [id, new Set()]))
        for (const item of lookups.itemsBySku.values()) if (preferredIds.has(item.id) && text(item.preferredSupplierId)) preferredIds.get(item.id).add(text(item.preferredSupplierId))
        const links = await prisma.runtimeRecord.findMany({
          where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, OR: preferredItems.map((id) => ({ recordKey: { startsWith: `${id}::` } })) },
          select: { id: true, recordKey: true, payload: true },
        })
        for (const link of links) {
          const itemId = text(link.payload?.itemId)
          if (link.payload?.preferred && preferredIds.has(itemId) && text(link.payload.supplierId)) preferredIds.get(itemId).add(text(link.payload.supplierId))
        }
        const known = new Map([...lookups.suppliersByCode.values()].map((supplier) => [supplier.id, supplier]))
        const missing = [...new Set([...preferredIds.values()].flatMap((ids) => [...ids]))].filter((id) => !known.has(id))
        if (missing.length) for (const supplier of await prisma.supplier.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, code: true } })) known.set(supplier.id, supplier)
        for (const [itemId, ids] of preferredIds) lookups.preferredSuppliersByItemId.set(itemId, [...ids].map((id) => ({ id, code: text(known.get(id)?.code) || id })))
      }
    }
    if (type === 'opening-stock') {
      const codes = distinct('warehouseCode')
      if (codes.length) {
        const warehouses = await prisma.warehouse.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true, name: true, status: true } })
        for (const warehouse of warehouses) lookups.warehousesByCode.set(warehouse.code, warehouse)
      }
      const warehouseIds = [...lookups.warehousesByCode.values()].map((row) => row.id).filter((id) => hasWarehouseAccess(actor, [id], 'operate'))
      const knownSkus = [...lookups.itemsBySku.keys()]
      if (warehouseIds.length && knownSkus.length) {
        const balances = await prisma.inventoryBalance.findMany({
          where: { tenantId, sku: { in: knownSkus }, warehouseKey: { in: warehouseIds } },
          select: { id: true, sku: true, warehouseId: true, warehouseKey: true, location: true, locationKey: true, onHandQuantity: true },
        })
        for (const balance of balances) {
          const hasStock = Number(balance.onHandQuantity || 0) !== 0
          lookups.balancesByKey.set(`${balance.sku}|${balance.warehouseKey}|${balance.locationKey}`, {
            ...balance,
            hasStock,
            // Only an empty record can take opening stock, and only when it
            // has no history (a reversed opening entry aside).
            hasHistory: hasStock ? false : await inventoryStockRecordHasHistory(prisma, tenantId, { sku: balance.sku, warehouseId: balance.warehouseId || balance.warehouseKey, locationKey: balance.locationKey }),
          })
        }
        const lines = await prisma.inventoryAdjustmentLine.findMany({
          where: {
            sku: { in: knownSkus },
            warehouseId: { in: warehouseIds },
            adjustment: { tenantId, reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: { in: ['draft', 'ready'] } },
          },
          select: { sku: true, warehouseId: true, locationKey: true, adjustment: { select: { id: true, adjustmentNumber: true, workflowStatus: true } } },
        })
        for (const line of lines) lookups.openingDraftsByKey.set(`${line.sku}|${line.warehouseId}|${line.locationKey}`, line.adjustment)
      }
    }
    return lookups
  }

  // Checks rows against the lookups. Two rows with the same key both fail;
  // their values are never combined.
  function checkRows(type, rows, lookups, actor) {
    const checked = rows.map((row) => {
      const result = CHECKS[type](row.values, lookups, actor)
      return { row, key: keyFor(type, row.values, lookups), ...result }
    })
    const counts = new Map()
    for (const entry of checked) if (entry.key) counts.set(entry.key, (counts.get(entry.key) || 0) + 1)
    for (const entry of checked) {
      if (entry.key && counts.get(entry.key) > 1) entry.issues.push(issue('', 'DUPLICATE_ROW', 'Another row in this file has the same key. Keep one of them.'))
    }
    if (type === 'item-suppliers') {
      const preferred = new Map()
      for (const entry of checked) if (entry.input?.preferred) preferred.set(text(entry.row.values.sku), (preferred.get(text(entry.row.values.sku)) || 0) + 1)
      for (const entry of checked) {
        if (entry.input?.preferred && preferred.get(text(entry.row.values.sku)) > 1) entry.issues.push(issue('preferred', 'PREFERRED_DUPLICATE', 'Only one supplier per item can be preferred.'))
      }
    }
    return checked.map((entry) => ({
      ...entry,
      action: entry.issues.length ? 'error' : entry.existing ? 'skip_existing' : 'create',
    }))
  }

  function rowsFromFile(type, parsed) {
    const mapping = mapDataImportHeaders(type, parsed.headers)
    if (mapping.duplicates.length) fail('DATA_IMPORT_HEADER_DUPLICATE', 'Two columns in the file mean the same thing. Keep one of them.', 422, { duplicates: mapping.duplicates })
    if (mapping.missing.length) {
      const columns = dataImportColumns(type).filter((entry) => mapping.missing.includes(entry.key)).map(({ key, en, zh }) => ({ key, en, zh }))
      fail('DATA_IMPORT_REQUIRED_COLUMN_MISSING', 'The file is missing a required column. Start from the template.', 422, { columns })
    }
    const rows = parsed.rows.map(({ rowNumber, cells }) => {
      const values = {}
      mapping.keys.forEach((key, index) => { if (key) values[key] = cells[index] ?? '' })
      return { rowNumber, values }
    })
    return { rows, ignoredColumns: mapping.ignored, columns: parsed.headers.map((header, index) => ({ header, key: mapping.keys[index] })) }
  }

  const summarize = (rows, field = 'action') => {
    const counts = { rows: rows.length, create: 0, skip_existing: 0, error: 0 }
    for (const row of rows) counts[row[field]] = (counts[row[field]] || 0) + 1
    return counts
  }

  async function preview(type, body = {}, context) {
    assertDataImportType(type)
    const { actor, tenantId } = await authorize(type, context)
    const parsed = await parseDataImportFile(body, limits)
    const { rows, ignoredColumns, columns } = rowsFromFile(type, parsed)
    const lookups = await loadLookups(type, rows, tenantId, actor)
    const checked = checkRows(type, rows, lookups, actor)
    const previewRows = checked.map((entry) => ({
      rowNumber: entry.row.rowNumber,
      key: entry.key,
      action: entry.action,
      issues: entry.issues,
      values: entry.row.values,
      ...(entry.details ? { details: entry.details } : {}),
      ...(entry.existing ? { existing: entry.existing } : {}),
    }))
    const result = {
      type,
      fileName: text(body.fileName),
      fileSha256: parsed.fileSha256,
      sourceFormat: parsed.sourceFormat,
      sheetName: parsed.sheetName,
      sheetList: parsed.sheetList,
      columns,
      ignoredColumns,
      rows: previewRows,
      counts: summarize(previewRows),
      chunkSize: DATA_IMPORT_CHUNK_SIZE,
    }
    if (type === 'opening-stock') {
      // Grouped by warehouse with row counts only: quantities of different
      // items are never added together.
      const groups = new Map()
      for (const row of previewRows) {
        const id = row.details?.warehouseId || ''
        if (!groups.has(id)) groups.set(id, { warehouseId: id || null, warehouseCode: row.details?.warehouseCode || '', warehouseName: row.details?.warehouseName || null, rows: 0, create: 0, newStockRecords: 0 })
        const group = groups.get(id)
        group.rows += 1
        if (row.action === 'create') { group.create += 1; if (row.details?.stockRecord === 'new') group.newStockRecords += 1 }
      }
      result.warehouses = [...groups.values()]
    }
    return result
  }

  function validateCommitBody(type, body) {
    const fileSha256 = text(body?.fileSha256).toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(fileSha256)) fail('DATA_IMPORT_FILE_REQUIRED', 'Check the file again before importing.', 422)
    const chunkIndex = Number(body?.chunkIndex)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > Math.ceil(limits.maxRows / DATA_IMPORT_CHUNK_SIZE)) fail('DATA_IMPORT_CHUNK_INVALID', 'The import chunk is not valid.', 422)
    const keys = new Set(dataImportColumns(type).map((entry) => entry.key))
    if (!Array.isArray(body?.rows) || !body.rows.length || body.rows.length > DATA_IMPORT_CHUNK_SIZE) fail('DATA_IMPORT_CHUNK_INVALID', `Send between 1 and ${DATA_IMPORT_CHUNK_SIZE} rows at a time.`, 422)
    const seen = new Set()
    const rows = body.rows.map((row) => {
      const rowNumber = Number(row?.rowNumber)
      if (!Number.isInteger(rowNumber) || rowNumber < 2 || seen.has(rowNumber)) fail('DATA_IMPORT_CHUNK_INVALID', 'Each row needs its own row number.', 422)
      seen.add(rowNumber)
      if (!row.values || typeof row.values !== 'object' || Array.isArray(row.values)) fail('DATA_IMPORT_CHUNK_INVALID', 'Each row needs its values.', 422)
      const values = {}
      for (const [key, value] of Object.entries(row.values)) {
        if (!keys.has(key)) continue
        if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') fail('DATA_IMPORT_CHUNK_INVALID', 'Row values must be text.', 422)
        values[key] = cellText(value).slice(0, 2000)
      }
      return { rowNumber, values }
    })
    return { fileSha256, chunkIndex, rows }
  }

  // Claims the chunk's execution row, or returns the stored result of a
  // completed one while it still holds (stillCurrent). A stored result that
  // no longer holds is dropped and the chunk runs again under a new row. A
  // second commit of the same chunk while the first runs gets 409; a chunk
  // left pending by a crash can be claimed again.
  async function claimExecution(tenantId, commandType, idempotencyKey, requestHash, stillCurrent) {
    const where = { tenantId_commandType_idempotencyKey: { tenantId, commandType, idempotencyKey } }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const execution = await prisma.businessCommandExecution.create({ data: { id: idFactory(), tenantId, commandType, idempotencyKey, requestHash, status: 'pending' } })
        return { execution }
      } catch (error) {
        if (error?.code !== 'P2002') throw error
      }
      const existing = await prisma.businessCommandExecution.findUnique({ where })
      if (!existing && attempt === 0) continue
      if (existing?.status === 'completed' && existing.resultPayload) {
        if (await stillCurrent(existing.resultPayload)) return { replay: { ...existing.resultPayload, idempotentReplay: true } }
        if (attempt > 0) break
        await prisma.businessCommandExecution.deleteMany({ where: { id: existing.id, status: 'completed' } })
        continue
      }
      if (existing && existing.status === 'pending' && new Date(existing.createdAt).getTime() < now().getTime() - STALE_EXECUTION_MS) {
        const taken = await prisma.businessCommandExecution.updateMany({ where: { id: existing.id, status: 'pending', createdAt: existing.createdAt }, data: { createdAt: now() } })
        if (taken.count === 1) return { execution: existing }
      }
      break
    }
    fail('DATA_IMPORT_IN_PROGRESS', 'This part of the file is already being imported. Wait a moment, then check the results.', 409)
  }

  const DUPLICATE_CODES = new Set(['DUPLICATE_SKU', 'DUPLICATE_CODE', 'RELATIONSHIP_EXISTS'])
  const knownError = (error) => Number(error?.status) >= 400 && Number(error?.status) < 500 && text(error?.code)

  async function runMasterDataRow(type, entry, actorId, scope) {
    try {
      if (type === 'items') {
        const item = await run.saveItemMaster(prisma, null, entry.input, actorId, scope)
        return { outcome: 'created', entity: { type: 'item', id: item.id, label: item.sku } }
      }
      if (type === 'suppliers') {
        const supplier = await run.saveSupplierMaster(prisma, null, entry.input, actorId, scope)
        return { outcome: 'created', entity: { type: 'supplier', id: supplier.id, label: supplier.code } }
      }
      if (type === 'customers') {
        const record = await run.saveCustomerMaster(prisma, null, entry.input, actorId, scope)
        return { outcome: 'created', entity: { type: 'customer', id: text(record.payload?.id) || record.id, label: record.recordKey } }
      }
      const relationship = await run.saveItemSupplier(prisma, entry.itemRef, null, entry.input, actorId, scope)
      return { outcome: 'created', entity: { type: 'item_supplier', id: relationship.relationshipId, label: entry.key } }
    } catch (error) {
      if (DUPLICATE_CODES.has(error?.code)) return { outcome: 'skipped_existing' }
      if (error?.code === 'VALIDATION_ERROR') return { outcome: 'error', issues: toColumnIssues(type, (error.details || []).map((row) => ({ field: row.field, code: row.code || 'VALIDATION_ERROR', message: row.message }))) }
      if (knownError(error)) return { outcome: 'error', issues: [issue('', error.code, error.message)] }
      throw error
    }
  }

  async function runOpeningStock(entries, { fileSha256, executionId, identity }) {
    const results = new Map()
    const groups = new Map()
    for (const entry of entries) {
      if (!groups.has(entry.warehouseId)) groups.set(entry.warehouseId, [])
      groups.get(entry.warehouseId).push(entry)
    }
    for (const [warehouseId, group] of groups) {
      const warehouse = group[0].details
      const rowNumbers = group.map((entry) => entry.row.rowNumber)
      // Keyed by the chunk's execution and the lines sent: a chunk resumed
      // after a crash finds its draft again, while a later run of the same
      // file (other rows, or after the first draft was cancelled) makes a
      // new one.
      const lines = group.map((entry) => [entry.row.rowNumber, entry.input])
      const groupKey = sha256(`${executionId}|${warehouseId}|${JSON.stringify(lines)}`)
      const input = {
        adjustmentNumber: `OB-${groupKey.slice(0, 10).toUpperCase()}-${text(warehouse.warehouseCode).slice(0, 24)}`,
        reasonCode: 'opening_balance',
        notes: `Opening stock imported from a file (SHA-256 ${fileSha256.slice(0, 12)}), rows ${Math.min(...rowNumbers)}–${Math.max(...rowNumbers)}.`,
        idempotencyKey: `data-import:opening:${groupKey}`,
        lines: group.map((entry) => entry.input),
      }
      try {
        const created = await run.createInventoryAdjustment(input, { identity })
        const adjustment = created.adjustment || {}
        const document = { type: 'inventory_adjustment', id: adjustment.id || created.entityId, number: adjustment.adjustmentNumber || input.adjustmentNumber, workflowStatus: adjustment.workflowStatus || 'draft' }
        for (const entry of group) results.set(entry.row.rowNumber, { outcome: 'created', document })
      } catch (error) {
        if (!knownError(error)) throw error
        for (const entry of group) results.set(entry.row.rowNumber, { outcome: 'error', issues: [issue('', error.code, error.message)] })
      }
    }
    return results
  }

  async function commit(type, body = {}, context) {
    assertDataImportType(type)
    const { actor, identity, tenantId, actorId } = await authorize(type, context)
    const { fileSha256, chunkIndex, rows } = validateCommitBody(type, body)
    const rowsHash = sha256(JSON.stringify(rows.map((row) => [row.rowNumber, Object.keys(row.values).sort().map((key) => [key, row.values[key]])])))
    const commandType = commandTypeFor(type)
    const idempotencyKey = sha256(`${type}|${fileSha256}|${chunkIndex}|${rowsHash}`)
    const recheck = async () => checkRows(type, rows, await loadLookups(type, rows, tenantId, actor), actor)
    // A stored result holds while none of its rows can be created: once a
    // record or draft it reported is gone (a cancelled or reversed opening
    // draft, a removed link), the chunk runs again.
    const claim = await claimExecution(tenantId, commandType, idempotencyKey, rowsHash, async (stored) => {
      const current = new Map((await recheck()).map((entry) => [entry.row.rowNumber, entry]))
      return [...current.values()].every((entry) => entry.action !== 'create') && (stored.rows || []).every((row) => {
        // A draft it reported is still the one holding that row.
        if (row.outcome !== 'created' || !row.document) return true
        return current.get(row.rowNumber)?.existing?.document?.id === row.document.id
      })
    })
    if (claim.replay) return claim.replay
    const { execution } = claim
    try {
      // Checked again: the data may have changed since the preview.
      const checked = await recheck()
      const scope = { tenantId }
      const outcomes = new Map()
      for (const entry of checked) {
        if (entry.action === 'error') outcomes.set(entry.row.rowNumber, { outcome: 'error', issues: entry.issues })
        else if (entry.action === 'skip_existing') outcomes.set(entry.row.rowNumber, { outcome: 'skipped_existing', ...entry.existing })
      }
      const toCreate = checked.filter((entry) => entry.action === 'create')
      if (type === 'opening-stock') {
        for (const [rowNumber, outcome] of await runOpeningStock(toCreate, { fileSha256, executionId: execution.id, identity })) outcomes.set(rowNumber, outcome)
      } else {
        for (const entry of toCreate) outcomes.set(entry.row.rowNumber, await runMasterDataRow(type, entry, actorId, scope))
      }
      const resultRows = checked.map((entry) => ({ rowNumber: entry.row.rowNumber, key: entry.key, issues: [], ...outcomes.get(entry.row.rowNumber) }))
      const counts = { rows: resultRows.length, created: 0, skipped_existing: 0, error: 0 }
      for (const row of resultRows) counts[row.outcome] += 1
      const documents = [...new Map(resultRows.filter((row) => row.document).map((row) => [row.document.id, row.document])).values()]
      const result = { type, fileSha256, chunkIndex, rows: resultRows, counts, documents }
      await prisma.auditLog.create({
        data: {
          id: idFactory(),
          tenantId,
          source: 'data-import',
          module: type === 'opening-stock' ? 'inventory' : 'master-data',
          action: 'data_import_chunk_committed',
          entityType: 'data_import',
          entityId: fileSha256,
          actorId,
          summary: `Imported ${type} rows ${Math.min(...rows.map((row) => row.rowNumber))}–${Math.max(...rows.map((row) => row.rowNumber))}: ${counts.created} created, ${counts.skipped_existing} skipped, ${counts.error} with errors.`,
          metadata: { type, fileSha256, chunkIndex, counts, documentIds: documents.map((row) => row.id) },
        },
      })
      // Only a chunk whose rows were all created or skipped is stored for
      // replay. A row refused at commit (a conflict with another write, or
      // data that changed since the check) is tried again when the chunk is
      // committed again, after the person fixes what was wrong.
      if (counts.error) await prisma.businessCommandExecution.deleteMany({ where: { id: execution.id, status: 'pending' } })
      else await prisma.businessCommandExecution.update({ where: { id: execution.id }, data: { status: 'completed', entityType: 'data_import', entityId: fileSha256, resultPayload: result, completedAt: now() } })
      return { ...result, idempotentReplay: false }
    } catch (error) {
      // Nothing to replay: release the chunk so it can be committed again.
      await prisma.businessCommandExecution.deleteMany({ where: { id: execution.id, status: 'pending' } }).catch(() => {})
      throw error
    }
  }

  return { preview, commit, limits }
}
