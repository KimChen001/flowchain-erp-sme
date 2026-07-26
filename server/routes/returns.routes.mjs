import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import {
  createReturnGovernanceCommandService,
  ReturnGovernanceError,
} from "../domain/return-governance-command-service.mjs";
import {
  createReturnGovernanceReadService,
  ReturnGovernanceReadError,
} from "../domain/return-governance-read-service.mjs";
import {
  createSupplierReturnCommandService,
  SupplierReturnCommandError,
} from "../domain/supplier-return-command-service.mjs";
import {
  createSupplierReturnReadService,
  SupplierReturnReadError,
} from "../domain/supplier-return-read-service.mjs";
import {
  createCustomerReturnCommandService,
  CustomerReturnCommandError,
} from "../domain/customer-return-command-service.mjs";
import { createCustomerReturnReadService } from "../domain/customer-return-read-service.mjs";
import {
  createQuarantineReleaseCommandService,
  QuarantineReleaseCommandError,
} from "../domain/quarantine-release-command-service.mjs";
import { createQuarantineReleaseReadService } from "../domain/quarantine-release-read-service.mjs";
import { PilotIdentityError } from "../domain/pilot-identity.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

const query = (url) => Object.fromEntries(url.searchParams.entries());
const capabilityIds = [
  "return-request",
  "return-authorization",
  "return-posting",
];
const capabilities = (env) =>
  Object.fromEntries(
    capabilityIds.map((id) => [id, capabilityForEnvironment(id, env)]),
  );

function unavailable(ctx, capabilityId) {
  ctx.send(ctx.res, 409, {
    code: "RETURN_GOVERNANCE_CAPABILITY_NOT_AVAILABLE",
    message:
      "Return governance requires database persistence and explicit enablement.",
    details: { capability: capabilityId },
  });
}

