import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { expandPathRegex, findWriteRouteCallers, urlReachesRoute } from '../../scripts/test-support/write-route-callers.mjs'

// Every write route (POST, PUT, PATCH, DELETE) the server answers under
// server/routes has a caller in the app (src/), or is listed below with the
// reason it has none (design audit L13, test strategy 4). A browser test that
// creates a record through the API passes even when no screen can do it, as
// the credit memo tests did (L2-02); this test fails instead.
//
// A pull request that adds a write route either calls it from the app or adds
// it to NO_APP_CALLER with a one-sentence reason. A pull request that gives a
// listed route a caller, or removes it, takes it off the list.
//
// How routes and requests are read: scripts/test-support/write-route-callers.mjs.

const root = fileURLToPath(new URL('../../', import.meta.url))

// Route files whose method checks the reader cannot place, with their routes
// written out by hand. `checks` is the number of method checks the reader
// leaves unplaced in the file: when it changes, read the file again and update
// the routes here.
const HAND_READ_ROUTES = {
  // The path is split by hand: prefix, then "import", "<id>" or "<id>/reindex".
  'server/routes/ai-knowledge.routes.mjs': {
    checks: 5,
    routes: [
      'POST /api/ai-runtime/knowledge',
      'POST /api/ai-runtime/knowledge/import',
      'POST /api/ai-runtime/knowledge/:id/reindex',
      'DELETE /api/ai-runtime/knowledge/:id',
    ],
  },
}

// Paths the reader takes from a route regex that are not routes.
const NOT_ROUTES = {
  'POST /api/inventory/transfers/:id': 'The POST branch needs an action after the id; without one it answers 404 INVENTORY_OPERATION_NOT_FOUND.',
  'POST /api/inventory/counts/:id': 'The POST branch needs an action after the id; without one it answers 404 INVENTORY_OPERATION_NOT_FOUND.',
  'POST /api/inventory/adjustments/:id': 'The POST branch needs an action after the id; without one it answers 404 INVENTORY_OPERATION_NOT_FOUND.',
}

const CREDIT_DOCUMENTS = 'No screen creates, approves or cancels credit memos or credit notes yet (audit L2-02; planned for December steps 9-10).'
const FROZEN_SETTLEMENT = 'Internal settlement, cashbook and the settlement workflow are frozen (shared/unavailable-product-routes.mjs); no screen sends this step.'
const BANK_STEP = 'The bank reconciliation workbench imports, parses, validates, commits, matches and reverses; it has no control for this step.'
const RECEIVABLE_STEP = 'The receivable screens offer only Record payment; dispute, resolve and external reference have no control yet.'
const EXPORT_HIDDEN = 'FlowChain has no export yet, so the supplier invoice page hides Mark export ready (audit L2-15); the command stays for the export work.'
const INTAKE_STEP ='The intake page pastes or uploads, maps, normalizes, validates, reviews and excludes records; it has no control for this step yet.'
const MOBILE_SYNC = 'Offline mobile sync protocol; its client is not in this repository, and the route and Postgres tests drive it.'

