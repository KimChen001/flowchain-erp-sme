import { randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { createCustomFieldService } from "../domain/custom-field-service.mjs";
import { INTAKE_LIMITS, IntakeError } from "../domain/intake-contracts.mjs";
import { PilotIdentityError, resolveProvisionedActor } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { createDbIntakeRepository } from "../repositories/db-intake-repository.mjs";

const decode = value => decodeURIComponent(value);

async function readBoundedJson(req) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (declared > INTAKE_LIMITS.maximumRequestBytes) throw new IntakeError("INTAKE_REQUEST_SIZE_LIMIT", "Request exceeds the supported size limit.", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > INTAKE_LIMITS.maximumRequestBytes) throw new IntakeError("INTAKE_REQUEST_SIZE_LIMIT", "Request exceeds the supported size limit.", 413);
    chunks.push(chunk);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new IntakeError("INTAKE_JSON_INVALID", "Request body must be valid JSON.", 400);
  }
}

function sendError(ctx, error) {
  if (error instanceof IntakeError || error instanceof PilotIdentityError || error?.name === "AuthorizationError") {
    ctx.send(ctx.res, error.status || 400, { code: error.code || "CUSTOM_FIELD_REQUEST_FAILED", message: error.message, ...(error.details ? { details: error.details } : {}) });
  } else if (error?.code === "P2002") {
    ctx.send(ctx.res, 409, { code: "CUSTOM_FIELD_CONFLICT", message: "A custom field with this stable key already exists." });
  } else {
    ctx.send(ctx.res, 500, { code: "CUSTOM_FIELD_REQUEST_FAILED", message: "The custom field request could not be completed." });
  }
}

export async function handleCustomFieldsRoute(ctx) {
  const path = ctx.url.pathname;
  if (path !== "/api/custom-fields" && !path.startsWith("/api/custom-fields/")) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  const capability = capabilityForEnvironment("universal-intake", ctx.env || process.env);
  if (!capability?.enabled) {
    ctx.send(ctx.res, 503, { code: "FLOWCHAIN_CAPABILITY_DISABLED", capability: "universal-intake", message: "Universal Intake is not enabled.", limitations: ["Custom fields are available only with the approved Universal Intake preview capability."] });
    return true;
  }
  try {
    const prisma = ctx.intakePrisma || await getPrismaClient(ctx.env || process.env);
    const actor = ctx.intakeActor || await resolveProvisionedActor(prisma, ctx.identity, { allowMissingTestActor: true });
    const repository = ctx.repositories?.intake || createDbIntakeRepository({ prisma, env: ctx.env || process.env });
    const service = ctx.customFieldService || createCustomFieldService({ repository });
    const context = { actor, requestId: String(ctx.req.headers?.["x-request-id"] || randomUUID()).slice(0, 128) };
    const permission = code => assertAuthorized({ actor, permission: code, tenantId: actor.tenantId });
    const readBody = () => ctx.intakeReadBody ? ctx.intakeReadBody(ctx.req) : readBoundedJson(ctx.req);

    if (path === "/api/custom-fields") {
      if (ctx.req.method === "GET") {
        permission("custom_field.read");
        ctx.send(ctx.res, 200, await service.list(Object.fromEntries(ctx.url.searchParams.entries()), context));
      } else if (ctx.req.method === "POST") {
        permission("custom_field.manage");
        ctx.send(ctx.res, 201, await service.create(await readBody(), context));
      } else return false;
      return true;
    }
    const match = path.match(/^\/api\/custom-fields\/([^/]+)(?:\/(revisions|publish|retire))?$/);
    if (!match) return false;
    const id = decode(match[1]);
    const action = match[2];
    if (ctx.req.method === "GET" && !action) {
      permission("custom_field.read");
      ctx.send(ctx.res, 200, await service.get(id, context));
    } else if (ctx.req.method === "POST" && action === "revisions") {
      permission("custom_field.manage");
      ctx.send(ctx.res, 201, await service.revise(id, await readBody(), context));
    } else if (ctx.req.method === "POST" && action === "publish") {
      permission("custom_field.publish");
      ctx.send(ctx.res, 200, await service.publish(id, await readBody(), context));
    } else if (ctx.req.method === "POST" && action === "retire") {
      permission("custom_field.publish");
      ctx.send(ctx.res, 200, await service.retire(id, context));
    } else return false;
    return true;
  } catch (error) {
    sendError(ctx, error);
    return true;
  }
}
