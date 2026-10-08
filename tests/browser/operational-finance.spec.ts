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
  const payload = {
    invoiceNumber: `CUS-INV-BROWSER-${suffix}`,
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
  await issueCustomerInvoice(request, specialist.token, manager.token, {
    suffix: "USD",
    shipmentId: "finance-browser-shipment-USD",
    shipmentLineId: "finance-browser-shipment-line-USD",
    currency: "USD",
    quantity: "2.0000",
    totalAmount: "25.0000",
  });

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
      invoiceNumber: "CUS-INV-BROWSER-UI",
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
  await page.goto(`/app/finance/customer-invoices/${uiDraft.entityId}`);
  await expect(page.getByTestId("customer-invoice-detail")).toContainText("CUS-INV-BROWSER-UI");
  // Submit, approve and issue only change the invoice's status: one click
  // each (owner decision D4), and the step is done when its button goes.
  for (const action of ["submit", "approve", "issue"]) {
    await expect(page.getByTestId(`customer-invoice-${action}`)).toHaveAttribute("data-one-step", "true");
    await page.getByTestId(`customer-invoice-${action}`).click();
    await expect(page.getByTestId(`customer-invoice-${action}`)).toHaveCount(0);
    await expect(page.getByTestId(`customer-invoice-${action}-panel`)).toHaveCount(0);
  }
  await expect(page.getByTestId("customer-invoice-actions")).toContainText(/当前状态下没有可执行的操作|No action is available/);
  const uiIssued = await api(
    request,
    manager.token,
    "get",
    `/api/finance/customer-invoices/${uiDraft.entityId}`,
  );
  expect(uiIssued.status).toBe("issued");
  expect(uiIssued.receivable.obligationNumber).toBe("AR-CUS-INV-BROWSER-UI");

  await page.goto("/app/finance/overview");
  await expect(page.getByTestId("operational-finance-landing")).toBeVisible();
  // Every receivable here is past its 2026-07-10 due date, so the overdue
  // card's link must list them although none has the stored status overdue.
  await page.getByRole("link", { name: /逾期应收义务|Overdue receivables/ }).click();
  await expect(page).toHaveURL(/\/app\/finance\/receivables\?status=overdue$/);
  for (const number of ["CUS-INV-BROWSER-CNY", "CUS-INV-BROWSER-USD", "CUS-INV-BROWSER-UI"])
    await expect(page.getByTestId("receivables-workbench")).toContainText(number);
  await page.goto("/app/finance/overview");
  await expect(page.getByTestId("operational-finance-landing")).toBeVisible();
  await expect(page.getByText("应付款不代表已付款。")).toBeVisible();
  await expect(page.getByText("应收款不代表已收款。")).toBeVisible();
  await expect(page.getByTestId("finance-currency-limitation")).toContainText(
    "多币种，未折算",
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
  await expect(page.getByTestId("supplier-invoice-match")).toContainText("price");
  await page.goto("/app/finance/payables");
  await expect(page.getByTestId("operational-finance-payable-list")).toContainText(
    "AP-BROWSER-EXACT",
  );
  await expect(page.getByText("应付款不代表已付款。")).toBeVisible();
  await page.goto("/app/finance/credits");
  await expect(page.getByTestId("operational-finance-credit-list")).toContainText(
    "SUP-CREDIT-BROWSER-001",
  );
  await page.goto("/app/sales/invoices");
  await expect(page.getByTestId("customer-invoice-workbench")).toContainText(
    "CUS-INV-BROWSER-CNY",
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
    salesTabs.getByRole("link", { name: "Invoices", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    viewerPage.getByRole("link", { name: "New invoice" }),
  ).toHaveAttribute("aria-disabled", "true");
  await viewerPage.goto("/app/finance/overview");
  const financeTabs = viewerPage.getByTestId("module-subnav");
  await expect(
    financeTabs.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    financeTabs.getByRole("link", { name: "Bills to pay", exact: true }),
  ).toBeVisible();
  // Bills and invoices are not repeated under Payables & receivables.
  await expect(financeTabs.getByRole("link", { name: "Bills", exact: true })).toHaveCount(0);
  await expect(financeTabs.getByRole("link", { name: "Invoices", exact: true })).toHaveCount(0);
  await expect(viewerPage.getByRole("link", { name: "采购发票" })).toHaveCount(0);
  const viewerWrite = await request.post("/api/finance/customer-invoices", {
    headers: { Authorization: `Bearer ${viewer.token}` },
    data: {
      invoiceNumber: "VIEWER-DENIED",
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
