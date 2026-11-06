// Links in emails point at FLOWCHAIN_PUBLIC_BASE_URL, which production
// requires. Outside production they may fall back to the loopback origin the
// request came from, so a local link opens the local app.
const text = (value) => String(value ?? "").trim();
const isProduction = (env) => text(env.NODE_ENV).toLowerCase() === "production" || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === "production";
const isLoopbackOrigin = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
};

export function publicBaseUrl(env, req) {
  const configured = text(env.FLOWCHAIN_PUBLIC_BASE_URL).replace(/\/+$/, "");
  if (configured || isProduction(env)) return configured;
  return isLoopbackOrigin(req?.headers?.origin)
    || isLoopbackOrigin(`http://${req?.headers?.host || ""}`)
    || "http://localhost";
}
