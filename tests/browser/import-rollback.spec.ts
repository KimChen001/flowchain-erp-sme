import { expect, test } from "@playwright/test";

test("legacy import history and rollback endpoints are fully retired", async ({ request }) => {
  const headers = { "x-flowchain-role": "admin", "x-flowchain-user": "legacy-import-admin" };
  for (const path of [
    "/api/imports/pilot-existing",
    "/api/imports/pilot-existing/issues",
    "/api/import-batches",
    "/api/import-batches/legacy-existing",
  ]) {
    const response = await request.get(path, { headers });
    expect(response.status()).toBe(501);
    expect((await response.json()).code).toBe("FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED");
  }
  const rollback = await request.post("/api/import-batches/legacy-existing/rollback", { headers, data: { reason: "must remain retired" } });
  expect(rollback.status()).toBe(501);
  expect((await rollback.json()).code).toBe("FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED");
});
