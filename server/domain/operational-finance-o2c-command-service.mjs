import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { OperationalFinanceError } from "./operational-finance-command-service.mjs";
import {
  buildCustomerCreditNotePlan,
  buildCustomerInvoicePlan,
} from "./operational-finance-o2c-policy.mjs";
import {
  financeFixed as fixed,
  financeUnits as units,
} from "./operational-finance-policy.mjs";

const text = (value) => String(value ?? "").trim();
const fail = (code, message, status = 400, details) => {
  throw new OperationalFinanceError(code, message, status, details);
};
const commandPermission = (commandType) => ({
  create_customer_invoice: "finance.customer_invoice.create",
  submit_customer_invoice: "finance.customer_invoice.submit",
  approve_customer_invoice: "finance.customer_invoice.approve",
  issue_customer_invoice: "finance.customer_invoice.issue",
  dispute_receivable: "finance.receivable.dispute",
  resolve_dispute_receivable: "finance.receivable.resolve_dispute",
  record_external_reference_receivable: "finance.receivable.record_external_reference",
  create_customer_credit_note: "finance.customer_credit.create",
  approve_customer_credit_note: "finance.customer_credit.approve",
})[String(commandType || "").replaceAll("-", "_")];
const stable = (value, parent = "") => {
  if (Array.isArray(value)) {
    const rows = value.map((entry) => stable(entry, parent));
    return parent === "lines"
      ? rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : rows;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key], key)]),
    );
  return value;
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const required = (value, label) => {
  const next = text(value);
  if (!next) fail("FINANCE_VALIDATION_FAILED", `${label} is required.`, 422);
  return next;
};
const version = (value) => {
  const next = Number(value);
  if (!Number.isInteger(next) || next < 0)
    fail(
      "FINANCE_VERSION_INVALID",
      "expectedVersion must be a non-negative integer.",
      422,
    );
  return next;
};
const whereExecution = (tenantId, commandType, idempotencyKey) => ({
  tenantId_commandType_idempotencyKey: {
    tenantId,
    commandType,
    idempotencyKey,
  },
});
const enabled = (env) => {
  if (
    text(env.FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE).toLowerCase() !== "true"
  )
    fail(
      "OPERATIONAL_FINANCE_CAPABILITY_NOT_AVAILABLE",
      "Operational finance requires database persistence and explicit enablement.",
      409,
    );
};
const identity = (context) => {
  const next = context?.identity || context;
  if (!next?.authenticated || !text(next.tenantId))
    fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  return next;
};
const enforce = (plan) => {
  if (!plan.allowed) {
    const first = plan.blockingIssues[0];
    fail(first.code, first.message, first.status, first.details);
  }
  return plan;
};
const replay = (execution, requestHash) => {
  if (!execution) return null;
  if (execution.requestHash !== requestHash)
    fail(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      "The idempotency key was already used with a different payload.",
      409,
    );
  if (execution.status !== "completed" || !execution.resultPayload)
    fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is in progress.", 409);
  return { ...execution.resultPayload, idempotentReplay: true };
};
const lockTenant = async (tx, table, tenantId, id, code) => {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id" FROM "${table}" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE`,
    tenantId,
    id,
  );
  if (!rows.length) fail(code, "Finance document was not found.", 404);
};
const lockChildren = async (tx, table, ids) => {
  for (const id of [...new Set(ids.map(text).filter(Boolean))].sort())
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
};
const audit = ({
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
}) => ({
  id: idFactory(),
  tenantId: actor.tenantId,
  actorId: actor.user.id,
  source: "operational_finance_o2c_command_service",
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
    refundExecution: false,
    ledgerMutation: false,
  },
});
const invoiceResult = (row) => ({
  entityType: "CustomerInvoice",
  entityId: row.id,
  invoice: {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    customerName: row.customerNameSnapshot,
    status: row.status,
    totalAmount: String(row.totalAmount),
    currency: row.currency,
    version: row.version,
  },
});
const receivableResult = (row) => ({
  entityType: "ReceivableObligation",
  entityId: row.id,
  receivable: {
    id: row.id,
    obligationNumber: row.obligationNumber,
    customerInvoiceId: row.customerInvoiceId,
    status: row.status,
    disputeStatus: row.disputeStatus,
    originalAmount: String(row.originalAmount),
    outstandingAmount: String(row.outstandingAmount),
    currency: row.currency,
    dueDate: row.dueDate?.toISOString?.(),
    version: row.version,
    settlementVerified: false,
  },
});
const creditResult = (row) => ({
  entityType: "CustomerCreditNote",
  entityId: row.id,
  creditNote: {
    id: row.id,
    creditNoteNumber: row.creditNoteNumber,
    customerInvoiceId: row.customerInvoiceId,
    returnPostingId: row.returnPostingId,
    status: row.status,
    totalAmount: String(row.totalAmount),
    currency: row.currency,
    version: row.version,
  },
});
const receivableActionPlan = (action, row, input, asOf) => {
  const blockingIssues = [];
  if (row.version !== version(input.expectedVersion))
    blockingIssues.push({
      code: "FINANCE_VERSION_CONFLICT",
      message: "Receivable changed concurrently.",
      status: 409,
    });
  if (action === "dispute" && !["open", "overdue"].includes(row.status))
    blockingIssues.push({
      code: "RECEIVABLE_STATUS_INVALID",
      message: "Only an open or overdue receivable can be disputed.",
      status: 409,
    });
  if (action === "resolve-dispute" && row.disputeStatus !== "open")
    blockingIssues.push({
      code: "RECEIVABLE_STATUS_INVALID",
      message: "Only an open dispute can be resolved.",
      status: 409,
    });
  if (
    ["dispute", "record-external-reference"].includes(action) &&
    !text(action === "dispute" ? input.reason : input.externalReference)
  )
    blockingIssues.push({
      code: "FINANCE_VALIDATION_FAILED",
      message:
        action === "dispute"
          ? "reason is required."
          : "externalReference is required.",
      status: 422,
    });
  return {
    operation: `${action}_receivable`,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    before: receivableResult(row).receivable,
    after: {
      ...receivableResult(row).receivable,
      status:
        action === "dispute"
          ? "disputed"
          : action === "resolve-dispute"
            ? new Date(row.dueDate).getTime() < asOf.getTime()
              ? "overdue"
              : "open"
            : row.status,
      disputeStatus:
        action === "dispute"
          ? "open"
          : action === "resolve-dispute"
            ? "resolved"
            : row.disputeStatus,
      version: row.version + 1,
    },
    settlementVerified: false,
    paymentExecution: false,
  };
};
const normalizedInvoice = (input = {}) => ({
  invoiceNumber: text(input.invoiceNumber),
  shipmentId: text(input.shipmentId),
  currency: text(input.currency).toUpperCase(),
  invoiceDate: text(input.invoiceDate),
  dueDate: text(input.dueDate),
  totalAmount: text(input.totalAmount),
  lines: (Array.isArray(input.lines) ? input.lines : []).map((line) => ({
    shipmentLineId: text(line.shipmentLineId),
    quantity: text(line.quantity),
    enteredTaxAmount: text(line.enteredTaxAmount || "0"),
  })),
});
const normalizedCredit = (input = {}) => ({
  creditNoteNumber: text(input.creditNoteNumber),
  customerInvoiceId: text(input.customerInvoiceId),
  returnPostingId: text(input.returnPostingId),
  currency: text(input.currency).toUpperCase(),
  lines: (Array.isArray(input.lines) ? input.lines : []).map((line) => ({
    customerInvoiceLineId: text(line.customerInvoiceLineId),
    returnPostingLineId: text(line.returnPostingLineId),
    quantity: text(line.quantity),
    pricingSource: text(line.pricingSource) || "original_invoice",
    unitPrice: text(line.unitPrice),
    enteredTaxAmount: text(line.enteredTaxAmount || "0"),
  })),
});

