import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { capabilityForEnvironment } from "./capability-registry.mjs";
import { operationalFinanceRequestHash } from "./operational-finance-command-service.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const source = (...parts) => readFileSync(resolve(root, ...parts), "utf8");

test("operational finance capabilities are beta and explicitly enabled in the PostgreSQL-only runtime", () => {
  for (const id of [
    "supplier-invoice",
    "three-way-match",
    "payable-obligation",
    "supplier-credit-memo",
    "customer-invoice",
    "receivable-obligation",
    "customer-credit-note",
  ]) {
    const disabled = capabilityForEnvironment(id, {
      FLOWCHAIN_PERSISTENCE_MODE: "database",
      FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "false",
    });
    assert.equal(disabled.maturity, "beta");
    assert.equal(disabled.databaseOnly, true);
    assert.equal(disabled.requiresExplicitEnable, true);
    assert.equal(disabled.enabled, false);
    assert.equal(
      capabilityForEnvironment(id, {
        FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
      }).enabled,
      true,
    );
  }
  const finance = capabilityForEnvironment("finance", {
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  });
  assert.equal(finance.maturity, "beta");
  assert.equal(finance.enabled, true);
});

test("O2C schema and routes are shipment-backed and exclude collection, refund, FX, and ledger execution", () => {
  const schema = source("prisma", "schema.prisma");
  const migration = source(
    "prisma",
    "migrations",
    "20260718060000_operational_finance_o2c",
    "migration.sql",
  );
  const routes = source("server", "routes", "operational-finance.routes.mjs");
  const policy = source(
    "server",
    "domain",
    "operational-finance-o2c-policy.mjs",
  );
  const command = source(
    "server",
    "domain",
    "operational-finance-o2c-command-service.mjs",
  );
  for (const model of [
    "CustomerInvoice",
    "CustomerInvoiceLine",
    "ReceivableObligation",
    "CustomerCreditNote",
    "CustomerCreditNoteLine",
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
    assert.match(migration, new RegExp(`CREATE TABLE "${model}"`));
  }
  assert.match(migration, /ALTER TABLE "SalesOrderLine"/);
  assert.match(policy, /postingStatus !== "posted"/);
  assert.match(policy, /CUSTOMER_INVOICE_QUANTITY_EXCEEDS_SHIPPED/);
  assert.match(policy, /CUSTOMER_RETURN_RECEIPT_REQUIRED/);
  for (const route of [
    "/api/finance/customer-invoices",
    "/api/finance/receivables",
    "/api/finance/aging",
    "/api/finance/customer-credit-notes",
  ])
    assert.match(routes, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(command, /isolationLevel: "Serializable"/);
  assert.match(command, /settlementVerified: false/);
  assert.doesNotMatch(command, /\.payment\.(?:create|update|delete)/);
  assert.doesNotMatch(command, /\.refund\.(?:create|update|delete)/);
  assert.doesNotMatch(command, /\.journalEntry\.(?:create|update|delete)/);
});

test("finance idempotency hash is stable for line ordering and changes with payload", () => {
  const first = {
    invoiceNumber: "INV-1",
    currency: "CNY",
    lines: [
      { receivingLineId: "B", quantity: "2.0000" },
      { receivingLineId: "A", quantity: "1.0000" },
    ],
  };
  const reordered = {
    lines: [...first.lines].reverse(),
    currency: "CNY",
    invoiceNumber: "INV-1",
  };
  assert.equal(
    operationalFinanceRequestHash(first),
    operationalFinanceRequestHash(reordered),
  );
  assert.notEqual(
    operationalFinanceRequestHash(first),
    operationalFinanceRequestHash({
      ...first,
      lines: [{ receivingLineId: "A", quantity: "3.0000" }],
    }),
  );
});

test("P2P schema extends legacy invoice and match models without parallel duplicates", () => {
  const schema = source("prisma", "schema.prisma");
  for (const model of [
    "SupplierInvoice",
    "SupplierInvoiceLine",
    "ThreeWayMatch",
    "ThreeWayMatchLine",
    "FinanceMatchException",
    "PayableObligation",
    "SupplierCreditMemo",
    "SupplierCreditMemoLine",
  ])
    assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.equal((schema.match(/model SupplierInvoice \{/g) || []).length, 1);
  assert.equal((schema.match(/model ThreeWayMatch \{/g) || []).length, 1);
  const migration = source(
    "prisma",
    "migrations",
    "20260718050000_operational_finance_p2p",
    "migration.sql",
  );
  assert.match(migration, /ALTER TABLE "SupplierInvoice"/);
  assert.match(migration, /CREATE TABLE "PayableObligation"/);
  assert.match(migration, /CREATE TABLE "SupplierCreditMemo"/);
  assert.doesNotMatch(migration, /CREATE TABLE "SupplierInvoice"/);
});

test("focused finance routes are registered and exclude generic mutation and payment execution", () => {
  const routes = source("server", "routes", "operational-finance.routes.mjs");
  const dispatcher = source("server", "bootstrap", "route-dispatcher.mjs");
  const command = source(
    "server",
    "domain",
    "operational-finance-command-service.mjs",
  );
  for (const route of [
    "/api/finance/supplier-invoices",
    "/api/finance/match-exceptions",
    "/api/finance/payables",
    "/api/finance/supplier-credit-memos",
  ])
    assert.match(routes, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(dispatcher, /handleOperationalFinanceRoute/);
  assert.doesNotMatch(routes, /generic-finance-mutation|\/api\/finance\/mutate/);
  assert.match(command, /isolationLevel: "Serializable"/);
  assert.match(command, /businessCommandExecution/);
  assert.doesNotMatch(command, /\.payment\.(?:create|update|delete)/);
  assert.doesNotMatch(command, /\.journalEntry\.(?:create|update|delete)/);
});
