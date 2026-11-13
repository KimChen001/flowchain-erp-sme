import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The receipt form and the receipt page on a phone, and what a posted
// receipt says about itself. The browser specs check the rendered pages.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const form = read('src/modules/procurement/ReceivingForm.tsx')
const page = read('src/modules/receiving/ReceivingPostingWorkbench.tsx')

test('below 768 px the receipt form draws each line as a card, the table above', () => {
  assert.match(form, /const phone = useMediaQuery\("\(max-width: 767\.98px\)"\)/)
  assert.match(form, /\{phone \? \(/)
  assert.match(form, /data-testid="receiving-form-cards"/)
  assert.match(form, /<FormLineCard key=\{view\.line\.id\}/)
  // The box has a tap target of at least 24 px on both.
  assert.match(form, /min-h-11 cursor-pointer items-center gap-3/)
  assert.match(form, /inline-flex h-7 w-7 cursor-pointer items-center justify-center/)
  // One set of controls, so each keeps its one name and its message.
  for (const name of ['tr("include")} ${line.sku}', 'tr("accepted")} ${line.sku}', 'tr("rejected")} ${line.sku}', 'tr("rejectionReason")} ${line.sku}', 'tr("location")} ${line.sku}']) {
    assert.equal(form.split(name).length - 1, 1, name)
  }
  assert.match(form, /invalidProps\(errorId\("reason"\), issue\.reason\)/)
})

test('the form says Save and submit: submitting does not post', () => {
  assert.match(form, /saveSubmit: \["Save and submit", "保存并提交"\]/)
  assert.doesNotMatch(form, /Save and submit for posting|保存并提交过账/)
})

test('a posted or reversed receipt shows one status, and its creation reads Recorded', () => {
  assert.match(page, /const settled = grn\.postingStatus === "posted" \|\| grn\.postingStatus === "reversed"/)
  assert.match(page, /\? \[\[say\("Status", "状态"\), chip\(grn\.postingStatus\)\]\]/)
  assert.match(page, /event\.postedFact && event\.event !== "receiving_created" \? say\("Posted", "已过账"\) : say\("Recorded", "已记录"\)/)
})

test('the receipt page shows the rejection reason, turns its lines into cards on a phone and puts Post first', () => {
  assert.match(page, /data-testid="receiving-line-rejection-reason"/)
  assert.match(page, /ref=\{listTableCardsRef\} data-testid="receiving-lines"/)
  assert.match(page, /data-card-title=\{label === itemColumn \? "" : undefined\}/)
  // The next step comes before Print: Submit for a draft, Post once submitted.
  const actions = page.slice(page.indexOf('The next step first'))
  const at = (marker) => actions.indexOf(marker)
  assert.ok(at('receiving-submit-draft') < at('receiving-print-sheet'))
  assert.ok(at('{operation === "post" && actionButton}') < at('receiving-print-sheet'))
  assert.match(page, /data-testid="receiving-ready-note"/)
})
