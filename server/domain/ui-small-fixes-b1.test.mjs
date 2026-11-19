import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { listAuditEntries } from '../repositories/audit-log-repository.mjs'
import { statusCodeLabel } from '../../src/i18n/statusLabels.ts'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

// Design audit batch B1, small interface fixes. The PO history panel and its
// labels (L16 with U-02) and opening a receipt by its number (L1-24) are also
// tested against PostgreSQL in tests/postgres/procurement-db-flow.test.mjs.

// L11-26: the regexes read `(d+)`, so no English finding matched and the
// Chinese readiness page showed every detail empty.
test('the Chinese readiness check reads every finding with its counts', async () => {
  const source = await read('src/modules/settings/WorkspaceSettings.tsx')
  const block = source.slice(source.indexOf('const DIAGNOSTIC_DETAILS'), source.indexOf('];', source.indexOf('const DIAGNOSTIC_DETAILS')))
  assert.doesNotMatch(block, /\(d\+\)/)
  const rules = [...block.matchAll(/\[\/(.+?)\/, \(m?\) => [`"](.+?)[`"]\]/g)].map(([, pattern, chinese]) => [new RegExp(pattern), chinese])
  assert.equal(rules.length, 7)
  const fill = (template, match) => template.replace(/\$\{m\[(\d)\]\}/g, (_, index) => match[Number(index)])
  for (const [english, chinese] of [
    ['12 migrations applied', '已应用 12 个数据库迁移'],
    ['2 active warehouses', '2 个启用仓库'],
    ['3 active users; 1 can manage roles', '3 个启用用户；1 人可管理角色'],
    ['1 active user without warehouse scope', '1 个启用用户未设置仓库范围'],
    ['4 pending; 0 blocked or failed', '4 个待处理；0 个被阻止或失败'],
  ]) {
    const rule = rules.find(([pattern]) => pattern.test(english))
    assert.ok(rule, english)
    assert.equal(fill(rule[1], english.match(rule[0])), chinese)
  }
})

// L16: the PO page asks for its history as "purchaseOrder"; the commands
// record "PurchaseOrder". The audit filter matches either case.
test('the audit log finds a document\'s history whatever the case of its type', () => {
  const db = { auditLog: [
    { id: 'a1', entityType: 'PurchaseOrder', entityId: 'PO-1', action: 'purchase_order_approve' },
    { id: 'a2', entity: { type: 'PurchaseOrder', id: 'PO-1' }, entityId: 'PO-1', action: 'purchase_order_issue' },
    { id: 'a3', entityType: 'PurchaseRequest', entityId: 'PO-1', action: 'purchase_request_approve' },
  ] }
  assert.deepEqual(listAuditEntries(db, { entityType: 'purchaseOrder', entityId: 'PO-1' }).map((entry) => entry.id), ['a1', 'a2'])
})

// U-02: once the panel had entries, its labels were Chinese only and statuses raw codes.
test('the document history panel speaks the reader\'s language and hides command bookkeeping', async () => {
  const source = await read('src/components/ui/index.tsx')
  assert.match(source, /purchase_order_approve: \["Approved", "已批准"\]/)
  assert.match(source, /purchase_order_issue: \["Issued to the supplier", "已下达给供应商"\]/)
  assert.match(source, /statusCodeLabel\(code, language\)/)
  assert.match(source, /AUDIT_TECHNICAL_KEYS = new Set\(\["commandType", "idempotencyKey", "expectedVersion"/)
  assert.match(source, /export function auditActorName\(actor: unknown\)/)
  assert.doesNotMatch(source, /"状态未变化"/)
  assert.doesNotMatch(source, />\s*查看细节\s*</)
  const db = await read('server/repositories/db-audit-log-repository.mjs')
  assert.match(db, /entityType: \{ equals: text\(filters\.entityType\), mode: 'insensitive' \}/)
})

test('the shell has no always-disabled bell, and reports no standing warehouse notes (L6-15, L6-16)', async () => {
  assert.doesNotMatch(await read('src/app/FlowChainApp.tsx'), /<Bell\b|Notifications unavailable/)
  assert.doesNotMatch(await read('server/services/business-read-context-service.mjs'), /dataLimitations\.push\('warehouse_runtime_not_connected'/)
})

test('a receivable reads as its invoice number, without its AR- number under it (L7-38)', async () => {
  const source = await read('src/modules/finance/OperationalFinanceO2cWorkbench.tsx')
  assert.doesNotMatch(source, /row\.customerInvoiceNumber && row\.obligationNumber && <div/)
})

test('a sales order shows its order date and only an actionable consistency check (L7-43, L7-44)', async () => {
  const source = await read('src/modules/sales/OutboundWorkbench.tsx')
  assert.match(source, /<HeaderFact label=\{say\("Order date", "下单日期"\)\}>\{data\.order\.createdAt \? formatInstantDay\(data\.order\.createdAt, locale, timezone\)/)
  assert.match(source, /\{\(data\.reconciliation\.status === "mismatch" \|\| data\.reconciliation\.reasonCode === "PARTIAL_WAREHOUSE_SCOPE"\) && <Section id="reconciliation"/)
})

test('a receipt opens by its number, and its commands use the loaded id (L1-24)', async () => {
  const query = await read('server/domain/receiving-workbench-query-service.mjs')
  assert.match(query, /documentNumber: \{ equals: String\(receivingDocumentId\), mode: 'insensitive' \}/)
  const page = await read('src/modules/receiving/ReceivingPostingWorkbench.tsx')
  assert.match(page, /const docId = detail\?\.receivingDocument\.id \|\| receivingDocumentId;/)
  assert.doesNotMatch(page, /receiving\/\$\{encodeURIComponent\(receivingDocumentId\)\}\/(submit|cancel|impact-preview|edit)/)
})

// L1-17 = L8-28: the message sent people to supplier returns, which are off.
test('a receipt blocked by its invoice says what to do instead of a supplier return', async () => {
  const policy = await read('server/domain/receiving-transaction-policy.mjs')
  assert.match(policy, /resolve it on that supplier invoice first; returning goods to a supplier is not available in FlowChain yet/)
  assert.doesNotMatch(policy, /use a supplier return/)
  const page = await read('src/modules/receiving/ReceivingPostingWorkbench.tsx')
  assert.match(page, /FlowChain 暂不支持向供应商退货/)
})

// U-01: the workbench sent ?new=1, which the request page ignores.
test('the workbench New purchase request opens the request form', async () => {
  assert.match(await read('src/modules/procurement/ProcurementWorkbench.tsx'), /navigate\("\/app\/procurement\/requests\?mode=create"\)/)
  assert.match(await read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx'), /params\.get\("mode"\) === "create"/)
})

// U-21: receipts said "Unposted" in the status and "Not posted" on the cards and filters.
test('an unposted receipt reads Not posted', () => {
  assert.equal(statusCodeLabel('unposted', 'en-US'), 'Not posted')
  assert.equal(statusCodeLabel('unposted', 'zh-CN'), '未过账')
})

// B1, part 2 (after #323): Today's counts, the priorities page, the request's
// wording and status, and the supplier invoice that is not found.
test('Needs action is never fewer than Overdue: both count the same rows (L6-03, L7-11, L6-04)', async () => {
  const { todayTileCounts } = await import('../../src/modules/overview/todayRows.ts')
  // Fourteen of twenty rows overdue, three of them decision cards; one set aside.
  const overview = { workTotal: 20, overdue: 14, decisions: { available: true, setAside: [{ key: 'purchase_order_overdue:PO-1', row: { overdueDays: 3 } }] } }
  assert.deepEqual(todayTileCounts(overview), { work: 19, overdue: 13 })
  // Any mix of rows and set-aside rows (the set-aside rows are among the rows).
  let seed = 7
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  for (let run = 0; run < 500; run += 1) {
    const rows = Array.from({ length: 1 + Math.floor(next() * 40) }, (_, index) => ({ key: `row:${index}`, overdue: next() < 0.6 }))
    const aside = rows.filter(() => next() < 0.2).map((row) => ({ key: row.key, row: { overdueDays: row.overdue ? 2 : 0 } }))
    const counts = todayTileCounts({ workTotal: rows.length, overdue: rows.filter((row) => row.overdue).length, decisions: { available: true, setAside: aside } })
    assert.ok(counts.work >= counts.overdue, JSON.stringify(counts))
  }
  for (const page of ['src/modules/overview/Page.tsx', 'src/modules/overview/AiSuggestionsPage.tsx']) assert.match(await read(page), /todayTileCounts\(overview/, page)
})

test('the priorities tab is named for what it shows, with no AI in its name (L6-04)', async () => {
  assert.match(await read('src/app/routeRegistry.tsx'), /label: "重点事项"/)
  assert.match(await read('src/i18n/workspaceCopy.ts'), /'重点事项': 'Priorities'/)
  assert.doesNotMatch(await read('src/app/routeRegistry.tsx'), /label: "AI 重点"/)
})

test('a purchase request is 驳回 and reads Pending approval while it waits (U-04, U-11)', async () => {
  const page = await read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.doesNotMatch(page, /拒绝/)
  assert.match(page, /reject: \["Reject", "驳回"\]/)
  assert.match(page, /status === "submitted" \? statusCodeLabel\("pending_approval", language\)/)
  assert.equal(statusCodeLabel('pending_approval', 'en-US'), 'Pending approval')
})

test('a supplier invoice that is not found says why a typed number may not open it (L1-24)', async () => {
  const page = await read('src/modules/finance/SupplierInvoiceScreens.tsx')
  assert.match(page, /failure === "notFound" && <>/)
  assert.match(page, /data-testid="supplier-invoice-not-found-hint">\{t\("finance\.billNotFoundHint"\)\}/)
  const i18n = await read('src/i18n/I18n.tsx')
  assert.match(i18n, /"finance\.billNotFoundHint": "An invoice number can repeat between suppliers/)
  assert.match(i18n, /"finance\.billNotFoundHint": "不同供应商的发票号可能相同/)
})
