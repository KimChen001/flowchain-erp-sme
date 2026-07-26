import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseRepositoryRegistry } from "../repositories/adapter-registry.mjs";
import {
  getMobileSyncEntityPolicy,
  loadAuthorizedSyncProjection,
  validateMobileSyncEntityPolicy,
} from "./mobile-sync-entity-policy.mjs";
import { issueCursor, verifyCursor } from "./mobile-sync-service.mjs";

const enabledFinance = {
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
};
const enabledReceiving = {
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true",
};
const enabledBankReconciliation = {
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_BANK_RECONCILIATION: "true",
};
const actor = (permissions, options = {}) => ({
  tenantId: options.tenantId || "tenant-a",
  user: { id: "user-a" },
  permissionCodes: new Set(permissions),
  allWarehouses: Boolean(options.allWarehouses),
  readWarehouseIds: new Set(options.readWarehouseIds || []),
});

test("CustomerInvoice sync uses read permission and independently redacts amount and partner fields", async () => {
  assert.equal(getMobileSyncEntityPolicy("CustomerInvoice").requiredReadPermission, "finance.customer_invoice.read");
  const row = {
    id: "invoice-a",
    tenantId: "tenant-a",
    status: "issued",
    version: 3,
    currency: "CNY",
    totalAmount: "88.5000",
    customerId: "customer-secret",
    customerNameSnapshot: "Customer Secret",
    updatedAt: new Date("2026-07-22T00:00:00.000Z"),
  };
  const prisma = { customerInvoice: { findFirst: async () => row } };
  const readOnly = await loadAuthorizedSyncProjection({
    prisma,
    tenant: { operationalSettings: {} },
    actor: actor(["finance.customer_invoice.read"]),
    entityType: "CustomerInvoice",
    entityId: row.id,
    env: enabledFinance,
  });
  assert.equal(readOnly.id, row.id);
  assert.equal(readOnly.amount, null);
  assert.equal(readOnly.customerId, null);
  assert.equal(readOnly.customerNameSnapshot, null);

  const fullyVisible = await loadAuthorizedSyncProjection({
    prisma,
    tenant: { operationalSettings: {} },
    actor: actor(["finance.customer_invoice.read", "finance.amounts.read", "finance.partner_snapshot.read"]),
    entityType: "CustomerInvoice",
    entityId: row.id,
    env: enabledFinance,
  });
  assert.equal(fullyVisible.amount, "88.5000");
  assert.equal(fullyVisible.customerId, "customer-secret");
  assert.equal(fullyVisible.customerNameSnapshot, "Customer Secret");

  const createOnly = await loadAuthorizedSyncProjection({
    prisma,
    tenant: { operationalSettings: {} },
    actor: actor(["finance.customer_invoice.create", "finance.amounts.read", "finance.partner_snapshot.read"]),
    entityType: "CustomerInvoice",
    entityId: row.id,
    env: enabledFinance,
  });
  assert.equal(createOnly, null);
  assert.equal(await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: { modules: { finance: false } } }, actor: actor(["finance.customer_invoice.read"]), entityType: "CustomerInvoice", entityId: row.id, env: enabledFinance }), null);
  assert.equal(await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.customer_invoice.read"]), entityType: "CustomerInvoice", entityId: row.id, env: { ...enabledFinance, FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "false" } }), null);
  assert.equal(await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.customer_invoice.read"]), entityType: "UnknownEntity", entityId: row.id, env: enabledFinance }), null);
});

test("sync registry read boundaries reject create approve post and manage actions without an explicit exception", () => {
  assert.equal(validateMobileSyncEntityPolicy(), true);
  for (const action of ["create", "approve", "post", "manage"]) {
    assert.throws(
      () => validateMobileSyncEntityPolicy({ Broken: { requiredReadPermission: `module.entity.${action}` } }),
      /must be a read action/,
    );
  }
  assert.equal(validateMobileSyncEntityPolicy({ Exceptional: { requiredReadPermission: "legacy.entity.manage", readPermissionExceptionReason: "Documented legacy read boundary" } }), true);
});

