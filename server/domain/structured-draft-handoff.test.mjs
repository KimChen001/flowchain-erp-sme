import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('the text draft review shell, its message helpers and their draft calls are gone from the app', () => {
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  for (const file of ['ActionDraftReviewShell.tsx', 'draftMessage.ts']) {
    assert.equal(fs.existsSync(path.join(repoRoot, 'src', 'modules', 'action-drafts', file)), false, file)
  }
  assert.doesNotMatch(app, /ActionDraftReviewShell|onReviewActionDraft|\/api\/action-drafts\/(?:preview|save)/)
  assert.doesNotMatch(app, /\/api\/purchase-requests/)
})

test('structured AI drafts open the formal creation page through one helper', () => {
  // An RFQ starts from an approved purchase request, so an RFQ draft opens that form.
  const handoff = readSource('src', 'modules', 'action-drafts', 'structuredDraftHandoff.ts')
  assert.match(handoff, /"procurement:requests"/)
  assert.match(handoff, /intent: type === "rfq_draft" \? "rfq" : undefined/)
  assert.doesNotMatch(handoff, /procurement:rfq/)
  // The assistant's in-chat request form opens the full form through the helper.
  const form = readSource('src', 'modules', 'ai-assistant', 'v2', 'parts', 'PurchaseRequestFormPart.tsx')
  assert.match(form, /structuredDraftTarget\("purchase_request_draft", \{ itemIdOrSku: handoffLine\.row\.item\.sku/)
  const inventory = readSource('src', 'modules', 'inventory', 'Page.tsx')
  assert.match(inventory, /<EntityLink kind="item"/)
  assert.doesNotMatch(inventory, /\/api\/master-data\/items\/.*\/suppliers/)
  assert.doesNotMatch(inventory, /维护供应商关系/)
  assert.doesNotMatch(inventory, /inventory_replenishment|预览 PR/)
})
