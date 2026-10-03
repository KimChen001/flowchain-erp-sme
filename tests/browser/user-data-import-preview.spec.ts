import { expect, test, type APIRequestContext } from "@playwright/test";

const demoIds = /PO-2026-1282|SKU-00412|RFQ-26-0046|PR-2026-2401|GRN-202605-0418|INV-SZ-260601|SUP-SZXY/;

function importPayload() {
  return {
    sourceName: "browser-preview-import",
    purchaseOrders: [
      {
        poId: "PO-IMPORT-BROWSER-0001",
        supplierName: "Browser Import Supplier",
        eta: "2026-07-11",
        amount: "7200",
        lines: [{ itemSku: "SKU-IMPORT-BROWSER-0001", quantity: "12" }],
      },
    ],
    purchaseRequests: [
      { prId: "PR-IMPORT-BROWSER-0001", itemSku: "SKU-IMPORT-BROWSER-0001", quantity: "12", requiredDate: "2026-07-09" },
    ],
    rfqs: [
      { rfqId: "RFQ-IMPORT-BROWSER-0001", prId: "PR-IMPORT-BROWSER-0001", suppliers: "2", quoted: "1", due: "2026-07-10" },
    ],
    products: [
      { itemSku: "SKU-IMPORT-BROWSER-0001", itemName: "Browser Import Item", currentStock: "4", safetyStock: "10", reorderPoint: "16" },
    ],
    suppliers: [
      { supplierId: "SUP-IMPORT-BROWSER-0001", supplierName: "Browser Import Supplier", risk: "medium" },
    ],
    receivingDocs: [
      { grnId: "GRN-IMPORT-BROWSER-0001", poId: "PO-IMPORT-BROWSER-0001", supplierName: "Browser Import Supplier", status: "pending", items: "3" },
    ],
  };
}

// The manager seeded by scripts/browser-product-recovery-api.mjs.
async function authHeaders(request: APIRequestContext) {
  const login = await request.post("/api/auth/login", { data: { email: "kim@example.com", name: "Kim", company: "FlowChain" } });
  expect(login.ok()).toBeTruthy();
  return { authorization: `Bearer ${(await login.json()).token}` };
}

async function purchaseOrderCount(request: APIRequestContext, headers: Record<string, string>) {
  const response = await request.get("/api/procurement/orders", { headers });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as unknown[]).length;
}

test("R169 user data import preview API stays compact and non-mutating", async ({ request }) => {
  const headers = await authHeaders(request);
  expect((await request.post("/api/user-data/import/preview", { data: importPayload() })).status()).toBe(401);
  const before = await purchaseOrderCount(request, headers);
  const response = await request.post("/api/user-data/import/preview", { headers, data: importPayload() });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(await purchaseOrderCount(request, headers)).toBe(before);
  const search = await (await request.get("/api/search?q=PO-IMPORT-BROWSER-0001", { headers })).json();
  expect(search.total).toBe(0);

  expect(payload.ok).toBe(true);
  expect(payload.dryRun).toBe(true);
  expect(payload.writesFiles).toBe(false);
  expect(payload.writesDb).toBe(false);
  expect(payload.overwritesDemoData).toBe(false);
  expect(payload.recordCounts.purchaseOrders).toBe(1);
  expect(payload.recordCounts.products).toBe(1);
  expect(payload.normalizedData).toBeUndefined();
  expect(payload.previewLimit).toBe(5);
  expect(payload.normalizedRecords.purchaseOrders[0].po).toBe("PO-IMPORT-BROWSER-0001");
  expect(payload.normalizedRecords.products[0].sku).toBe("SKU-IMPORT-BROWSER-0001");
  expect(JSON.stringify(payload)).not.toMatch(demoIds);
});
