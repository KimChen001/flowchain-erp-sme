import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The entry form standard (src/components/ui/formLayout.tsx) and the three
// forms that follow it. The browser specs check the rendered forms.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const FORMS = [
  'src/modules/purchase-requests/CanonicalProcurementPanel.tsx',
  'src/modules/sales/OutboundWorkbench.tsx',
  'src/modules/procurement/ReceivingForm.tsx',
]

test('the form standard sits beside the shared UI and covers sections, fields, required marks, messages and actions', () => {
  const layout = read('src/components/ui/formLayout.tsx')
  for (const topic of [/1\. Sections\./, /2\. Fields\./, /3\. Required fields\./, /4\. Validation\./, /5\. Actions\./]) assert.match(layout, topic)
  for (const name of ['FormHeader', 'FormSection', 'FormLineCard', 'FormActionBar', 'RequiredNote', 'RequiredMark', 'FieldError', 'focusFirstInvalid', 'formGridClass']) {
    assert.match(layout, new RegExp(`export (function|const) ${name}\\b`), name)
  }
  assert.match(layout, /required: \["Required", "必填"\]/)
  assert.match(layout, /formGridClass = "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4"/)
  // Cancel · Save draft · Submit, the primary action last.
  const bar = layout.slice(layout.indexOf('export function FormActionBar'))
  const order = ['say("cancel")', '{draft && button(draft, false)}', '{button(submit, true)}'].map((part) => bar.indexOf(part))
  assert.ok(order.every((at) => at > 0), 'the bar renders Cancel, the draft action and the submit action')
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  // Stuck to the bottom of main, whose own bottom padding clears the
  // assistant button; an offset here would count that room twice.
  assert.match(bar, /sticky bottom-0 /)
  const app = read('src/app/FlowChainApp.tsx')
  assert.match(app, /<main\s+className="[^"]*pb-20 sm:p-6 sm:pb-24"/)
  for (const file of FORMS) assert.doesNotMatch(read(file), /ref=\{formRef\} className="[^"]*\bpb-/, `${file} adds no bottom padding of its own`)
})

test('Field marks a required control and ties a message to it', () => {
  const ui = read('src/components/ui/index.tsx')
  assert.match(ui, /required = false, error/)
  assert.match(ui, /"aria-required": true/)
  assert.match(ui, /"aria-invalid": true, "aria-describedby"/)
  // The "*" is outside the label, so the label still names the control alone.
  assert.match(ui, /\{labelElement\}<span aria-hidden="true" className="[^"]*text-blue-600">\*<\/span>/)
})

test('the purchase request, sales order and receipt forms use the standard', () => {
  for (const file of FORMS) {
    const source = read(file)
    for (const part of ['<FormHeader', '<FormSection', '<FormActionBar', 'focusFirstInvalid(formRef.current)', '<FocusFirstField />', 'formGridClass']) {
      assert.ok(source.includes(part), `${file} uses ${part}`)
    }
  }
  // Save is never disabled to hide a missing field.
  assert.doesNotMatch(read(FORMS[1]), /disabled=\{saving \|\| !customerId/)
  // The purchase request form marks what the server refuses a line without.
  const requests = read(FORMS[0])
  for (const name of ['supplierId', 'quantity', 'estimatedUnitPrice', 'estimatedAmount', 'needByDate']) {
    assert.match(requests, new RegExp(`required error=\\{lineError\\(index, "${name}"\\)\\}`), name)
  }
  // A field path never reaches the person: errors without a message fall back to a sentence.
  assert.doesNotMatch(requests, /copy\(e\.message \|\| e\.field\)/)
})
