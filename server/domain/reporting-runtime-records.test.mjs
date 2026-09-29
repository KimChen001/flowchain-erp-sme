import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbProcurementRuntimeRepository } from '../repositories/db-procurement-runtime-repository.mjs';
import { createBusinessReadContextService } from '../services/business-read-context-service.mjs';
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs';
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs';

test('reporting inventory does not combine pieces, boxes and rolls into one stock total', () => {
  const report = buildRuntimeGovernedReport({ inventoryItems: [{ sku: 'A', onHandQuantity: 20, unit: 'pcs' }, { sku: 'B', onHandQuantity: 3, unit: 'box' }] }, { subject: 'inventory' });
  assert.equal(report.kpis.find(row => row.id === 'inventory_on_hand').value, null);
  assert.ok(report.limitations.includes('inventory_units_mixed'));
  assert.deepEqual(report.details.map(row => row.quantity), [20, 3]);
});

test('report runtime loads tenant-scoped receipts and invoice amounts instead of empty placeholders', async () => {
  const queries = [];
  const prisma = Object.fromEntries(Object.entries({
    purchaseOrder: [{ id: 'PO', status: 'fully_received', currency: 'USD', amount: 120, lines: [] }],
    receivingDocument: [{ id: 'GRN', poId: 'PO', status: 'received', postingStatus: 'unposted', lines: [] }],
    supplierInvoice: [{ id: 'INV', relatedPoId: 'PO', relatedGrnId: 'GRN', totalAmount: '120.50', currency: 'USD', status: 'draft', lines: [] }],
  }).map(([key, rows]) => [key, { findMany: async query => { queries.push(query); return rows; } }]));
  const procurementRuntime = createDbProcurementRuntimeRepository({ prisma });
  const context = await createBusinessReadContextService({ repositories: { procurementRuntime } }).read({ tenantId: 'tenant-a' });
  assert.equal(queries.length, 3);
  for (const query of queries) assert.deepEqual(query.where, { tenantId: 'tenant-a' });
  assert.equal(context.receipts[0].poId, 'PO');
  assert.equal(context.supplierInvoices[0].receiptId, 'GRN');
  assert.ok(!context.dataLimitations.includes('invoice_runtime_has_no_records'));
  const report = buildRuntimeGovernedReport(context, { subject: 'finance' });
  assert.equal(report.kpis[0].value, 120.5);
  assert.equal(report.dataScope.currencyCode, 'USD');
});

test('received and rejected POs are not open; draft and cancelled sales do not inflate attention or demand', () => {
  const context = {
    purchaseOrders: ['fully_received', 'rejected', 'issued', 'partially_received', 'cancelled'].map((status, i) => ({ id: `PO-${i}`, status, currency: 'USD', lines: [] })),
    salesOrders: ['draft', 'cancelled', 'confirmed'].map((workflowStatus, i) => ({ id: `SO-${i}`, sku: 'SKU', workflowStatus, status: workflowStatus === 'cancelled' ? 'cancelled' : 'shortage_risk', statusLabel: '中文标签', orderedQty: 10, fulfilledQty: 0, reservedQty: 0, currency: 'USD' })),
    inventoryItems: [{ sku: 'SKU', onHandQuantity: 5, reservedQuantity: 0 }], items: [], suppliers: [], supplierInvoices: [],
  };
  const overview = buildRuntimeGovernedReport(context, { subject: 'overview' });
  assert.equal(overview.kpis.find(row => row.id === 'open_po_count').value, 2);
  assert.equal(overview.attention.find(row => row.id === 'open_orders').count, 2);
  assert.equal(overview.attention.find(row => row.id === 'unfulfilled_sales').count, 1);
  const sales = buildRuntimeGovernedReport(context, { subject: 'sales' });
  assert.equal(sales.kpis.find(row => row.id === 'open_sales_demand').value, 10);
  assert.deepEqual(sales.details.map(row => row.status), ['draft', 'cancelled', 'shortage_risk']);
  assert.equal(buildRuntimeInventoryAllocation(context).availability[0].shortage, 5);
});
