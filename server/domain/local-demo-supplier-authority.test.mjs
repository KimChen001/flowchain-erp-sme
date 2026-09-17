import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_DEMO_SUPPLIERS,
  LOCAL_DEMO_COUNTS,
  localDemoSupplier,
} from "../../scripts/setup-local-demo.mjs";

// Built from escapes so this file stays ASCII-only while asserting about CJK.
const CJK = new RegExp("[\\u3400-\\u9fff]", "u");

// Regression guard. The browser harness in scripts/browser-product-recovery-api.mjs
// used to re-create LOCAL-DEMO-SUP-005 and -006 with its own names while
// tolerating the resulting P2002, so the shared seed silently won and the two
// seeders disagreed about the same supplier ids. LOCAL-DEMO master data now
// resolves through localDemoSupplier(), and an unknown id must fail loudly
// rather than producing a second, divergent definition.

test("shared LOCAL-DEMO supplier master data is internally consistent", () => {
  assert.equal(LOCAL_DEMO_SUPPLIERS.length, LOCAL_DEMO_COUNTS.suppliers);

  const ids = LOCAL_DEMO_SUPPLIERS.map(([id]) => id);
  const codes = LOCAL_DEMO_SUPPLIERS.map(([, code]) => code);
  const names = LOCAL_DEMO_SUPPLIERS.map(([, , name]) => name);

  assert.equal(new Set(ids).size, ids.length, "supplier ids must be unique");
  assert.equal(new Set(codes).size, codes.length, "supplier codes must be unique");
  assert.equal(new Set(names).size, names.length, "supplier names must be unique");

  for (const [id, code, name, category] of LOCAL_DEMO_SUPPLIERS) {
    assert.match(id, /^LOCAL-DEMO-SUP-\d{3}$/);
    assert.match(code, /^LDS-\d{3}$/);
    assert.equal(typeof name, "string");
    assert.equal(name.trim(), name);
    assert.ok(name.length > 0);
    assert.equal(typeof category, "string");
    assert.ok(category.length > 0);
    // The US English LOCAL-DEMO data must not carry CJK master data.
    assert.equal(CJK.test(`${name} ${category}`), false, `${id} must not contain CJK text`);
  }
});

test("localDemoSupplier resolves the authority and rejects unknown ids", () => {
  const resolved = localDemoSupplier("LOCAL-DEMO-SUP-005");
  assert.deepEqual(resolved, {
    id: "LOCAL-DEMO-SUP-005",
    code: "LDS-005",
    name: "Northstar Electronics",
    category: "Electronic components",
  });

  // Every declared supplier is resolvable and round-trips to its own row.
  for (const [id, code, name, category] of LOCAL_DEMO_SUPPLIERS) {
    assert.deepEqual(localDemoSupplier(id), { id, code, name, category });
  }

  // A typo or an id only one seeder knows about must throw, not silently
  // create divergent LOCAL-DEMO master data.
  assert.throws(() => localDemoSupplier("LOCAL-DEMO-SUP-999"), /Unknown local demo supplier id/);
  assert.throws(() => localDemoSupplier(""), /Unknown local demo supplier id/);
});