test("warehouse tombstones enforce trusted tenant and warehouse scope and expose no old payload", async () => {
  const base = {
    prisma: {},
    tenant: { operationalSettings: {} },
    entityType: "ReceivingAttachment",
    entityId: "attachment-a",
    operation: "tombstone",
    env: enabledReceiving,
  };
  const warehouseA = actor(["receiving.read"], { readWarehouseIds: ["warehouse-a"] });
  const trusted = { tenantId: "tenant-a", resourceTenantId: "tenant-a", moduleKey: "receiving", authorizationClass: "receiving.read", scopeWarehouseIds: ["warehouse-a"] };
  assert.deepEqual(await loadAuthorizedSyncProjection({ ...base, actor: warehouseA, feedContext: trusted }), { id: "attachment-a", entityType: "ReceivingAttachment", tombstone: true });
  assert.equal(await loadAuthorizedSyncProjection({ ...base, actor: warehouseA, feedContext: { ...trusted, scopeWarehouseIds: ["warehouse-b"] } }), null);
  assert.equal(await loadAuthorizedSyncProjection({ ...base, actor: warehouseA, feedContext: { ...trusted, scopeWarehouseIds: [] } }), null);
  assert.equal(await loadAuthorizedSyncProjection({ ...base, actor: warehouseA, feedContext: { ...trusted, resourceTenantId: "tenant-b" } }), null);
  assert.deepEqual(await loadAuthorizedSyncProjection({ ...base, actor: actor(["receiving.read"], { allWarehouses: true }), feedContext: { ...trusted, scopeWarehouseIds: [] } }), { id: "attachment-a", entityType: "ReceivingAttachment", tombstone: true });
  assert.equal(await loadAuthorizedSyncProjection({ ...base, actor: actor(["receiving.read"], { allWarehouses: true }), feedContext: { ...trusted, resourceTenantId: null, scopeWarehouseIds: [] } }), null);
});

