import { expect, test } from "@playwright/test";

const headers = { "x-flowchain-role": "admin", "x-flowchain-user": "legacy-import-admin" };

test("legacy import preview and commit remain retired even for an administrator", async ({ request }) => {
  const preview = await request.post("/api/imports/preview", { headers, data: { importType: "items", rows: [{ sku: "RETIRED" }] } });
  expect(preview.status()).toBe(501);
  expect(await preview.json()).toMatchObject({
    code: "FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED",
    capability: "legacy-imports",
  });
  const commit = await request.post("/api/imports/pilot-existing/commit", { headers, data: { idempotencyKey: "still-retired" } });
  expect(commit.status()).toBe(501);
  expect((await commit.json()).code).toBe("FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED");
});
