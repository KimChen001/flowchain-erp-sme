import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./test-fixtures/standard-business-scenario.json', import.meta.url), 'utf8'));

test('standard business scenario keeps complete and reconcilable document chains', () => {
  const unique = (rows, key) => new Set(rows.map((row) => row[key])).size === rows.length;
  for (const key of ['pr', 'rfq', 'po', 'grn', 'invoice', 'match', 'reconciliation', 'settlement']) assert.equal(unique(fixture.purchaseChains, key), true, `${key} must be unique`);
  for (const row of fixture.purchaseChains) {
    assert.ok(fixture.suppliers.includes(row.supplier), `unknown supplier ${row.supplier}`);
    assert.ok(fixture.items.includes(row.sku), `unknown SKU ${row.sku}`);
    assert.equal(row.orderedQty, row.receivedQty, `${row.po} quantity mismatch`);
    assert.equal(row.receivedQty, row.invoicedQty, `${row.invoice} quantity mismatch`);
    assert.equal(row.poAmount, row.grnAmount, `${row.grn} amount mismatch`);
    assert.equal(row.grnAmount, row.invoiceSubtotal, `${row.invoice} amount mismatch`);
    assert.ok(Date.parse(row.prDate) <= Date.parse(row.poDate));
    assert.ok(Date.parse(row.poDate) <= Date.parse(row.grnDate));
    assert.ok(Date.parse(row.grnDate) <= Date.parse(row.invoiceDate));
    assert.equal(row.status, 'completed');
  }
});

test('sales fulfillment and inventory movements reference valid master data', () => {
  for (const row of fixture.salesChains) {
    assert.ok(fixture.customers.includes(row.customer));
    assert.ok(fixture.items.includes(row.sku));
    assert.equal(row.orderedQty, row.deliveredQty);
    assert.equal(row.deliveredQty, row.receivedQty);
    assert.equal(row.status, 'completed');
  }
  for (const row of fixture.inventoryMovements) {
    assert.ok(fixture.warehouses.includes(row.warehouse));
    assert.ok(fixture.items.includes(row.sku));
    assert.notEqual(row.quantity, 0);
    assert.ok(row.source.startsWith('ADJ-') || row.source.startsWith('GRN-') || row.source.startsWith('DN-'));
  }
});

test('default scenario distribution favors normal operations', () => {
  assert.equal(fixture.distribution.normal, 80);
  assert.equal(fixture.distribution.attention, 15);
  assert.equal(fixture.distribution.exception, 5);
  assert.equal(Object.values(fixture.distribution).reduce((sum, value) => sum + value, 0), 100);
});