function knownError(ctx, error) {
  if (
    error instanceof ReturnGovernanceError ||
    error instanceof ReturnGovernanceReadError ||
    error instanceof SupplierReturnCommandError ||
    error instanceof SupplierReturnReadError ||
    error instanceof CustomerReturnCommandError ||
    error instanceof QuarantineReleaseCommandError ||
    error instanceof PilotIdentityError ||
    error?.name === "AuthorizationError"
  ) {
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || "RETURN_GOVERNANCE_FAILED",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  ctx.send(ctx.res, 500, {
    code: "RETURN_GOVERNANCE_FAILED",
    message: "Return governance could not be completed.",
  });
}

function ensureDatabaseAndIdentity(ctx) {
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
  if (capabilityForEnvironment(id, ctx.env || process.env)?.enabled)
    return true;
  unavailable(ctx, id);
  return false;
}

async function services(ctx) {
  const env = ctx.env || process.env;
  const prisma =
    ctx.returnGovernancePrisma ||
    ctx.inventoryOperationsPrisma ||
    (await getPrismaClient(env));
  return {
    prisma,
    read:
      ctx.returnGovernanceReadService ||
      createReturnGovernanceReadService({
        prisma,
        capabilities: capabilities(env),
      }),
    command:
      ctx.returnGovernanceCommandService ||
      createReturnGovernanceCommandService({ prisma, env }),
    postingRead:
      ctx.supplierReturnReadService ||
      createSupplierReturnReadService({
        prisma,
        capability: capabilityForEnvironment("return-posting", env),
      }),
    postingCommand:
      ctx.supplierReturnCommandService ||
      createSupplierReturnCommandService({ prisma, env }),
    customerPostingRead:
      ctx.customerReturnReadService ||
      createCustomerReturnReadService({
        prisma,
        capability: capabilityForEnvironment("return-posting", env),
      }),
    customerPostingCommand:
      ctx.customerReturnCommandService ||
      createCustomerReturnCommandService({ prisma, env }),
    releasePostingRead:
      ctx.quarantineReleaseReadService ||
      createQuarantineReleaseReadService({
        prisma,
        capability: capabilityForEnvironment("return-posting", env),
      }),
    releasePostingCommand:
      ctx.quarantineReleaseCommandService ||
      createQuarantineReleaseCommandService({ prisma, env }),
  };
}

export async function handleReturnsRoute(ctx) {
  const path = ctx.url.pathname;
  if (
    path !== "/api/returns/entry-data" &&
    !path.startsWith("/api/returns/requests") &&
    !path.startsWith("/api/returns/authorizations") &&
    !path.startsWith("/api/returns/postings")
  )
    return false;
  if (!ensureDatabaseAndIdentity(ctx)) return true;
  try {
    const {
      prisma,
      read,
      command,
      postingRead,
      postingCommand,
      customerPostingRead,
      customerPostingCommand,
      releasePostingRead,
      releasePostingCommand,
    } = await services(ctx);
    if (ctx.req.method === "GET" && path === "/api/returns/requests") {
      ctx.send(ctx.res, 200, await read.listRequests(query(ctx.url), ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/returns/entry-data") {
      ctx.send(ctx.res, 200, await read.entryData(ctx));
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/returns/authorizations") {
      ctx.send(
        ctx.res,
        200,
        await read.listAuthorizations(query(ctx.url), ctx),
      );
      return true;
    }
    if (ctx.req.method === "GET" && path === "/api/returns/postings") {
      ctx.send(ctx.res, 200, await read.listPostings(query(ctx.url), ctx));
      return true;
    }
    if (
      ctx.req.method === "POST" &&
      path === "/api/returns/requests/preview"
    ) {
      if (!ensureCapability(ctx, "return-request")) return true;
      ctx.send(
        ctx.res,
        200,
        await read.previewRequest(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }
    if (ctx.req.method === "POST" && path === "/api/returns/requests") {
      if (!ensureCapability(ctx, "return-request")) return true;
      ctx.send(
        ctx.res,
        201,
        await command.createRequest(await ctx.readBody(ctx.req), ctx),
      );
      return true;
    }

    const requestMatch = path.match(
      /^\/api\/returns\/requests\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (requestMatch) {
      const requestId = decodeURIComponent(requestMatch[1]);
      const action = requestMatch[2] || "";
      if (
        ctx.req.method === "GET" &&
        (!action || action === "workbench")
      ) {
        ctx.send(
          ctx.res,
          200,
          await read.requestWorkbench(requestId, ctx),
        );
        return true;
      }
      const body = await ctx.readBody(ctx.req);
      if (ctx.req.method === "PATCH" && !action) {
        if (!ensureCapability(ctx, "return-request")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.reviseRequest(requestId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "submit-preview") {
        if (!ensureCapability(ctx, "return-request")) return true;
        ctx.send(ctx.res, 200, await read.previewSubmit(requestId, ctx));
        return true;
      }
      if (ctx.req.method === "POST" && action === "submit") {
        if (!ensureCapability(ctx, "return-request")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.submitRequest(requestId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "cancel-preview") {
        if (!ensureCapability(ctx, "return-request")) return true;
        ctx.send(
          ctx.res,
          200,
          await read.previewCancel(requestId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "cancel") {
        if (!ensureCapability(ctx, "return-request")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.cancelRequest(requestId, body, ctx),
        );
        return true;
      }
      if (
        ctx.req.method === "POST" &&
        action === "authorization-preview"
      ) {
        if (!ensureCapability(ctx, "return-authorization")) return true;
        ctx.send(
          ctx.res,
          200,
          await read.previewAuthorization(requestId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "authorize") {
        if (!ensureCapability(ctx, "return-authorization")) return true;
        ctx.send(
          ctx.res,
          201,
          await command.authorizeRequest(requestId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "reject") {
        if (!ensureCapability(ctx, "return-authorization")) return true;
        ctx.send(
          ctx.res,
          201,
          await command.rejectRequest(requestId, body, ctx),
        );
        return true;
      }
    }

    const authorizationPostingMatch = path.match(
      /^\/api\/returns\/authorizations\/([^/]+)\/postings(?:\/(preview))?$/,
    );
    if (authorizationPostingMatch) {
      const authorizationId = decodeURIComponent(
        authorizationPostingMatch[1],
      );
      const action = authorizationPostingMatch[2] || "";
      const body = await ctx.readBody(ctx.req);
      const authorizationType = await prisma.returnAuthorization.findFirst({
        where: {
          id: authorizationId,
          tenantId: ctx.identity.tenantId,
        },
        select: {
          returnRequest: { select: { returnType: true } },
          lines: { select: { dispositionRoute: true } },
        },
      });
      const release =
        authorizationType?.lines?.length > 0 &&
        authorizationType.lines.every(
          (line) =>
            line.dispositionRoute ===
            "release_quarantine_to_available",
        );
      const customer =
        authorizationType?.returnRequest?.returnType === "customer_return";
      const selectedDraftRead = release
        ? releasePostingRead
        : customer
          ? customerPostingRead
          : postingRead;
      if (ctx.req.method === "POST" && action === "preview") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await selectedDraftRead.previewDraft(
            authorizationId,
            body,
            ctx,
          ),
        );
        return true;
      }
      if (ctx.req.method === "POST" && !action) {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          201,
          await (release
            ? releasePostingCommand.createDraft(
                { ...body, authorizationId },
                ctx,
              )
            : customer
            ? customerPostingCommand.createDraft(
                { ...body, authorizationId },
                ctx,
              )
            : postingCommand.createPostingDraft(
                { ...body, authorizationId },
                ctx,
              )),
        );
        return true;
      }
    }

    const authorizationMatch = path.match(
      /^\/api\/returns\/authorizations\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (authorizationMatch) {
      const authorizationId = decodeURIComponent(authorizationMatch[1]);
      const action = authorizationMatch[2] || "";
      if (
        ctx.req.method === "GET" &&
        (!action || action === "workbench")
      ) {
        ctx.send(
          ctx.res,
          200,
          await read.authorizationWorkbench(authorizationId, ctx),
        );
        return true;
      }
      const body = await ctx.readBody(ctx.req);
      if (ctx.req.method === "POST" && action === "cancel") {
        if (!ensureCapability(ctx, "return-authorization")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.cancelAuthorization(authorizationId, body, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "expire") {
        if (!ensureCapability(ctx, "return-authorization")) return true;
        ctx.send(
          ctx.res,
          200,
          await command.expireAuthorization(authorizationId, body, ctx),
        );
        return true;
      }
    }

    const postingMatch = path.match(
      /^\/api\/returns\/postings\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (postingMatch) {
      const postingId = decodeURIComponent(postingMatch[1]);
      const action = postingMatch[2] || "";
      const postingType = await prisma.returnPostingDocument.findFirst({
        where: { id: postingId, tenantId: ctx.identity.tenantId },
        select: { postingType: true },
      });
      const customer =
        postingType?.postingType === "customer_return_receipt";
      const release = postingType?.postingType === "quarantine_release";
      const selectedRead = release
        ? releasePostingRead
        : customer
          ? customerPostingRead
          : postingRead;
      if (
        ctx.req.method === "GET" &&
        (!action || action === "workbench")
      ) {
        ctx.send(
          ctx.res,
          200,
          await postingRead.postingWorkbench(postingId, ctx),
        );
        return true;
      }
      const body = await ctx.readBody(ctx.req);
      if (ctx.req.method === "PATCH" && !action) {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await (release
            ? releasePostingCommand.reviseDraft(postingId, body, ctx)
            : customer
            ? customerPostingCommand.reviseDraft(postingId, body, ctx)
            : postingCommand.revisePostingDraft(postingId, body, ctx)),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "ready-preview") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await selectedRead.previewReady(postingId, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "ready") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await (release
            ? releasePostingCommand.readyPosting(postingId, body, ctx)
            : customer
            ? customerPostingCommand.readyPosting(postingId, body, ctx)
            : postingCommand.readyPosting(postingId, body, ctx)),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "cancel") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await (release
            ? releasePostingCommand.cancelPosting(postingId, body, ctx)
            : customer
            ? customerPostingCommand.cancelPosting(postingId, body, ctx)
            : postingCommand.cancelPosting(postingId, body, ctx)),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "post-preview") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await selectedRead.previewPost(postingId, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "post") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await (release
            ? releasePostingCommand.postRelease(postingId, body, ctx)
            : customer
            ? customerPostingCommand.postReceipt(postingId, body, ctx)
            : postingCommand.postSupplierReturn(postingId, body, ctx)),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "reverse-preview") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await selectedRead.previewReverse(postingId, ctx),
        );
        return true;
      }
      if (ctx.req.method === "POST" && action === "reverse") {
        if (!ensureCapability(ctx, "return-posting")) return true;
        ctx.send(
          ctx.res,
          200,
          await (release
            ? releasePostingCommand.reverseRelease(postingId, body, ctx)
            : customer
            ? customerPostingCommand.reverseReceipt(postingId, body, ctx)
            : postingCommand.reverseSupplierReturn(postingId, body, ctx)),
        );
        return true;
      }
    }
    ctx.send(ctx.res, 405, {
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed.",
    });
  } catch (error) {
    knownError(ctx, error);
  }
  return true;
}
