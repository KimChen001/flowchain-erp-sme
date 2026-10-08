import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSupplierMaster, supplierCurrencyIssue, supplierInputIssues } from './supplier-master-command.mjs';

test('supplier writes require an authenticated workspace scope', async () => {
  await assert.rejects(saveSupplierMaster({}, null, {}, 'user', {}), error => error.status === 403);
});
test('an update cannot access a supplier in another tenant', async () => {
  let lookedUp;
  const prisma = { $transaction: callback => callback({ supplier: { findFirst: async query => { lookedUp = query.where; return null; } } }) };
  await assert.rejects(saveSupplierMaster(prisma, 'foreign-supplier', {}, 'user-a', { tenantId: 'tenant-a' }), error => error.status === 404);
  assert.deepEqual(lookedUp, { id: 'foreign-supplier', tenantId: 'tenant-a' });
});
test('stale edits fail before any mutation', async () => {
  const prisma = { $transaction: callback => callback({ supplier: { findFirst: async () => ({ id: 'supplier', metadata: { version: 3 } }) } }) };
  await assert.rejects(saveSupplierMaster(prisma, 'supplier', { expectedVersion: 2 }, 'user', { tenantId: 'tenant' }), error => error.status === 409);
});

// The field checks run without a database, so the CSV import can show them
// before any write; saveSupplierMaster reports the same fields and messages.
test('supplier checks keep their fields and messages and add codes', () => {
  const { issues, values } = supplierInputIssues({ supplierCode: ' ', supplierName: '', status: 'retired', email: 'nope', deliveryCycleDays: 2.5 });
  assert.deepEqual(issues, [
    { field: 'supplierCode', code: 'CODE_REQUIRED', message: 'Enter a supplier code.' },
    { field: 'supplierName', code: 'NAME_REQUIRED', message: 'Enter a supplier name.' },
    { field: 'status', code: 'STATUS_INVALID', message: 'Choose a valid status.' },
    { field: 'email', code: 'EMAIL_INVALID', message: 'Enter a valid email address.' },
    { field: 'deliveryCycleDays', code: 'WHOLE_NUMBER_REQUIRED', message: 'Lead time must be a whole number of days, zero or greater.' },
  ]);
  assert.equal(values.metadata.deliveryCycleDays, 2.5);
  const ok = supplierInputIssues({ supplierCode: 'SUP-1', supplierName: 'Boston Components', defaultCurrency: 'EUR', paymentTermsId: 'TERM-1' });
  assert.deepEqual([ok.issues, ok.values.code, ok.values.status, ok.values.metadata.defaultCurrency, ok.values.metadata.paymentTermsId], [[], 'SUP-1', 'active', 'EUR', 'TERM-1']);
  assert.equal(supplierCurrencyIssue('USD'), null);
  assert.deepEqual(supplierCurrencyIssue('ZZZ'), { field: 'defaultCurrency', code: 'CURRENCY_INVALID', message: 'Choose a valid currency.' });
});
test('an empty supplier currency becomes the workspace currency, and the checks still refuse as before', async () => {
  let created;
  const tx = {
    supplier: { findFirst: async () => null, create: async ({ data }) => (created = data) },
    tenant: { findUnique: async ({ where }) => ({ id: where.id, currency: 'CNY' }) },
    auditLog: { create: async () => ({}) },
  };
  const prisma = { $transaction: callback => callback(tx) };
  await saveSupplierMaster(prisma, null, { supplierCode: 'SUP-1', supplierName: 'Boston Components' }, 'user', { tenantId: 'tenant' });
  assert.equal(created.metadata.defaultCurrency, 'CNY');
  const error = await saveSupplierMaster(prisma, null, { supplierCode: '', supplierName: 'X', email: 'bad', defaultCurrency: 'ZZZ' }, 'user', { tenantId: 'tenant' }).catch(cause => cause);
  assert.equal(error.status, 422);
  assert.deepEqual(error.details.map(({ field, message }) => ({ field, message })), [
    { field: 'supplierCode', message: 'Enter a supplier code.' },
    { field: 'email', message: 'Enter a valid email address.' },
    { field: 'defaultCurrency', message: 'Choose a valid currency.' },
  ]);
});

// An empty payment term is not recorded: nothing is stored, never NET30.
test('a supplier saved without a payment term stores none, and a chosen term must be a workspace term', async () => {
  let saved;
  const terms = [{ id: 'PT-1', code: 'NET45' }];
  const tx = (old = null) => ({
    supplier: { findFirst: async () => old, create: async ({ data }) => (saved = data), update: async ({ data }) => (saved = data) },
    tenant: { findUnique: async () => ({ currency: 'USD' }) },
    paymentTerm: { findFirst: async ({ where }) => terms.find(term => where.tenantId === 'tenant' && where.OR.some(match => match.code === term.code || match.id === term.id)) || null },
    auditLog: { create: async () => ({}) },
  });
  const prisma = old => ({ $transaction: callback => callback(tx(old)) });
  await saveSupplierMaster(prisma(), null, { supplierCode: 'SUP-1', supplierName: 'Boston Components', paymentTermsId: '' }, 'user', { tenantId: 'tenant' });
  assert.equal(Object.hasOwn(saved.metadata, 'paymentTermsId'), false);
  await saveSupplierMaster(prisma(), null, { supplierCode: 'SUP-1', supplierName: 'Boston Components', paymentTermsId: 'NET45' }, 'user', { tenantId: 'tenant' });
  assert.equal(saved.metadata.paymentTermsId, 'NET45');
  // The import stores the term's id; that is a workspace term too.
  await saveSupplierMaster(prisma(), null, { supplierCode: 'SUP-1', supplierName: 'Boston Components', paymentTermsId: 'PT-1' }, 'user', { tenantId: 'tenant' });
  assert.equal(saved.metadata.paymentTermsId, 'PT-1');
  const error = await saveSupplierMaster(prisma(), null, { supplierCode: 'SUP-1', supplierName: 'Boston Components', paymentTermsId: 'NET90' }, 'user', { tenantId: 'tenant' }).catch(cause => cause);
  assert.equal(error.status, 422);
  assert.deepEqual(error.details, [{ field: 'paymentTermsId', code: 'PAYMENT_TERM_NOT_FOUND', message: 'Choose one of the workspace payment terms.' }]);
  // Clearing a stored term (including a legacy "paymentTerms" value) removes it.
  const old = { id: 'SUP-X', code: 'SUP-1', name: 'Boston Components', metadata: { version: 2, defaultCurrency: 'USD', paymentTerms: 'NET30' } };
  await saveSupplierMaster(prisma(old), 'SUP-X', { expectedVersion: 2, paymentTermsId: '' }, 'user', { tenantId: 'tenant' });
  assert.equal(Object.hasOwn(saved.metadata, 'paymentTermsId') || Object.hasOwn(saved.metadata, 'paymentTerms'), false);
  // An unchanged stored term is kept without a lookup, even if no such term row exists.
  const legacy = { id: 'SUP-Y', code: 'SUP-2', name: 'Legacy Supplier', metadata: { version: 1, defaultCurrency: 'USD', paymentTermsId: 'NET30' } };
  await saveSupplierMaster(prisma(legacy), 'SUP-Y', { expectedVersion: 1, paymentTermsId: 'NET30', email: 'ap@legacy.example' }, 'user', { tenantId: 'tenant' });
  assert.equal(saved.metadata.paymentTermsId, 'NET30');
});
