import { expect, test } from "@playwright/test";

test.setTimeout(150_000);

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

async function api(
  request: any,
  token: string,
  method: "get" | "post",
  path: string,
  data?: any,
) {
  const response = await request[method](path, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  expect(
    response.ok(),
    `${method.toUpperCase()} ${path}: ${response.status()} ${JSON.stringify(body)}`,
  ).toBeTruthy();
  return body;
}

const supplierInvoice = (
  number: string,
  quantity: string,
  unitPrice: string,
  lineAmount: string,
) => ({
  invoiceNumber: number,
  supplierId: "finance-browser-supplier",
  currency: "CNY",
  invoiceDate: "2026-07-01T00:00:00.000Z",
  dueDate: "2026-07-10T00:00:00.000Z",
  totalAmount: lineAmount,
  lines: [
    {
      purchaseOrderLineId: "finance-browser-po-line",
      receivingLineId: "finance-browser-grn-line",
      quantity,
      unitPrice,
      lineAmount,
      enteredTaxAmount: "0.0000",
    },
  ],
});

async function createAndMatchSupplierInvoice(
  request: any,
  specialistToken: string,
  payload: any,
  suffix: string,
) {
  const preview = await api(
    request,
    specialistToken,
    "post",
    "/api/finance/supplier-invoices/preview",
    payload,
  );
  expect(preview.allowed).toBe(true);
  const created = await api(
    request,
    specialistToken,
    "post",
    "/api/finance/supplier-invoices",
    { ...payload, idempotencyKey: `browser-create-supplier-${suffix}` },
  );
  await api(
    request,
    specialistToken,
    "post",
    `/api/finance/supplier-invoices/${created.entityId}/submit`,
    {
      expectedVersion: 0,
      idempotencyKey: `browser-submit-supplier-${suffix}`,
    },
  );
  const matched = await api(
    request,
    specialistToken,
    "post",
    `/api/finance/supplier-invoices/${created.entityId}/match`,
    {
      expectedVersion: 1,
      matchNumber: `MATCH-BROWSER-${suffix}`,
      idempotencyKey: `browser-match-supplier-${suffix}`,
    },
  );
  return { created, matched };
}

async function issueCustomerInvoice(
  request: any,
  specialistToken: string,
  managerToken: string,
  {
    suffix,
    shipmentId,
    shipmentLineId,
    currency,
    quantity,
    totalAmount,
    tax = "0.0000",
  }: any,
) {
  // No invoice number: the server assigns CI-YYYYMM-NNNN when the draft is created.
  const payload = {
    shipmentId,
    currency,
    invoiceDate: "2026-07-01T00:00:00.000Z",
    dueDate: "2026-07-10T00:00:00.000Z",
    totalAmount,
    lines: [
      {
        shipmentLineId,
        quantity,
        enteredTaxAmount: tax,
      },
    ],
  };
  const preview = await api(
    request,
    specialistToken,
    "post",
    "/api/finance/customer-invoices/preview",
    payload,
  );
  expect(preview.allowed).toBe(true);
  const created = await api(
    request,
    specialistToken,
    "post",
    "/api/finance/customer-invoices",
    { ...payload, idempotencyKey: `browser-create-customer-${suffix}` },
  );
  await api(
    request,
    specialistToken,
    "post",
    `/api/finance/customer-invoices/${created.entityId}/submit`,
    {
      expectedVersion: 0,
      idempotencyKey: `browser-submit-customer-${suffix}`,
    },
  );
  await api(
    request,
    managerToken,
    "post",
    `/api/finance/customer-invoices/${created.entityId}/approve`,
    {
      expectedVersion: 1,
      idempotencyKey: `browser-approve-customer-${suffix}`,
    },
  );
  const issued = await api(
    request,
    managerToken,
    "post",
    `/api/finance/customer-invoices/${created.entityId}/issue`,
    {
      expectedVersion: 2,
      obligationNumber: `AR-BROWSER-${suffix}`,
      idempotencyKey: `browser-issue-customer-${suffix}`,
    },
  );
  return { created, issued };
}

test("operational finance closes P2P, O2C, credit, aging, role, evidence, and currency product gates", async ({
  page,
  request,
  browser,
}) => {
  const manager = await login(request, "manager@example.com");
  const specialist = await login(request, "specialist@example.com");
  const viewer = await login(request, "viewer@example.com");
  await session(page, manager);

  const exact = await createAndMatchSupplierInvoice(
    request,
    specialist.token,
    supplierInvoice("SUP-INV-BROWSER-EXACT", "4.0000", "10.0000", "40.0000"),
    "EXACT",
  );
  const exactApproval = await api(
    request,
    manager.token,
    "post",
    `/api/finance/supplier-invoices/${exact.created.entityId}/approve`,
    {
      expectedVersion: 2,
      obligationNumber: "AP-BROWSER-EXACT",
      idempotencyKey: "browser-approve-supplier-exact",
    },
  );
  expect(exactApproval.payable.status).toBe("approved");

  const variance = await createAndMatchSupplierInvoice(
    request,
    specialist.token,
    supplierInvoice("SUP-INV-BROWSER-VARIANCE", "4.0000", "11.0000", "44.0000"),
    "VARIANCE",
  );
  expect(variance.matched.invoice.status).toBe("exception");
  const exceptions = await api(
    request,
    manager.token,
    "get",
    `/api/finance/match-exceptions?invoiceId=${variance.created.entityId}`,
  );
  expect(exceptions.items.length).toBeGreaterThan(0);
  for (const entry of exceptions.items)
    await api(
      request,
      manager.token,
      "post",
      `/api/finance/match-exceptions/${entry.id}/review`,
      {
        expectedVersion: entry.version,
        decision: "approved",
        resolution: "Browser acceptance reviewed variance.",
        idempotencyKey: `browser-review-${entry.id}`,
      },
    );
  await api(
    request,
    manager.token,
    "post",
    `/api/finance/supplier-invoices/${variance.created.entityId}/approve`,
    {
      expectedVersion: 2,
      obligationNumber: "AP-BROWSER-VARIANCE",
      idempotencyKey: "browser-approve-supplier-variance",
    },
  );

  const exactDetail = await api(
    request,
    viewer.token,
    "get",
    `/api/finance/supplier-invoices/${exact.created.entityId}`,
  );
  expect(exactDetail.evidence.length).toBeGreaterThan(1);
  expect(exactDetail.reconciliation[0].matched).toBe(true);
  const supplierCreditPayload = {
    creditMemoNumber: "SUP-CREDIT-BROWSER-001",
    supplierInvoiceId: exact.created.entityId,
    returnPostingId: "finance-browser-return-posting-SUP",
    currency: "CNY",
    lines: [
      {
        supplierInvoiceLineId: exactDetail.lines[0].id,
        returnPostingLineId: "finance-browser-return-posting-line-SUP",
        quantity: "2.0000",
        pricingSource: "original_invoice",
        enteredTaxAmount: "0.0000",
      },
    ],
  };
  const supplierCredit = await api(
    request,
    specialist.token,
    "post",
    "/api/finance/supplier-credit-memos",
    {
      ...supplierCreditPayload,
      idempotencyKey: "browser-create-supplier-credit",
    },
  );
  const supplierCreditApproved = await api(
    request,
    manager.token,
    "post",
    `/api/finance/supplier-credit-memos/${supplierCredit.entityId}/approve`,
    {
      expectedVersion: 0,
      idempotencyKey: "browser-approve-supplier-credit",
    },
  );
  expect(supplierCreditApproved.creditMemo.status).toBe("approved");

  const cny = await issueCustomerInvoice(
    request,
    specialist.token,
    manager.token,
    {
      suffix: "CNY",
      shipmentId: "finance-browser-shipment-CNY",
      shipmentLineId: "finance-browser-shipment-line-CNY",
      currency: "CNY",
      quantity: "4.0000",
      totalAmount: "52.0000",
      tax: "2.0000",
    },
  );
  expect(cny.issued.receivable.status).toBe("open");
  expect(cny.issued.receivable.settlementVerified).toBe(false);
  const cnyNumber: string = cny.created.invoice.invoiceNumber;
  expect(cnyNumber).toMatch(/^CI-\d{6}-\d{4,}$/);
  const usd = await issueCustomerInvoice(request, specialist.token, manager.token, {
    suffix: "USD",
    shipmentId: "finance-browser-shipment-USD",
    shipmentLineId: "finance-browser-shipment-line-USD",
    currency: "USD",
    quantity: "2.0000",
    totalAmount: "25.0000",
  });
  const usdNumber: string = usd.created.invoice.invoiceNumber;

  const customerDetail = await api(
    request,
    viewer.token,
    "get",
    `/api/finance/customer-invoices/${cny.created.entityId}`,
  );
  expect(customerDetail.evidence[1].postingStatus).toBe("posted");
  const customerCreditPayload = {
    creditNoteNumber: "CUS-CREDIT-BROWSER-001",
    customerInvoiceId: cny.created.entityId,
    returnPostingId: "finance-browser-return-posting-CUST",
    currency: "CNY",
    lines: [
      {
        customerInvoiceLineId: customerDetail.lines[0].id,
        returnPostingLineId: "finance-browser-return-posting-line-CUST",
        quantity: "2.0000",
        pricingSource: "original_invoice",
        enteredTaxAmount: "0.0000",
      },
    ],
  };
  const customerCredit = await api(
    request,
    specialist.token,
    "post",
    "/api/finance/customer-credit-notes",
    {
      ...customerCreditPayload,
      idempotencyKey: "browser-create-customer-credit",
    },
  );
  const customerCreditApproved = await api(
    request,
    manager.token,
    "post",
    `/api/finance/customer-credit-notes/${customerCredit.entityId}/approve`,
    {
      expectedVersion: 0,
      idempotencyKey: "browser-approve-customer-credit",
    },
  );
  expect(customerCreditApproved.creditNote.status).toBe("approved");

  // A draft entered for the rest of the CNY shipment is submitted, approved
  // and issued from its detail page, each step previewed before confirming.
  const uiDraft = await api(
    request,
    specialist.token,
    "post",
    "/api/finance/customer-invoices",
    {
      shipmentId: "finance-browser-shipment-CNY",
      currency: "CNY",
      invoiceDate: "2026-07-01T00:00:00.000Z",
      dueDate: "2026-07-10T00:00:00.000Z",
      totalAmount: "12.5000",
      lines: [
        {
          shipmentLineId: "finance-browser-shipment-line-CNY",
          quantity: "1.0000",
          enteredTaxAmount: "0.0000",
        },
      ],
      idempotencyKey: "browser-create-customer-ui",
    },
  );
  const uiNumber: string = uiDraft.invoice.invoiceNumber;
  await page.goto(`/app/finance/customer-invoices/${uiDraft.entityId}`);
  await expect(page.getByTestId("customer-invoice-detail")).toContainText(uiNumber);
  // Submit, approve and issue only change the invoice's status: one click
  // each (owner decision D4), and the step is done when its button goes.
  // A run that fails after an allowed preview (here a forced 409, as when
  // someone else acted first) opens the panel with the error to retry.
  await page.route("**/api/finance/customer-invoices/*/submit", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { code: "BROWSER_TEST_RUN_FAILED", message: "Someone else changed this invoice first." } })
      : route.fallback(),
  );
  await page.getByTestId("customer-invoice-submit").click();
  await expect(page.getByTestId("customer-invoice-submit-panel")).toContainText("Someone else changed this invoice first.");
  // The earlier preview no longer holds: Confirm stays available and previews
  // again before it runs (the form standard never disables it to wait).
  await expect(page.getByTestId("customer-invoice-submit-confirm")).toBeEnabled();
  await expect(page.getByTestId("customer-invoice-submit-panel")).not.toContainText(/Preview passed|预览通过/);
  await page.unroute("**/api/finance/customer-invoices/*/submit");
  await page.getByTestId("customer-invoice-submit-panel").getByRole("button", { name: /^(Close|关闭)$/ }).click();
  for (const action of ["submit", "approve", "issue"]) {
    await expect(page.getByTestId(`customer-invoice-${action}`)).toHaveAttribute("data-one-step", "true");
    await page.getByTestId(`customer-invoice-${action}`).click();
    await expect(page.getByTestId(`customer-invoice-${action}`)).toHaveCount(0);
    await expect(page.getByTestId(`customer-invoice-${action}-panel`)).toHaveCount(0);
  }
  // With no step of its own left, the invoice points to recording the
  // payment, and never says "No action is available" next to an action.
  await expect(page.getByTestId("customer-invoice-next")).toContainText(/Next: record the payment received|下一步：登记收款/);
  await expect(page.getByTestId("customer-invoice-actions")).not.toContainText(/当前状态下没有可执行的操作|No action is available/);
  // Issued and nothing received: the header reads To be paid, and Overdue past its due date.
  await expect(page.getByTestId("customer-invoice-status")).toContainText(/To be paid|待收款/);
  await expect(page.getByTestId("customer-invoice-status")).toContainText(/Overdue|已逾期/);
  const uiIssued = await api(
    request,
    manager.token,
    "get",
    `/api/finance/customer-invoices/${uiDraft.entityId}`,
  );
  expect(uiIssued.status).toBe("issued");
  expect(uiIssued.receivable.obligationNumber).toBe(`AR-${uiNumber}`);
  // Due 2026-07-10 and still owed: the receivable reads overdue, as it does
  // in the receivables list, and its due date is red.
  await expect(page.getByTestId("customer-invoice-receivable-status")).toHaveText(/^(已逾期|Overdue)$/);
  await expect(page.getByTestId("customer-invoice-receivable-due")).toHaveCSS("color", "rgb(185, 28, 28)");
  await expect(page.getByTestId("customer-invoice-due-date")).toHaveCSS("color", "rgb(185, 28, 28)");

  await page.goto("/app/finance/overview");
  await expect(page.getByTestId("operational-finance-landing")).toBeVisible();
  // The overview shows the money first, one amount per currency and never
  // added together: CNY 52 less the 25 credit plus the 12.50 invoice, and
  // USD 25, all owed and all overdue.
  const overviewCards = page.getByTestId("finance-overview-cards");
  const owedTile = overviewCards.getByRole("link", { name: /^(应收未收|Owed to us):/ });
  await expect(owedTile).toContainText("39.50");
  await expect(owedTile).toContainText("25.00");
  await expect(owedTile).toContainText(/3 张发票已开具|3 invoices issued/);
  const overdueTile = overviewCards.getByRole("link", { name: /^(逾期应收款|Overdue receivables):/ });
  await expect(overdueTile).toContainText("39.50");
  await expect(overdueTile).toContainText("25.00");
  // The aging strip: due 2026-07-10, so every receivable is over 90 days
  // past due, and each bucket opens the aging page for its currency.
  const agingStrip = page.getByTestId("finance-aging-receivables");
  await expect(agingStrip.getByTestId("finance-aging-receivables-CNY-90_plus")).toContainText("39.50");
  await expect(agingStrip.getByTestId("finance-aging-receivables-USD-90_plus")).toContainText("25.00");
  await expect(agingStrip.getByTestId("finance-aging-receivables-USD-90_plus")).toHaveAttribute("href", "/app/finance/aging?currency=USD");
  await expect(page.getByTestId("finance-aging-payables")).toContainText("CNY");
  // Every receivable here is past its 2026-07-10 due date, so the overdue
  // card's link must list them although none has the stored status overdue.
  await overdueTile.click();
  await expect(page).toHaveURL(/\/app\/finance\/receivables\?status=overdue$/);
  const receivables = page.getByTestId("receivables-workbench");
  for (const number of [cnyNumber, usdNumber, uiNumber])
    await expect(receivables).toContainText(number);
  await expect(receivables.getByTestId("receivable-row")).toHaveCount(3);
  // The search box filters on the server by invoice number; the list says
  // how many match and the cards still count every receivable.
  const search = receivables.getByRole("searchbox", { name: /^(Search|搜索)$/ });
  await search.fill(usdNumber);
  await search.press("Enter");
  await expect(page).toHaveURL(new RegExp(`search=${usdNumber}`));
  await expect(receivables.getByTestId("receivable-row")).toHaveCount(1);
  await expect(receivables.getByTestId("receivable-row")).toContainText(usdNumber);
  await expect(receivables.getByTestId("receivable-list")).toContainText(/共 1 条|1 total/);
  await expect(receivables.getByTestId("receivable-metrics").getByRole("link", { name: /已逾期|Overdue/ })).toContainText("3");
  await expect(receivables.getByTestId("receivable-metrics").getByRole("link", { name: /未结应收|Open receivables/ })).toContainText("3");
  // ...and by customer.
  await search.fill("Finance Browser Customer USD");
  await search.press("Enter");
  await expect(receivables.getByTestId("receivable-row")).toHaveCount(1);
  await expect(receivables.getByTestId("receivable-row")).toContainText(usdNumber);
  // An overdue receivable's chip reads overdue.
  await expect(receivables.getByTestId("receivable-row")).toContainText(/已逾期|Overdue/);
  // One notice on the page.
  await expect(receivables.getByTestId("receivables-notice")).toHaveCount(1);
  await page.goto("/app/finance/overview");
  await expect(page.getByTestId("operational-finance-landing")).toBeVisible();
  // One notice, and the cards are router links to the lists they count.
  await expect(page.getByTestId("finance-overview-notice")).toContainText(/应付款和应收款记录的是欠款|Payables and receivables record what is owed/);
  // Four money and decision tiles, and five quieter ones shown even at 0.
  await expect(page.getByTestId("finance-overview-cards").getByRole("link")).toHaveCount(4);
  await expect(page.getByTestId("finance-overview-secondary").getByRole("link")).toHaveCount(5);
  await expect(page.getByTestId("finance-overview-secondary").getByRole("link", { name: /^(有争议的应收款|Disputed receivables): 0,/ })).toBeVisible();
  await expect(page.getByText("应付款不代表已付款。")).toHaveCount(0);
  await page.getByTestId("finance-overview-cards").getByRole("link", { name: /^(待付款|To pay):/ }).click();
  await expect(page).toHaveURL(/\/app\/finance\/payables\?status=outstanding$/);
  await expect(page.getByTestId("operational-finance-payable-list")).toContainText("AP-BROWSER-EXACT");
  await page.goto("/app/finance/overview");
  // The currency card is one line now.
  await expect(page.getByTestId("finance-currency-limitation")).toContainText(
    /金额按币种分别列示|Amounts per currency/,
  );
  await expect(page.getByTestId("finance-currency-limitation")).toContainText(
    "CNY",
  );
  await expect(page.getByTestId("finance-currency-limitation")).toContainText(
    "USD",
  );

  // Bills live under Purchasing; the old Finance address still lands there.
  await page.goto("/app/finance/invoices?status=approved");
  await expect(page).toHaveURL(/\/app\/procurement\/bills\?status=approved$/);
  await expect(page.getByTestId("operational-finance-invoice-list")).toContainText(
    "SUP-INV-BROWSER-EXACT",
  );
  // Match exceptions are reviewed on the bill they belong to.
  await page.goto("/app/procurement/bills");
  await page.getByRole("link", { name: "SUP-INV-BROWSER-VARIANCE", exact: true }).click();
  // The difference reads by its kind, never as the stored code; every one
  // reviewed (above, through the API), the match no longer reads as an exception.
  await expect(page.getByTestId("supplier-invoice-match")).toContainText(/Price difference|价格差异/);
  await expect(page.getByTestId("supplier-invoice-match")).toContainText(/Variance approved|差异已批准/);
  await expect(page.getByTestId("supplier-invoice-match")).not.toContainText(/line-level match exception/);
  await page.goto("/app/finance/payables");
  const payables = page.getByTestId("operational-finance-payable-list");
  await expect(payables).toContainText("AP-BROWSER-EXACT");
  await expect(page.getByText("应付款不代表已付款。")).toBeVisible();
  // Payables have the receivables page's cards and Actions column.
  await expect(payables.getByTestId("payable-metrics").getByRole("link")).toHaveCount(4);
  await expect(payables.getByRole("columnheader", { name: /^(Actions|操作)$/ })).toBeVisible();
  await expect(payables.getByTestId("payable-row").filter({ hasText: "AP-BROWSER-EXACT" }).getByRole("link", { name: /^(View|查看)$/ })).toBeVisible();
  const payableSearch = payables.getByRole("searchbox", { name: /^(Search|搜索)$/ });
  await payableSearch.fill("AP-BROWSER-VARIANCE");
  await payableSearch.press("Enter");
  await expect(payables.getByTestId("payable-row")).toHaveCount(1);
  await expect(payables.getByTestId("payable-row")).toContainText("AP-BROWSER-VARIANCE");
  await page.goto("/app/finance/credits");
  await expect(page.getByTestId("operational-finance-credit-list")).toContainText(
    "SUP-CREDIT-BROWSER-001",
  );
  await page.goto("/app/sales/invoices");
  await expect(page.getByTestId("customer-invoice-workbench")).toContainText(
    cnyNumber,
  );
  await page.goto("/app/finance/aging");
  await expect(page.getByTestId("receivables-aging")).toContainText(
    "多币种，未折算",
  );
  await expect(page.getByTestId("receivables-aging")).toContainText("America/New_York");
  await page.goto("/app/finance/customer-credit-notes");
  await expect(page.getByTestId("customer-credit-notes")).toContainText(
    "CUS-CREDIT-BROWSER-001",
  );
  await expect(page.getByText("贷项通知单不自动执行退款。")).toBeVisible();

  const viewerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const viewerPage = await viewerContext.newPage();
  await session(viewerPage, viewer);
  // Customer invoices live under Sales; the old Finance address lands there.
  await viewerPage.goto("/app/finance/customer-invoices");
  await expect(viewerPage).toHaveURL(/\/app\/sales\/invoices$/);
  await expect(viewerPage.getByTestId("customer-invoice-workbench")).toBeVisible();
  const salesTabs = viewerPage.getByTestId("module-subnav");
  await expect(
    salesTabs.getByRole("link", { name: "Customer invoices", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    viewerPage.getByRole("link", { name: "New customer invoice" }),
  ).toHaveAttribute("aria-disabled", "true");
  await viewerPage.goto("/app/finance/overview");
  // The viewer reads receivables and payables but not their amounts: the
  // counts stay, each tile says its amount is hidden, and the aging bar
  // counts invoices. No amount reaches the page.
  const viewerLanding = viewerPage.getByTestId("operational-finance-landing");
  const viewerOwed = viewerLanding.getByTestId("finance-overview-cards").getByRole("link", { name: /^(应收未收|Owed to us):/ });
  await expect(viewerOwed).toContainText("3");
  await expect(viewerOwed).toContainText(/当前角色无权查看金额|amount hidden for your role/);
  await expect(viewerLanding.getByTestId("finance-aging-receivables")).toContainText(/当前角色无权查看金额|Amounts hidden for your role/);
  await expect(viewerLanding.getByTestId("finance-aging-receivables-CNY-90_plus")).toContainText("2");
  await expect(viewerLanding).not.toContainText("39.50");
  await expect(viewerLanding).not.toContainText("25.00");
  const financeTabs = viewerPage.getByTestId("module-subnav");
  await expect(
    financeTabs.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    financeTabs.getByRole("link", { name: "Supplier invoices to pay", exact: true }),
  ).toBeVisible();
  // Supplier and customer invoices are not repeated under Payables & receivables.
  await expect(financeTabs.getByRole("link", { name: "Supplier invoices", exact: true })).toHaveCount(0);
  await expect(financeTabs.getByRole("link", { name: "Customer invoices", exact: true })).toHaveCount(0);
  await expect(viewerPage.getByRole("link", { name: "采购发票" })).toHaveCount(0);
  const viewerWrite = await request.post("/api/finance/customer-invoices", {
    headers: { Authorization: `Bearer ${viewer.token}` },
    data: {
      shipmentId: "finance-browser-shipment-CNY",
      currency: "CNY",
      invoiceDate: "2026-07-01T00:00:00.000Z",
      dueDate: "2026-07-10T00:00:00.000Z",
      lines: [
        {
          shipmentLineId: "finance-browser-shipment-line-CNY",
          quantity: "1.0000",
        },
      ],
      idempotencyKey: "viewer-denied-customer-invoice",
    },
  });
  expect(viewerWrite.status()).toBe(403);
  await viewerContext.close();
});

// A list longer than one page: the list card shows the server's total, the
// cards show the server's counts over every record, and the pager asks the
// server for the next page. Served by a stub, so 120 receivables need no seed.
test("the receivables list shows the true total and pages 50 at a time", async ({ page, request }) => {
  const manager = await login(request, "manager@example.com");
  await session(page, manager);
  const receivable = (index: number) => ({
    id: `AR-STUB-${index}`,
    obligationNumber: `AR-CI-STUB-${String(index).padStart(3, "0")}`,
    customerInvoiceId: `CI-ID-STUB-${index}`,
    customerInvoiceNumber: `CI-STUB-${String(index).padStart(3, "0")}`,
    customerName: `Stub Customer ${index}`,
    outstandingAmount: index < 10 ? "10.0000" : "0.0000",
    currency: "GBP",
    dueDate: index < 10 ? "2026-01-10T00:00:00.000Z" : "2025-12-01T00:00:00.000Z",
    status: index < 10 ? "open" : "settled",
    disputeStatus: "none",
    settlementVerified: false,
    availableActions: [],
  });
  const requested: URL[] = [];
  await page.route((url) => url.pathname === "/api/finance/receivables", (route) => {
    const url = new URL(route.request().url());
    requested.push(url);
    const pageNumber = Number(url.searchParams.get("page") || 1);
    const items = Array.from({ length: pageNumber < 3 ? 50 : 20 }, (_, index) => receivable((pageNumber - 1) * 50 + index));
    return route.fulfill({ json: { dataSource: "stub", page: pageNumber, pageSize: 50, total: 120, counts: { outstanding: 87, overdue: 52, disputed: 4, settled: 33 }, currencies: ["GBP"], items, capabilities: {} } });
  });
  await page.goto("/app/finance/receivables");
  const receivables = page.getByTestId("receivables-workbench");
  await expect(receivables.getByTestId("receivable-row")).toHaveCount(50);
  await expect(receivables.getByTestId("receivable-list")).toContainText(/共 120 条，当前显示 50 条|120 total, 50 shown/);
  const metrics = receivables.getByTestId("receivable-metrics");
  await expect(metrics.getByRole("link", { name: /未结应收|Open receivables/ })).toContainText("87");
  await expect(metrics.getByRole("link", { name: /已逾期|Overdue/ })).toContainText("52");
  await expect(metrics.getByRole("link", { name: /已结清|Paid/ })).toContainText("33");
  // The list asks for 50, overdue and open first.
  expect(requested[0].searchParams.get("pageSize")).toBe("50");
  expect(requested[0].searchParams.get("sort")).toBe("attention");
  const pager = receivables.getByTestId("receivable-pager");
  await expect(pager).toContainText(/第 1 \/ 3 页 · 共 120 条|Page 1 of 3 · 120 results/);
  await pager.getByRole("button", { name: /^(下一页|Next)$/ }).click();
  await expect(page).toHaveURL(/\/app\/finance\/receivables\?page=2$/);
  await expect(receivables.getByTestId("receivable-row").first()).toContainText("CI-STUB-050");
  await expect(pager).toContainText(/第 2 \/ 3 页|Page 2 of 3/);
  expect(requested.at(-1)?.searchParams.get("page")).toBe("2");
  // A filter starts again at page 1.
  await receivables.getByRole("combobox", { name: /^(状态|Status)$/ }).selectOption("settled");
  await expect(page).toHaveURL(/\/app\/finance\/receivables\?status=settled$/);
  await expect.poll(() => requested.at(-1)?.searchParams.get("status")).toBe("settled");
  expect(requested.at(-1)?.searchParams.get("page")).toBeNull();
});
