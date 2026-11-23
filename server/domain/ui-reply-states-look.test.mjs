import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SUPPLIER_REPLY_COPY } from '../../src/modules/purchasing/supplierReply/supplierReplyCopy.ts'

// Procurement look pass, the supplier-reply card's new states (review 11/23):
// a held line's reason that stands on its own line starts with a capital in
// English. The copy is written to follow "Item — " in the Not used list, so
// it starts in lower case; only the standalone places capitalise it, by CSS.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test("a held line's reason starts with a capital where it stands alone, and stays lower case after a dash", () => {
  const card = read('src/modules/purchasing/supplierReply/SupplierReplyCard.tsx')
  // The question box of a proposed card and the manual form: both standalone.
  const standalone = '<div className="text-amber-800 first-letter:uppercase" data-testid="supplier-reply-line-issue">{t(`issue_${line.issue}` as SupplierReplyCopyKey)}</div>'
  assert.equal(card.split(standalone).length - 1, 2)
  assert.ok(!card.includes('<div className="text-amber-800">{t(`issue_'))
  // The Not used list keeps the reason after the item name and a dash (its
  // condition may change: the several-orders note can say a reason once).
  assert.ok(card.includes(' ? ` — ${t(`issue_${line.issue}` as SupplierReplyCopyKey)}` : ""}'))
  // The copy itself is unchanged: the new reasons start in lower case in
  // English (so the capital comes from CSS), and Chinese has no case.
  for (const key of ['issue_several_orders', 'issue_correction_across_orders', 'issue_line_mismatch', 'issue_other_order_text', 'issue_no_order_part', 'issue_refused', 'issue_addressed_to_system']) {
    const [english, chinese] = SUPPLIER_REPLY_COPY[key]
    assert.match(english, /^[a-z]/, key)
    assert.ok(chinese && chinese !== english, key)
  }
})
