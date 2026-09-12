import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSupplierMaster } from './supplier-master-command.mjs';

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
