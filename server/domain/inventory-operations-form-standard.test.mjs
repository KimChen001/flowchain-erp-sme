import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The inventory transfer, cycle count and adjustment create forms follow the
// entry form standard (src/components/ui/formLayout.tsx), as the purchase
// request, sales order and receipt forms do (ui-form-standard.test.mjs).
// tests/browser/inventory-operations.spec.ts checks the rendered forms.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const source = read('src/modules/inventory/InventoryOperationsWorkbench.tsx')
const between = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start > 0 && end > start, `${from} … ${to}`)
  return source.slice(start, end)
}
const FORMS = {
  TransferCreate: { body: between('function TransferCreate(', '\nfunction CountCreate('), save: 'create-transfer' },
  CountCreate: { body: between('function CountCreate(', '\nconst newRecordReasons'), save: 'create-count' },
  AdjustmentCreate: { body: between('function AdjustmentCreate(', '\nfunction OperationDetail('), save: 'create-adjustment' },
}

test('the inventory create forms use the header, sections and one action bar of the standard', () => {
  for (const [name, { body, save }] of Object.entries(FORMS)) {
    for (const part of ['ref={formRef}', '<FocusFirstField />', '<FormHeader', '<FormSection', '<FormActionBar', 'formGridClass', 'focusFirstInvalid(formRef.current)', 'formCopy("checkFields")']) {
      assert.ok(body.includes(part), `${name} uses ${part}`)
    }
    // The page's h1 names the form, so the header has no title of its own.
    assert.doesNotMatch(body, /<FormHeader title=/, name)
    assert.equal(body.split('<FormActionBar').length, 2, `${name} has one action bar`)
    assert.ok(body.lastIndexOf('</FormSection>') < body.indexOf('<FormActionBar'), `${name}: the bar comes after the sections`)
    // Save is the bar's one (primary) action, after Cancel. It is disabled
    // only while inventory operations are off, never for a missing field.
    assert.ok(body.includes(`disabled: !enabled(entry), testId: "${save}" }}`), `${name}: Save is disabled only by the capability`)
    assert.doesNotMatch(body, /draft=\{\{/, `${name} has one save action`)
    assert.doesNotMatch(body, /disabled=\{/, `${name} disables no control`)
    // The old single-card layout and its buttons are gone.
    assert.doesNotMatch(body, /className=\{(button|secondary)\}|CancelLink|<Card /, name)
  }
  assert.doesNotMatch(source, /function CancelLink|const formField|const formLabel/)
})

test('each form marks what the server refuses a save without and says it under the field', () => {
  const transfer = FORMS.TransferCreate.body
  assert.match(transfer, /<Field label=\{copy\("物料"\)\} required error=\{shown\[`\$\{at\}\.itemId`\]\}>/)
  assert.match(transfer, /<Field label=\{copy\("数量"\)\} required error=\{shown\[`\$\{at\}\.quantity`\]\}>/)
  // A route that does not move the stock is refused; the message sits under the target.
  assert.match(transfer, /<Field label=\{copy\("目标仓库"\)\} error=\{shown\[`\$\{at\}\.destinationWarehouseId`\]\}>/)
  // The server saves a draft without either warehouse, so neither is starred.
  assert.match(transfer, /<Field label=\{copy\("来源仓库"\)\}>/)
  // "Add line" sits in the lines section, under the lines, not in the bar.
  const add = transfer.indexOf('{copy("添加行")}')
  assert.ok(add > transfer.indexOf('<FormSection') && add < transfer.lastIndexOf('</FormSection>'), 'Add line is in the lines section')
  assert.match(transfer, /<FormLineCard[\s\S]*?remove=\{\{[\s\S]*?disabled: lines\.length < 2/)

  const count = FORMS.CountCreate.body
  assert.match(count, /<Field label=\{copy\("仓库"\)\} required error=\{shown\.warehouseId\}>/)
  // The stock records are a list, so "tick one" is a message about the whole form.
  assert.match(count, /formMessage\(Object\.keys\(shown\)\.length > 0, checked \? formIssues : \[\], error/)

  const adjustment = FORMS.AdjustmentCreate.body
  assert.match(adjustment, /<Field label=\{copy\("原因"\)\} required>/)
  for (const [label, field] of [['库存余额', 'inventoryBalanceId'], ['物料', 'itemId'], ['仓库', 'warehouseId'], ['调整数量', 'adjustmentQuantity']]) {
    assert.match(adjustment, new RegExp(`<Field label=\\{copy\\("${label}"\\)\\} required error=\\{shown\\[\`\\$\\{at\\}\\.${field}\`\\]\\}>`), field)
  }
  // Notes are needed only for the reason Other: not starred, aria-required then.
  assert.match(adjustment, /<Field label=\{copy\("备注"\)\} error=\{shown\.notes\}>/)
  assert.match(adjustment, /aria-required=\{reasonCode === "other"\}/)
  // The server's opening-stock refusal goes under the line's location.
  assert.match(adjustment, /code === "ADJUSTMENT_OPENING_BALANCE_EXISTS" \? openingConflictFields\(\)/)
  assert.match(adjustment, /<Field label=\{copy\("Location"\)\} error=\{shown\[`\$\{at\}\.location`\]\}>/)
  // The reserved-stock note is help text, not a warning.
  const note = adjustment.slice(adjustment.indexOf('{line.mode === "existing" && ('))
  assert.match(note.slice(0, 400), /helpTextClass[\s\S]*color: A\.gray2[\s\S]*减少库存不会影响已预留数量/)
  assert.doesNotMatch(note.slice(0, 400), /amber/)
})

test('the forms check the same rules as the server', () => {
  // The quantity is read with the server's own pattern (outboundDecimalUnits).
  const server = read('server/domain/outbound-transaction-policy.mjs')
  const pattern = '/^-?\\d+(?:\\.\\d+)?$/'
  assert.ok(server.includes(`if (!${pattern}.test(raw))`), 'the server pattern is unchanged')
  assert.ok(source.includes(`if (!${pattern}.test(raw)) return null;`), 'the forms use the server pattern')
  const command = read('server/domain/inventory-operations-command-service.mjs')
  // A transfer: an item, a positive quantity and a target that is not the source.
  assert.match(command, /!item \|\|\s*quantity <= 0n \|\|\s*`\$\{source\.warehouseId\}\|\$\{source\.locationKey\}` ===\s*`\$\{destination\.warehouseId\}\|\$\{destination\.locationKey\}`/)
  // A count: a warehouse and at least one stock record.
  assert.match(command, /if \(!warehouseId \|\| !balanceIds\.length\)/)
  // An adjustment: notes for Other, never a zero quantity.
  assert.match(command, /reasonCode === "other" && !text\(payload\.notes\)/)
  assert.match(command, /if \(delta === 0n\)/)
})
