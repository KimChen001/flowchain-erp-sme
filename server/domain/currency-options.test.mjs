import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { orderedCurrencyCodes } from '../../src/lib/currencyOptions.ts'

test('currency dropdowns offer the workspace currency first, then common currencies', () => {
  // The purchase request catalog lists CNY first; a USD workspace must not.
  assert.deepEqual(orderedCurrencyCodes('USD', ['CNY', 'USD', 'EUR']), ['USD', 'EUR', 'CNY'])
  assert.deepEqual(orderedCurrencyCodes('eur', ['CNY', 'USD', 'EUR']), ['EUR', 'USD', 'CNY'])
  assert.deepEqual(orderedCurrencyCodes('', ['CNY', 'USD', 'EUR']), ['USD', 'EUR', 'CNY'])
  // A stored currency outside the list is kept, never dropped.
  assert.deepEqual(orderedCurrencyCodes('USD', ['USD', 'EUR'], 'CHF'), ['USD', 'EUR', 'CHF'])
  const open = orderedCurrencyCodes('CAD')
  assert.deepEqual(open.slice(0, 3), ['CAD', 'USD', 'EUR'])
  assert.equal(new Set(open).size, open.length)
})

test('purchase request, supplier and outbound currency lists use the shared ordering', async () => {
  for (const file of ['src/modules/purchase-requests/CanonicalProcurementPanel.tsx', 'src/modules/srm/SupplierForm.tsx', 'src/modules/sales/OutboundWorkbench.tsx']) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.match(source, /orderedCurrencyCodes\(/, file)
  }
})
