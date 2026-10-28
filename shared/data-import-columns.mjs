// The CSV import's file layout, shared by the server (templates, header
// matching) and the client (labels). One column table per record type, in
// import order. Each column has the English and Chinese header labels, an
// example value for the template and the other headers that mean the same
// column, including the Universal Intake aliases. Headers are matched without
// regard to case, spacing or full-width brackets, in either language, because
// the master data export follows the interface language.

export const DATA_IMPORT_TYPES = Object.freeze(['items', 'suppliers', 'customers', 'item-suppliers', 'opening-stock'])

const column = (key, en, zh, { required = false, example = '', aliases = [] } = {}) =>
  Object.freeze({ key, en, zh, required, example, aliases: Object.freeze(aliases) })

const statusAliases = ['启用状态']
const currencyAliases = ['货币']

export const DATA_IMPORT_COLUMNS = Object.freeze({
  // The item labels are the item export's headers (src/modules/master-data/export.ts),
  // in the export's order, so an exported file can be imported again.
  items: Object.freeze([
    column('sku', 'SKU', 'SKU', { required: true, example: 'VALVE-100', aliases: ['item_code', 'material_code', '物料编码', '商品编码'] }),
    column('itemName', 'Item name', '物料名称', { required: true, example: 'Ball valve 2 in', aliases: ['item_name', 'material_name', '商品名称'] }),
    column('category', 'Category', '物料分类', { example: 'Valves', aliases: ['commodity', 'category_name', '品类', '分类'] }),
    column('specification', 'Specification', '规格型号', { example: 'Brass, 2 in', aliases: ['规格'] }),
    column('unit', 'Unit', '单位', { required: true, example: 'EA', aliases: ['base_unit', 'uom', '基本单位'] }),
    column('safetyStock', 'Safety stock', '安全库存', { example: '5' }),
    column('reorderPoint', 'Reorder point', '再订货点', { example: '10' }),
    column('leadTimeDays', 'Lead time (days)', '采购提前期（天）', { example: '7', aliases: ['lead_time_days'] }),
    column('batchManaged', 'Batch managed', '批次管理', { example: 'No' }),
    column('serialManaged', 'Serial managed', '序列号管理', { example: 'No' }),
    column('status', 'Status', '状态', { example: 'Active', aliases: statusAliases }),
  ]),
  suppliers: Object.freeze([
    column('supplierCode', 'Supplier code', '供应商编号', { required: true, example: 'SUP-001', aliases: ['supplier_code', 'vendor_code', '供应商编码', '供应商代码'] }),
    column('supplierName', 'Supplier name', '供应商名称', { required: true, example: 'Boston Components', aliases: ['supplier_name', 'vendor_name', '供应商'] }),
    column('contactName', 'Contact name', '联系人', { example: 'Alex Kim', aliases: ['contact'] }),
    column('telephone', 'Telephone', '联系电话', { example: '+1 617 555 0100', aliases: ['phone', 'mobile', '电话', '手机号'] }),
    column('email', 'Email', '邮箱', { example: 'orders@example.com', aliases: ['email_address', '电子邮箱'] }),
    column('address', 'Address', '地址', { example: '1 Main St, Boston, MA' }),
    column('defaultCurrency', 'Default currency', '默认币种', { example: 'USD', aliases: ['currency', '币种', ...currencyAliases] }),
    column('paymentTermCode', 'Payment term code', '付款条款编码', { example: 'NET30', aliases: ['payment_terms', 'payment_term', 'payment terms', '付款条款', '付款条件', '账期'] }),
    column('leadTimeDays', 'Lead time (days)', '送货周期（天）', { example: '7', aliases: ['delivery lead time (days)', 'lead_time_days'] }),
    column('status', 'Status', '状态', { example: 'Active', aliases: statusAliases }),
  ]),
  customers: Object.freeze([
    column('code', 'Customer code', '客户编号', { required: true, example: 'CUST-001', aliases: ['customer_code', '客户编码', '客户代码'] }),
    column('name', 'Customer name', '客户名称', { required: true, example: 'Redwood Retail', aliases: ['customer_name', '客户'] }),
    column('contact', 'Contact', '联系人', { example: 'Sam Lee', aliases: ['contact name', 'contact_name'] }),
    column('phone', 'Phone', '电话', { example: '+1 415 555 0100', aliases: ['telephone', 'mobile', '联系电话', '手机号'] }),
    column('email', 'Email', '邮箱', { example: 'buyer@example.com', aliases: ['email_address', '电子邮箱'] }),
    column('address', 'Address', '地址', { example: '2 Market St, San Francisco, CA' }),
    column('paymentTerms', 'Payment terms', '付款条款', { example: 'NET30', aliases: ['payment_terms', 'payment_term', '付款条件', '账期'] }),
    column('currency', 'Currency', '币种', { example: 'USD', aliases: currencyAliases }),
    column('status', 'Status', '状态', { example: 'Active', aliases: statusAliases }),
  ]),
  'item-suppliers': Object.freeze([
    column('sku', 'SKU', 'SKU', { required: true, example: 'VALVE-100', aliases: ['item_code', '物料编码', '商品编码'] }),
    column('supplierCode', 'Supplier code', '供应商编号', { required: true, example: 'SUP-001', aliases: ['supplier_code', 'vendor_code', '供应商编码', '供应商代码'] }),
    column('supplierSku', 'Supplier SKU', '供应商物料号', { example: 'BC-7781', aliases: ['supplier_sku', 'vendor_sku', '供应商料号'] }),
    column('referencePrice', 'Reference price', '参考价格', { example: '12.50', aliases: ['reference_price', 'price', '参考价'] }),
    column('currency', 'Currency', '币种', { example: 'USD', aliases: currencyAliases }),
    column('minimumOrderQuantity', 'Minimum order quantity', '最小起订量', { example: '10', aliases: ['moq', 'minimum_order_quantity'] }),
    column('leadTimeDays', 'Lead time (days)', '交期（天）', { example: '14', aliases: ['lead_time_days', '交期'] }),
    column('preferred', 'Preferred', '首选', { example: 'Yes', aliases: ['preferred supplier', '是否首选'] }),
  ]),
  'opening-stock': Object.freeze([
    column('sku', 'SKU', 'SKU', { required: true, example: 'VALVE-100', aliases: ['item_code', '物料编码', '商品编码'] }),
    column('warehouseCode', 'Warehouse code', '仓库编码', { required: true, example: 'MAIN', aliases: ['warehouse_code', 'warehouse', '仓库'] }),
    column('location', 'Location', '库位', { required: true, example: 'A-01', aliases: ['bin', 'location_code', '货位'] }),
    column('quantity', 'Quantity', '数量', { required: true, example: '25', aliases: ['qty', '期初数量'] }),
    column('unit', 'Unit', '单位', { example: 'EA', aliases: ['uom', '基本单位'] }),
  ]),
})

