import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import {
  buildSupplierCreditMemoPlan,
  buildSupplierInvoicePlan,
  buildSupplierMatchPlan,
  financeFixed,
  financeUnits,
} from "./operational-finance-policy.mjs";

export class OperationalFinanceError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "OperationalFinanceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => {
  throw new OperationalFinanceError(code, message, status, details);
};
const text = (value) => String(value ?? "").trim();
const commandPermission = (commandType) => ({
  create_supplier_invoice: "finance.supplier_invoice.create",
  revise_supplier_invoice: "finance.supplier_invoice.revise",
  submit_supplier_invoice: "finance.supplier_invoice.submit",
  match_supplier_invoice: "finance.three_way_match.execute",
  review_match_exception: "finance.match_exception.review",
  approve_supplier_invoice: "finance.supplier_invoice.approve",
  hold_payable_obligation: "finance.payable.hold",
  release_payable_obligation: "finance.payable.release",
  mark_export_ready_payable_obligation: "finance.payable.mark_export_ready",
  create_supplier_credit_memo: "finance.supplier_credit.create",
  approve_supplier_credit_memo: "finance.supplier_credit.approve",
})[commandType];
const executionWhere = (tenantId, commandType, idempotencyKey) => ({
  tenantId_commandType_idempotencyKey: {
    tenantId,
    commandType,
    idempotencyKey,
  },
});

function stable(value, parent = "") {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parent));
    return parent === "lines"
      ? rows.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        )
      : rows;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key], key)]),
    );
  return value;
}

export const operationalFinanceRequestHash = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

function required(value, label, code = "FINANCE_VALIDATION_FAILED") {
  const normalized = text(value);
  if (!normalized) fail(code, `${label} is required.`, 422);
  return normalized;
}

function expectedVersion(value, label = "expectedVersion") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    fail(
      "FINANCE_VERSION_INVALID",
      `${label} must be a non-negative integer.`,
      422,
    );
  return parsed;
}

function normalizedInvoiceInput(input = {}) {
  return {
    invoiceNumber: text(input.invoiceNumber),
    supplierId: text(input.supplierId),
    currency: text(input.currency).toUpperCase(),
    invoiceDate: text(input.invoiceDate),
    dueDate: text(input.dueDate),
    totalAmount: text(input.totalAmount),
    lines: (Array.isArray(input.lines) ? input.lines : []).map((line) => ({
      purchaseOrderLineId: text(line.purchaseOrderLineId),
      receivingLineId: text(line.receivingLineId),
      quantity: text(line.quantity),
      unitPrice: text(line.unitPrice),
      lineAmount: text(line.lineAmount ?? line.amount),
      enteredTaxAmount: text(line.enteredTaxAmount || "0"),
    })),
  };
}

function normalizedCreditMemoInput(input = {}) {
  return {
    creditMemoNumber: text(input.creditMemoNumber),
    supplierInvoiceId: text(input.supplierInvoiceId),
    returnPostingId: text(input.returnPostingId),
    currency: text(input.currency).toUpperCase(),
    lines: (Array.isArray(input.lines) ? input.lines : []).map((line) => ({
      supplierInvoiceLineId: text(line.supplierInvoiceLineId),
      returnPostingLineId: text(line.returnPostingLineId),
      quantity: text(line.quantity),
      pricingSource: text(line.pricingSource) || "original_invoice",
      unitPrice: text(line.unitPrice),
      enteredTaxAmount: text(line.enteredTaxAmount || "0"),
    })),
  };
}

function assertEnabled(env) {
  if (
    text(env.FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE).toLowerCase() !== "true"
  )
    fail(
      "OPERATIONAL_FINANCE_CAPABILITY_NOT_AVAILABLE",
      "Operational finance requires database persistence and explicit enablement.",
      409,
    );
}

function assertIdentity(context) {
  const identity = context?.identity || context;
  if (!identity?.authenticated || !text(identity.tenantId))
    fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  return identity;
}

function enforce(plan) {
  if (!plan.allowed) {
    const first = plan.blockingIssues[0];
    fail(first.code, first.message, first.status, first.details);
  }
  return plan;
}

function replay(execution, requestHash) {
  if (!execution) return null;
  if (execution.requestHash !== requestHash)
    fail(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "The idempotency key was already used with a different payload.",
      409,
    );
  if (execution.status !== "completed" || !execution.resultPayload)
    fail(
      "COMMAND_EXECUTION_IN_PROGRESS",
      "The command is already in progress.",
      409,
    );
  return { ...execution.resultPayload, idempotentReplay: true };
}

async function lockTenantRow(tx, table, tenantId, id, notFoundCode) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
    tenantId,
    id,
  );
  if (!rows.length)
    fail(notFoundCode, "Operational finance document was not found.", 404);
}

async function lockChildRows(tx, table, ids) {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort())
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
}

function audit({
  idFactory,
  actor,
  action,
  entityType,
  entityId,
  summary,
  commandType,
  idempotencyKey,
  before,
  after,
  evidence,
}) {
  return {
    id: idFactory(),
    tenantId: actor.tenantId,
    actorId: actor.user.id,
    source: "operational_finance_command_service",
    module: "finance",
    action,
    entityType,
    entityId,
    summary,
    metadata: {
      commandType,
      idempotencyKey,
      before,
      after,
      evidence,
      paymentExecution: false,
      ledgerMutation: false,
    },
  };
}

