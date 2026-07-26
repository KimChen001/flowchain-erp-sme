import { randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { INTAKE_LIMITS, IntakeError } from "../domain/intake-contracts.mjs";
import { createIntakeServices } from "../domain/intake-services.mjs";
import { PilotIdentityError, resolveProvisionedActor } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { createDbIntakeRepository } from "../repositories/db-intake-repository.mjs";
import { createArtifactStorageFromEnv } from "../storage/artifact-storage.mjs";

const query = url => Object.fromEntries(url.searchParams.entries());
const decode = value => decodeURIComponent(value);

async function readBoundedJson(req) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (declared > INTAKE_LIMITS.maximumRequestBytes) throw new IntakeError("INTAKE_REQUEST_SIZE_LIMIT", "Intake request exceeds the supported size limit.", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > INTAKE_LIMITS.maximumRequestBytes) throw new IntakeError("INTAKE_REQUEST_SIZE_LIMIT", "Intake request exceeds the supported size limit.", 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new IntakeError("INTAKE_JSON_INVALID", "Request body must be valid JSON.", 400);
  }
}

function sendError(ctx, error) {
  if (error instanceof IntakeError || error instanceof PilotIdentityError || error?.name === "AuthorizationError") {
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || "INTAKE_REQUEST_FAILED",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  if (error?.code === "P2002") {
    ctx.send(ctx.res, 409, { code: "INTAKE_CONFLICT", message: "An Intake resource with the same tenant key already exists." });
    return;
  }
  ctx.send(ctx.res, 500, { code: "INTAKE_REQUEST_FAILED", message: "The Intake request could not be completed." });
}

function requestContext(ctx, actor) {
  return {
    actor,
    requestId: String(ctx.req.headers?.["x-request-id"] || randomUUID()).trim().slice(0, 128),
  };
}

async function resources(ctx) {
  if (ctx.intakeActor && ctx.intakeServices) return { actor: ctx.intakeActor, services: ctx.intakeServices };
  const prisma = ctx.intakePrisma || await getPrismaClient(ctx.env || process.env);
  const actor = await resolveProvisionedActor(prisma, ctx.identity, { allowMissingTestActor: true });
  const repository = ctx.repositories?.intake || createDbIntakeRepository({ prisma, env: ctx.env || process.env });
  const storage = ctx.intakeArtifactStorage ?? createArtifactStorageFromEnv(ctx.env || process.env);
  return { actor, services: createIntakeServices({ repository, storage }) };
}

function permission(actor, code) {
  assertAuthorized({ actor, permission: code, tenantId: actor.tenantId });
}

function enabled(ctx) {
  return capabilityForEnvironment("universal-intake", ctx.env || process.env);
}

export async function handleIntakeRoute(ctx) {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/intake/")) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  const capability = enabled(ctx);
  if (!capability?.enabled) {
    ctx.send(ctx.res, 503, {
      code: "FLOWCHAIN_CAPABILITY_DISABLED",
      capability: "universal-intake",
      message: "Universal Intake is a preview capability and is not enabled for this runtime.",
      limitations: ["Set FLOWCHAIN_ENABLE_UNIVERSAL_INTAKE=true only in an approved preview environment."],
    });
    return true;
  }

  try {
    const { actor, services } = await resources(ctx);
    const context = requestContext(ctx, actor);
    const readBody = () => ctx.intakeReadBody ? ctx.intakeReadBody(ctx.req) : readBoundedJson(ctx.req);

    if (path === "/api/intake/artifacts") {
      if (ctx.req.method === "GET") {
        permission(actor, "intake.artifact.read");
        ctx.send(ctx.res, 200, await services.artifacts.list(query(ctx.url), context));
      } else if (ctx.req.method === "POST") {
        permission(actor, "intake.artifact.create");
        ctx.send(ctx.res, 201, await services.artifacts.register(await readBody(), context));
      } else return false;
      return true;
    }
    const artifact = path.match(/^\/api\/intake\/artifacts\/([^/]+)$/);
    if (artifact && ctx.req.method === "GET") {
      permission(actor, "intake.artifact.read");
      ctx.send(ctx.res, 200, await services.artifacts.get(decode(artifact[1]), context));
      return true;
    }

    if (path === "/api/intake/batches") {
      if (ctx.req.method === "GET") {
        permission(actor, "intake.batch.read");
        ctx.send(ctx.res, 200, await services.batches.list(query(ctx.url), context));
      } else if (ctx.req.method === "POST") {
        permission(actor, "intake.batch.create");
        ctx.send(ctx.res, 201, await services.batches.create(await readBody(), context));
      } else return false;
      return true;
    }
    const batchIssues = path.match(/^\/api\/intake\/batches\/([^/]+)\/issues$/);
    if (batchIssues && ctx.req.method === "GET") {
      permission(actor, "intake.batch.read");
      ctx.send(ctx.res, 200, await services.issues.list(decode(batchIssues[1]), query(ctx.url), context));
      return true;
    }
    const batchRecords = path.match(/^\/api\/intake\/batches\/([^/]+)\/records$/);
    if (batchRecords) {
      if (ctx.req.method === "GET") {
        permission(actor, "intake.batch.read");
        ctx.send(ctx.res, 200, await services.batches.listRecords(decode(batchRecords[1]), query(ctx.url), context));
      } else if (ctx.req.method === "POST") {
        permission(actor, "intake.batch.create");
        ctx.send(ctx.res, 201, await services.batches.addRecords(decode(batchRecords[1]), await readBody(), context));
      } else return false;
      return true;
    }
    const batchReview = path.match(/^\/api\/intake\/batches\/([^/]+)\/reviews$/);
    if (batchReview && ctx.req.method === "POST") {
      permission(actor, "intake.review");
      ctx.send(ctx.res, 201, await services.reviews.open(decode(batchReview[1]), await readBody(), context));
      return true;
    }
    const batchCommit = path.match(/^\/api\/intake\/batches\/([^/]+)\/commit$/);
    if (batchCommit && ctx.req.method === "POST") {
      permission(actor, "intake.commit");
      const body = await readBody();
      const result = await services.commits.attempt(decode(batchCommit[1]), {
        ...body,
        idempotencyKey: String(ctx.req.headers?.["idempotency-key"] || body.idempotencyKey || "").trim(),
      }, context);
      ctx.send(ctx.res, 501, result);
      return true;
    }
    const batchCancel = path.match(/^\/api\/intake\/batches\/([^/]+)\/cancel$/);
    if (batchCancel && ctx.req.method === "POST") {
      permission(actor, "intake.batch.cancel");
      ctx.send(ctx.res, 200, await services.batches.cancel(decode(batchCancel[1]), await readBody(), context));
      return true;
    }
    const batchTransition = path.match(/^\/api\/intake\/batches\/([^/]+)\/transitions$/);
    if (batchTransition && ctx.req.method === "POST") {
      permission(actor, "intake.batch.create");
      const body = await readBody();
      ctx.send(ctx.res, 200, await services.batches.transition(decode(batchTransition[1]), String(body.to || ""), body, context));
      return true;
    }
    const batch = path.match(/^\/api\/intake\/batches\/([^/]+)$/);
    if (batch && ctx.req.method === "GET") {
      permission(actor, "intake.batch.read");
      ctx.send(ctx.res, 200, await services.batches.get(decode(batch[1]), context));
      return true;
    }

    if (path === "/api/intake/mapping-profiles") {
      if (ctx.req.method === "GET") {
        permission(actor, "intake.batch.read");
        ctx.send(ctx.res, 200, await services.mappings.list(query(ctx.url), context));
      } else if (ctx.req.method === "POST") {
        permission(actor, "intake.mapping.manage");
        ctx.send(ctx.res, 201, await services.mappings.create(await readBody(), context));
      } else return false;
      return true;
    }
    const mapping = path.match(/^\/api\/intake\/mapping-profiles\/([^/]+)(?:\/(activate|retire))?$/);
    if (mapping) {
      const id = decode(mapping[1]);
      const action = mapping[2];
      if (ctx.req.method === "GET" && !action) {
        permission(actor, "intake.batch.read");
        ctx.send(ctx.res, 200, await services.mappings.get(id, context));
      } else if (ctx.req.method === "POST" && action === "activate") {
        permission(actor, "intake.mapping.manage");
        ctx.send(ctx.res, 200, await services.mappings.activate(id, context));
      } else if (ctx.req.method === "POST" && action === "retire") {
        permission(actor, "intake.mapping.manage");
        ctx.send(ctx.res, 200, await services.mappings.retire(id, context));
      } else return false;
      return true;
    }

    const issue = path.match(/^\/api\/intake\/issues\/([^/]+)\/resolve$/);
    if (issue && ctx.req.method === "POST") {
      permission(actor, "intake.review");
      ctx.send(ctx.res, 200, await services.issues.resolve(decode(issue[1]), context));
      return true;
    }
    const review = path.match(/^\/api\/intake\/reviews\/([^/]+)\/(approve|reject)$/);
    if (review && ctx.req.method === "POST") {
      permission(actor, "intake.review");
      const decision = review[2] === "approve" ? "approved" : "rejected";
      ctx.send(ctx.res, 200, await services.reviews.decide(decode(review[1]), decision, await readBody(), context));
      return true;
    }
    return false;
  } catch (error) {
    sendError(ctx, error);
    return true;
  }
}
