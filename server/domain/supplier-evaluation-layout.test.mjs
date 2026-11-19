import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The Supplier evaluation table was 69 px wider than its card at 1440 px and
// 143 px wider at 1366 px, so the sticky Actions column covered the Tier
// column. Measured in the browser, these limits bring it inside the card at
// both widths: the Business owner header wraps, the name column is capped at
// 170 px, the six figure columns are tighter, and the table's floor is 1,040 px.
const page = readFileSync(new URL('../../src/modules/srm/SupplierEvaluationPage.tsx', import.meta.url), 'utf8')
const lines = page.split('\n')
const px = (line, prefix) => Number((line.match(new RegExp(`${prefix}-\\[(\\d+)px\\]`)) || [])[1])

test('the table floor leaves room for the card on a 1366 px screen', () => {
  const table = lines.find((line) => line.includes('data-testid="supplier-evaluation-table"') && line.includes('<table'))
  assert.ok(table, 'table not found')
  assert.ok(px(table, 'min-w') <= 1040, `table min width ${px(table, 'min-w')}`)
})

test('the Business owner header wraps within 104 px', () => {
  const header = lines.find((line) => line.includes('t("Business owner")') && line.includes('<th'))
  assert.ok(header, 'Business owner header not found')
  assert.match(header, /!whitespace-normal/)
  assert.ok(px(header, 'max-w') <= 104)
})

test('the supplier name column is capped at 170 px', () => {
  const cell = lines.find((line) => line.includes('title={row.supplierName}') && line.includes('<td'))
  assert.ok(cell, 'supplier name cell not found')
  assert.ok(px(cell, 'max-w') > 0 && px(cell, 'max-w') <= 170, `name column max width ${px(cell, 'max-w')}`)
})

test('the six figure columns use tighter padding and a 72 px floor', () => {
  const header = lines.find((line) => line.includes('METRIC_HEADERS.map'))
  assert.match(header, /!px-3/)
  assert.ok(px(header, 'min-w') <= 72)
  const figureCells = lines.filter((line) => line.includes('tdNumericRightClass') && line.includes('<td'))
  assert.equal(figureCells.length, 6)
  for (const cell of figureCells) assert.match(cell, /!px-3/)
})
