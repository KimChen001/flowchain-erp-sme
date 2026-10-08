import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function login(request: any, email: string) {
  const response = await request.post("/api/auth/login", {
    data: { email, name: "Ignored", company: "Ignored" },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function session(page: any, value: any) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem("flowchain:auth-token", token);
    localStorage.setItem("flowchain:current-user", JSON.stringify(user));
  }, value);
}

async function confirmPreview(page: any) {
  await expect(page.getByTestId("return-preview")).toContainText("允许执行");
  await page.getByTestId("confirm-return-action").click();
}

async function createRequest(
  page: any,
  {
    type,
    number,
    sourceId,
    quantity,
  }: {
    type: "customer_return" | "supplier_return";
    number: string;
    sourceId: string;
    quantity: string;
  },
) {
  await page.goto("/app/inventory/returns/requests/new");
  await page.getByLabel("退货类型").selectOption(type);
  await page.getByLabel("申请单号").fill(number);
  await page.getByLabel("来源单据").selectOption(sourceId);
  await page.getByLabel("选择来源行 RET-BROWSER-SKU").check();
  await page.getByLabel("申请数量 RET-BROWSER-SKU").fill(quantity);
  await page.getByLabel("原因说明").fill("Playwright governed return");
  await page.getByTestId("preview-return-request").click();
  await confirmPreview(page);
  await expect(page.getByTestId("return-request-workbench")).toBeVisible();
  await expect(page).not.toHaveURL(/\/requests\/new$/);
  return page.url();
}

async function submitAndAuthorize(
  page: any,
  {
    authorizationNumber,
    quantity,
    route,
  }: {
    authorizationNumber: string;
    quantity: string;
    route: string;
  },
) {
  await page.getByTestId("preview-submit-return").click();
  await confirmPreview(page);
  await expect(page.getByTestId("return-authorization-form")).toBeVisible();
  await page.getByLabel("授权单号").fill(authorizationNumber);
  await page.getByLabel("授权数量 RET-BROWSER-SKU").fill(quantity);
  await page.getByLabel("处置路径 RET-BROWSER-SKU").selectOption(route);
  await page.getByTestId("preview-authorize-return").click();
  await confirmPreview(page);
  await page.getByRole("link", { name: authorizationNumber }).click();
  await expect(page.getByTestId("return-authorization-workbench")).toBeVisible();
}

async function createPosting(
  page: any,
  {
    postingNumber,
    quantity,
    sourceBalanceLabel,
    sourceBalanceId,
    destinationBalanceId,
  }: {
    postingNumber: string;
    quantity: string;
    sourceBalanceLabel: string;
    sourceBalanceId: string;
    destinationBalanceId?: string;
  },
) {
  await page.getByLabel("执行单号").fill(postingNumber);
  await page.getByLabel("执行数量 RET-BROWSER-SKU").fill(quantity);
  await page.getByLabel(sourceBalanceLabel).selectOption(sourceBalanceId);
  if (destinationBalanceId)
    await page
      .getByLabel("目标可用库存余额 RET-BROWSER-SKU")
      .selectOption(destinationBalanceId);
  await page.getByTestId("preview-create-return-posting").click();
  await confirmPreview(page);
  await expect(page).toHaveURL(/\/app\/inventory\/returns\/postings\/[^/]+$/);
  return page.url();
}

async function readyAndPost(page: any) {
  await page.getByRole("button", { name: "预览就绪" }).click();
  await confirmPreview(page);
  await page.getByTestId("preview-post-return").click();
  await confirmPreview(page);
  await expect(page.getByTestId("preview-reverse-return")).toBeEnabled();
  await expect(page.getByTestId("return-reconciliation")).toContainText(
    "已匹配",
  );
}