// Write routes with no caller in the app, each with the reason.
const NO_APP_CALLER = {
  // Credit memos (supplier) and credit notes (customer): audit L2-02.
  'POST /api/finance/supplier-credit-memos': CREDIT_DOCUMENTS,
  'POST /api/finance/supplier-credit-memos/preview': CREDIT_DOCUMENTS,
  'POST /api/finance/supplier-credit-memos/:id/approve': CREDIT_DOCUMENTS,
  'POST /api/finance/supplier-credit-memos/:id/approve-preview': CREDIT_DOCUMENTS,
  'POST /api/finance/supplier-credit-memos/:id/cancel': CREDIT_DOCUMENTS,
  'POST /api/finance/supplier-credit-memos/:id/cancel-preview': CREDIT_DOCUMENTS,
  'POST /api/finance/customer-credit-notes': CREDIT_DOCUMENTS,
  'POST /api/finance/customer-credit-notes/preview': CREDIT_DOCUMENTS,
  'POST /api/finance/customer-credit-notes/:id/approve': CREDIT_DOCUMENTS,
  'POST /api/finance/customer-credit-notes/:id/approve-preview': CREDIT_DOCUMENTS,
  'POST /api/finance/customer-credit-notes/:id/cancel': CREDIT_DOCUMENTS,
  'POST /api/finance/customer-credit-notes/:id/cancel-preview': CREDIT_DOCUMENTS,

  // Frozen modules.
  'POST /api/finance/advance-applications': FROZEN_SETTLEMENT,
  'POST /api/finance/advance-applications/:id/submit': FROZEN_SETTLEMENT,
  'POST /api/finance/advance-applications/:id/approve': FROZEN_SETTLEMENT,
  'POST /api/finance/advance-applications/:id/post': FROZEN_SETTLEMENT,
  'POST /api/finance/advance-applications/:id/reverse': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/preview': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/revise': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/submit': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/approve': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/reject': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/cancel': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/post': FROZEN_SETTLEMENT,
  'POST /api/finance/internal-transfers/:id/reverse': FROZEN_SETTLEMENT,
  'POST /api/finance/settlements/:id/revise': FROZEN_SETTLEMENT,
  'PATCH /api/finance/bank-mappings/:id': BANK_STEP,
  'POST /api/finance/bank-statements/batches/:id/preview': BANK_STEP,
  'POST /api/finance/bank-statements/batches/:id/void': BANK_STEP,
  'PATCH /api/finance/bank-statements/batches/:id/rows/:id': BANK_STEP,
  'POST /api/finance/bank-statements/batches/:id/rows/:id/exclude': BANK_STEP,
  'POST /api/finance/bank-statements/batches/:id/rows/:id/accept-duplicate': BANK_STEP,
  'POST /api/finance/bank-reconciliation/candidates/:id/dismiss': BANK_STEP,
  'POST /api/finance/bank-reconciliation/exceptions/:id/resolve': BANK_STEP,
  'PATCH /api/finance/bank-reconciliation/groups/:id': BANK_STEP,
  'POST /api/finance/bank-reconciliation/integrity/refresh': BANK_STEP,

  // Steps the screens do not offer yet.
  'POST /api/finance/receivables/:id/dispute': RECEIVABLE_STEP,
  'POST /api/finance/receivables/:id/dispute-preview': RECEIVABLE_STEP,
  'POST /api/finance/receivables/:id/resolve-dispute': RECEIVABLE_STEP,
  'POST /api/finance/receivables/:id/resolve-dispute-preview': RECEIVABLE_STEP,
  'POST /api/finance/receivables/:id/record-external-reference': RECEIVABLE_STEP,
  'POST /api/finance/receivables/:id/record-external-reference-preview': RECEIVABLE_STEP,
  'POST /api/finance/payables/:id/mark-export-ready': EXPORT_HIDDEN,
  'POST /api/finance/payables/:id/mark-export-ready-preview': EXPORT_HIDDEN,
  'PATCH /api/finance/supplier-invoices/:id':'The supplier invoice page leaves out the revise step, so no screen edits a saved invoice.',
  'POST /api/intake/batches': INTAKE_STEP,
  'POST /api/intake/batches/:id/cancel': INTAKE_STEP,
  'POST /api/intake/batches/:id/commit': INTAKE_STEP,
  'POST /api/intake/batches/:id/profile/select-header': INTAKE_STEP,
  'POST /api/intake/batches/:id/profile/select-sheet': INTAKE_STEP,
  'POST /api/intake/batches/:id/records': INTAKE_STEP,
  'POST /api/intake/batches/:id/transitions': INTAKE_STEP,
  'POST /api/intake/issues/:id/resolve': INTAKE_STEP,
  'POST /api/intake/mapping-profiles': INTAKE_STEP,
  'POST /api/intake/mapping-profiles/:id/activate': INTAKE_STEP,
  'POST /api/intake/mapping-profiles/:id/retire': INTAKE_STEP,
  'PATCH /api/returns/postings/:id': 'Returns stay off until December step 7, and the return posting page does not edit a posting draft yet.',
  'PATCH /api/mobile/receiving/drafts/:id': 'The phone receiving page creates, submits and posts a draft; it does not revise one.',
  'POST /api/procurement/orders/:id/return-for-revision': 'The desktop PO page has no Return for revision; the phone uses /api/mobile/purchase-orders/:id/return-for-revision.',
  'POST /api/report-views/:id/share': 'The reports page saves, updates, clones and deletes views; it has no share action.',
  'DELETE /api/attachments/:id': 'No screen deletes an attachment by id; contract files use DELETE /api/contracts/:id/attachments/:id.',

  // Older and retired routes.
  'POST /api/inventory/items': 'Answers 501: balances change only through transfers, counts and adjustments.',
  'POST /api/sales-demand/orders': 'Answers 501: sales orders are created through POST /api/sales/orders.',

  // Used outside the web app.
  'POST /api/sync/clients/register': MOBILE_SYNC,
  'POST /api/sync/acknowledge': MOBILE_SYNC,
  'POST /api/sync/clients/:id/revoke': MOBILE_SYNC,
}

const handRoutes = Object.entries(HAND_READ_ROUTES).flatMap(([file, entry]) => entry.routes.map((key) => ({ key, source: file })))
const scan = findWriteRouteCallers(root, { extraRoutes: handRoutes })
const byKey = new Map(scan.routes.map((route) => [route.key, route]))
const describe = (route) => `${route.key}  (${route.sources[0]})`

test('every write route has a caller in the app or a stated reason', () => {
  const missing = scan.routes.filter((route) => !route.callers.length && !NOT_ROUTES[route.key] && !NO_APP_CALLER[route.key])
  assert.deepEqual(missing.map(describe), [], 'These write routes have no caller in src/. Call them from the app, or add each to NO_APP_CALLER in this file with a one-sentence reason.')
})