function invoiceResult(invoice) {
  return {
    entityType: "SupplierInvoice",
    entityId: invoice.id,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      matchStatus: invoice.matchStatus,
      currency: invoice.currency,
      totalAmount: String(invoice.totalAmount ?? invoice.amount ?? "0"),
      version: invoice.version,
    },
  };
}

function payableResult(payable) {
  return {
    entityType: "PayableObligation",
    entityId: payable.id,
    payable: {
      id: payable.id,
      obligationNumber: payable.obligationNumber,
      supplierInvoiceId: payable.supplierInvoiceId,
      status: payable.status,
      originalAmount: String(payable.originalAmount),
      outstandingAmount: String(payable.outstandingAmount),
      currency: payable.currency,
      version: payable.version,
    },
  };
}

function creditMemoResult(memo) {
  return {
    entityType: "SupplierCreditMemo",
    entityId: memo.id,
    creditMemo: {
      id: memo.id,
      creditMemoNumber: memo.creditMemoNumber,
      supplierInvoiceId: memo.supplierInvoiceId,
      returnPostingId: memo.returnPostingId,
      status: memo.status,
      totalAmount: String(memo.totalAmount),
      currency: memo.currency,
      version: memo.version,
    },
  };
}

function supplierInvoiceLineData(line, idFactory) {
  return {
    id: idFactory(),
    lineNumber: line.lineNumber,
    purchaseOrderLineId: line.purchaseOrderLineId,
    receivingLineId: line.receivingLineId,
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    unit: line.unit,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineAmount: line.lineAmount,
    enteredTaxAmount: line.enteredTaxAmount,
    amount: financeFixed(
      financeUnits(line.lineAmount) + financeUnits(line.enteredTaxAmount),
    ),
  };
}

const isConcurrency = (error) =>
  error?.code === "P2034" ||
  /serialization|deadlock|write conflict/i.test(text(error?.message));

