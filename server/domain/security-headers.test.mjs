import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScmServer } from "../bootstrap/scm-server.mjs";
import { withRequestLogging } from "../bootstrap/request-logging.mjs";
import { securityHeaders, withSecurityHeaders } from "../bootstrap/security-headers.mjs";
import { withServerErrorBoundary } from "../bootstrap/server-error-boundary.mjs";
import { sendStaticAsset } from "../bootstrap/static-assets.mjs";

// Pinned literally: a change to the policy must be a deliberate edit here.
const EXPECTED_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'";

const productionHttps = {
  NODE_ENV: "production",
  FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.example.com",
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port, method, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  const port = await listen(server);
  try {
    return await run(port);
  } finally {
    await close(server);
  }
}

function assertBrowserHeaders(response, label) {
  assert.equal(response.headers["content-security-policy"], EXPECTED_CSP, `${label}: CSP`);
  assert.equal(response.headers["x-content-type-options"], "nosniff", `${label}: nosniff`);
  assert.equal(response.headers["x-frame-options"], "DENY", `${label}: frame`);
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()", `${label}: permissions`);
  assert.equal(response.headers["cross-origin-opener-policy"], "same-origin", `${label}: COOP`);
}

test("the policy is exact and every header is sent outside production", () => {
  assert.deepEqual(securityHeaders({}), {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": EXPECTED_CSP,
  });
});

test("HSTS is sent only in production with an https public address", () => {
  const hsts = (env) => securityHeaders(env)["Strict-Transport-Security"];
  assert.equal(hsts({}), undefined);
  assert.equal(hsts({ NODE_ENV: "development", FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.example.com" }), undefined);
  assert.equal(hsts({ NODE_ENV: "production" }), undefined);
  assert.equal(hsts({ NODE_ENV: "production", FLOWCHAIN_PUBLIC_BASE_URL: "http://flowchain.example.com" }), undefined);
  assert.equal(hsts({ NODE_ENV: "production", FLOWCHAIN_PUBLIC_BASE_URL: "not a url" }), undefined);
  assert.equal(hsts(productionHttps), "max-age=31536000");
  // The release image's deployment profile counts as production too.
  assert.equal(hsts({ NODE_ENV: "development", FLOWCHAIN_DEPLOYMENT_PROFILE: "production", FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.example.com" }), "max-age=31536000");
});

test("FLOWCHAIN_CSP_MODE switches the policy to report-only or off, and anything else enforces", () => {
  const reportOnly = securityHeaders({ FLOWCHAIN_CSP_MODE: "report-only" });
  assert.equal(reportOnly["Content-Security-Policy"], undefined);
  assert.equal(reportOnly["Content-Security-Policy-Report-Only"], EXPECTED_CSP);
  assert.equal(securityHeaders({ FLOWCHAIN_CSP_MODE: " Report-Only " })["Content-Security-Policy-Report-Only"], EXPECTED_CSP);

  const off = securityHeaders({ FLOWCHAIN_CSP_MODE: "off" });
  assert.equal(off["Content-Security-Policy"], undefined);
  assert.equal(off["Content-Security-Policy-Report-Only"], undefined);
  // The other headers do not depend on the CSP mode.
  assert.equal(off["X-Content-Type-Options"], "nosniff");
  assert.equal(off["X-Frame-Options"], "DENY");

  for (const value of ["enforce", "", "disabled", "false"]) {
    const headers = securityHeaders({ FLOWCHAIN_CSP_MODE: value });
    assert.equal(headers["Content-Security-Policy"], EXPECTED_CSP, `mode ${JSON.stringify(value)}`);
    assert.equal(headers["Content-Security-Policy-Report-Only"], undefined);
  }
});

test("static responses keep their status, body and own headers, and /sign-in/confirm keeps no-referrer", async () => {
  const distDir = await mkdtemp(join(tmpdir(), "flowchain-security-headers-"));
  try {
    await mkdir(join(distDir, "assets"));
    await writeFile(join(distDir, "index.html"), "<!doctype html><title>FlowChain</title>");
    await writeFile(join(distDir, "assets", "app.js"), "console.log(1)");
    const serveStatic = (req, res) => sendStaticAsset({ req, res, url: new URL(req.url, "http://localhost"), distDir });
    const paths = ["/app/inventory", "/sign-in/confirm?token=abc", "/assets/app.js", "/assets/missing-chunk.js"];

    const plain = await withServer(serveStatic, (port) => Promise.all(paths.map((path) => request(port, "GET", path))));
    const secured = await withServer(withSecurityHeaders(serveStatic, { env: productionHttps }), (port) => Promise.all(paths.map((path) => request(port, "GET", path))));

    paths.forEach((path, index) => {
      assert.equal(secured[index].status, plain[index].status, path);
      assert.equal(secured[index].body, plain[index].body, path);
      for (const name of ["content-type", "cache-control"]) assert.equal(secured[index].headers[name], plain[index].headers[name], `${path}: ${name}`);
      assertBrowserHeaders(secured[index], path);
      assert.equal(secured[index].headers["strict-transport-security"], "max-age=31536000", path);
    });
    const [shell, confirm, asset, missing] = secured;
    assert.equal(shell.status, 200);
    assert.match(shell.headers["content-type"], /^text\/html/);
    assert.equal(shell.headers["referrer-policy"], "strict-origin-when-cross-origin");
    // The route's own header wins over the default.
    assert.equal(confirm.status, 200);
    assert.equal(confirm.headers["referrer-policy"], "no-referrer");
    assert.equal(asset.status, 200);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.headers["content-type"], /^text\/html/);
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }
});

test("a 500 from the error boundary carries the headers and an unchanged body", async () => {
  const failing = async () => {
    throw Object.assign(new Error("boom"), { code: "TEST_FAILURE" });
  };
  const logger = { error() {}, info() {}, warn() {} };
  const compose = (secure) => withRequestLogging(
    secure
      ? withSecurityHeaders(withServerErrorBoundary(failing, { logger }), { env: {} })
      : withServerErrorBoundary(failing, { logger }),
    { idFactory: () => "request-id-fixed" },
  );
  const plain = await withServer(compose(false), (port) => request(port, "POST", "/api/fails"));
  const secured = await withServer(compose(true), (port) => request(port, "POST", "/api/fails"));
  assert.equal(secured.status, 500);
  assert.equal(secured.status, plain.status);
  assert.equal(secured.body, plain.body);
  assert.equal(secured.headers["content-type"], plain.headers["content-type"]);
  assert.equal(secured.headers["access-control-allow-origin"], "*");
  assert.equal(secured.headers["x-request-id"], "request-id-fixed");
  assertBrowserHeaders(secured, "500");
  assert.equal(secured.headers["strict-transport-security"], undefined);
});

test("the server sends the headers on API JSON, preflight and health answers without changing them", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:5432/flowchain_security_headers";
  const server = createScmServer();
  try {
    const port = await listen(server);
    const session = await request(port, "GET", "/api/auth/me");
    const preflight = await request(port, "OPTIONS", "/api/anything");
    const health = await request(port, "GET", "/api/health");

    assert.equal(session.status, 401);
    assert.deepEqual(JSON.parse(session.body), {
      code: "INVALID_SESSION",
      error: "invalid or expired workspace session token",
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).live, true);
    for (const [label, response] of Object.entries({ session, preflight, health })) {
      assertBrowserHeaders(response, label);
      assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin", label);
      assert.match(response.headers["x-request-id"], /^[A-Za-z0-9._:-]{8,128}$/, label);
    }
  } finally {
    await close(server);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
