import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import {
  createOperationalFinanceCommandService,
  OperationalFinanceError,
} from "../domain/operational-finance-command-service.mjs";
import {
  createOperationalFinanceReadService,
  OperationalFinanceReadError,
} from "../domain/operational-finance-read-service.mjs";
import { createOperationalFinanceO2cCommandService } from "../domain/operational-finance-o2c-command-service.mjs";
import { createOperationalFinanceO2cReadService } from "../domain/operational-finance-o2c-read-service.mjs";
import { createInternalSettlementCommandService, InternalSettlementError } from "../domain/internal-settlement-command-service.mjs";
import { createInternalSettlementReadService } from "../domain/internal-settlement-read-service.mjs";
import { createInternalTransferCommandService } from "../domain/internal-transfer-command-service.mjs";
import { createAdvanceApplicationCommandService } from "../domain/advance-application-command-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

const capabilityIds = [
  "supplier-invoice",
  "three-way-match",
  "payable-obligation",
  "supplier-credit-memo",
  "customer-invoice",
  "receivable-obligation",
  "customer-credit-note",
  "internal-settlement",
  "settlement-workflow",
  "cashbook",
];
const capabilities = (env) =>
  Object.fromEntries(
    capabilityIds.map((id) => [id, capabilityForEnvironment(id, env)]),
  );
const query = (url) => Object.fromEntries(url.searchParams.entries());

function unavailable(ctx, capabilityId) {
  const settlementWorkflow = capabilityId === "settlement-workflow";
  ctx.send(ctx.res, 409, {
    code: settlementWorkflow
      ? "SETTLEMENT_WORKFLOW_CAPABILITY_NOT_AVAILABLE"
      : "OPERATIONAL_FINANCE_CAPABILITY_NOT_AVAILABLE",
    message: settlementWorkflow
      ? "Settlement workflow requires database persistence and explicit enablement."
      : "Operational finance requires database persistence and explicit enablement.",
    details: { capability: capabilityId },
  });
}

function ensureBoundary(ctx) {
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, {
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication is required.",
    });
    return false;
  }
  return true;
}

function ensureCapability(ctx, id) {
  if (capabilityForEnvironment(id, ctx.env || process.env)?.enabled) return true;
  unavailable(ctx, id);
  return false;
}