export function createOperationalFinanceCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function execute(commandType, input, context, payload, work) {
    assertEnabled(env);
    const identity = assertIdentity(context);
    const idempotencyKey = required(
      input.idempotencyKey,
      "idempotencyKey",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    const requestHash = operationalFinanceRequestHash(payload);
    const where = executionWhere(
      identity.tenantId,
      commandType,
      idempotencyKey,
    );
    const outside = replay(
      await prisma.businessCommandExecution.findUnique({ where }),
      requestHash,
    );
    if (outside) return outside;
    try {
      return await prisma.$transaction(
        async (tx) => {
          const actor = await resolveProvisionedActor(tx, identity);
          assertAuthorized({ actor, permission: commandPermission(commandType), tenantId: actor.tenantId });
          const inside = replay(
            await tx.businessCommandExecution.findUnique({ where }),
            requestHash,
          );
          if (inside) return inside;
          const execution = await tx.businessCommandExecution.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              commandType,
              idempotencyKey,
              requestHash,
              status: "pending",
            },
          });
          const result = await work(tx, actor, payload, {
            commandType,
            idempotencyKey,
          });
          await tx.businessCommandExecution.update({
            where: { id: execution.id },
            data: {
              status: "completed",
              entityType: result.entityType,
              entityId: result.entityId,
              resultPayload: result,
              completedAt: now(),
            },
          });
          return { ...result, idempotentReplay: false };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof OperationalFinanceError) throw error;
      if (error?.code === "P2002")
        fail(
          "FINANCE_UNIQUE_CONFLICT",
          "A finance document with the same governed identifier already exists.",
          409,
        );
      if (isConcurrency(error))
        fail(
          "FINANCE_CONCURRENCY_CONFLICT",
          "Operational finance facts changed concurrently. Reload and retry.",
          409,
        );
      throw error;
    }
  }

  async function previewSupplierInvoice(input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.supplier_invoice.create", tenantId: actor.tenantId });
    return buildSupplierInvoicePlan({
      prisma,
      tenantId: actor.tenantId,
      input: normalizedInvoiceInput(input),
      countCommittedOnly: true,
    });
  }

  async function createSupplierInvoice(input, context) {
    const payload = normalizedInvoiceInput(input);
    return execute(
      "create_supplier_invoice",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        const plan = enforce(
          await buildSupplierInvoicePlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: normalized,
            countCommittedOnly: true,
          }),
        );
        const invoice = await tx.supplierInvoice.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            invoiceNumber: plan.invoice.invoiceNumber,
            supplierId: plan.source.supplier.id,
            supplierName: plan.source.supplier.name,
            supplierSnapshot: plan.source.supplier,
            relatedPoId: plan.source.purchaseOrderId,
            relatedGrnId: plan.source.receivingDocumentId,
            invoiceDate: new Date(plan.invoice.invoiceDate),
            dueDate: new Date(plan.invoice.dueDate),
            subtotalAmount: plan.invoice.subtotalAmount,
            enteredTaxAmount: plan.invoice.enteredTaxAmount,
            totalAmount: plan.invoice.totalAmount,
            amount: plan.invoice.totalAmount,
            currency: plan.invoice.currency,
            status: "draft",
            matchStatus: "not_matched",
            varianceAmount: "0.0000",
            lines: {
              create: plan.lines.map((line) =>
                supplierInvoiceLineData(line, idFactory),
              ),
            },
          },
          include: { lines: true },
        });
        const result = invoiceResult(invoice);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_invoice_created",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier invoice draft created from authoritative PO and receiving facts.",
            ...command,
            before: null,
            after: result.invoice,
            evidence: {
              purchaseOrderId: plan.source.purchaseOrderId,
              receivingDocumentId: plan.source.receivingDocumentId,
              lineIds: plan.lines.map((line) => line.receivingLineId),
            },
          }),
        });
        return result;
      },
    );
  }

  async function reviseSupplierInvoice(invoiceId, input, context) {
    const payload = {
      invoiceId: required(invoiceId, "invoiceId"),
      expectedVersion: expectedVersion(input.expectedVersion),
      ...normalizedInvoiceInput(input),
    };
    return execute(
      "revise_supplier_invoice",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "SupplierInvoice",
          actor.tenantId,
          normalized.invoiceId,
          "SUPPLIER_INVOICE_NOT_FOUND",
        );
        const current = await tx.supplierInvoice.findUnique({
          where: { id: normalized.invoiceId },
          include: { lines: true },
        });
        if (current.status !== "draft")
          fail(
            "SUPPLIER_INVOICE_FROZEN",
            "Only a draft supplier invoice can be revised.",
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Supplier invoice changed concurrently.",
            409,
          );
        const plan = enforce(
          await buildSupplierInvoicePlan({
            prisma: tx,
            tenantId: actor.tenantId,
            currentInvoiceId: current.id,
            input: normalized,
            countCommittedOnly: true,
          }),
        );
        await tx.supplierInvoiceLine.deleteMany({
          where: { supplierInvoiceId: current.id },
        });
        const invoice = await tx.supplierInvoice.update({
          where: { id: current.id },
          data: {
            invoiceNumber: plan.invoice.invoiceNumber,
            supplierId: plan.source.supplier.id,
            supplierName: plan.source.supplier.name,
            supplierSnapshot: plan.source.supplier,
            relatedPoId: plan.source.purchaseOrderId,
            relatedGrnId: plan.source.receivingDocumentId,
            invoiceDate: new Date(plan.invoice.invoiceDate),
            dueDate: new Date(plan.invoice.dueDate),
            subtotalAmount: plan.invoice.subtotalAmount,
            enteredTaxAmount: plan.invoice.enteredTaxAmount,
            totalAmount: plan.invoice.totalAmount,
            amount: plan.invoice.totalAmount,
            currency: plan.invoice.currency,
            version: { increment: 1 },
            lines: {
              create: plan.lines.map((line) =>
                supplierInvoiceLineData(line, idFactory),
              ),
            },
          },
          include: { lines: true },
        });
        const result = invoiceResult(invoice);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_invoice_revised",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier invoice draft revised.",
            ...command,
            before: invoiceResult(current).invoice,
            after: result.invoice,
            evidence: {
              purchaseOrderId: plan.source.purchaseOrderId,
              receivingDocumentId: plan.source.receivingDocumentId,
            },
          }),
        });
        return result;
      },
    );
  }

  async function invoiceInput(tx, invoice) {
    const lines = invoice.lines || (await tx.supplierInvoiceLine.findMany({
      where: { supplierInvoiceId: invoice.id },
      orderBy: { lineNumber: "asc" },
    }));
    return {
      invoiceNumber: invoice.invoiceNumber,
      supplierId: invoice.supplierId,
      currency: invoice.currency,
      invoiceDate: invoice.invoiceDate?.toISOString(),
      dueDate: invoice.dueDate?.toISOString(),
      totalAmount: String(invoice.totalAmount ?? invoice.amount),
      lines: lines.map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        receivingLineId: line.receivingLineId,
        quantity: String(line.quantity),
        unitPrice: String(line.unitPrice),
        lineAmount: String(line.lineAmount ?? line.amount),
        enteredTaxAmount: String(line.enteredTaxAmount || "0"),
      })),
    };
  }

  async function previewSubmitSupplierInvoice(invoiceId, input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.supplier_invoice.submit", tenantId: actor.tenantId });
    const invoice = await prisma.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId: actor.tenantId },
      include: { lines: true },
    });
    if (!invoice)
      fail("SUPPLIER_INVOICE_NOT_FOUND", "Supplier invoice was not found.", 404);
    const plan = await buildSupplierInvoicePlan({
      prisma,
      tenantId: actor.tenantId,
      currentInvoiceId: invoice.id,
      input: await invoiceInput(prisma, invoice),
      countCommittedOnly: false,
    });
    const version = expectedVersion(input.expectedVersion);
    const blockingIssues = [...plan.blockingIssues];
    if (invoice.status !== "draft")
      blockingIssues.push({
        code: "SUPPLIER_INVOICE_STATUS_INVALID",
        message: "Only a draft supplier invoice can be submitted.",
        status: 409,
      });
    if (invoice.version !== version)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Supplier invoice changed concurrently.",
        status: 409,
      });
    return {
      ...plan,
      operation: "submit_supplier_invoice",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      expectedVersion: version,
      currentStatus: invoice.status,
      nextStatus: "submitted",
    };
  }

  async function submitSupplierInvoice(invoiceId, input, context) {
    const payload = {
      invoiceId: required(invoiceId, "invoiceId"),
      expectedVersion: expectedVersion(input.expectedVersion),
    };
    return execute(
      "submit_supplier_invoice",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "SupplierInvoice",
          actor.tenantId,
          normalized.invoiceId,
          "SUPPLIER_INVOICE_NOT_FOUND",
        );
        const current = await tx.supplierInvoice.findUnique({
          where: { id: normalized.invoiceId },
          include: { lines: true },
        });
        if (current.status !== "draft")
          fail(
            "SUPPLIER_INVOICE_STATUS_INVALID",
            "Only a draft supplier invoice can be submitted.",
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Supplier invoice changed concurrently.",
            409,
          );
        await lockChildRows(
          tx,
          "ReceivingLine",
          current.lines.map((line) => line.receivingLineId),
        );
        await lockChildRows(
          tx,
          "PurchaseOrderLine",
          current.lines.map((line) => line.purchaseOrderLineId),
        );
        enforce(
          await buildSupplierInvoicePlan({
            prisma: tx,
            tenantId: actor.tenantId,
            currentInvoiceId: current.id,
            input: await invoiceInput(tx, current),
            countCommittedOnly: false,
          }),
        );
        const invoice = await tx.supplierInvoice.update({
          where: { id: current.id },
          data: {
            status: "submitted",
            submittedAt: now(),
            submittedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const result = invoiceResult(invoice);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_invoice_submitted",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier invoice submitted for three-way matching.",
            ...command,
            before: invoiceResult(current).invoice,
            after: result.invoice,
            evidence: {
              purchaseOrderId: current.relatedPoId,
              receivingDocumentId: current.relatedGrnId,
            },
          }),
        });
        return result;
      },
    );
  }

  async function previewMatchSupplierInvoice(invoiceId, input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.three_way_match.execute", tenantId: actor.tenantId });
    const plan = await buildSupplierMatchPlan({
      prisma,
      tenantId: actor.tenantId,
      invoiceId,
    });
    const version = expectedVersion(input.expectedVersion);
    const blockingIssues = [...plan.blockingIssues];
    if (plan.invoice && plan.invoice.version !== version)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Supplier invoice changed concurrently.",
        status: 409,
      });
    return {
      ...plan,
      allowed: blockingIssues.length === 0,
      blockingIssues,
      expectedVersion: version,
    };
  }

  async function matchSupplierInvoice(invoiceId, input, context) {
    const payload = {
      invoiceId: required(invoiceId, "invoiceId"),
      expectedVersion: expectedVersion(input.expectedVersion),
      matchNumber: text(input.matchNumber),
    };
    return execute(
      "match_supplier_invoice",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "SupplierInvoice",
          actor.tenantId,
          normalized.invoiceId,
          "SUPPLIER_INVOICE_NOT_FOUND",
        );
        const current = await tx.supplierInvoice.findUnique({
          where: { id: normalized.invoiceId },
          include: { lines: true },
        });
        if (current.status !== "submitted")
          fail(
            "SUPPLIER_INVOICE_STATUS_INVALID",
            "Only a submitted supplier invoice can start a match run.",
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Supplier invoice changed concurrently.",
            409,
          );
        await lockChildRows(
          tx,
          "ReceivingLine",
          current.lines.map((line) => line.receivingLineId),
        );
        await lockChildRows(
          tx,
          "PurchaseOrderLine",
          current.lines.map((line) => line.purchaseOrderLineId),
        );
        const plan = enforce(
          await buildSupplierMatchPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            invoiceId: current.id,
          }),
        );
        const matchId = idFactory();
        const match = await tx.threeWayMatch.create({
          data: {
            id: matchId,
            tenantId: actor.tenantId,
            matchNumber:
              normalized.matchNumber ||
              `MATCH-${current.invoiceNumber}-${current.version + 1}`,
            poId: current.relatedPoId,
            grnId: current.relatedGrnId,
            invoiceId: current.id,
            supplierId: current.supplierId,
            supplierName: current.supplierName,
            poAmount: plan.totals.purchaseOrder,
            invoiceAmount: plan.totals.invoice,
            varianceAmount: plan.totals.variance,
            currency: current.currency,
            status: plan.resultStatus,
            blockingReason: plan.exceptions.length
              ? `${plan.exceptions.length} line-level match exception(s)`
              : null,
            matchedAt: now(),
            matchedById: actor.user.id,
            lines: {
              create: plan.lines.map((line) => ({
                id: idFactory(),
                ...line,
              })),
            },
          },
          include: { lines: true },
        });
        const matchLineByInvoiceLine = new Map(
          match.lines.map((line) => [line.supplierInvoiceLineId, line.id]),
        );
        for (const exception of plan.exceptions)
          await tx.financeMatchException.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              matchId: match.id,
              matchLineId: matchLineByInvoiceLine.get(
                exception.supplierInvoiceLineId,
              ),
              supplierInvoiceId: current.id,
              exceptionType: exception.exceptionType,
              status: "open",
              expectedValue: exception.expectedValue,
              actualValue: exception.actualValue,
              varianceValue: exception.varianceValue,
              currency: exception.currency,
            },
          });
        const invoice = await tx.supplierInvoice.update({
          where: { id: current.id },
          data: {
            status: plan.resultStatus,
            matchStatus: plan.resultStatus,
            varianceAmount: plan.totals.variance,
            version: { increment: 1 },
          },
        });
        const result = {
          ...invoiceResult(invoice),
          match: {
            id: match.id,
            matchNumber: match.matchNumber,
            status: match.status,
            lineCount: match.lines.length,
            exceptionCount: plan.exceptions.length,
          },
          reconciliation: plan.lines.map((line) => ({
            supplierInvoiceLineId: line.supplierInvoiceLineId,
            purchaseOrderLineId: line.purchaseOrderLineId,
            receivingLineId: line.receivingLineId,
            status: line.status,
            quantityVariance: line.quantityVariance,
            priceVariance: line.priceVariance,
            amountVariance: line.amountVariance,
          })),
        };
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_invoice_matched",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier invoice three-way match completed line by line.",
            ...command,
            before: invoiceResult(current).invoice,
            after: result.invoice,
            evidence: {
              matchId: match.id,
              purchaseOrderId: current.relatedPoId,
              receivingDocumentId: current.relatedGrnId,
              exceptionIds: [],
            },
          }),
        });
        return result;
      },
    );
  }

  async function reviewMatchException(exceptionId, input, context) {
    const payload = {
      exceptionId: required(exceptionId, "exceptionId"),
      expectedVersion: expectedVersion(input.expectedVersion),
      decision: required(input.decision, "decision"),
      resolution: required(input.resolution, "resolution"),
    };
    return execute(
      "review_match_exception",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "FinanceMatchException",
          actor.tenantId,
          normalized.exceptionId,
          "MATCH_EXCEPTION_NOT_FOUND",
        );
        const current = await tx.financeMatchException.findUnique({
          where: { id: normalized.exceptionId },
        });
        if (current.status !== "open")
          fail(
            "MATCH_EXCEPTION_STATUS_INVALID",
            "Only an open match exception can be reviewed.",
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Match exception changed concurrently.",
            409,
          );
        if (!["approved", "rejected"].includes(normalized.decision))
          fail(
            "MATCH_EXCEPTION_DECISION_INVALID",
            "Decision must be approved or rejected.",
            422,
          );
        const exception = await tx.financeMatchException.update({
          where: { id: current.id },
          data: {
            status: normalized.decision,
            resolution: normalized.resolution,
            resolvedAt: now(),
            resolvedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const result = {
          entityType: "FinanceMatchException",
          entityId: exception.id,
          exception: {
            id: exception.id,
            supplierInvoiceId: exception.supplierInvoiceId,
            status: exception.status,
            resolution: exception.resolution,
            version: exception.version,
          },
        };
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "match_exception_reviewed",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Line-level supplier invoice match exception reviewed.",
            ...command,
            before: {
              id: current.id,
              status: current.status,
              version: current.version,
            },
            after: result.exception,
            evidence: {
              matchId: current.matchId,
              matchLineId: current.matchLineId,
              supplierInvoiceId: current.supplierInvoiceId,
            },
          }),
        });
        return result;
      },
    );
  }

  async function previewReviewMatchException(exceptionId, input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.match_exception.review", tenantId: actor.tenantId });
    const exception = await prisma.financeMatchException.findFirst({
      where: { id: exceptionId, tenantId: actor.tenantId },
    });
    if (!exception)
      fail("MATCH_EXCEPTION_NOT_FOUND", "Match exception was not found.", 404);
    const version = expectedVersion(input.expectedVersion);
    const decision = text(input.decision);
    const blockingIssues = [];
    if (exception.version !== version)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Match exception changed concurrently.",
        status: 409,
      });
    if (exception.status !== "open")
      blockingIssues.push({
        code: "MATCH_EXCEPTION_STATUS_INVALID",
        message: "Only an open match exception can be reviewed.",
        status: 409,
      });
    if (!["approved", "rejected"].includes(decision))
      blockingIssues.push({
        code: "MATCH_EXCEPTION_DECISION_INVALID",
        message: "Decision must be approved or rejected.",
        status: 422,
      });
    if (!text(input.resolution))
      blockingIssues.push({
        code: "FINANCE_VALIDATION_FAILED",
        message: "resolution is required.",
        status: 422,
      });
    return {
      operation: "review_match_exception",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      before: {
        id: exception.id,
        status: exception.status,
        version: exception.version,
      },
      after: { status: decision, version: exception.version + 1 },
      paymentExecution: false,
      ledgerMutation: false,
    };
  }

  async function previewApproveSupplierInvoice(invoiceId, input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.supplier_invoice.approve", tenantId: actor.tenantId });
    const invoice = await prisma.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId: actor.tenantId },
    });
    if (!invoice)
      fail("SUPPLIER_INVOICE_NOT_FOUND", "Supplier invoice was not found.", 404);
    const [openOrRejected, existingPayable] = await Promise.all([
      prisma.financeMatchException.count({
        where: {
          supplierInvoiceId: invoice.id,
          status: { in: ["open", "rejected"] },
        },
      }),
      prisma.payableObligation.findUnique({
        where: { supplierInvoiceId: invoice.id },
      }),
    ]);
    const version = expectedVersion(input.expectedVersion);
    const blockingIssues = [];
    if (invoice.version !== version)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Supplier invoice changed concurrently.",
        status: 409,
      });
    if (!["matched", "exception"].includes(invoice.status))
      blockingIssues.push({
        code: "SUPPLIER_INVOICE_STATUS_INVALID",
        message: "Only a matched invoice can be approved.",
        status: 409,
      });
    if (openOrRejected)
      blockingIssues.push({
        code: "MATCH_EXCEPTION_REVIEW_REQUIRED",
        message:
          "Every line-level match exception must be approved before invoice approval.",
        status: 409,
      });
    if (existingPayable)
      blockingIssues.push({
        code: "PAYABLE_OBLIGATION_ALREADY_EXISTS",
        message: "This supplier invoice already has a payable obligation.",
        status: 409,
      });
    return {
      operation: "approve_supplier_invoice",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      before: invoiceResult(invoice).invoice,
      after: {
        invoiceStatus: "approved",
        payableStatus: "approved",
        obligationNumber:
          text(input.obligationNumber) || `AP-${invoice.invoiceNumber}`,
        originalAmount: String(invoice.totalAmount ?? invoice.amount),
        outstandingAmount: String(invoice.totalAmount ?? invoice.amount),
        currency: invoice.currency,
        dueDate: invoice.dueDate?.toISOString(),
      },
      factsToCreate: {
        payableObligations: 1,
        payments: 0,
        journalEntries: 0,
      },
      paymentExecution: false,
      ledgerMutation: false,
    };
  }

  async function approveSupplierInvoice(invoiceId, input, context) {
    const payload = {
      invoiceId: required(invoiceId, "invoiceId"),
      expectedVersion: expectedVersion(input.expectedVersion),
      obligationNumber: text(input.obligationNumber),
    };
    return execute(
      "approve_supplier_invoice",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "SupplierInvoice",
          actor.tenantId,
          normalized.invoiceId,
          "SUPPLIER_INVOICE_NOT_FOUND",
        );
        const current = await tx.supplierInvoice.findUnique({
          where: { id: normalized.invoiceId },
        });
        if (!["matched", "exception"].includes(current.status))
          fail(
            "SUPPLIER_INVOICE_STATUS_INVALID",
            "Only a matched invoice can be approved.",
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Supplier invoice changed concurrently.",
            409,
          );
        const openOrRejected = await tx.financeMatchException.count({
          where: {
            supplierInvoiceId: current.id,
            status: { in: ["open", "rejected"] },
          },
        });
        if (openOrRejected)
          fail(
            "MATCH_EXCEPTION_REVIEW_REQUIRED",
            "Every line-level match exception must be approved before invoice approval.",
            409,
          );
        const invoice = await tx.supplierInvoice.update({
          where: { id: current.id },
          data: {
            status: "approved",
            approvedAt: now(),
            approvedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const payable = await tx.payableObligation.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            supplierInvoiceId: current.id,
            obligationNumber:
              normalized.obligationNumber || `AP-${current.invoiceNumber}`,
            originalAmount: current.totalAmount ?? current.amount,
            outstandingAmount: current.totalAmount ?? current.amount,
            currency: current.currency,
            dueDate: current.dueDate,
            status: "approved",
            approvedAt: now(),
            approvedById: actor.user.id,
          },
        });
        const result = {
          ...invoiceResult(invoice),
          payable: payableResult(payable).payable,
        };
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_invoice_approved",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier invoice approved and payable obligation recorded.",
            ...command,
            before: invoiceResult(current).invoice,
            after: result,
            evidence: {
              payableObligationId: payable.id,
              matchStatus: current.matchStatus,
            },
          }),
        });
        return result;
      },
    );
  }

  async function changePayableStatus(
    action,
    payableId,
    input,
    context,
  ) {
    const commandType = `${action}_payable_obligation`;
    const payload = {
      payableId: required(payableId, "payableId"),
      expectedVersion: expectedVersion(input.expectedVersion),
      reason: text(input.reason),
    };
    return execute(
      commandType,
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "PayableObligation",
          actor.tenantId,
          normalized.payableId,
          "PAYABLE_OBLIGATION_NOT_FOUND",
        );
        const current = await tx.payableObligation.findUnique({
          where: { id: normalized.payableId },
        });
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Payable obligation changed concurrently.",
            409,
          );
        let data;
        if (action === "hold") {
          if (!["approved", "export_ready"].includes(current.status))
            fail(
              "PAYABLE_STATUS_INVALID",
              "Only an approved or export-ready obligation can be held.",
              409,
            );
          data = {
            status: "held",
            heldAt: now(),
            heldById: actor.user.id,
            holdReason: required(normalized.reason, "reason"),
          };
        } else if (action === "release") {
          if (current.status !== "held")
            fail(
              "PAYABLE_STATUS_INVALID",
              "Only a held obligation can be released.",
              409,
            );
          data = {
            status: "approved",
            heldAt: null,
            heldById: null,
            holdReason: null,
          };
        } else if (action === "mark_export_ready") {
          if (current.status !== "approved")
            fail(
              "PAYABLE_STATUS_INVALID",
              "Only an approved obligation can be marked export ready.",
              409,
            );
          data = {
            status: "export_ready",
            exportReadyAt: now(),
            exportReadyById: actor.user.id,
          };
        } else
          fail("FINANCE_COMMAND_INVALID", "Unknown payable action.", 422);
        const payable = await tx.payableObligation.update({
          where: { id: current.id },
          data: { ...data, version: { increment: 1 } },
        });
        await tx.supplierInvoice.update({
          where: { id: current.supplierInvoiceId },
          data: {
            status: action === "hold" ? "held" : "approved",
            ...(action === "hold"
              ? {
                  heldAt: now(),
                  heldById: actor.user.id,
                  holdReason: data.holdReason,
                }
              : { heldAt: null, heldById: null, holdReason: null }),
            version: { increment: 1 },
          },
        });
        const result = payableResult(payable);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: commandType,
            entityType: result.entityType,
            entityId: result.entityId,
            summary: `Payable obligation ${action.replaceAll("_", " ")}.`,
            ...command,
            before: payableResult(current).payable,
            after: result.payable,
            evidence: { supplierInvoiceId: current.supplierInvoiceId },
          }),
        });
        return result;
      },
    );
  }

  async function previewPayableAction(action, payableId, input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: action === "hold" ? "finance.payable.hold" : action === "release" ? "finance.payable.release" : "finance.payable.mark_export_ready", tenantId: actor.tenantId });
    const payable = await prisma.payableObligation.findFirst({
      where: { id: payableId, tenantId: actor.tenantId },
    });
    if (!payable)
      fail(
        "PAYABLE_OBLIGATION_NOT_FOUND",
        "Payable obligation was not found.",
        404,
      );
    const version = expectedVersion(input.expectedVersion);
    const blockingIssues = [];
    let nextStatus = payable.status;
    if (payable.version !== version)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Payable obligation changed concurrently.",
        status: 409,
      });
    if (action === "hold") {
      nextStatus = "held";
      if (!["approved", "export_ready"].includes(payable.status))
        blockingIssues.push({
          code: "PAYABLE_STATUS_INVALID",
          message: "Only an approved or export-ready obligation can be held.",
          status: 409,
        });
      if (!text(input.reason))
        blockingIssues.push({
          code: "FINANCE_VALIDATION_FAILED",
          message: "reason is required.",
          status: 422,
        });
    } else if (action === "release") {
      nextStatus = "approved";
      if (payable.status !== "held")
        blockingIssues.push({
          code: "PAYABLE_STATUS_INVALID",
          message: "Only a held obligation can be released.",
          status: 409,
        });
    } else if (action === "mark-export-ready") {
      nextStatus = "export_ready";
      if (payable.status !== "approved")
        blockingIssues.push({
          code: "PAYABLE_STATUS_INVALID",
          message:
            "Only an approved obligation can be marked export ready.",
          status: 409,
        });
    } else
      blockingIssues.push({
        code: "FINANCE_COMMAND_INVALID",
        message: "Unknown payable action.",
        status: 422,
      });
    return {
      operation: `${action}_payable_obligation`,
      allowed: blockingIssues.length === 0,
      blockingIssues,
      before: payableResult(payable).payable,
      after: {
        ...payableResult(payable).payable,
        status: nextStatus,
        version: payable.version + 1,
      },
      paymentExecution: false,
      ledgerMutation: false,
    };
  }

  async function previewSupplierCreditMemo(input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.supplier_credit.create", tenantId: actor.tenantId });
    return buildSupplierCreditMemoPlan({
      prisma,
      tenantId: actor.tenantId,
      input: normalizedCreditMemoInput(input),
    });
  }

  async function createSupplierCreditMemo(input, context) {
    const payload = normalizedCreditMemoInput(input);
    return execute(
      "create_supplier_credit_memo",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockChildRows(
          tx,
          "SupplierInvoiceLine",
          normalized.lines.map((line) => line.supplierInvoiceLineId),
        );
        await lockChildRows(
          tx,
          "ReturnPostingLine",
          normalized.lines.map((line) => line.returnPostingLineId),
        );
        const plan = enforce(
          await buildSupplierCreditMemoPlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: normalized,
          }),
        );
        const memo = await tx.supplierCreditMemo.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            creditMemoNumber: plan.creditMemo.creditMemoNumber,
            supplierInvoiceId: plan.invoice.id,
            returnPostingId: plan.returnPosting.id,
            supplierId: plan.invoice.supplierId,
            supplierNameSnapshot: plan.invoice.supplierName,
            currency: plan.creditMemo.currency,
            subtotalAmount: plan.creditMemo.subtotalAmount,
            enteredTaxAmount: plan.creditMemo.enteredTaxAmount,
            totalAmount: plan.creditMemo.totalAmount,
            status: "draft",
            lines: {
              create: plan.lines.map((line) => ({
                id: idFactory(),
                ...line,
              })),
            },
          },
        });
        const result = creditMemoResult(memo);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_credit_memo_created",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier credit memo draft created from posted supplier return evidence.",
            ...command,
            before: null,
            after: result.creditMemo,
            evidence: {
              supplierInvoiceId: memo.supplierInvoiceId,
              returnPostingId: memo.returnPostingId,
              lineIds: plan.lines.map((line) => line.returnPostingLineId),
            },
          }),
        });
        return result;
      },
    );
  }

  async function approveSupplierCreditMemo(memoId, input, context) {
    const payload = {
      memoId: required(memoId, "memoId"),
      expectedVersion: expectedVersion(input.expectedVersion),
    };
    return execute(
      "approve_supplier_credit_memo",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenantRow(
          tx,
          "SupplierCreditMemo",
          actor.tenantId,
          normalized.memoId,
          "SUPPLIER_CREDIT_MEMO_NOT_FOUND",
        );
        const current = await tx.supplierCreditMemo.findUnique({
          where: { id: normalized.memoId },
        });
        if (current.status !== "draft")
          fail(
            "SUPPLIER_CREDIT_STATUS_INVALID",
            "Only a draft supplier credit memo can be approved.",
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Supplier credit memo changed concurrently.",
            409,
          );
        const payable = await tx.payableObligation.findUnique({
          where: { supplierInvoiceId: current.supplierInvoiceId },
        });
        if (payable) {
          await lockTenantRow(
            tx,
            "PayableObligation",
            actor.tenantId,
            payable.id,
            "PAYABLE_OBLIGATION_NOT_FOUND",
          );
          const outstanding =
            financeUnits(payable.outstandingAmount) -
            financeUnits(current.totalAmount);
          if (outstanding < 0n)
            fail(
              "SUPPLIER_CREDIT_AMOUNT_EXCEEDED",
              "Approved supplier credit cannot exceed the outstanding payable obligation.",
              409,
            );
          await tx.payableObligation.update({
            where: { id: payable.id },
            data: {
              outstandingAmount: financeFixed(outstanding),
              approvedCreditAmount: financeFixed(
                financeUnits(payable.approvedCreditAmount) +
                  financeUnits(current.totalAmount),
              ),
              version: { increment: 1 },
            },
          });
        }
        const memo = await tx.supplierCreditMemo.update({
          where: { id: current.id },
          data: {
            status: "approved",
            approvedAt: now(),
            approvedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const result = creditMemoResult(memo);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "supplier_credit_memo_approved",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Supplier credit memo approved; no payment or ledger entry was created.",
            ...command,
            before: creditMemoResult(current).creditMemo,
            after: result.creditMemo,
            evidence: {
              supplierInvoiceId: current.supplierInvoiceId,
              returnPostingId: current.returnPostingId,
              payableObligationId: payable?.id || null,
            },
          }),
        });
        return result;
      },
    );
  }

  async function previewApproveSupplierCreditMemo(memoId, input, context) {
    assertEnabled(env);
    const actor = await resolveProvisionedActor(prisma, assertIdentity(context));
    assertAuthorized({ actor, permission: "finance.supplier_credit.approve", tenantId: actor.tenantId });
    const memo = await prisma.supplierCreditMemo.findFirst({
      where: { id: memoId, tenantId: actor.tenantId },
    });
    if (!memo)
      fail(
        "SUPPLIER_CREDIT_MEMO_NOT_FOUND",
        "Supplier credit memo was not found.",
        404,
      );
    const payable = await prisma.payableObligation.findUnique({
      where: { supplierInvoiceId: memo.supplierInvoiceId },
    });
    const version = expectedVersion(input.expectedVersion);
    const blockingIssues = [];
    if (memo.version !== version)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Supplier credit memo changed concurrently.",
        status: 409,
      });
    if (memo.status !== "draft")
      blockingIssues.push({
        code: "SUPPLIER_CREDIT_STATUS_INVALID",
        message: "Only a draft supplier credit memo can be approved.",
        status: 409,
      });
    if (
      payable &&
      financeUnits(memo.totalAmount) > financeUnits(payable.outstandingAmount)
    )
      blockingIssues.push({
        code: "SUPPLIER_CREDIT_AMOUNT_EXCEEDED",
        message:
          "Approved supplier credit cannot exceed the outstanding payable obligation.",
        status: 409,
      });
    return {
      operation: "approve_supplier_credit_memo",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      before: creditMemoResult(memo).creditMemo,
      after: {
        ...creditMemoResult(memo).creditMemo,
        status: "approved",
        version: memo.version + 1,
      },
      payableImpact: payable
        ? {
            id: payable.id,
            outstandingBefore: String(payable.outstandingAmount),
            outstandingAfter: financeFixed(
              financeUnits(payable.outstandingAmount) -
                financeUnits(memo.totalAmount),
            ),
          }
        : null,
      paymentExecution: false,
      ledgerMutation: false,
    };
  }

  return {
    previewSupplierInvoice,
    createSupplierInvoice,
    reviseSupplierInvoice,
    previewSubmitSupplierInvoice,
    submitSupplierInvoice,
    previewMatchSupplierInvoice,
    matchSupplierInvoice,
    previewReviewMatchException,
    reviewMatchException,
    previewApproveSupplierInvoice,
    approveSupplierInvoice,
    previewPayableAction,
    holdPayable: (id, input, context) =>
      changePayableStatus("hold", id, input, context),
    releasePayable: (id, input, context) =>
      changePayableStatus("release", id, input, context),
    markPayableExportReady: (id, input, context) =>
      changePayableStatus("mark_export_ready", id, input, context),
    previewSupplierCreditMemo,
    createSupplierCreditMemo,
    previewApproveSupplierCreditMemo,
    approveSupplierCreditMemo,
  };
}
