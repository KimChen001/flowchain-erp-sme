import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DATA_IMPORT_COLUMNS,
  DATA_IMPORT_KNOWN_IGNORED_COLUMNS,
  DATA_IMPORT_TYPES,
  dataImportCsv,
  dataImportCsvCell,
  dataImportTemplateCsv,
  mapDataImportHeaders,
  normalizeDataImportHeader,
} from '../../shared/data-import-columns.mjs'

// Lives with the server tests so npm test runs it; the columns file is
// shared by the server and the client.
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

// The item export's headers, in order, and their Chinese labels as the
// master data copy translates them.
function itemExportHeaders() {
  const exportSource = source('src/modules/master-data/export.ts')
  const items = exportSource.slice(exportSource.indexOf('items: {'), exportSource.indexOf('warehouses: {'))
  // A column items do not record is exported empty ("").
  const english = [...items.matchAll(/\["([^"]+)",\s*(?:item\.|yesNo|copy|"")/g)].map((match) => match[1])
  const copy = source('src/modules/master-data/masterDataFormat.ts')
  const chinese = (label) => copy.match(new RegExp(`"${label.replace(/[()]/g, '\\$&')}":\\s*"([^"]+)"`))?.[1] || label
  return english.map((en) => ({ en, zh: chinese(en) }))
}

test('the item columns are the item export headers, so an exported file imports again', () => {
  const exported = itemExportHeaders()
  assert.equal(exported.length, 17)
  const imported = DATA_IMPORT_COLUMNS.items.map(({ en, zh }) => ({ en, zh }))
  const ignored = DATA_IMPORT_KNOWN_IGNORED_COLUMNS.items.map(({ en, zh }) => ({ en, zh }))
  // Every export header is either read or reported as ignored, in both languages.
  assert.deepEqual([...imported, ...ignored].sort((a, b) => a.en.localeCompare(b.en)), [...exported].sort((a, b) => a.en.localeCompare(b.en)))
  // And the read ones keep the export's order.
  assert.deepEqual(imported.map((row) => row.en), exported.filter((row) => imported.some((entry) => entry.en === row.en)).map((row) => row.en))
  for (const language of ['en', 'zh']) {
    const mapped = mapDataImportHeaders('items', exported.map((row) => row[language]))
    assert.deepEqual(mapped.missing, [], language)
    assert.deepEqual(mapped.ignored.map((row) => row.reason), Array(6).fill('not_imported'), language)
  }
})

test('every header name points at one column of its type', () => {
  for (const type of DATA_IMPORT_TYPES) {
    const owner = new Map()
    for (const column of DATA_IMPORT_COLUMNS[type]) {
      for (const name of [column.key, column.en, column.zh, ...column.aliases]) {
        const key = normalizeDataImportHeader(name)
        assert.ok(!owner.has(key) || owner.get(key) === column.key, `${type}: "${name}" names ${owner.get(key)} and ${column.key}`)
        owner.set(key, column.key)
      }
      assert.ok(column.en && column.zh, `${type}.${column.key} needs both labels`)
    }
    assert.ok(DATA_IMPORT_COLUMNS[type].some((column) => column.required), type)
  }
  assert.equal(normalizeDataImportHeader('  Lead_time （days） '), 'lead time (days)')
})

test('a template is a UTF-8 CSV with a byte order mark, a header row and one example row', () => {
  const english = dataImportTemplateCsv('suppliers')
  assert.ok(english.startsWith('﻿Supplier code,Supplier name,'))
  const lines = english.slice(1).trim().split('\r\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /^SUP-001,Boston Components,/)
  assert.ok(lines[1].includes('"1 Main St, Boston, MA"'))
  assert.ok(dataImportTemplateCsv('opening-stock', 'zh-CN').startsWith('﻿SKU,仓库编码,库位,数量,单位\r\n'))
  assert.equal(dataImportTemplateCsv('widgets'), null)
  // The template's own headers map back to every column.
  for (const type of DATA_IMPORT_TYPES) {
    for (const language of ['en-US', 'zh-CN']) {
      const header = dataImportTemplateCsv(type, language).slice(1).split('\r\n')[0].split(',')
      const mapped = mapDataImportHeaders(type, header)
      assert.deepEqual([mapped.missing, mapped.ignored, mapped.duplicates], [[], [], []], `${type} ${language}`)
    }
  }
})

test('a downloaded cell cannot start a spreadsheet formula', () => {
  assert.equal(dataImportCsvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  for (const value of ['+1', '-1', '@SUM(A1)']) assert.equal(dataImportCsvCell(value), `'${value}`)
  assert.equal(dataImportCsvCell('a,b'), '"a,b"')
  assert.equal(dataImportCsvCell(null), '')
  assert.equal(dataImportCsv([['A'], ['=1']]), '﻿A\r\n\'=1\r\n')
})
