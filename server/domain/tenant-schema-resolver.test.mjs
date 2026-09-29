import assert from "node:assert/strict";
import test from "node:test";
import { canonicalFieldByPath } from "./canonical-master-data-schemas.mjs";
import { resolveTenantEntitySchema } from "./tenant-schema-resolver.mjs";

const clock = () => new Date("2026-09-29T12:00:00.000Z");
const repositoryFor = tenant => ({
  listPublishedCustomFields: async () => [],
  ...(tenant === undefined ? {} : { getTenantBusinessDefaults: async () => tenant }),
});
const defaultOf = (schema, fieldPath) => schema.fields.find(field => field.fieldPath === fieldPath).defaultValue;

test("canonical supplier and customer defaults are US when no tenant is known", async () => {
  for (const recordType of ["supplier", "customer"]) {
    assert.equal(canonicalFieldByPath(recordType, `${recordType}.currency`).defaultValue, "USD");
    assert.equal(canonicalFieldByPath(recordType, `${recordType}.countryCode`).defaultValue, "US");
    const withoutLookup = await resolveTenantEntitySchema({ repository: repositoryFor(undefined), tenantId: "tenant-a", recordType, clock });
    assert.equal(defaultOf(withoutLookup, `${recordType}.currency`), "USD");
    assert.equal(defaultOf(withoutLookup, `${recordType}.countryCode`), "US");
    const missingTenant = await resolveTenantEntitySchema({ repository: repositoryFor(null), tenantId: "tenant-a", recordType, clock });
    assert.equal(defaultOf(missingTenant, `${recordType}.currency`), "USD");
    assert.equal(defaultOf(missingTenant, `${recordType}.countryCode`), "US");
  }
});

test("a Chinese tenant keeps CNY and CN intake defaults from its own settings", async () => {
  for (const recordType of ["supplier", "customer"]) {
    const schema = await resolveTenantEntitySchema({ repository: repositoryFor({ currency: "CNY", countryCode: "CN" }), tenantId: "tenant-cn", recordType, clock });
    assert.equal(defaultOf(schema, `${recordType}.currency`), "CNY");
    assert.equal(defaultOf(schema, `${recordType}.countryCode`), "CN");
    assert.equal(defaultOf(schema, `${recordType}.status`), "active");
  }
});

test("tenant defaults are part of the schema hash and do not touch the item schema", async () => {
  const us = await resolveTenantEntitySchema({ repository: repositoryFor({ currency: "USD", countryCode: "US" }), tenantId: "tenant-us", recordType: "supplier", clock });
  const cn = await resolveTenantEntitySchema({ repository: repositoryFor({ currency: "CNY", countryCode: "CN" }), tenantId: "tenant-cn", recordType: "supplier", clock });
  assert.notEqual(us.tenantSchemaHash, cn.tenantSchemaHash);
  const item = await resolveTenantEntitySchema({ repository: repositoryFor({ currency: "CNY", countryCode: "CN" }), tenantId: "tenant-cn", recordType: "item", clock });
  assert.equal(item.fields.some(field => field.fieldPath.endsWith(".currency") || field.fieldPath.endsWith(".countryCode")), false);
});