test("bank reconciliation sync is read-authorized, independently redacted, and fails closed for tombstones", async () => {
  const row = { id: "bank-line-a", tenantId: "tenant-a", version: 2, transactionDate: new Date("2026-07-21T00:00:00.000Z"), direction: "credit", amount: "125.5", matchedAmount: "0", remainingAmount: "125.5000", currency: "CNY", reconciliationStatus: "unmatched", counterpartyName: "Fictitious Customer", counterpartyAccountMasked: "****5678" };
  const prisma = { bankStatementLine: { findFirst: async () => row } };
  const redacted = await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.bank_statement.read"]), entityType: "BankStatementLine", entityId: row.id, env: enabledBankReconciliation });
  assert.equal(redacted.amount, null);
  assert.equal(redacted.matchedAmount, null);
  assert.equal(redacted.counterpartyName, null);
  const visible = await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.bank_statement.read", "finance.amounts.read", "finance.partner_snapshot.read"]), entityType: "BankStatementLine", entityId: row.id, env: enabledBankReconciliation });
  assert.equal(visible.amount, "125.5000");
  assert.equal(visible.matchedAmount, "0.0000");
  assert.equal(visible.counterpartyName, "Fictitious Customer");
  assert.equal(await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.bank_statement.import"]), entityType: "BankStatementLine", entityId: row.id, env: enabledBankReconciliation }), null);
  const base = { prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.bank_statement.read"]), entityType: "BankStatementLine", entityId: row.id, operation: "tombstone", env: enabledBankReconciliation };
  assert.equal(await loadAuthorizedSyncProjection(base), null);
  const trusted = { tenantId: "tenant-a", resourceTenantId: "tenant-a", moduleKey: "finance", authorizationClass: "finance.bank_statement.read", scopeWarehouseIds: [] };
  assert.deepEqual(await loadAuthorizedSyncProjection({ ...base, feedContext: trusted }), { id: row.id, entityType: "BankStatementLine", tombstone: true });
  assert.equal(await loadAuthorizedSyncProjection({ ...base, feedContext: { ...trusted, resourceTenantId: "tenant-b" } }), null);
  assert.equal(await loadAuthorizedSyncProjection({ ...base, feedContext: { ...trusted, authorizationClass: "finance.bank_statement.import" } }), null);
});

test("bank batch mobile counts use active reconciliation aggregates instead of imported count", async () => {
  const row = { id: "batch-a", tenantId: "tenant-a", version: 3, batchNumber: "BST-1", workflowStatus: "committed", validationStatus: "valid", importedLineCount: 99 };
  const prisma = {
    bankStatementImportBatch: { findFirst: async () => row },
    bankStatementLine: { groupBy: async () => [
      { reconciliationStatus: "unmatched", _count: { _all: 2 } },
      { reconciliationStatus: "partially_matched", _count: { _all: 1 } },
      { reconciliationStatus: "matched", _count: { _all: 4 } },
      { reconciliationStatus: "exception", _count: { _all: 1 } },
    ] },
    bankReconciliationException: { count: async () => 2 },
  };
  const projected = await loadAuthorizedSyncProjection({ prisma, tenant: { operationalSettings: {} }, actor: actor(["finance.bank_statement.read"]), entityType: "BankStatementImportBatch", entityId: row.id, env: enabledBankReconciliation });
  assert.deepEqual({ active: projected.activeLineCount, unmatched: projected.unmatchedCount, partial: projected.partiallyMatchedCount, matched: projected.matchedCount, exceptions: projected.exceptionCount }, { active: 8, unmatched: 2, partial: 1, matched: 4, exceptions: 3 });
  assert.notEqual(projected.unmatchedCount, row.importedLineCount);
});

test("cursor key rotation verifies a cursor genuinely signed by the previous key", () => {
  const k1 = "previous-key-secret-that-is-at-least-32-characters";
  const k2 = "current-key-secret-that-is-at-least-32-characters";
  const claims = { issuedAt: 1_000, expiresAt: 9_000, tenantId: "tenant-a", userId: "user-a", clientId: "client-a", deviceIdHash: "device-a", lastSequence: "4", authorizationFingerprint: "fingerprint", snapshotSessionId: null };
  const previousCursor = issueCursor(claims, { NODE_ENV: "test", FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID: "k1", FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET: k1 });
  const rotated = { NODE_ENV: "test", FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID: "k2", FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET: k2, FLOWCHAIN_SYNC_CURSOR_PREVIOUS_KEYS: JSON.stringify({ k1 }) };
  assert.equal(verifyCursor(previousCursor, rotated, 2_000).keyId, "k1");
  assert.equal(verifyCursor(issueCursor(claims, rotated), rotated, 2_000).keyId, "k2");
  assert.throws(() => verifyCursor(previousCursor, { ...rotated, FLOWCHAIN_SYNC_CURSOR_PREVIOUS_KEYS: "{}" }, 2_000), (error) => error.code === "SYNC_CURSOR_KEY_UNKNOWN");
  assert.throws(() => verifyCursor(previousCursor.slice(0, -1) + (previousCursor.endsWith("a") ? "b" : "a"), rotated, 2_000), (error) => error.code === "SYNC_CURSOR_TAMPERED");
  assert.throws(() => verifyCursor(previousCursor, rotated, 10_000), (error) => error.code === "SYNC_CURSOR_EXPIRED");
  assert.throws(() => verifyCursor(previousCursor, { ...rotated, FLOWCHAIN_SYNC_CURSOR_PREVIOUS_KEYS: JSON.stringify({ k1: "weak" }) }, 2_000), (error) => error.code === "SYNC_CURSOR_KEY_WEAK");
});

test("PostgreSQL repository registry exposes no legacy procurement runtime", () => {
  const registry = createDatabaseRepositoryRegistry({
    env: { FLOWCHAIN_ENABLE_LEGACY_PROCUREMENT_RUNTIME: "true" },
    prisma: {},
  });
  assert.equal("procurementLegacyRuntime" in registry, false);
});