export function createOperationalFinanceO2cCommandService({
  prisma,
  env = process.env,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!prisma) throw new Error("prisma is required");

  async function execute(commandType, input, context, payload, work) {
    enabled(env);
    const signed = identity(context);
    const idempotencyKey = required(input.idempotencyKey, "idempotencyKey");
    const requestHash = hash(payload);
    const where = whereExecution(
      signed.tenantId,
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
          const actor = await resolveProvisionedActor(tx, signed);
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
      if (
        error?.code === "P2034" ||
        /serialization|deadlock|write conflict/i.test(text(error?.message))
      )
        fail(
          "FINANCE_CONCURRENCY_CONFLICT",
          "Finance facts changed concurrently. Reload and retry.",
          409,
        );
      throw error;
    }
  }

  async function previewCustomerInvoice(input, context) {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    assertAuthorized({ actor, permission: "finance.customer_invoice.create", tenantId: actor.tenantId });
    return buildCustomerInvoicePlan({
      prisma,
      tenantId: actor.tenantId,
      input: normalizedInvoice(input),
      consumeExisting: false,
    });
  }

  async function createCustomerInvoice(input, context) {
    const payload = normalizedInvoice(input);
    return execute(
      "create_customer_invoice",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        const preview = enforce(
          await buildCustomerInvoicePlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: normalized,
            consumeExisting: false,
          }),
        );
        const row = await tx.customerInvoice.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            invoiceNumber: preview.invoice.invoiceNumber,
            salesOrderId: preview.source.salesOrderId,
            shipmentId: preview.source.shipmentId,
            customerId: preview.source.customerId,
            customerNameSnapshot: preview.source.customerName,
            invoiceDate: new Date(preview.invoice.invoiceDate),
            dueDate: new Date(preview.invoice.dueDate),
            subtotalAmount: preview.invoice.subtotalAmount,
            enteredTaxAmount: preview.invoice.enteredTaxAmount,
            totalAmount: preview.invoice.totalAmount,
            currency: preview.invoice.currency,
            lines: {
              create: preview.lines.map(
                ({
                  shippedQuantity: _shipped,
                  previouslyInvoicedQuantity: _previous,
                  ...line
                }) => ({ id: idFactory(), ...line }),
              ),
            },
          },
        });
        const result = invoiceResult(row);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "customer_invoice_created",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Customer invoice draft created from posted shipment facts.",
            ...command,
            before: null,
            after: result.invoice,
            evidence: {
              salesOrderId: preview.source.salesOrderId,
              shipmentId: preview.source.shipmentId,
              shipmentLineIds: preview.lines.map((line) => line.shipmentLineId),
            },
          }),
        });
        return result;
      },
    );
  }

  async function invoiceStatePreview(invoiceId, input, context, action) {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    assertAuthorized({ actor, permission: `finance.customer_invoice.${action}`, tenantId: actor.tenantId });
    const invoice = await prisma.customerInvoice.findFirst({
      where: { id: invoiceId, tenantId: actor.tenantId },
      include: { lines: true },
    });
    if (!invoice)
      fail("CUSTOMER_INVOICE_NOT_FOUND", "Customer invoice was not found.", 404);
    const expected = version(input.expectedVersion);
    const requiredStatus =
      action === "submit"
        ? "draft"
        : action === "approve"
          ? "submitted"
          : "approved";
    const blockingIssues = [];
    if (invoice.version !== expected)
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Customer invoice changed concurrently.",
        status: 409,
      });
    if (invoice.status !== requiredStatus)
      blockingIssues.push({
        code: "CUSTOMER_INVOICE_STATUS_INVALID",
        message: `Customer invoice must be ${requiredStatus} before ${action}.`,
        status: 409,
      });
    if (action === "submit") {
      const check = await buildCustomerInvoicePlan({
        prisma,
        tenantId: actor.tenantId,
        currentInvoiceId: invoice.id,
        consumeExisting: true,
        input: {
          invoiceNumber: invoice.invoiceNumber,
          shipmentId: invoice.shipmentId,
          currency: invoice.currency,
          invoiceDate: invoice.invoiceDate.toISOString(),
          dueDate: invoice.dueDate.toISOString(),
          totalAmount: String(invoice.totalAmount),
          lines: invoice.lines.map((line) => ({
            shipmentLineId: line.shipmentLineId,
            quantity: String(line.quantity),
            enteredTaxAmount: String(line.enteredTaxAmount),
          })),
        },
      });
      blockingIssues.push(...check.blockingIssues);
    }
    return {
      operation: `${action}_customer_invoice`,
      allowed: blockingIssues.length === 0,
      blockingIssues,
      before: invoiceResult(invoice).invoice,
      after: {
        ...invoiceResult(invoice).invoice,
        status:
          action === "submit"
            ? "submitted"
            : action === "approve"
              ? "approved"
              : "issued",
        version: invoice.version + 1,
      },
      factsToCreate: {
        receivableObligations: action === "issue" ? 1 : 0,
        payments: 0,
        journalEntries: 0,
      },
    };
  }

  async function transitionInvoice(action, invoiceId, input, context) {
    const payload = {
      invoiceId: required(invoiceId, "invoiceId"),
      expectedVersion: version(input.expectedVersion),
      obligationNumber: text(input.obligationNumber),
    };
    return execute(
      `${action}_customer_invoice`,
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenant(
          tx,
          "CustomerInvoice",
          actor.tenantId,
          normalized.invoiceId,
          "CUSTOMER_INVOICE_NOT_FOUND",
        );
        const current = await tx.customerInvoice.findUnique({
          where: { id: normalized.invoiceId },
          include: { lines: true },
        });
        const requiredStatus =
          action === "submit"
            ? "draft"
            : action === "approve"
              ? "submitted"
              : "approved";
        if (current.status !== requiredStatus)
          fail(
            "CUSTOMER_INVOICE_STATUS_INVALID",
            `Customer invoice must be ${requiredStatus} before ${action}.`,
            409,
          );
        if (current.version !== normalized.expectedVersion)
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Customer invoice changed concurrently.",
            409,
          );
        if (action === "submit") {
          await lockChildren(
            tx,
            "ShipmentLine",
            current.lines.map((line) => line.shipmentLineId),
          );
          enforce(
            await buildCustomerInvoicePlan({
              prisma: tx,
              tenantId: actor.tenantId,
              currentInvoiceId: current.id,
              consumeExisting: true,
              input: {
                invoiceNumber: current.invoiceNumber,
                shipmentId: current.shipmentId,
                currency: current.currency,
                invoiceDate: current.invoiceDate.toISOString(),
                dueDate: current.dueDate.toISOString(),
                totalAmount: String(current.totalAmount),
                lines: current.lines.map((line) => ({
                  shipmentLineId: line.shipmentLineId,
                  quantity: String(line.quantity),
                  enteredTaxAmount: String(line.enteredTaxAmount),
                })),
              },
            }),
          );
        }
        const status =
          action === "submit"
            ? "submitted"
            : action === "approve"
              ? "approved"
              : "issued";
        const row = await tx.customerInvoice.update({
          where: { id: current.id },
          data: {
            status,
            ...(action === "submit"
              ? { submittedAt: now(), submittedById: actor.user.id }
              : action === "approve"
                ? { approvedAt: now(), approvedById: actor.user.id }
                : { issuedAt: now(), issuedById: actor.user.id }),
            version: { increment: 1 },
          },
        });
        let receivable = null;
        if (action === "issue")
          receivable = await tx.receivableObligation.create({
            data: {
              id: idFactory(),
              tenantId: actor.tenantId,
              customerInvoiceId: current.id,
              obligationNumber:
                normalized.obligationNumber || `AR-${current.invoiceNumber}`,
              originalAmount: current.totalAmount,
              outstandingAmount: current.totalAmount,
              currency: current.currency,
              dueDate: current.dueDate,
              status: "open",
            },
          });
        const result = {
          ...invoiceResult(row),
          ...(receivable
            ? { receivable: receivableResult(receivable).receivable }
            : {}),
        };
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: `${action}_customer_invoice`,
            entityType: result.entityType,
            entityId: result.entityId,
            summary: `Customer invoice ${action} completed.`,
            ...command,
            before: invoiceResult(current).invoice,
            after: result,
            evidence: {
              salesOrderId: current.salesOrderId,
              shipmentId: current.shipmentId,
              receivableObligationId: receivable?.id || null,
            },
          }),
        });
        return result;
      },
    );
  }

  async function previewReceivableAction(action, id, input, context) {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    assertAuthorized({ actor, permission: action === "dispute" ? "finance.receivable.dispute" : action === "resolve-dispute" ? "finance.receivable.resolve_dispute" : "finance.receivable.record_external_reference", tenantId: actor.tenantId });
    const row = await prisma.receivableObligation.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!row)
      fail("RECEIVABLE_NOT_FOUND", "Receivable obligation was not found.", 404);
    return receivableActionPlan(action, row, input, now());
  }

  async function receivableAction(action, id, input, context) {
    const payload = {
      receivableId: required(id, "receivableId"),
      expectedVersion: version(input.expectedVersion),
      reason: text(input.reason),
      externalReference: text(input.externalReference),
    };
    return execute(
      `${action}_receivable`,
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenant(
          tx,
          "ReceivableObligation",
          actor.tenantId,
          normalized.receivableId,
          "RECEIVABLE_NOT_FOUND",
        );
        const current = await tx.receivableObligation.findUnique({
          where: { id: normalized.receivableId },
        });
        const actionPlan = enforce(
          receivableActionPlan(action, current, normalized, now()),
        );
        const data =
          action === "dispute"
            ? {
                status: "disputed",
                disputeStatus: "open",
                disputeReason: normalized.reason,
              }
            : action === "resolve-dispute"
              ? {
                  status: actionPlan.after.status,
                  disputeStatus: "resolved",
                  disputeReason: normalized.reason || current.disputeReason,
                }
              : {
                  externalSettlementReference: normalized.externalReference,
                  externalSettlementEnteredAt: now(),
                  externalSettlementEnteredById: actor.user.id,
                };
        const row = await tx.receivableObligation.update({
          where: { id: current.id },
          data: { ...data, version: { increment: 1 } },
        });
        const result = receivableResult(row);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: `${action}_receivable`,
            entityType: result.entityType,
            entityId: result.entityId,
            summary: `Receivable ${action} recorded without settlement execution.`,
            ...command,
            before: receivableResult(current).receivable,
            after: result.receivable,
            evidence: { customerInvoiceId: current.customerInvoiceId },
          }),
        });
        return result;
      },
    );
  }

  async function previewCustomerCreditNote(input, context) {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    assertAuthorized({ actor, permission: "finance.customer_credit.create", tenantId: actor.tenantId });
    return buildCustomerCreditNotePlan({
      prisma,
      tenantId: actor.tenantId,
      input: normalizedCredit(input),
    });
  }

  async function createCustomerCreditNote(input, context) {
    const payload = normalizedCredit(input);
    return execute(
      "create_customer_credit_note",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenant(
          tx,
          "CustomerInvoice",
          actor.tenantId,
          normalized.customerInvoiceId,
          "CUSTOMER_INVOICE_NOT_FOUND",
        );
        await lockTenant(
          tx,
          "ReturnPostingDocument",
          actor.tenantId,
          normalized.returnPostingId,
          "CUSTOMER_RETURN_RECEIPT_REQUIRED",
        );
        await lockChildren(
          tx,
          "CustomerInvoiceLine",
          normalized.lines.map((line) => line.customerInvoiceLineId),
        );
        await lockChildren(
          tx,
          "ReturnPostingLine",
          normalized.lines.map((line) => line.returnPostingLineId),
        );
        const preview = enforce(
          await buildCustomerCreditNotePlan({
            prisma: tx,
            tenantId: actor.tenantId,
            input: normalized,
          }),
        );
        const row = await tx.customerCreditNote.create({
          data: {
            id: idFactory(),
            tenantId: actor.tenantId,
            creditNoteNumber: preview.creditNote.creditNoteNumber,
            customerInvoiceId: preview.invoice.id,
            returnPostingId: preview.returnPosting.id,
            customerId: preview.invoice.customerId,
            customerNameSnapshot: preview.invoice.customerName,
            currency: preview.creditNote.currency,
            subtotalAmount: preview.creditNote.subtotalAmount,
            enteredTaxAmount: preview.creditNote.enteredTaxAmount,
            totalAmount: preview.creditNote.totalAmount,
            lines: {
              create: preview.lines.map((line) => ({
                id: idFactory(),
                ...line,
              })),
            },
          },
        });
        const result = creditResult(row);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "customer_credit_note_created",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Customer credit note draft created from posted return receipt.",
            ...command,
            before: null,
            after: result.creditNote,
            evidence: {
              customerInvoiceId: row.customerInvoiceId,
              returnPostingId: row.returnPostingId,
            },
          }),
        });
        return result;
      },
    );
  }

  async function previewApproveCustomerCreditNote(id, input, context) {
    enabled(env);
    const actor = await resolveProvisionedActor(prisma, identity(context));
    assertAuthorized({ actor, permission: "finance.customer_credit.approve", tenantId: actor.tenantId });
    const row = await prisma.customerCreditNote.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!row)
      fail("CUSTOMER_CREDIT_NOTE_NOT_FOUND", "Credit note was not found.", 404);
    const receivable = await prisma.receivableObligation.findUnique({
      where: { customerInvoiceId: row.customerInvoiceId },
    });
    const blockingIssues = [];
    if (row.version !== version(input.expectedVersion))
      blockingIssues.push({
        code: "FINANCE_VERSION_CONFLICT",
        message: "Customer credit note changed concurrently.",
        status: 409,
      });
    if (row.status !== "draft")
      blockingIssues.push({
        code: "CUSTOMER_CREDIT_STATUS_INVALID",
        message: "Only a draft customer credit note can be approved.",
        status: 409,
      });
    if (
      receivable &&
      units(row.totalAmount) > units(receivable.outstandingAmount)
    )
      blockingIssues.push({
        code: "CUSTOMER_CREDIT_AMOUNT_EXCEEDED",
        message: "Customer credit cannot exceed the receivable outstanding amount.",
        status: 409,
      });
    return {
      operation: "approve_customer_credit_note",
      allowed: blockingIssues.length === 0,
      blockingIssues,
      before: creditResult(row).creditNote,
      after: {
        ...creditResult(row).creditNote,
        status: "approved",
        version: row.version + 1,
      },
      refundExecution: false,
      paymentExecution: false,
    };
  }

  async function approveCustomerCreditNote(id, input, context) {
    const payload = {
      creditNoteId: required(id, "creditNoteId"),
      expectedVersion: version(input.expectedVersion),
    };
    return execute(
      "approve_customer_credit_note",
      input,
      context,
      payload,
      async (tx, actor, normalized, command) => {
        await lockTenant(
          tx,
          "CustomerCreditNote",
          actor.tenantId,
          normalized.creditNoteId,
          "CUSTOMER_CREDIT_NOTE_NOT_FOUND",
        );
        const current = await tx.customerCreditNote.findUnique({
          where: { id: normalized.creditNoteId },
        });
        if (
          current.version !== normalized.expectedVersion ||
          current.status !== "draft"
        )
          fail(
            "FINANCE_VERSION_CONFLICT",
            "Customer credit note state changed.",
            409,
          );
        const receivable = await tx.receivableObligation.findUnique({
          where: { customerInvoiceId: current.customerInvoiceId },
        });
        if (receivable) {
          await lockTenant(
            tx,
            "ReceivableObligation",
            actor.tenantId,
            receivable.id,
            "RECEIVABLE_NOT_FOUND",
          );
          const outstanding =
            units(receivable.outstandingAmount) - units(current.totalAmount);
          if (outstanding < 0n)
            fail(
              "CUSTOMER_CREDIT_AMOUNT_EXCEEDED",
              "Customer credit cannot exceed the receivable outstanding amount.",
              409,
            );
          await tx.receivableObligation.update({
            where: { id: receivable.id },
            data: {
              outstandingAmount: fixed(outstanding),
              approvedCreditAmount: fixed(
                units(receivable.approvedCreditAmount) +
                  units(current.totalAmount),
              ),
              version: { increment: 1 },
            },
          });
        }
        const row = await tx.customerCreditNote.update({
          where: { id: current.id },
          data: {
            status: "approved",
            approvedAt: now(),
            approvedById: actor.user.id,
            version: { increment: 1 },
          },
        });
        const result = creditResult(row);
        await tx.auditLog.create({
          data: audit({
            idFactory,
            actor,
            action: "customer_credit_note_approved",
            entityType: result.entityType,
            entityId: result.entityId,
            summary: "Customer credit note approved without refund execution.",
            ...command,
            before: creditResult(current).creditNote,
            after: result.creditNote,
            evidence: {
              customerInvoiceId: current.customerInvoiceId,
              returnPostingId: current.returnPostingId,
              receivableId: receivable?.id || null,
            },
          }),
        });
        return result;
      },
    );
  }

  return {
    previewCustomerInvoice,
    createCustomerInvoice,
    previewSubmitCustomerInvoice: (id, input, context) =>
      invoiceStatePreview(id, input, context, "submit"),
    submitCustomerInvoice: (id, input, context) =>
      transitionInvoice("submit", id, input, context),
    previewApproveCustomerInvoice: (id, input, context) =>
      invoiceStatePreview(id, input, context, "approve"),
    approveCustomerInvoice: (id, input, context) =>
      transitionInvoice("approve", id, input, context),
    previewIssueCustomerInvoice: (id, input, context) =>
      invoiceStatePreview(id, input, context, "issue"),
    issueCustomerInvoice: (id, input, context) =>
      transitionInvoice("issue", id, input, context),
    previewReceivableAction,
    disputeReceivable: (id, input, context) =>
      receivableAction("dispute", id, input, context),
    resolveReceivableDispute: (id, input, context) =>
      receivableAction("resolve-dispute", id, input, context),
    recordExternalSettlementReference: (id, input, context) =>
      receivableAction("record-external-reference", id, input, context),
    previewCustomerCreditNote,
    createCustomerCreditNote,
    previewApproveCustomerCreditNote,
    approveCustomerCreditNote,
  };
}
