import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { DataImportError, assertDataImportType, createDataImportService, dataImportLimits } from "../domain/data-import-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { dataImportTemplateCsv } from "../../shared/data-import-columns.mjs";

// CSV import through the manual-entry commands:
//   GET  /api/data-import/templates/:type?language=en-US|zh-CN
//   POST /api/data-import/:type/preview   { fileName, contentBase64, sheetName?, encoding? }
//   POST /api/data-import/:type/commit    { fileSha256, chunkIndex, rows }
// The workspace is always the session's; nothing in the body chooses it.
// Universal Intake (/api/intake/*) and the retired /api/imports* stay as they are.

// The shared readBody has no size limit, so the body is read here with one,
// as the intake route does. A file arrives as base64, a third larger.
async function readBoundedJson(req, maximumBytes) {
  if (Object.prototype.hasOwnProperty.call(req, "__flowchainParsedBody")) return req.__flowchainParsedBody;
  const tooLarge = () => new DataImportError("DATA_IMPORT_REQUEST_TOO_LARGE", "The file is larger than the import limit.", 413, { limitBytes: maximumBytes });
  if (Number(req.headers?.["content-length"] || 0) > maximumBytes) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) throw tooLarge();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new DataImportError("DATA_IMPORT_JSON_INVALID", "The request body must be valid JSON.", 400);
  }
}

export async function handleDataImportRoute(ctx) {
  const { req, res, url, send } = ctx;
  if (!url.pathname.startsWith("/api/data-import")) return false;
  const env = ctx.env || process.env;
  try {
    if (!capabilityForEnvironment("data-import", env)?.enabled) {
      send(res, 409, { code: "DATA_IMPORT_NOT_ENABLED", message: "Data import is not enabled in this workspace." });
      return true;
    }
    const template = url.pathname.match(/^\/api\/data-import\/templates\/([^/]+)$/);
    if (template && req.method === "GET") {
      const type = assertDataImportType(decodeURIComponent(template[1]));
      const language = url.searchParams.get("language") === "zh-CN" ? "zh-CN" : "en-US";
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="flowchain-${type}-template${language === "zh-CN" ? "-zh-CN" : ""}.csv"`,
        "Cache-Control": "no-store",
      });
      res.end(dataImportTemplateCsv(type, language));
      return true;
    }
    const action = url.pathname.match(/^\/api\/data-import\/([^/]+)\/(preview|commit)$/);
    if (!action || req.method !== "POST") {
      send(res, 404, { code: "DATA_IMPORT_ROUTE_NOT_FOUND", message: "Data import route was not found." });
      return true;
    }
    const type = assertDataImportType(decodeURIComponent(action[1]));
    const limits = dataImportLimits(env);
    const body = await readBoundedJson(req, Math.ceil(limits.maxFileBytes / 3) * 4 + 256 * 1024);
    const prisma = ctx.dataImportPrisma || (await getPrismaClient(env));
    const service = createDataImportService({ prisma, env });
    const context = { identity: ctx.identity };
    send(res, 200, action[2] === "preview" ? await service.preview(type, body, context) : await service.commit(type, body, context));
    return true;
  } catch (error) {
    const known = error instanceof DataImportError || error instanceof PilotIdentityError || error?.name === "AuthorizationError";
    send(res, known ? error.status || 400 : 500, {
      code: known ? error.code : "DATA_IMPORT_FAILED",
      message: known ? error.message : "The import failed. Try again; rows already imported are skipped.",
      ...(known && error instanceof DataImportError && error.details ? { details: error.details } : {}),
      ...(known && error?.name === "AuthorizationError" ? { permission: error.details?.permissionCode } : {}),
    });
    return true;
  }
}