test('each route listed without a caller still exists and still has no caller', () => {
  for (const [list, entries] of [['NO_APP_CALLER', NO_APP_CALLER], ['NOT_ROUTES', NOT_ROUTES]]) {
    const gone = Object.keys(entries).filter((key) => !byKey.has(key))
    assert.deepEqual(gone, [], `${list} names routes the server no longer answers; take them off the list.`)
    const called = Object.keys(entries).filter((key) => byKey.get(key)?.callers.length).map((key) => `${key}  <- ${byKey.get(key).callers.join(', ')}`)
    assert.deepEqual(called, [], `${list} names routes the app now calls; take them off the list.`)
  }
  for (const [key, reason] of Object.entries({ ...NO_APP_CALLER, ...NOT_ROUTES })) {
    assert.match(reason, /\S.*\.$/, `${key} needs a one-sentence reason`)
  }
})

test('the reader places every write-method check, or the file is read by hand', () => {
  const unplaced = {}
  for (const check of scan.unresolved) unplaced[check.file] = [...(unplaced[check.file] || []), `${check.file}:${check.line} ${check.text}`]
  for (const [file, checks] of Object.entries(unplaced)) {
    assert.ok(HAND_READ_ROUTES[file], `The reader could not find the path for these method checks; write the route more plainly, or list the file in HAND_READ_ROUTES:\n${checks.join('\n')}`)
    assert.equal(checks.length, HAND_READ_ROUTES[file].checks, `${file} changed (${checks.length} unplaced method checks, ${HAND_READ_ROUTES[file].checks} expected); read it again and update HAND_READ_ROUTES.`)
  }
  for (const file of Object.keys(HAND_READ_ROUTES)) assert.ok(unplaced[file], `${file} is read by hand but the reader now places all its checks; take it out of HAND_READ_ROUTES.`)
})

test('the reader finds the routes and callers it is known to find', () => {
  assert.ok(scan.routes.length > 250, `only ${scan.routes.length} write routes found`)
  const callersOf = (key) => {
    assert.ok(byKey.has(key), `${key} not found`)
    return byKey.get(key).callers.join(' ')
  }
  // A path the app reads (GET) is not a caller of its POST: the L2-02 case.
  assert.equal(callersOf('POST /api/finance/supplier-credit-memos'), '')
  // A literal url; a url passed as a component prop; a regex route with actions.
  assert.match(callersOf('POST /api/finance/supplier-invoices'), /SupplierInvoiceScreens\.tsx/)
  assert.match(callersOf('POST /api/finance/supplier-invoices/:id/approve'), /FinanceControls\.tsx/)
  // A url built by a helper that returns { url, body }.
  assert.match(callersOf('POST /api/procurement/requests/:id/direct-purchase-order'), /RecordActionsPart\.tsx/)
  // A path held in a variable assigned in several branches.
  assert.match(callersOf('POST /api/sales/orders/:id/reservations/reserve'), /OutboundWorkbench\.tsx/)
  // A url taken from a lookup table and rewritten with .replace().
  assert.match(callersOf('POST /api/inventory/transfers/:id/:id'), /InventoryOperationsWorkbench\.tsx/)
  // A route file read by hand.
  assert.match(callersOf('POST /api/ai-runtime/knowledge/:id/reindex'), /KnowledgeLibrary\.tsx/)
})

test('path regexes expand into one route per alternative', () => {
  const paths = expandPathRegex(String.raw`/^\/api\/x\/([^/]+)(?:\/(submit|approve))?$/`).map((option) => option.path)
  assert.deepEqual(paths, ['/api/x/:id', '/api/x/:id/submit', '/api/x/:id/approve'])
  const [option] = expandPathRegex(String.raw`/^\/api\/x\/([^/]+)\/(cancel)$/`)
  assert.deepEqual(option.groups, { 1: ':id', 2: 'cancel' })
})

test('a request url reaches a route only where its unknown parts can stand for the route', () => {
  const words = new Set(['approve'])
  assert.equal(urlReachesRoute('/api/x/\u0001/approve', '/api/x/:id/approve'), true)
  // An unknown action reaches only the actions the calling files name.
  assert.equal(urlReachesRoute('/api/x/\u0001/*', '/api/x/:id/approve', words), true)
  assert.equal(urlReachesRoute('/api/x/\u0001/*', '/api/x/:id/reject', words), false)
  // An encoded id stays within one segment.
  assert.equal(urlReachesRoute('/api/x/\u0001', '/api/x/:id/approve', words), false)
  // A route parameter takes a fixed action from the url.
  assert.equal(urlReachesRoute('/api/x/\u0001/post', '/api/x/:id/:id'), true)
  assert.equal(urlReachesRoute('/api/x', '/api/x/:id'), false)
})
