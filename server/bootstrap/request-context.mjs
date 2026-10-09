import { readBody, send } from "../utils/http.mjs";

export function createRouteContext({
  req,
  res,
  url,
  db,
  repositories,
  identity,
  sessionStore,
  approvalNotifier = null,
  dataMode,
  runtime,
  domain,
  env = process.env,
  errorReporter = null,
}) {
  return {
    req,
    res,
    url,
    db,
    send,
    readBody,
    repositories,
    dataMode,
    env,
    identity,
    sessionStore,
    // A route that answers 500 itself calls this first, so the error is
    // logged with its stack and can raise an alert.
    reportError: (error) => errorReporter?.report(error, { req, status: 500, phase: "route" }),
    // Tells approvers a document is waiting (server/notifications).
    approvalNotifier,
    ...domain,
    ...runtime,
  };
}
