import { readBody, send } from "../utils/http.mjs";

export function createRouteContext({
  req,
  res,
  url,
  db,
  repositories,
  identity,
  localSessions,
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
    localSessions,
    ...domain,
    ...runtime,
  };
}