test("return and quarantine workbench closes supplier, customer, release, evidence, reversal, and access gates", async ({
  page,
  request,
  browser,
}) => {
  const manager = await login(request, "manager@example.com");
  await session(page, manager);

  await page.goto("/app/inventory/returns");
  const landing = page.getByTestId("returns-landing");
  await expect(landing).toBeVisible();
  await expect(landing.getByRole("link", { name: /退货申请/ })).toBeVisible();
  await expect(landing.getByRole("link", { name: /隔离库存/ })).toBeVisible();

  const customerRequestUrl = await createRequest(page, {
    type: "customer_return",
    number: "RET-CUST-BROWSER-001",
    sourceId: "returns-browser-shipment",
    quantity: "4.0000",
  });
  await submitAndAuthorize(page, {
    authorizationNumber: "AUTH-CUST-BROWSER-001",
    quantity: "4.0000",
    route: "receive_to_quarantine",
  });
  const customerPostingUrl = await createPosting(page, {
    postingNumber: "POST-CUST-BROWSER-001",
    quantity: "4.0000",
    sourceBalanceLabel: "隔离库存余额 RET-BROWSER-SKU",
    sourceBalanceId: "returns-browser-quarantine",
  });
  await readyAndPost(page);
  await expect(page.getByTestId("return-evidence")).toContainText(
    "customer_return_quarantine_in",
  );
  await expect(
    page
      .getByTestId("return-posting-workbench")
      .getByRole("link", { name: "隔离库存" }),
  ).toBeVisible();

  await page.goto("/app/inventory/quarantine?sku=RET-BROWSER-SKU");
  await expect(page.getByTestId("quarantine-inventory-workbench")).toContainText(
    "4.0000",
  );
  await expect(page.getByTestId("quarantine-inventory-workbench")).toContainText(
    "否",
  );
  const availableAfterCustomer = await request.get(
    "/api/inventory/balances?sku=RET-BROWSER-SKU",
    { headers: { Authorization: `Bearer ${manager.token}` } },
  );
  const availableCustomerData = await availableAfterCustomer.json();
  expect(
    availableCustomerData.balances.find(
      (row: any) => row.id === "returns-browser-available-source",
    ).onHandQuantity,
  ).toBe("20.0000");

  await page.goto(customerRequestUrl);
  await expect(page.getByTestId("return-authorization-form")).toContainText(
    "隔离库存释放授权",
  );
  await page.getByLabel("授权单号").fill("AUTH-RELEASE-BROWSER-001");
  await page.getByLabel("授权数量 RET-BROWSER-SKU").fill("2.0000");
  await page
    .getByLabel("处置路径 RET-BROWSER-SKU")
    .selectOption("release_quarantine_to_available");
  await page.getByTestId("preview-authorize-return").click();
  await confirmPreview(page);
  await page
    .getByRole("link", { name: "AUTH-RELEASE-BROWSER-001" })
    .click();
  const releasePostingUrl = await createPosting(page, {
    postingNumber: "POST-RELEASE-BROWSER-001",
    quantity: "2.0000",
    sourceBalanceLabel: "隔离库存余额 RET-BROWSER-SKU",
    sourceBalanceId: "returns-browser-quarantine",
    destinationBalanceId: "returns-browser-available-destination",
  });
  await readyAndPost(page);
  await expect(page.getByTestId("return-reconciliation")).toContainText(
    "movement_quarantine_release_out",
  );
  await expect(page.getByTestId("return-reconciliation")).toContainText(
    "movement_quarantine_release_available_in",
  );
  await page.goto("/app/inventory/quarantine?sku=RET-BROWSER-SKU");
  await expect(page.getByTestId("quarantine-inventory-workbench")).toContainText(
    "2.0000",
  );
  let balances = await request.get("/api/inventory/balances?sku=RET-BROWSER-SKU", {
    headers: { Authorization: `Bearer ${manager.token}` },
  });
  let balanceData = await balances.json();
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "returns-browser-available-destination",
    ).availableQuantity,
  ).toBe("2.0000");

  await page.goto(releasePostingUrl);
  await page.getByTestId("preview-reverse-return").click();
  await expect(page.getByTestId("return-preview")).toContainText("允许执行");
  await page.getByLabel("冲销原因").fill("Playwright release reversal");
  await page.getByTestId("confirm-return-action").click();
  await expect(page.getByTestId("return-posting-workbench")).toContainText(
    "已冲销",
  );
  await page.goto("/app/inventory/quarantine?sku=RET-BROWSER-SKU");
  await expect(page.getByTestId("quarantine-inventory-workbench")).toContainText(
    "4.0000",
  );

  const supplierRequestUrl = await createRequest(page, {
    type: "supplier_return",
    number: "RET-SUP-BROWSER-001",
    sourceId: "returns-browser-receiving",
    quantity: "3.0000",
  });
  await submitAndAuthorize(page, {
    authorizationNumber: "AUTH-SUP-BROWSER-001",
    quantity: "3.0000",
    route: "return_from_available",
  });
  const supplierPostingUrl = await createPosting(page, {
    postingNumber: "POST-SUP-BROWSER-001",
    quantity: "3.0000",
    sourceBalanceLabel: "可用库存余额 RET-BROWSER-SKU",
    sourceBalanceId: "returns-browser-available-source",
  });
  await readyAndPost(page);
  balances = await request.get("/api/inventory/balances?sku=RET-BROWSER-SKU", {
    headers: { Authorization: `Bearer ${manager.token}` },
  });
  balanceData = await balances.json();
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "returns-browser-available-source",
    ).onHandQuantity,
  ).toBe("17.0000");
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "returns-browser-available-source",
    ).reservedQuantity,
  ).toBe("2.0000");

  await page.getByTestId("preview-reverse-return").click();
  await expect(page.getByTestId("return-preview")).toContainText("允许执行");
  await page.getByLabel("冲销原因").fill("Playwright supplier reversal");
  await page.getByTestId("confirm-return-action").click();
  await expect(page.getByTestId("return-posting-workbench")).toContainText(
    "已冲销",
  );
  balances = await request.get("/api/inventory/balances?sku=RET-BROWSER-SKU", {
    headers: { Authorization: `Bearer ${manager.token}` },
  });
  balanceData = await balances.json();
  expect(
    balanceData.balances.find(
      (row: any) => row.id === "returns-browser-available-source",
    ).onHandQuantity,
  ).toBe("20.0000");

  const viewer = await login(request, "viewer@example.com");
  const viewerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const viewerPage = await viewerContext.newPage();
  await session(viewerPage, viewer);
  await viewerPage.goto(supplierPostingUrl);
  await expect(viewerPage.getByTestId("return-posting-workbench")).toBeVisible();
  await expect(viewerPage.getByTestId("preview-post-return")).toBeDisabled();
  await expect(viewerPage.getByTestId("preview-reverse-return")).toBeDisabled();
  const viewerCreate = await request.post("/api/returns/requests", {
    headers: { Authorization: `Bearer ${viewer.token}` },
    data: {
      requestNumber: "VIEWER-DENIED",
      returnType: "customer_return",
      contextDocumentType: "ShipmentDocument",
      contextDocumentId: "returns-browser-shipment",
      reasonCode: "damaged",
      lines: [
        {
          sourceDocumentLineId: "returns-browser-shipment-line",
          requestedQuantity: "1.0000",
        },
      ],
      idempotencyKey: "viewer-denied",
    },
  });
  expect(viewerCreate.status()).toBe(403);
  await viewerContext.close();

  const noScope = await login(request, "readonly@example.com");
  const hidden = await request.get(
    new URL(supplierRequestUrl).pathname.replace("/app/", "/api/") +
      "/workbench",
    { headers: { Authorization: `Bearer ${noScope.token}` } },
  );
  expect(hidden.status()).toBe(404);

  expect(customerPostingUrl).toContain("/app/inventory/returns/postings/");
});
