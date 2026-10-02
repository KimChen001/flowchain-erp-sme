import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createOperationalFinanceCommandService,
  OperationalFinanceError,
} from "./operational-finance-command-service.mjs";
import { createOperationalFinanceReadService } from "./operational-finance-read-service.mjs";
import { createPrismaClient } from "../persistence/prisma-client.mjs";

const databaseUrl =
  process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
const enabled = Boolean(databaseUrl);
const tenantId = "tenant-operational-finance-p2p";
const otherTenantId = "tenant-operational-finance-other";
const managerId = "manager-operational-finance-p2p";
const specialistId = "specialist-operational-finance-p2p";
const viewerId = "viewer-operational-finance-p2p";
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_URL_TEST: databaseUrl,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
  NODE_ENV: "test",
};
const identity = (userId, role, currentTenantId = tenantId) => ({
  authenticated: true,
  tenantId: currentTenantId,
  userId,
  role,
  source: "test",
});
const manager = { identity: identity(managerId, "manager") };
const specialist = {
  identity: identity(specialistId, "business-specialist"),
};
const viewer = { identity: identity(viewerId, "viewer") };
const capabilities = Object.fromEntries(
  [
    "supplier-invoice",
    "three-way-match",
    "payable-obligation",
    "supplier-credit-memo",
  ].map((id) => [id, { id, enabled: true, maturity: "beta" }]),
);

async function source(prisma, suffix, {
  quantity = "10.0000",
  price = "10.0000",
  currency = "CNY",
  tenant = tenantId,
  supplierId = "supplier-finance-p2p",
  supplierName = "Finance Supplier",
} = {}) {
  const poId = `PO-FIN-${suffix}`;
  const poLineId = `POL-FIN-${suffix}`;
  const grnId = `GRN-FIN-${suffix}`;
  const receivingLineId = `GRNL-FIN-${suffix}`;
  await prisma.purchaseOrder.create({
    data: {
      id: poId,
      tenantId: tenant,
      status: "approved",
      supplierId,
      supplierName,
      currency,
      lines: {
        create: {
          id: poLineId,
          itemId: "item-finance-p2p",
          sku: "FIN-P2P",
          itemName: "Finance Item",
          orderedQuantity: quantity,
          receivedQuantity: quantity,
          unit: "EA",
          unitPrice: price,
        },
      },
    },
  });
  await prisma.receivingDocument.create({
    data: {
      id: grnId,
      tenantId: tenant,
      documentNumber: `GRN-${suffix}`,
      poId,
      supplierId,
      supplierName,
      status: "received",
      workflowStatus: "posted",
      postingStatus: "posted",
      postedAt: new Date(),
      postedById: managerId,
      warehouseId: "warehouse-finance-p2p",
      currency,
      lines: {
        create: {
          id: receivingLineId,
          purchaseOrderLineId: poLineId,
          itemId: "item-finance-p2p",
          sku: "FIN-P2P",
          itemName: "Finance Item",
          acceptedQty: quantity,
          rejectedQty: "0.0000",
          unit: "EA",
          warehouseId: "warehouse-finance-p2p",
          location: "A-01",
          locationKey: "a-01",
        },
      },
    },
  });
  return { poId, poLineId, grnId, receivingLineId, quantity, price, currency, supplierId };
}

function invoicePayload(sourceFacts, suffix, {
  quantity = "4.0000",
  price = sourceFacts.price,
  lineAmount = "40.0000",
  tax = "2.0000",
  total = "42.0000",
  currency = sourceFacts.currency,
  invoiceNumber = `SUP-INV-${suffix}`,
} = {}) {
  return {
    invoiceNumber,
    supplierId: sourceFacts.supplierId,
    currency,
    invoiceDate: "2026-07-17T00:00:00.000Z",
    dueDate: "2026-08-16T00:00:00.000Z",
    totalAmount: total,
    lines: [
      {
        purchaseOrderLineId: sourceFacts.poLineId,
        receivingLineId: sourceFacts.receivingLineId,
        quantity,
        unitPrice: price,
        lineAmount,
        enteredTaxAmount: tax,
      },
    ],
  };
}

