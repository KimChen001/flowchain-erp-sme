import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleSessionRoutes } from "../bootstrap/session-routes.mjs";
import { validateProductionRuntimeConfig } from "../config/production-runtime-config.mjs";
import { directEmailLoginEnabled } from "./local-development-contract.mjs";

const localDatabase = "postgresql://user:pass@127.0.0.1:5432/flowchain";

async function postLogin(env) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ email: "admin@example.com" }))]), { method: "POST", headers: {} });
  const response = { status: 0, body: "" };
  const res = { writeHead: (status) => { response.status = status; }, end: (body) => { response.body = String(body || ""); } };
  // A store that fails the test if the refused route ever reaches it.
  const sessionStore = { create: async () => { throw new Error("refused login must not create a session"); } };
  const handled = await handleSessionRoutes({ req, res, url: new URL("http://local/api/auth/login"), identity: { authenticated: false }, sessionStore, emailLinks: {}, localSessionSecret: "secret", env });
  assert.equal(handled, true);
  return { status: response.status, body: JSON.parse(response.body) };
}

test("the legacy email-only sign-in exists only in local development and test mode", () => {
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "test" }), true);
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "development", FLOWCHAIN_DEV_LOCAL: "true", DATABASE_URL: localDatabase }), true);
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "production" }), false);
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "production", FLOWCHAIN_DEV_LOCAL: "true", DATABASE_URL: localDatabase }), false);
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "development" }), false);
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "development", FLOWCHAIN_DEV_LOCAL: "true", DATABASE_URL: "postgresql://user:pass@db.example.com/flowchain" }), false);
  assert.equal(directEmailLoginEnabled({}), false);
  assert.equal(directEmailLoginEnabled({ NODE_ENV: "test", FLOWCHAIN_DEPLOYMENT_PROFILE: "production" }), false);
});

test("outside local development and tests POST /api/auth/login is refused with 404 before any sign-in work", async () => {
  for (const env of [
    { NODE_ENV: "production", FLOWCHAIN_DEFAULT_TENANT_ID: "tenant" },
    { NODE_ENV: "development", FLOWCHAIN_DEFAULT_TENANT_ID: "tenant" },
    { NODE_ENV: "development", FLOWCHAIN_DEV_LOCAL: "true", DATABASE_URL: "postgresql://user:pass@db.example.com/flowchain", FLOWCHAIN_DEFAULT_TENANT_ID: "tenant" },
    { FLOWCHAIN_DEFAULT_TENANT_ID: "tenant" },
  ]) {
    const refused = await postLogin(env);
    assert.equal(refused.status, 404, JSON.stringify(env));
    assert.deepEqual(refused.body, { error: "Not found" });
  }
});

test("production config validation fails when the local-development or test switch is on", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://runtime-user:runtime-password@database.invalid/flowchain",
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: "tenant-production-runtime",
    FLOWCHAIN_LOCAL_SESSION_SECRET: "production-session-secret-at-least-32-characters",
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: "/var/lib/flowchain/uploads",
    FLOWCHAIN_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    FLOWCHAIN_MAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_validation_only_key",
    FLOWCHAIN_MAIL_FROM: "sign-in@flowchain.example",
    FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.example",
  };
  const issues = (overrides) => {
    try {
      validateProductionRuntimeConfig({ ...production, ...overrides });
      return [];
    } catch (error) {
      return error.issues.map((entry) => `${entry.key}:${entry.code}`);
    }
  };
  assert.deepEqual(issues({}).filter((entry) => !entry.startsWith("FLOWCHAIN_UPLOAD_STORAGE_DIR")), []);
  assert.ok(issues({ FLOWCHAIN_DEV_LOCAL: "true" }).includes("FLOWCHAIN_DEV_LOCAL:local_development_forbidden"));
  assert.ok(issues({ FLOWCHAIN_DEPLOYMENT_PROFILE: "production", NODE_ENV: "test" }).includes("NODE_ENV:test_mode_forbidden"));
});