// Item export columns that the import does not read. They are listed as
// "Column ignored" in the preview rather than as unknown headers. The default
// supplier comes from the item-supplier file's Preferred column instead.
export const DATA_IMPORT_KNOWN_IGNORED_COLUMNS = Object.freeze({
  items: Object.freeze([
    Object.freeze({ en: 'Default warehouse', zh: '默认仓库' }),
    Object.freeze({ en: 'Default bin', zh: '默认库位' }),
    Object.freeze({ en: 'Maximum stock', zh: '最大库存' }),
    Object.freeze({ en: 'QA required', zh: '质检要求' }),
    Object.freeze({ en: 'Default supplier', zh: '默认供应商' }),
    Object.freeze({ en: 'Default tax code', zh: '默认税码' }),
  ]),
})

// Yes/no and status cells, in either language. The item export writes
// "Incomplete" / "待完善" for a draft item, so those read as draft too.
export const DATA_IMPORT_YES = Object.freeze(['yes', 'y', 'true', '是'])
export const DATA_IMPORT_NO = Object.freeze(['no', 'n', 'false', '否'])
export const DATA_IMPORT_STATUS_VALUES = Object.freeze({
  active: Object.freeze(['active', '启用']),
  inactive: Object.freeze(['inactive', '停用']),
  draft: Object.freeze(['draft', '草稿', 'incomplete', '待完善']),
})

export function normalizeDataImportHeader(value) {
  return String(value ?? '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

export function dataImportColumns(type) {
  return DATA_IMPORT_COLUMNS[type] || null
}

// Matches a file's headers to the type's columns. Returns the column key of
// each header (null when the import does not read it), the ignored headers,
// the required columns that are missing and any column named twice.
export function mapDataImportHeaders(type, headers) {
  const columns = dataImportColumns(type) || []
  const byName = new Map()
  for (const entry of columns) {
    for (const name of [entry.key, entry.en, entry.zh, ...entry.aliases]) byName.set(normalizeDataImportHeader(name), entry.key)
  }
  const known = new Set((DATA_IMPORT_KNOWN_IGNORED_COLUMNS[type] || []).flatMap((entry) => [entry.en, entry.zh]).map(normalizeDataImportHeader))
  const keys = []
  const ignored = []
  const seen = new Map()
  const duplicates = []
  for (const header of headers) {
    const key = byName.get(normalizeDataImportHeader(header)) || null
    keys.push(key)
    if (!key) {
      ignored.push({ header: String(header), reason: known.has(normalizeDataImportHeader(header)) ? 'not_imported' : 'unknown' })
      continue
    }
    if (seen.has(key)) duplicates.push({ key, headers: [seen.get(key), String(header)] })
    else seen.set(key, String(header))
  }
  const missing = columns.filter((entry) => entry.required && !seen.has(entry.key)).map((entry) => entry.key)
  return { keys, ignored, missing, duplicates }
}

// A CSV cell. Cells that a spreadsheet would read as a formula get a leading
// apostrophe, so a downloaded file cannot run one.
export function dataImportCsvCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// A UTF-8 CSV with a byte order mark, so spreadsheet programs read Chinese
// headers correctly.
export function dataImportCsv(rows) {
  return `﻿${rows.map((row) => row.map(dataImportCsvCell).join(',')).join('\r\n')}\r\n`
}

// The template: the header row in the chosen language and one example row.
export function dataImportTemplateCsv(type, language = 'en-US') {
  const columns = dataImportColumns(type)
  if (!columns) return null
  return dataImportCsv([
    columns.map((entry) => (language === 'zh-CN' ? entry.zh : entry.en)),
    columns.map((entry) => entry.example),
  ])
}