function knownError(ctx, error) {
  if (
    error instanceof OperationalFinanceError ||
    error instanceof OperationalFinanceReadError ||
    error instanceof InternalSettlementError ||
    error instanceof PilotIdentityError ||
    error?.name === "AuthorizationError"
  ) {
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || "OPERATIONAL_FINANCE_FAILED",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  ctx.send(ctx.res, 500, {
    code: "OPERATIONAL_FINANCE_FAILED",
    message: "Operational finance could not be completed.",
  });
}

async function services(ctx) {
  const env = ctx.env || process.env;
  const prisma =
    ctx.operationalFinancePrisma || (await getPrismaClient(env));
  return {
    read:
      ctx.operationalFinanceReadService ||
      createOperationalFinanceReadService({
        prisma,
        capabilities: capabilities(env),
      }),
    command:
      ctx.operationalFinanceCommandService ||
      createOperationalFinanceCommandService({ prisma, env }),
    o2cRead:
      ctx.operationalFinanceO2cReadService ||
      createOperationalFinanceO2cReadService({
        prisma,
        capabilities: capabilities(env),
      }),
    o2cCommand:
      ctx.operationalFinanceO2cCommandService ||
      createOperationalFinanceO2cCommandService({ prisma, env }),
    settlementRead:
      ctx.internalSettlementReadService ||
      createInternalSettlementReadService({ prisma, capabilities: capabilities(env) }),
    settlementCommand:
      ctx.internalSettlementCommandService ||
      createInternalSettlementCommandService({ prisma, env }),
    transferCommand: ctx.internalTransferCommandService || createInternalTransferCommandService({ prisma, env }),
    advanceCommand: ctx.advanceApplicationCommandService || createAdvanceApplicationCommandService({ prisma, env }),
  };
}

export async function handleOperationalFinanceRoute(ctx) {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/finance/")) return false;
  if (!ensureBoundary(ctx)) return true;
  try {
    const { read, command, o2cRead, o2cCommand, settlementRead, settlementCommand, transferCommand, advanceCommand } = await services(ctx);
    if (ctx.req.method === "GET" && path === "/api/finance/entry-data") {
      const [p2p, o2c, settlement] = await Promise.all([
        read.entryData(ctx),
        o2cRead.entryData(ctx),
        settlementRead.entryData(ctx),
      ]);
      ctx.send(ctx.res, 200, { ...p2p, ...o2c, ...settlement, capabilities: capabilities(ctx.env || process.env) });
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/cashbook/accounts") {
      ctx.send(ctx.res, 200, await settlementRead.listAccounts(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/cashbook/accounts") {
      if (!ensureCapability(ctx, "cashbook")) return true;
      ctx.send(ctx.res, 201, await settlementCommand.createCashbookAccount(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/cashbook/entries") {
      ctx.send(ctx.res, 200, await settlementRead.listEntries(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/settlements") {
      ctx.send(ctx.res, 200, await settlementRead.listSettlements(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/advances") {
      ctx.send(ctx.res, 200, await settlementRead.listAdvances(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/advance-applications") {
      if (!ensureCapability(ctx, "settlement-workflow")) return true;
      ctx.send(ctx.res, 201, await advanceCommand.createAdvanceApplication(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    const advanceMatch = path.match(/^\/api\/finance\/advance-applications\/([^/]+)\/(submit|approve|post|reverse)$/);
    if (ctx.req.method === "POST" && advanceMatch) {
      if (!ensureCapability(ctx, "settlement-workflow")) return true;
      const methods = { submit: "submitAdvanceApplication", approve: "approveAdvanceApplication", post: "postAdvanceApplication", reverse: "reverseAdvanceApplication" };
      ctx.send(ctx.res, 200, await advanceCommand[methods[advanceMatch[2]]](decodeURIComponent(advanceMatch[1]), await ctx.readBody(ctx.req), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/internal-transfers") {
      ctx.send(ctx.res, 200, await settlementRead.listInternalTransfers(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/internal-transfers/preview") {
      if (!ensureCapability(ctx, "settlement-workflow")) return true;
      ctx.send(ctx.res, 200, await transferCommand.previewInternalTransferPosting(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/internal-transfers") {
      if (!ensureCapability(ctx, "settlement-workflow")) return true;
      ctx.send(ctx.res, 201, await transferCommand.createInternalTransfer(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    const transferMatch = path.match(/^\/api\/finance\/internal-transfers\/([^/]+)(?:\/(revise|submit|approve|reject|cancel|post|reverse))?$/);
    if (transferMatch) {
      const transferId = decodeURIComponent(transferMatch[1]), action = transferMatch[2] || "";
      if (ctx.req.method === "GET" && !action) {
        const result = await settlementRead.internalTransferDetail(transferId, ctx);
        ctx.send(ctx.res, result ? 200 : 404, result || { code: "TRANSFER_NOT_FOUND", message: "Internal transfer was not found." });
        return true;
      }
      if (ctx.req.method === "POST" && action) {
        if (!ensureCapability(ctx, "settlement-workflow")) return true;
        const methods = { revise: "reviseInternalTransfer", submit: "submitInternalTransfer", approve: "approveInternalTransfer", reject: "rejectInternalTransfer", cancel: "cancelInternalTransfer", post: "postInternalTransfer", reverse: "reverseInternalTransfer" };
        ctx.send(ctx.res, 200, await transferCommand[methods[action]](transferId, await ctx.readBody(ctx.req), ctx));
        return true;
      }
    }
    if (ctx.req.method === "POST" && path === "/api/finance/settlements/preview") {
      if (!ensureCapability(ctx, "internal-settlement")) return true;
      ctx.send(ctx.res, 200, await settlementCommand.previewSettlement(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/settlements") {
      if (!ensureCapability(ctx, "internal-settlement")) return true;
      ctx.send(ctx.res, 201, await settlementCommand.createSettlement(await ctx.readBody(ctx.req), ctx));
      return true;
    }
    const settlementMatch = path.match(/^\/api\/finance\/settlements\/([^/]+)(?:\/(revise|submit|approve|reject|cancel|posting-preview|post|reverse|reconciliation))?$/);
    if (settlementMatch) {
      const settlementId = decodeURIComponent(settlementMatch[1]);
      const action = settlementMatch[2] || "";
      if (ctx.req.method === "GET" && !action) {
        const result = await settlementRead.detail(settlementId, ctx);
        ctx.send(ctx.res, result ? 200 : 404, result || { code: "SETTLEMENT_NOT_FOUND", message: "Settlement was not found." });
        return true;
      }
      if (ctx.req.method === "GET" && action === "reconciliation") {
        const result = await settlementRead.reconciliation(settlementId, ctx);
        ctx.send(ctx.res, result ? 200 : 404, result || { code: "SETTLEMENT_NOT_FOUND", message: "Settlement was not found." });
        return true;
      }
      if (ctx.req.method === "POST" && action === "posting-preview") {
        if (!ensureCapability(ctx, "settlement-workflow")) return true;
        ctx.send(ctx.res, 200, await settlementCommand.previewSettlementPosting(settlementId, ctx));
        return true;
      }
      if (ctx.req.method === "POST" && ["revise", "submit", "approve", "reject", "cancel", "post", "reverse"].includes(action)) {
        if (!ensureCapability(ctx, ["revise", "submit", "approve", "reject", "cancel"].includes(action) ? "settlement-workflow" : "internal-settlement")) return true;
        const body = await ctx.readBody(ctx.req);
        const commands = { revise: "reviseSettlement", submit: "submitSettlement", approve: "approveSettlement", reject: "rejectSettlement", cancel: "cancelSettlement", post: "postSettlement", reverse: "reverseSettlement" };
        const result = await settlementCommand[commands[action]](settlementId, body, ctx);
        ctx.send(ctx.res, 200, result);
        return true;
      }
    }
    if (ctx.req.method === "GET" && path === "/api/finance/landing") {
      ctx.send(ctx.res, 200, await o2cRead.landing(ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/customer-invoices") {
      ctx.send(ctx.res, 200, await o2cRead.listCustomerInvoices(query(ctx.url), ctx));
      return true;
    }
    if (
      ctx.req.method === "POST" &&
      path === "/api/finance/customer-invoices/preview"
    ) {
      if (!ensureCapability(ctx, "customer-invoice")) return true;
      ctx.send(
        ctx.res,
        200,
        await o2cCommand.previewCustomerInvoice(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/customer-invoices") {
      if (!ensureCapability(ctx, "customer-invoice")) return true;
      ctx.send(
        ctx.res,
        201,
        await o2cCommand.createCustomerInvoice(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/receivables") {
      ctx.send(ctx.res, 200, await o2cRead.listReceivables(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/aging") {
      ctx.send(ctx.res, 200, await o2cRead.aging(query(ctx.url), ctx));
      return true;
    }
    if (
      ctx.req.method === "GET" &&
      path === "/api/finance/customer-credit-notes"
    ) {
      ctx.send(
        ctx.res,
        200,
        await o2cRead.listCustomerCreditNotes(query(ctx.url), ctx),
      );
      return true;
    }
    if (
      ctx.req.method === "POST" &&
      path === "/api/finance/customer-credit-notes/preview"
    ) {
      if (!ensureCapability(ctx, "customer-credit-note")) return true;
      ctx.send(
        ctx.res,
        200,
        await o2cCommand.previewCustomerCreditNote(
          await ctx.readBody(ctx.req),
          ctx,
        ),
      );
      return true;
    }
    if (
      ctx.req.method === "POST" &&
      path === "/api/finance/customer-credit-notes"
    ) {
      if (!ensureCapability(ctx, "customer-credit-note")) return true;
      ctx.send(
        ctx.res,
        201,
        await o2cCommand.createCustomerCreditNote(
          await ctx.readBody(ctx.req),
          ctx,
        ),
      );
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/supplier-invoices") {
      ctx.send(ctx.res, 200, await read.listSupplierInvoices(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/supplier-invoices/preview") {
      if (!ensureCapability(ctx, "supplier-invoice")) return true;
      ctx.send(
        ctx.res,
        200,
        await command.previewSupplierInvoice(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/finance/supplier-invoices") {
      if (!ensureCapability(ctx, "supplier-invoice")) return true;
      ctx.send(
        ctx.res,
        201,
        await command.createSupplierInvoice(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/match-exceptions") {
      ctx.send(ctx.res, 200, await read.listMatchExceptions(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/payables") {
      ctx.send(ctx.res, 200, await read.listPayables(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/finance/supplier-credit-memos") {
      ctx.send(
        ctx.res,
        200,
        await read.listSupplierCreditMemos(query(ctx.url), ctx),
      );
      return true;
    }
    if (
      ctx.req.method === "POST" &&
      path === "/api/finance/supplier-credit-memos/preview"
    ) {
      if (!ensureCapability(ctx, "supplier-credit-memo")) return true;
      ctx.send(
        ctx.res,
        200,
        await command.previewSupplierCreditMemo(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }
    if (
      ctx.req.method === "POST" &&
      path === "/api/finance/supplier-credit-memos"
    ) {
      if (!ensureCapability(ctx, "supplier-credit-memo")) return true;
      ctx.send(
        ctx.res,
        201,
        await command.createSupplierCreditMemo(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }

    const invoiceMatch = path.match(
      /^\/api\/finance\/supplier-invoices\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (invoiceMatch) {
      const invoiceId = decodeURIComponent(invoiceMatch[1]);
      const action = invoiceMatch[2] || "";
      if (ctx.req.method === "GET" && !action) {
        ctx.send(ctx.res, 200, await read.supplierInvoiceDetail(invoiceId, ctx));
        return true;
      }
      if (ctx.req.method === "PATCH" && !action) {
        if (!ensureCapability(ctx, "supplier-invoice")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.reviseSupplierInvoice(
            invoiceId,
            await ctx.readBody(ctx.req),
            ctx,
          ),
        );
        return true;
      }
      const body = await ctx.readBody(ctx.req);
      if (ctx.req.method === "POST" && action === "submit-preview") {
        if (!ensureCapability(ctx, "supplier-invoice")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.previewSubmitSupplierInvoice(invoiceId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "submit") {
        if (!ensureCapability(ctx, "supplier-invoice")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.submitSupplierInvoice(invoiceId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "match-preview") {
        if (!ensureCapability(ctx, "three-way-match")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.previewMatchSupplierInvoice(invoiceId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "match") {
        if (!ensureCapability(ctx, "three-way-match")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.matchSupplierInvoice(invoiceId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "approve-preview") {
        if (!ensureCapability(ctx, "payable-obligation")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.previewApproveSupplierInvoice(invoiceId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "approve") {
        if (!ensureCapability(ctx, "payable-obligation")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.approveSupplierInvoice(invoiceId, body, ctx),
        );
        return true;
      }
    }

    const exceptionMatch = path.match(
      /^\/api\/finance\/match-exceptions\/([^/]+)\/(review-preview|review)$/,
    );
    if (exceptionMatch && ctx.req.method === "POST") {
      if (!ensureCapability(ctx, "three-way-match")) return true;
      const body = await ctx.readBody(ctx.req);
      const exceptionId = decodeURIComponent(exceptionMatch[1]);
      const result =
        exceptionMatch[2] === "review-preview"
          ? await command.previewReviewMatchException(exceptionId, body, ctx)
          : await command.reviewMatchException(exceptionId, body, ctx);
      ctx.send(ctx.res, 200, result);
      return true;
    }

    const payableMatch = path.match(
      /^\/api\/finance\/payables\/([^/]+)\/(hold|release|mark-export-ready)(-preview)?$/,
    );
    if (payableMatch && ctx.req.method === "POST") {
      if (!ensureCapability(ctx, "payable-obligation")) return true;
      const payableId = decodeURIComponent(payableMatch[1]);
      const action = payableMatch[2];
      const body = await ctx.readBody(ctx.req);
      if (payableMatch[3]) {
        ctx.send(
          ctx.res,
          200,
          await command.previewPayableAction(action, payableId, body, ctx),
        );
        return true;
      }
      const method =
        action === "hold"
          ? "holdPayable"
          : action === "release"
            ? "releasePayable"
            : "markPayableExportReady";
      ctx.send(ctx.res, 200, await command[method](payableId, body, ctx));
      return true;
    }

    const memoMatch = path.match(
      /^\/api\/finance\/supplier-credit-memos\/([^/]+)\/(approve-preview|approve)$/,
    );
    if (memoMatch && ctx.req.method === "POST") {
      if (!ensureCapability(ctx, "supplier-credit-memo")) return true;
      const memoId = decodeURIComponent(memoMatch[1]);
      const body = await ctx.readBody(ctx.req);
      ctx.send(
        ctx.res,
        200,
        memoMatch[2] === "approve-preview"
          ? await command.previewApproveSupplierCreditMemo(memoId, body, ctx)
          : await command.approveSupplierCreditMemo(memoId, body, ctx),
      );
      return true;
    }

    const customerInvoiceMatch = path.match(
      /^\/api\/finance\/customer-invoices\/([^/]+)(?:\/(submit-preview|submit|approve-preview|approve|issue-preview|issue))?$/,
    );
    if (customerInvoiceMatch) {
      const invoiceId = decodeURIComponent(customerInvoiceMatch[1]);
      const action = customerInvoiceMatch[2] || "";
      if (ctx.req.method === "GET" && !action) {
        ctx.send(
          ctx.res,
          200,
          await o2cRead.customerInvoiceDetail(invoiceId, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action) {
        const capability =
          action.startsWith("issue")
            ? "receivable-obligation"
            : "customer-invoice";
        if (!ensureCapability(ctx, capability)) return true;
        const methods = {
          "submit-preview": "previewSubmitCustomerInvoice",
          submit: "submitCustomerInvoice",
          "approve-preview": "previewApproveCustomerInvoice",
          approve: "approveCustomerInvoice",
          "issue-preview": "previewIssueCustomerInvoice",
          issue: "issueCustomerInvoice",
        };
        ctx.send(
          ctx.res,
          200,
          await o2cCommand[methods[action]](
            invoiceId,
            await ctx.readBody(ctx.req),
            ctx,
          ),
        );
        return true;
      }
    }

    const receivableMatch = path.match(
      /^\/api\/finance\/receivables\/([^/]+)\/(dispute|resolve-dispute|record-external-reference)(-preview)?$/,
    );
    if (receivableMatch && ctx.req.method === "POST") {
      if (!ensureCapability(ctx, "receivable-obligation")) return true;
      const receivableId = decodeURIComponent(receivableMatch[1]);
      const action = receivableMatch[2];
      const body = await ctx.readBody(ctx.req);
      if (receivableMatch[3]) {
        ctx.send(
          ctx.res,
          200,
          await o2cCommand.previewReceivableAction(
            action,
            receivableId,
            body,
            ctx,
          ),
        );
        return true;
      }
      const method =
        action === "dispute"
          ? "disputeReceivable"
          : action === "resolve-dispute"
            ? "resolveReceivableDispute"
            : "recordExternalSettlementReference";
      ctx.send(
        ctx.res,
        200,
        await o2cCommand[method](receivableId, body, ctx),
      );
      return true;
    }

    const customerCreditMatch = path.match(
      /^\/api\/finance\/customer-credit-notes\/([^/]+)\/(approve-preview|approve)$/,
    );
    if (customerCreditMatch && ctx.req.method === "POST") {
      if (!ensureCapability(ctx, "customer-credit-note")) return true;
      const noteId = decodeURIComponent(customerCreditMatch[1]);
      const body = await ctx.readBody(ctx.req);
      ctx.send(
        ctx.res,
        200,
        customerCreditMatch[2] === "approve-preview"
          ? await o2cCommand.previewApproveCustomerCreditNote(noteId, body, ctx)
          : await o2cCommand.approveCustomerCreditNote(noteId, body, ctx),
      );
      return true;
    }

    ctx.send(ctx.res, 404, {
      code: "OPERATIONAL_FINANCE_ROUTE_NOT_FOUND",
      message: "Operational finance route was not found.",
    });
    return true;
  } catch (error) {
    knownError(ctx, error);
    return true;
  }
}