async function seed(prisma) {
  await prisma.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: "Operational Finance P2P",
        operationalSettings: {
          review: {
            quantityTolerance: "0.0000",
            pricePercentageTolerance: "0.0000",
            priceAbsoluteTolerance: "0.0000",
            amountTolerance: "0.0000",
          },
        },
      },
      { id: otherTenantId, name: "Other Finance Tenant" },
    ],
  });
  await prisma.user.createMany({
    data: [
      {
        id: managerId,
        tenantId,
        email: "manager-finance@flowchain.invalid",
        name: "Finance Manager",
        role: "manager",
      },
      {
        id: specialistId,
        tenantId,
        email: "specialist-finance@flowchain.invalid",
        name: "Finance Specialist",
        role: "business-specialist",
      },
      {
        id: viewerId,
        tenantId,
        email: "viewer-finance@flowchain.invalid",
        name: "Finance Viewer",
        role: "viewer",
      },
      {
        id: "other-manager-finance",
        tenantId: otherTenantId,
        email: "other-manager-finance@flowchain.invalid",
        name: "Other Manager",
        role: "manager",
      },
    ],
  });
  await prisma.supplier.create({
    data: {
      id: "supplier-finance-p2p",
      tenantId,
      code: "SUP-FIN",
      name: "Finance Supplier",
    },
  });
  await prisma.item.create({
    data: {
      id: "item-finance-p2p",
      tenantId,
      sku: "FIN-P2P",
      name: "Finance Item",
      unit: "EA",
      preferredSupplierId: "supplier-finance-p2p",
    },
  });
  await prisma.warehouse.create({
    data: {
      id: "warehouse-finance-p2p",
      tenantId,
      code: "FIN-WH",
      name: "Finance Warehouse",
    },
  });
  await prisma.inventoryBalance.create({
    data: {
      id: "balance-finance-p2p",
      tenantId,
      itemId: "item-finance-p2p",
      sku: "FIN-P2P",
      itemName: "Finance Item",
      warehouseId: "warehouse-finance-p2p",
      warehouseKey: "warehouse-finance-p2p",
      location: "A-01",
      locationKey: "a-01",
      onHandQuantity: "100.0000",
      reservedQuantity: "0.0000",
      availableQuantity: "100.0000",
      unit: "EA",
      status: "available",
    },
  });
}

