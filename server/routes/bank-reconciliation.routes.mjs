import { BankStatementParserError } from "../domain/bank-statement-parser.mjs";
import { BankStatementError, bankStatementLimits, createBankStatementService } from "../domain/bank-statement-service.mjs";
import { BankReconciliationError, createBankReconciliationService } from "../domain/bank-reconciliation-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { bodyLimitForFile } from "../utils/http.mjs";

const query = (url) => Object.fromEntries(url.searchParams.entries());
const decode = (value) => decodeURIComponent(value);
function commandInput(ctx, body = {}) {
  const idempotencyKey = String(ctx.req.headers["idempotency-key"] || body.idempotencyKey || "").trim();
  const ifMatch = String(ctx.req.headers["if-match"] || "").replace(/^W\//, "").replaceAll('"', "").trim();
  return { ...body, ...(idempotencyKey ? { idempotencyKey } : {}), ...(body.expectedVersion == null && ifMatch ? { expectedVersion: Number(ifMatch) } : {}) };
}
function knownError(ctx, error) {
  if (error instanceof BankStatementError || error instanceof BankStatementParserError || error instanceof BankReconciliationError || error instanceof PilotIdentityError || error?.name === "AuthorizationError" || error?.name === "RequestBodyError") {
    ctx.send(ctx.res, error.status || 400, { code: error.code || "BANK_RECONCILIATION_FAILED", message: error.message, ...(error.details ? { details: error.details } : {}) }); return;
  }
  ctx.reportError?.(error);
  ctx.send(ctx.res, 500, { code: "BANK_RECONCILIATION_FAILED", message: "Bank statement reconciliation could not be completed." });
}
async function services(ctx) {
  const prisma = ctx.bankReconciliationPrisma || await getPrismaClient(ctx.env || process.env);
  return {
    statement: ctx.bankStatementService || createBankStatementService({ prisma, env: ctx.env || process.env, storageProvider: ctx.bankAttachmentStorage }),
    reconciliation: ctx.bankReconciliationService || createBankReconciliationService({ prisma, env: ctx.env || process.env }),
  };
}

export async function handleBankReconciliationRoute(ctx) {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/finance/bank-")) return false;
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." }); return true; }
  try {
    const { statement, reconciliation } = await services(ctx);
    if (path === "/api/finance/bank-mappings") {
      if (ctx.req.method === "GET") ctx.send(ctx.res, 200, await statement.listMappings(ctx));
      else if (ctx.req.method === "POST") ctx.send(ctx.res, 201, await statement.createMapping(await ctx.readBody(ctx.req), ctx));
      else return false; return true;
    }
    const mapping = path.match(/^\/api\/finance\/bank-mappings\/([^/]+)$/);
    if (mapping) {
      if (ctx.req.method === "GET") ctx.send(ctx.res, 200, await statement.getMapping(decode(mapping[1]), ctx));
      else if (ctx.req.method === "PATCH") ctx.send(ctx.res, 200, await statement.updateMapping(decode(mapping[1]), commandInput(ctx, await ctx.readBody(ctx.req)), ctx));
      else return false; return true;
    }
    if (path === "/api/finance/bank-statements/uploads" && ctx.req.method === "POST") { ctx.send(ctx.res, 201, await statement.stageUpload(await ctx.readBody(ctx.req, { maxBytes: bodyLimitForFile(bankStatementLimits(ctx.env || process.env).maxFileBytes) }), ctx)); return true; }
    if (path === "/api/finance/bank-statements/batches") {
      if (ctx.req.method === "GET") ctx.send(ctx.res, 200, await statement.listBatches(query(ctx.url), ctx));
      else if (ctx.req.method === "POST") ctx.send(ctx.res, 201, await statement.createBatch(await ctx.readBody(ctx.req), ctx));
      else return false; return true;
    }
    const batchRows = path.match(/^\/api\/finance\/bank-statements\/batches\/([^/]+)\/rows(?:\/([^/]+))?(?:\/(exclude|accept-duplicate))?$/);
    if (batchRows) {
      const batchId = decode(batchRows[1]), rowId = batchRows[2] ? decode(batchRows[2]) : null, action = batchRows[3];
      if (ctx.req.method === "GET" && !rowId) ctx.send(ctx.res, 200, await statement.listRows(batchId, ctx));
      else if (ctx.req.method === "PATCH" && rowId && !action) ctx.send(ctx.res, 200, await statement.updateRow(batchId, rowId, commandInput(ctx, await ctx.readBody(ctx.req)), ctx));
      else if (ctx.req.method === "POST" && rowId && action === "exclude") ctx.send(ctx.res, 200, await statement.excludeRow(batchId, rowId, await ctx.readBody(ctx.req), ctx));
      else if (ctx.req.method === "POST" && rowId && action === "accept-duplicate") ctx.send(ctx.res, 200, await statement.acceptDuplicate(batchId, rowId, await ctx.readBody(ctx.req), ctx));
      else return false; return true;
    }
    const batch = path.match(/^\/api\/finance\/bank-statements\/batches\/([^/]+)(?:\/(preview|parse|validate|commit|void))?$/);
    if (batch) {
      const id = decode(batch[1]), action = batch[2] || "";
      if (ctx.req.method === "GET" && !action) ctx.send(ctx.res, 200, await statement.getBatch(id, ctx));
      else if (ctx.req.method === "POST" && action === "preview") ctx.send(ctx.res, 200, { batch: await statement.getBatch(id, ctx), ...(await statement.listRows(id, ctx)) });
      else if (ctx.req.method === "POST" && action === "parse") ctx.send(ctx.res, 200, await statement.parseBatch(id, ctx));
      else if (ctx.req.method === "POST" && action === "validate") ctx.send(ctx.res, 200, await statement.validateBatch(id, ctx));
      else if (ctx.req.method === "POST" && action === "commit") ctx.send(ctx.res, 200, await statement.commitBatch(id, commandInput(ctx, await ctx.readBody(ctx.req)), ctx));
      else if (ctx.req.method === "POST" && action === "void") ctx.send(ctx.res, 200, await statement.voidBatch(id, commandInput(ctx, await ctx.readBody(ctx.req)), ctx));
      else return false; return true;
    }
    if (path === "/api/finance/bank-statements/lines" && ctx.req.method === "GET") { ctx.send(ctx.res, 200, await statement.listLines(query(ctx.url), ctx)); return true; }
    const lineCandidates = path.match(/^\/api\/finance\/bank-reconciliation\/lines\/([^/]+)\/candidates(?:\/(generate))?$/);
    if (lineCandidates) { const id = decode(lineCandidates[1]); if (ctx.req.method === "GET" && !lineCandidates[2]) ctx.send(ctx.res, 200, await reconciliation.listCandidates(id, ctx)); else if (ctx.req.method === "POST" && lineCandidates[2]) ctx.send(ctx.res, 200, await reconciliation.generateCandidates(id, await ctx.readBody(ctx.req), ctx)); else return false; return true; }
    const line = path.match(/^\/api\/finance\/bank-statements\/lines\/([^/]+)$/);
    if (line && ctx.req.method === "GET") { ctx.send(ctx.res, 200, await statement.getLine(decode(line[1]), ctx)); return true; }
    const candidate = path.match(/^\/api\/finance\/bank-reconciliation\/candidates\/([^/]+)\/dismiss$/);
    if (candidate && ctx.req.method === "POST") { ctx.send(ctx.res, 200, await reconciliation.dismissCandidate(decode(candidate[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    if (path === "/api/finance/bank-reconciliation/integrity/refresh" && ctx.req.method === "POST") { ctx.send(ctx.res, 200, await reconciliation.refreshIntegrity(ctx)); return true; }
    if (path === "/api/finance/bank-reconciliation/groups") {
      if (ctx.req.method === "GET") ctx.send(ctx.res, 200, await reconciliation.listGroups(query(ctx.url), ctx));
      else if (ctx.req.method === "POST") ctx.send(ctx.res, 201, await reconciliation.createGroup(await ctx.readBody(ctx.req), ctx));
      else return false; return true;
    }
    const group = path.match(/^\/api\/finance\/bank-reconciliation\/groups\/([^/]+)(?:\/(preview|confirm|reverse))?$/);
    if (group) { const id = decode(group[1]), action = group[2] || ""; if (ctx.req.method === "GET" && !action) ctx.send(ctx.res, 200, await reconciliation.getGroup(id, ctx)); else if (ctx.req.method === "PATCH" && !action) ctx.send(ctx.res, 200, await reconciliation.reviseGroup(id, commandInput(ctx, await ctx.readBody(ctx.req)), ctx)); else if (ctx.req.method === "POST" && action === "preview") ctx.send(ctx.res, 200, await reconciliation.previewGroup(id, ctx)); else if (ctx.req.method === "POST" && action === "confirm") ctx.send(ctx.res, 200, await reconciliation.confirmGroup(id, commandInput(ctx, await ctx.readBody(ctx.req)), ctx)); else if (ctx.req.method === "POST" && action === "reverse") ctx.send(ctx.res, 200, await reconciliation.reverseGroup(id, commandInput(ctx, await ctx.readBody(ctx.req)), ctx)); else return false; return true; }
    if (path === "/api/finance/bank-reconciliation/exceptions" && ctx.req.method === "GET") { ctx.send(ctx.res, 200, await reconciliation.listExceptions(ctx)); return true; }
    const exception = path.match(/^\/api\/finance\/bank-reconciliation\/exceptions\/([^/]+)\/resolve$/);
    if (exception && ctx.req.method === "POST") { ctx.send(ctx.res, 200, await reconciliation.resolveException(decode(exception[1]), await ctx.readBody(ctx.req), ctx)); return true; }
    const summary = path.match(/^\/api\/finance\/bank-reconciliation\/cashbook-entries\/([^/]+)\/summary$/);
    if (summary && ctx.req.method === "GET") { ctx.send(ctx.res, 200, await reconciliation.cashbookSummary(decode(summary[1]), ctx)); return true; }
    return false;
  } catch (error) { knownError(ctx, error); return true; }
}
