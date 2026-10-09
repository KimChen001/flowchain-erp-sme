import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workbook = readFileSync(new URL('../../src/lib/excel/excelWorkbookService.ts', import.meta.url), 'utf8');
const schemas = readFileSync(new URL('../../src/lib/excel/excelSchemas.ts', import.meta.url), 'utf8');

test('Excel templates contain data, field definitions, and import guide sheets', () => {
  for (const sheet of ['导入数据', '字段说明', '导入说明']) assert.ok(workbook.includes(sheet));
  for (const filename of ['supplier-invoice-import-template.xlsx', 'supplier-reconciliation-import-template.xlsx', 'purchase-request-import-template.xlsx', 'supplier-master-import-template.xlsx', 'item-master-import-template.xlsx', 'customer-master-import-template.xlsx', 'inventory-balance-import-template.xlsx']) assert.ok(schemas.includes(filename));
  assert.match(workbook, /\.xlsx、\.xls、\.csv/);
  assert.match(workbook, /!autofilter/);
  assert.match(workbook, /!freeze/);
});