test(
  "operational P2P finance is authoritative, idempotent, line-matched, and payment-free",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      await seed(prisma);
      const command = createOperationalFinanceCommandService({ prisma, env });
      const read = createOperationalFinanceReadService({
        prisma,
        capabilities,
      });
      const exactSource = await source(prisma, "EXACT");
      const exactPayload = invoicePayload(exactSource, "EXACT");
      const beforeFacts = {
        balances: await prisma.inventoryBalance.count(),
        movements: await prisma.inventoryMovement.count(),
      };

      const preview = await command.previewSupplierInvoice(
        exactPayload,
        specialist,
      );
      assert.equal(preview.allowed, true);
      assert.equal(preview.invoice.totalAmount, "42.0000");
      assert.equal(preview.factsToCreate.payments, 0);
      assert.equal(preview.factsToCreate.journalEntries, 0);

      const createInput = {
        ...exactPayload,
        idempotencyKey: "create-exact",
      };
      const created = await command.createSupplierInvoice(
        createInput,
        specialist,
      );
      assert.equal(created.invoice.status, "draft");
      assert.equal(created.invoice.totalAmount, "42");
      const replay = await command.createSupplierInvoice(
        createInput,
        specialist,
      );
      assert.equal(replay.entityId, created.entityId);
      assert.equal(replay.idempotentReplay, true);
      await assert.rejects(
        command.createSupplierInvoice(
          {
            ...createInput,
            totalAmount: "43.0000",
          },
          specialist,
        ),
        (error) =>
          error instanceof OperationalFinanceError &&
          error.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      );

      const submitPreview = await command.previewSubmitSupplierInvoice(
        created.entityId,
        { expectedVersion: 0 },
        specialist,
      );
      assert.equal(submitPreview.allowed, true);
      const submitted = await command.submitSupplierInvoice(
        created.entityId,
        { expectedVersion: 0, idempotencyKey: "submit-exact" },
        specialist,
      );
      assert.equal(submitted.invoice.status, "submitted");

      const matchPreview = await command.previewMatchSupplierInvoice(
        created.entityId,
        { expectedVersion: 1 },
        specialist,
      );
      assert.equal(matchPreview.allowed, true);
      assert.equal(matchPreview.exceptions.length, 0);
      const matched = await command.matchSupplierInvoice(
        created.entityId,
        {
          expectedVersion: 1,
          matchNumber: "MATCH-EXACT",
          idempotencyKey: "match-exact",
        },
        specialist,
      );
      assert.equal(matched.invoice.status, "matched");
      assert.equal(matched.match.exceptionCount, 0);
      assert.equal(matched.reconciliation[0].status, "matched");

      const approvalPreview = await command.previewApproveSupplierInvoice(
        created.entityId,
        { expectedVersion: 2, obligationNumber: "AP-EXACT" },
        manager,
      );
      assert.equal(approvalPreview.allowed, true);
      assert.equal(approvalPreview.paymentExecution, false);
      const approved = await command.approveSupplierInvoice(
        created.entityId,
        {
          expectedVersion: 2,
          obligationNumber: "AP-EXACT",
          idempotencyKey: "approve-exact",
        },
        manager,
      );
      assert.equal(approved.invoice.status, "approved");
      assert.equal(approved.payable.status, "approved");
      assert.equal(approved.payable.outstandingAmount, "42");

      const held = await command.holdPayable(
        approved.payable.id,
        {
          expectedVersion: 0,
          reason: "Contract review",
          idempotencyKey: "hold-exact",
        },
        manager,
      );
      assert.equal(held.payable.status, "held");
      const released = await command.releasePayable(
        approved.payable.id,
        { expectedVersion: 1, idempotencyKey: "release-exact" },
        manager,
      );
      assert.equal(released.payable.status, "approved");
      const exportReady = await command.markPayableExportReady(
        approved.payable.id,
        { expectedVersion: 2, idempotencyKey: "export-ready-exact" },
        manager,
      );
      assert.equal(exportReady.payable.status, "export_ready");

      const invoiceDetail = await read.supplierInvoiceDetail(
        created.entityId,
        manager,
      );
      assert.equal(invoiceDetail.reconciliation.length, 1);
      assert.equal(invoiceDetail.reconciliation[0].matched, true);
      assert.equal(invoiceDetail.payable.settlementExecuted, false);

      const exceptionSource = await source(prisma, "EXCEPTION", {
        quantity: "5.0000",
      });
      const exceptionPayload = invoicePayload(
        exceptionSource,
        "EXCEPTION",
        {
          quantity: "2.0000",
          price: "12.0000",
          lineAmount: "24.0000",
          tax: "0.0000",
          total: "24.0000",
        },
      );
      const exceptionDraft = await command.createSupplierInvoice(
        {
          ...exceptionPayload,
          idempotencyKey: "create-exception",
        },
        specialist,
      );
      await command.submitSupplierInvoice(
        exceptionDraft.entityId,
        {
          expectedVersion: 0,
          idempotencyKey: "submit-exception",
        },
        specialist,
      );
      const exceptionMatch = await command.matchSupplierInvoice(
        exceptionDraft.entityId,
        {
          expectedVersion: 1,
          matchNumber: "MATCH-EXCEPTION",
          idempotencyKey: "match-exception",
        },
        specialist,
      );
      assert.equal(exceptionMatch.invoice.status, "exception");
      assert.ok(exceptionMatch.match.exceptionCount >= 1);
      const exceptions = await prisma.financeMatchException.findMany({
        where: { supplierInvoiceId: exceptionDraft.entityId },
        orderBy: { id: "asc" },
      });
      for (const entry of exceptions) {
        const reviewPreview = await command.previewReviewMatchException(
          entry.id,
          {
            expectedVersion: 0,
            decision: "approved",
            resolution: "Manager accepted documented supplier variance.",
          },
          manager,
        );
        assert.equal(reviewPreview.allowed, true);
        await command.reviewMatchException(
          entry.id,
          {
            expectedVersion: 0,
            decision: "approved",
            resolution: "Manager accepted documented supplier variance.",
            idempotencyKey: `review-${entry.id}`,
          },
          manager,
        );
      }
      const exceptionApproved = await command.approveSupplierInvoice(
        exceptionDraft.entityId,
        {
          expectedVersion: 2,
          obligationNumber: "AP-EXCEPTION",
          idempotencyKey: "approve-exception",
        },
        manager,
      );
      assert.equal(exceptionApproved.payable.status, "approved");

      const overDraft = await command.createSupplierInvoice(
        {
          ...invoicePayload(exceptionSource, "OVER", {
            quantity: "4.0000",
            lineAmount: "40.0000",
            tax: "0.0000",
            total: "40.0000",
          }),
          idempotencyKey: "create-over",
        },
        specialist,
      );
      await assert.rejects(
        command.submitSupplierInvoice(
          overDraft.entityId,
          { expectedVersion: 0, idempotencyKey: "submit-over" },
          specialist,
        ),
        (error) =>
          error instanceof OperationalFinanceError &&
          error.code === "SUPPLIER_INVOICE_QUANTITY_EXCEEDS_RECEIVED",
      );

      const concurrencySource = await source(prisma, "CONCURRENT");
      const concurrencyDrafts = [];
      for (const suffix of ["A", "B"])
        concurrencyDrafts.push(
          await command.createSupplierInvoice(
            {
              ...invoicePayload(concurrencySource, `CONCURRENT-${suffix}`, {
                quantity: "6.0000",
                lineAmount: "60.0000",
                tax: "0.0000",
                total: "60.0000",
              }),
              idempotencyKey: `create-concurrent-${suffix}`,
            },
            specialist,
          ),
        );
      const concurrent = await Promise.allSettled(
        concurrencyDrafts.map((draft, index) =>
          command.submitSupplierInvoice(
            draft.entityId,
            {
              expectedVersion: 0,
              idempotencyKey: `submit-concurrent-${index}`,
            },
            specialist,
          ),
        ),
      );
      assert.equal(
        concurrent.filter((entry) => entry.status === "fulfilled").length,
        1,
      );
      assert.equal(
        concurrent.filter((entry) => entry.status === "rejected").length,
        1,
      );

      await assert.rejects(
        command.previewSupplierInvoice(exactPayload, viewer),
        (error) => error.code === "AUTHORIZATION_PERMISSION_DENIED",
      );
      await assert.rejects(
        read.supplierInvoiceDetail(created.entityId, {
          identity: identity(
            "other-manager-finance",
            "manager",
            otherTenantId,
          ),
        }),
        (error) => error.code === "SUPPLIER_INVOICE_NOT_FOUND",
      );

      const exactInvoice = await prisma.supplierInvoice.findUnique({
        where: { id: created.entityId },
        include: { lines: true },
      });
      const returnRequest = await prisma.returnRequest.create({
        data: {
          id: "RR-FIN-CREDIT",
          tenantId,
          requestNumber: "RR-FIN-CREDIT",
          returnType: "supplier_return",
          partnerId: "supplier-finance-p2p",
          partnerNameSnapshot: "Finance Supplier",
          sourceDocumentType: "ReceivingDocument",
          sourceDocumentId: exactSource.grnId,
          reasonCode: "supplier_credit",
          workflowStatus: "executed",
          requestedById: specialistId,
          lines: {
            create: {
              id: "RRL-FIN-CREDIT",
              sourceDocumentType: "ReceivingDocument",
              sourceDocumentId: exactSource.grnId,
              sourceDocumentLineId: exactSource.receivingLineId,
              sourceQuantity: "10.0000",
              itemId: "item-finance-p2p",
              sku: "FIN-P2P",
              itemName: "Finance Item",
              requestedQuantity: "2.0000",
              unit: "EA",
              reasonCode: "supplier_credit",
            },
          },
        },
      });
      const authorization = await prisma.returnAuthorization.create({
        data: {
          id: "RA-FIN-CREDIT",
          tenantId,
          authorizationNumber: "RA-FIN-CREDIT",
          returnRequestId: returnRequest.id,
          workflowStatus: "executed",
          lines: {
            create: {
              id: "RAL-FIN-CREDIT",
              returnRequestLineId: "RRL-FIN-CREDIT",
              authorizedQuantity: "2.0000",
              dispositionRoute: "return_from_available",
            },
          },
        },
      });
      const posting = await prisma.returnPostingDocument.create({
        data: {
          id: "RP-FIN-CREDIT",
          tenantId,
          postingNumber: "RP-FIN-CREDIT",
          returnAuthorizationId: authorization.id,
          postingType: "supplier_return_dispatch",
          workflowStatus: "ready",
          postingStatus: "posted",
          warehouseId: "warehouse-finance-p2p",
          readyAt: new Date(),
          readyById: managerId,
          postedAt: new Date(),
          postedById: managerId,
          lines: {
            create: {
              id: "RPL-FIN-CREDIT",
              returnAuthorizationLineId: "RAL-FIN-CREDIT",
              itemId: "item-finance-p2p",
              sku: "FIN-P2P",
              itemName: "Finance Item",
              quantity: "2.0000",
              unit: "EA",
              warehouseId: "warehouse-finance-p2p",
              location: "A-01",
              locationKey: "a-01",
              inventoryBalanceId: "balance-finance-p2p",
            },
          },
        },
      });
      const creditPayload = {
        creditMemoNumber: "SCM-FIN-001",
        supplierInvoiceId: exactInvoice.id,
        returnPostingId: posting.id,
        currency: "CNY",
        lines: [
          {
            supplierInvoiceLineId: exactInvoice.lines[0].id,
            returnPostingLineId: "RPL-FIN-CREDIT",
            quantity: "2.0000",
            pricingSource: "original_invoice",
            enteredTaxAmount: "0.0000",
          },
        ],
      };
      const creditPreview = await command.previewSupplierCreditMemo(
        creditPayload,
        specialist,
      );
      assert.equal(creditPreview.allowed, true);
      assert.equal(creditPreview.creditMemo.totalAmount, "20.0000");
      const credit = await command.createSupplierCreditMemo(
        { ...creditPayload, idempotencyKey: "create-credit" },
        specialist,
      );
      const creditApprovalPreview =
        await command.previewApproveSupplierCreditMemo(
          credit.entityId,
          { expectedVersion: 0 },
          manager,
        );
      assert.equal(creditApprovalPreview.allowed, true);
      const creditApproved = await command.approveSupplierCreditMemo(
        credit.entityId,
        { expectedVersion: 0, idempotencyKey: "approve-credit" },
        manager,
      );
      assert.equal(creditApproved.creditMemo.status, "approved");
      const payableAfterCredit = await prisma.payableObligation.findUnique({
        where: { supplierInvoiceId: exactInvoice.id },
      });
      assert.equal(String(payableAfterCredit.outstandingAmount), "22");
      assert.equal(String(payableAfterCredit.approvedCreditAmount), "20");

      const excessiveCredit = await command.previewSupplierCreditMemo(
        {
          ...creditPayload,
          creditMemoNumber: "SCM-FIN-002",
          lines: [
            {
              ...creditPayload.lines[0],
              quantity: "1.0000",
            },
          ],
        },
        specialist,
      );
      assert.equal(excessiveCredit.allowed, false);
      assert.equal(
        excessiveCredit.blockingIssues[0].code,
        "SUPPLIER_CREDIT_QUANTITY_EXCEEDED",
      );

      assert.deepEqual(
        {
          balances: await prisma.inventoryBalance.count(),
          movements: await prisma.inventoryMovement.count(),
        },
        beforeFacts,
      );
      assert.equal(await prisma.auditLog.count({ where: { tenantId } }) > 0, true);
      assert.equal(
        await prisma.businessCommandExecution.count({
          where: { tenantId, status: "completed" },
        }) > 0,
        true,
      );
    } finally {
      await prisma.$disconnect();
    }
  },
);

