import {
  legacyMutationBlockedAuditEntry,
  recordDatabaseAuditBestEffort,
} from "../domain/audit-policy.mjs";
import { createEmptyDataset } from "../domain/data-mode.mjs";
import { resolveRequestIdentity } from "../domain/local-signed-session.mjs";
import {
  isDatabaseModeWriteBlocked,
  sendDatabaseModeMutationBlocked,
} from "../domain/route-classification.mjs";
import { createRepositoryRegistry, getPersistenceMode } from "../repositories/adapter-registry.mjs";
import { handleRuntimeCapabilityRoute } from "../routes/runtime-capability.routes.mjs";
import { send } from "../utils/http.mjs";
import { dispatchApiRoute } from "./route-dispatcher.mjs";
import { createRouteContext } from "./request-context.mjs";
import { handleRuntimeRoutes } from "./runtime-routes.mjs";
import { handleSessionRoutes } from "./session-routes.mjs";
import { sendStaticAsset } from "./static-assets.mjs";

export function createHttpRequestHandler({
  port,
  distDir,
  buildIdentity,
  localSessions,
  localSessionSecret,
  domain,
  runtime,
  env = process.env,
}) {
  return async function handleHttpRequest(req, res) {
    if (req.method === "OPTIONS") return send(res, 204, {});

    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const db = createEmptyDataset({ mode: "user" });
    const persistenceMode = getPersistenceMode(env);
    const dataMode = { mode: "user", readsDemoData: false };
    const repositories = createRepositoryRegistry({ db, env });
    const identity = resolveRequestIdentity(
      req,
      localSessions,
      localSessionSecret,
      env,
    );

    if (await handleRuntimeRoutes({ req, res, url, env, buildIdentity, dataMode, persistenceMode })) return;
    if (handleRuntimeCapabilityRoute({ req, res, url, send })) return;

    if (isDatabaseModeWriteBlocked({ persistenceMode, method: req.method, pathname: url.pathname })) {
      await recordDatabaseAuditBestEffort(
        { repositories },
        legacyMutationBlockedAuditEntry({ method: req.method, pathname: url.pathname }),
      );
      return sendDatabaseModeMutationBlocked(res, send);
    }

    if (await handleSessionRoutes({
      req,
      res,
      url,
      identity,
      localSessions,
      localSessionSecret,
      env,
    })) return;

    if (url.pathname.startsWith("/api/master-data") && !identity.authenticated)
      return send(res, 401, {
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to access tenant master data.",
      });

    const routeContext = createRouteContext({
      req,
      res,
      url,
      db,
      repositories,
      identity,
      localSessions,
      dataMode: dataMode.mode,
      runtime,
      domain,
      env,
    });

    if (await dispatchApiRoute(routeContext)) return;
    if (!url.pathname.startsWith("/api/"))
      return sendStaticAsset({ req, res, url, distDir });
    return send(res, 404, { error: "Not found" });
  };
}
