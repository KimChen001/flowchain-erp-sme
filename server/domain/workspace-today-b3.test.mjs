import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mapPurchaseOrder } from '../repositories/db-procurement-read-repository.mjs'
import { tenantCalendarDay } from './tenant-calendar-day.mjs'

// Design audit batch B3 (2026-11-17): one "today" for every page, the
// workspace's calendar day, and one due day per order (L6-02 = L7-01, L6-23,
// L6 appendix #15-19, V-B-02).
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the localization sends the workspace day, as the server counts it', () => {
  assert.match(read('server/routes/pilot-workspace.routes.mjs'), /workspaceToday: tenantCalendarDay\(new Date\(\), tenant\.timezone \|\| DEFAULT_TENANT_TIMEZONE\),/)
  // 20:30 on the 14th in New York is already the 15th in London.
  assert.equal(tenantCalendarDay(new Date('2026-11-15T01:30:00Z'), 'Europe/London'), '2026-11-15')
  assert.equal(tenantCalendarDay(new Date('2026-11-15T01:30:00Z'), 'America/New_York'), '2026-11-14')
})

test('an order is due on its earliest open line\'s day, as Today counts it (V-B-02)', () => {
  // The header keeps a received line's date; Today and now the workbench use the open line's.
  const po = mapPurchaseOrder({
    id: 'PO-1', expectedDate: new Date('2026-11-01T00:00:00Z'),
    lines: [
      { id: 'L1', orderedQuantity: '5', receivedQuantity: '5', metadata: { promisedDate: '2026-11-01' } },
      { id: 'L2', orderedQuantity: '5', receivedQuantity: '0', metadata: { promisedDate: '2026-11-14' } },
    ],
  })
  assert.equal(po.eta, '2026-11-01')
  assert.equal(po.dueDay, '2026-11-14')
  // Fully received: nothing is due.
  assert.equal(mapPurchaseOrder({ id: 'PO-2', expectedDate: new Date('2026-11-01T00:00:00Z'), lines: [{ id: 'L1', orderedQuantity: '5', receivedQuantity: '5' }] }).dueDay, null)
})

test('I18n gives the workspace day once the localization has loaded, and "" before', () => {
  const i18n = read('src/i18n/I18n.tsx')
  assert.match(i18n, /workspaceToday: ready \? state\.workspaceToday \|\| todayInTimeZone\(state\.timezone\) : "",/)
  assert.match(i18n, /localizationReady: ready,/)
  assert.match(i18n, /setState\([^\n]*payload\);\n\s+setReady\(true\);/)
})

test('the workbench and the other pages count from the workspace day, not the browser\'s (L6-02, #13-#19)', () => {
  const workbench = read('src/modules/procurement/ProcurementWorkbench.tsx')
  assert.doesNotMatch(workbench, /todayInTimeZone\(timezone\)/)
  assert.match(workbench, /const rows = useMemo\(\(\) => \(lists && workspaceToday \? workRows\(lists, workspaceToday\) : \[\]\), \[lists, workspaceToday\]\);/)
  assert.match(workbench, /const ready = state === "loaded" && Boolean\(workspaceToday\);/)
  assert.match(workbench, /const value = \(name: Queue\) => ready \? String\(count\(name\)\) : "—";/)
  assert.match(workbench, /const due = row\.dueDay \|\| row\.eta;/)
  for (const file of ['src/modules/finance/OperationalFinanceO2cWorkbench.tsx', 'src/modules/finance/OperationalFinanceP2pWorkbench.tsx', 'src/modules/procurement/RfqListPage.tsx']) {
    const source = read(file)
    assert.doesNotMatch(source, /const today = todayInTimeZone\(timezone\);/, file)
    assert.match(source, /const today = workspaceToday;/, file)
  }
  // Before the day is known the RFQ list must not build a date from "" (Invalid
  // Date throws in toISOString and took the list down in the browser run).
  assert.match(read('src/modules/procurement/RfqListPage.tsx'), /const inAWeek = today \? new Date\(/)
  const orders = read('src/modules/purchasing/Page.tsx')
  assert.match(orders, /const dueOf = \(order: PurchaseOrder\) => order\.dueDay \|\| order\.eta;/)
  // Overdue: open and due before the workspace day (one rule for the filter and its count).
  assert.match(orders, /workspaceToday && dueOf\(order\) && String\(dueOf\(order\)\) < workspaceToday/)
  assert.doesNotMatch(orders, /todayInTimeZone\(\)\)\) return false/)
  // A default date saved with a record is the workspace day (#18).
  const form = read('src/components/business/BusinessDocumentForm.tsx')
  assert.match(form, /const \[businessDate, setBusinessDate\] = useState\(workspaceToday\);/)
  assert.doesNotMatch(form, /todayInTimeZone/)
  assert.match(read('src/modules/ai-assistant/v2/parts/PurchaseRequestFormPart.tsx'), /addCalendarDays\(copy\.workspaceToday \|\| todayInTimeZone\(copy\.timezone\), lead\)/)
  assert.match(read('src/modules/reports/BiDashboard.tsx'), /const today = useMemo\(\(\) => serverToday \|\| workspaceToday\(timezone\), \[serverToday, timezone\]\);/)
  // The browser check runs with the shell specs in CI.
  assert.match(read('scripts/run-product-recovery-playwright.mjs'), /"tests\/browser\/workspace-today\.spec\.ts",/)
})
