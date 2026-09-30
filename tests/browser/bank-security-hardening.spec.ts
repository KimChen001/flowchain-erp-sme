import { expect, test } from "@playwright/test";

test.setTimeout(180_000);
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const login = async (request: any, email: string) => {
  const response = await request.post("/api/auth/login", { data: { email, name: "Bank Security User", company: "FlowChain" } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
};
const json = async (response: any) => {
  const body = await response.json();
  expect(response.ok(), `${response.status()} ${JSON.stringify(body)}`).toBeTruthy();
  return body;
};
const scan = (value: any, predicate: (key: string, child: any) => void) => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) { predicate(key, child); scan(child, predicate); }
};

test("bank projections remain redacted after historical override and role changes", async ({ page, request }) => {
  const admin = await login(request, "admin@example.com");
  const auth = headers(admin.token);
  const accounts = await json(await request.get("/api/finance/cashbook/accounts", { headers: auth }));
  const account = accounts.items.find((item: any) => item.accountCode === "BANK-BROWSER-CNY");

  const unsafeValue = "must-not-echo-browser-secret";
  const unsafe = await request.post("/api/finance/bank-mappings", { headers: auth, data: { templateCode: "BROWSER-UNSAFE", name: "Unsafe", formatType: "csv", cashbookAccountId: account.id, debitCreditMode: "signed_amount", signConvention: "positive_credit", columnMapping: { transactionId: "id" }, metadata: { clientSecret: unsafeValue } } });
  expect(unsafe.status()).toBe(422);
  const unsafeBody = await unsafe.json();
  expect(unsafeBody.code).toBe("BANK_MAPPING_SECRET_FIELD_FORBIDDEN");
  expect(JSON.stringify(unsafeBody)).not.toContain(unsafeValue);

  const mapping = await json(await request.post("/api/finance/bank-mappings", { headers: auth, data: { templateCode: "BROWSER-SEC", name: "Security Mapping", formatType: "csv", cashbookAccountId: account.id, debitCreditMode: "signed_amount", signConvention: "positive_credit", timezone: "UTC", columnMapping: { transactionId: "transaction_id", transactionDate: "transaction_date", signedAmount: "signed_amount", currency: "currency", counterpartyName: "counterparty_name", counterpartyAccount: "counterparty_account", bankReference: "bank_reference" } } }));
  const csv = "transaction_id,transaction_date,signed_amount,currency,counterparty_name,counterparty_account,bank_reference,unknown\nSEC-1,2026-07-23,12.3400,CNY,Fictitious Partner,6222000012345678,REF-SEC-1,private-value\n";
  const upload = await json(await request.post("/api/finance/bank-statements/uploads", { headers: auth, data: { fileName: "bank-security.csv", mimeType: "text/csv", contentBase64: Buffer.from(csv).toString("base64") } }));
  let batch = await json(await request.post("/api/finance/bank-statements/batches", { headers: auth, data: { cashbookAccountId: account.id, mappingTemplateId: mapping.id, uploadId: upload.uploadId, currency: "CNY" } }));
  batch = await json(await request.post(`/api/finance/bank-statements/batches/${batch.id}/parse`, { headers: auth }));
  let rows = await json(await request.get(`/api/finance/bank-statements/batches/${batch.id}/rows`, { headers: auth }));
  await json(await request.patch(`/api/finance/bank-statements/batches/${batch.id}/rows/${rows.items[0].id}`, { headers: { ...auth, "If-Match": String(rows.items[0].version) }, data: { overrideReason: "Controlled browser correction", changes: { amount: "10.0000", counterpartyName: "Corrected Partner" } } }));

  const governance = await json(await request.get("/api/authorization/roles", { headers: auth }));
  const viewer = governance.users.find((item: any) => item.email === "viewer@example.com");
  const createRole = async (name: string, permissionCodes: string[]) => json(await request.post("/api/authorization/roles", { headers: auth, data: { name, permissionCodes } }));
  const bankRead = ["finance.bank_statement.read", "finance.bank_reconciliation.read"];
  const amountRole = await createRole("Bank Amount Browser", [...bankRead, "finance.amounts.read"]);
  const partnerRole = await createRole("Bank Partner Browser", [...bankRead, "finance.partner_snapshot.read"]);
  const readRole = await createRole("Bank Read Browser", bankRead);
  let viewerAuth = headers((await login(request, "viewer@example.com")).token);
  // A role change ends the viewer's sessions, so each check signs in again.
  const assign = async (roleId: string) => {
    const previous = viewerAuth;
    await json(await request.put(`/api/authorization/users/${viewer.id}/roles`, { headers: auth, data: { roleIds: [roleId] } }));
    expect((await request.get(`/api/finance/bank-statements/batches/${batch.id}/rows`, { headers: previous })).status()).toBe(401);
    viewerAuth = headers((await login(request, "viewer@example.com")).token);
  };
  const readRows = async () => (await json(await request.get(`/api/finance/bank-statements/batches/${batch.id}/rows`, { headers: viewerAuth }))).items[0];

  await assign(amountRole.id);
  const amountOnly = await readRows();
  expect(amountOnly.normalizedAmount).toBe("10.0000");
  expect(amountOnly.normalizedCounterpartyName).toBeNull();
  expect(amountOnly.overrideData.before.amount).toBe("12.34");
  expect(amountOnly.overrideData.after.counterpartyName).toBeNull();

  await assign(partnerRole.id);
  const partnerOnly = await readRows();
  expect(partnerOnly.normalizedAmount).toBeNull();
  expect(partnerOnly.normalizedCounterpartyName).toBe("Corrected Partner");
  expect(partnerOnly.overrideData.before.amount).toBeNull();
  expect(partnerOnly.overrideData.after.counterpartyName).toBe("Corrected Partner");

  await assign(readRole.id);
  const readOnly = await readRows();
  expect(readOnly.normalizedAmount).toBeNull();
  expect(readOnly.normalizedCounterpartyName).toBeNull();
  expect(readOnly.rawData.unknown).toBeNull();
  scan(readOnly, (key, child) => {
    expect(key).not.toMatch(/rawRowHash|canonicalFingerprint|counterpartyAccountHash|accountIdentifierHash|payloadHash|clientSecret|accessToken|refreshToken|privateKey/i);
    if (/amount|balance|debit|credit/i.test(key) && typeof child === "string") expect(child).not.toMatch(/^\d/);
  });

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(({ token, user }) => { localStorage.setItem("flowchain:auth-token", token); localStorage.setItem("flowchain:current-user", JSON.stringify(user)); }, admin);
  await page.goto("/app/finance/bank-statements");
  await expect(page.getByTestId("bank-reconciliation-workbench")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
