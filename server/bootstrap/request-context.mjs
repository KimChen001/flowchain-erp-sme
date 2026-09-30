import { readBody, send } from "../utils/http.mjs";

export function createRouteContext({
  req,
  res,
  url,
  db,
  repositories,
  identity,
  sessionStore,
  dataMode,
  runtime,
  domain,
  env = process.env,
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
    ...domain,
    ...runtime,
  };
}
