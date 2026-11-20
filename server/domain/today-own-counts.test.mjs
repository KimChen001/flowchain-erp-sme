import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { todayRowsNotShown } from '../../src/modules/overview/todayRows.ts'

// Product review 2026-11-20: Today said "{n} more are not shown here" where n
// was the decision cards already shown above it, and "Nothing needs action
// right now" while decisions waited; Priorities counted the decisions and
// listed none of them.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const row = (kind, recordId) => ({ kind, recordId })

test('rows not shown are the server\'s rows beyond the list, never the decision cards', () => {
  const listed = [row('purchase_order_overdue', 'PO-1'), row('reorder_now', 'SKU-1'), row('supplier_invoice_held', 'SI-1')]
  // Three rows, all listed; two became decision cards: nothing is hidden.
  assert.equal(todayRowsNotShown({ workTotal: 3, workItems: listed }, new Set(['purchase_order_overdue:PO-1', 'reorder_now:SKU-1'])), 0)
  // The server has 10 and sent 3: 7 are not shown.
  assert.equal(todayRowsNotShown({ workTotal: 10, workItems: listed }, new Set()), 7)
  // Two of the 7 beyond the list are decision cards (shown above): 5.
  assert.equal(todayRowsNotShown({ workTotal: 10, workItems: listed }, new Set(['purchase_order_overdue:PO-9', 'reorder_now:SKU-9', 'reorder_now:SKU-1'])), 5)
  // No total sent, or no overview: nothing claimed.
  assert.equal(todayRowsNotShown({ workItems: listed }, new Set()), 0)
  assert.equal(todayRowsNotShown(null, new Set()), 0)
})

test('Today\'s list says so when only decisions wait, and counts only rows beyond the list', () => {
  const page = read('src/modules/overview/Page.tsx')
  assert.match(page, /const notShown = todayRowsNotShown\(overview, decisionKeys\)/)
  assert.match(page, /\{t\("moreNotShown", \{ n: notShown \}\)\}/)
  assert.doesNotMatch(page, /workTotal - items\.length/)
  assert.match(page, /waiting\.length \? t\("noOtherWork"\) : t\("noWork"\)/)
  // The Overdue view says the same when overdue decisions wait above.
  assert.match(page, /filter === "overdue" \? \(waiting\.some\(\(entry\) => entry\.row\.overdueDays > 0\) \? t\("noOtherOverdueWork"\) : t\("noOverdueWork"\)\)/)
  assert.match(page, /if \(state === "loaded" && hash === "#today-decisions"\) document\.getElementById\("today-decisions"\)\?\.scrollIntoView/)
  assert.match(page, /<div id="today-decisions"/)
  const copy = read('src/modules/overview/todayCopy.ts')
  assert.match(copy, /noOtherWork: "Nothing else needs action\. The items waiting for your decision are above\.",/)
  assert.match(copy, /noOtherWork: "没有其他待处理事项。等你决定的事项在上方。",/)
  assert.match(copy, /noOtherOverdueWork: "Nothing else is overdue\. The overdue items waiting for your decision are above\.",/)
  assert.match(copy, /noOtherOverdueWork: "没有其他逾期事项。等你决定的逾期事项在上方。",/)
})

test('Priorities says how many wait for a decision on Today, with a link, instead of "nothing needs attention"', () => {
  const page = read('src/modules/overview/AiSuggestionsPage.tsx')
  assert.match(page, /data-testid="ai-priorities-decisions"/)
  // To the decision cards themselves, which Today scrolls to.
  assert.match(page, /<Link to="\/app\/overview\/risks#today-decisions"[^>]*>\{copy\.openDecisions\} →<\/Link>/)
  assert.match(page, /!items\.length && !waitingDecisions && <div className="py-8 text-center">/)
  for (const key of ['decisionsOne', 'decisionsMany', 'openDecisions']) {
    const pairs = [...page.matchAll(new RegExp(`    ${key}: "([^"]+)",`, 'g'))].map((match) => match[1])
    assert.equal(pairs.length, 2, key)
    assert.match(pairs[1], /[一-鿿]/, `${key} has its Chinese`)
  }
})