test(
  "a supplier invoice number is recorded once per supplier and a repeat names the number",
  { skip: !enabled },
  async () => {
    const prisma = await createPrismaClient(env);
    try {
      const numberTenantId = "tenant-operational-finance-invoice-number";
      const clerkId = "clerk-operational-finance-invoice-number";
      const clerk = {
        identity: identity(clerkId, "business-specialist", numberTenantId),
      };
      await prisma.tenant.create({
        data: { id: numberTenantId, name: "Invoice Number Uniqueness" },
      });
      await prisma.user.create({
        data: {
          id: clerkId,
          tenantId: numberTenantId,
          email: "clerk-invoice-number@flowchain.invalid",
          name: "Invoice Clerk",
          role: "business-specialist",
        },
      });
      await prisma.supplier.createMany({
        data: [
          { id: "supplier-invoice-number-a", tenantId: numberTenantId, code: "SUP-NUM-A", name: "Numbering Supplier A" },
          { id: "supplier-invoice-number-b", tenantId: numberTenantId, code: "SUP-NUM-B", name: "Numbering Supplier B" },
        ],
      });
      const fromA = await source(prisma, "NUMBER-A", {
        tenant: numberTenantId,
        supplierId: "supplier-invoice-number-a",
        supplierName: "Numbering Supplier A",
      });
      const fromB = await source(prisma, "NUMBER-B", {
        tenant: numberTenantId,
        supplierId: "supplier-invoice-number-b",
        supplierName: "Numbering Supplier B",
      });
      const command = createOperationalFinanceCommandService({ prisma, env });
      const create = (facts, invoiceNumber, idempotencyKey) =>
        command.createSupplierInvoice(
          { ...invoicePayload(facts, idempotencyKey, { invoiceNumber }), idempotencyKey },
          clerk,
        );
      const repeatedNumber = (invoiceNumber) => (error) =>
        error instanceof OperationalFinanceError &&
        error.status === 409 &&
        error.code === "SUPPLIER_INVOICE_NUMBER_DUPLICATE" &&
        error.message.includes(invoiceNumber);
      const recorded = (supplierId, invoiceNumber) =>
        prisma.supplierInvoice.count({
          where: { tenantId: numberTenantId, supplierId, invoiceNumber },
        });

      const first = await create(fromA, "INV-7001", "number-first");
      await assert.rejects(create(fromA, "INV-7001", "number-again"), repeatedNumber("INV-7001"));
      await assert.rejects(create(fromA, "  INV-7001 ", "number-padded"), repeatedNumber("INV-7001"));
      const replay = await create(fromA, "INV-7001", "number-first");
      assert.equal(replay.entityId, first.entityId);
      assert.equal(replay.idempotentReplay, true);
      await create(fromB, "INV-7001", "number-other-supplier");
      assert.equal(await recorded("supplier-invoice-number-a", "INV-7001"), 1);
      assert.equal(await recorded("supplier-invoice-number-b", "INV-7001"), 1);

      const second = await create(fromA, "INV-7002", "number-second");
      const revise = (invoiceNumber, idempotencyKey) =>
        command.reviseSupplierInvoice(
          second.entityId,
          {
            ...invoicePayload(fromA, idempotencyKey, { invoiceNumber }),
            expectedVersion: 0,
            idempotencyKey,
          },
          clerk,
        );
      await assert.rejects(revise("INV-7001", "number-revise-onto-recorded"), repeatedNumber("INV-7001"));
      const kept = await revise("INV-7002", "number-revise-keep");
      assert.equal(kept.invoice.invoiceNumber, "INV-7002");
      assert.equal(kept.invoice.version, 1);

      for (let round = 0; round < 4; round += 1) {
        const invoiceNumber = `INV-RACE-${round}`;
        const settled = await Promise.allSettled(
          [0, 1].map((index) => create(fromA, invoiceNumber, `number-race-${round}-${index}`)),
        );
        assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
        const loser = settled.find((entry) => entry.status === "rejected").reason;
        assert.ok(
          loser instanceof OperationalFinanceError &&
            loser.status === 409 &&
            ["SUPPLIER_INVOICE_NUMBER_DUPLICATE", "FINANCE_CONCURRENCY_CONFLICT"].includes(loser.code),
          `unexpected concurrent create outcome: ${loser?.status} ${loser?.code}`,
        );
        assert.equal(await recorded("supplier-invoice-number-a", invoiceNumber), 1);
      }

      // The guarantee is a hand-written partial unique index that
      // schema.prisma cannot declare, so check it survives every migration.
      const [index] = await prisma.$queryRawUnsafe(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'SupplierInvoice_tenant_supplier_number_key'`,
      );
      // A cancelled invoice keeps its number but no longer reserves it.
      assert.match(
        index?.indexdef || "",
        /UNIQUE INDEX .*\("tenantId", "supplierId", "invoiceNumber"\) WHERE \(\("invoiceNumber" IS NOT NULL\) AND \(status <> 'cancelled'::text\)\)/,
      );
    } finally {
      await prisma.$disconnect();
    }
  },
);
