import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";
import { productionHarnessMailEnv, signInThroughEmailLink } from "./test-support/production-harness.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const tenantId = "tenant-workspace-settings-api";
const email = "settings-admin@flowchain.invalid";
const userId = `USR-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const viewerEmail = "settings-viewer@flowchain.invalid";

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
const waitFor = async url => {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("Settings API server did not become ready.");
};
const startApi = env => {
  const child = spawn(node, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { if (/error|failed|exception/i.test(String(chunk))) process.stderr.write(String(chunk)); });
  child.stderr.on("data", chunk => process.stderr.write(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")));
  return child;
};
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
};
async function raw(base, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  return { status: response.status, payload };
}
async function request(base, path, options) {
  const result = await raw(base, path, options);
  assert.ok(result.status >= 200 && result.status < 300, `${options?.method || "GET"} ${path}: ${result.status} ${JSON.stringify(result.payload)}`);
  return result.payload;
}

const pgPort = await freePort();
const apiPort = await freePort();
const password = `settings-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-settings-api-"));
const database = "flowchain_workspace_settings_api";
const url = `postgresql://flowchain_settings:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`;
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_settings", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;
let server;

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  const env = {
    ...process.env,
    DATABASE_URL: url,
    DATABASE_URL_TEST: url,
    FLOWCHAIN_PERSISTENCE_MODE: "database",
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: "false",
    FLOWCHAIN_LOCAL_SESSION_SECRET: `settings-api-${randomUUID()}-secure-secret`,
    FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
    FLOWCHAIN_UPLOAD_STORAGE_DIR: join(directory, "attachments"),
    FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
    FLOWCHAIN_COMMIT_SHA: "workspace-settings-api-smoke",
    FLOWCHAIN_BRANCH: "test/workspace-settings-api-smoke",
    FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "false",
    SCM_API_PORT: String(apiPort),
    ...productionHarnessMailEnv(),
    NODE_ENV: "production",
  };
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 10 * 1024 * 1024 });
  prisma = await createPrismaClient(env);
  await prisma.tenant.create({ data: { id: tenantId, name: "Settings Workspace", legalName: "Settings Company" } });
  await prisma.user.create({ data: { id: userId, tenantId, email, name: "Settings Admin", role: "admin", status: "active" } });
  await prisma.user.create({ data: { id: "USR-settings-viewer", tenantId, email: viewerEmail, name: "Settings Viewer", role: "viewer", status: "active" } });
  server = startApi(env);
  const base = `http://127.0.0.1:${apiPort}`;
  await waitFor(`${base}/api/health`);
  const login = await signInThroughEmailLink(base, prisma, { tenantId, email });
  let token = login.token;

  let workspace = await request(base, "/api/workspace", { token });
  assert.equal(workspace.defaultLanguage, "en-US");
  assert.equal(workspace.locale, "en-US");
  assert.equal(workspace.timezone, "America/New_York");
  assert.equal(workspace.baseCurrency, "USD");
  assert.equal(workspace.countryCode, "US");
  workspace = await request(base, "/api/workspace", {
    token, method: "PATCH", body: { ...workspace, companyName: "FlowChain Operations", workspaceName: "Operations Workspace", defaultLanguage: "en-US", locale: "zh-CN", timezone: "America/Chicago", baseCurrency: "CNY" },
  });
  assert.equal(workspace.defaultLanguage, "en-US");
  assert.equal(workspace.locale, "zh-CN");
  assert.equal(workspace.timezone, "America/Chicago");
  assert.equal(workspace.baseCurrency, "CNY");
  assert.equal((await request(base, "/api/me/localization", { token })).effectiveLanguage, "en-US");

  let profile = await request(base, "/api/me/profile", { token });
  profile = await request(base, "/api/me/profile", { token, method: "PATCH", body: { ...profile, languagePreference: "zh-CN" } });
  assert.equal(profile.languagePreference, "zh-CN");
  assert.equal((await request(base, "/api/me/localization", { token })).effectiveLanguage, "zh-CN");
  profile = await request(base, "/api/me/profile", { token, method: "PATCH", body: { ...profile, languagePreference: null } });
  assert.equal(profile.languagePreference, null);
  const followed = await request(base, "/api/me/localization", { token });
  assert.equal(followed.effectiveLanguage, "en-US");
  assert.equal(followed.locale, "zh-CN");
  assert.equal(followed.timezone, "America/Chicago");

  const settings = await request(base, "/api/settings-runtime", { token });
  for (const name of ["Return Request", "Return Authorization", "Return Posting", "Supplier Invoice", "Customer Invoice", "Credit Memo / Credit Note"]) {
    assert.ok(settings.numbering.rules.some(rule => rule.document === name), `missing numbering rule ${name}`);
  }
  for (const name of ["Return Authorization", "Supplier Invoice Match Exception", "Payable Approval", "Customer Credit Note Approval"]) {
    assert.ok(settings.review.policies.some(policy => policy.name === name), `missing review policy ${name}`);
  }
  const numbering = { ...settings.numbering, rules: settings.numbering.rules.map(rule => rule.id === "NUM-RR" ? { ...rule, prefix: "RTR" } : rule) };
  await request(base, "/api/settings-runtime/numbering", { token, method: "PATCH", body: { settings: numbering } });
  assert.equal((await prisma.tenant.findUnique({ where: { id: tenantId } })).operationalSettings.numbering.rules.find(rule => rule.id === "NUM-RR").prefix, "RTR");

  // Document settings: saved by whoever manages the workspace, refused over a limit and without that permission.
  const documents = { ...settings.documents, letterhead: { ...settings.documents.letterhead, addressLines: ["12 Pier Road", "Oakland, CA 94607"] }, purchaseOrder: { ...settings.documents.purchaseOrder, termsText: "Net 30 from invoice." } };
  await request(base, "/api/settings-runtime/documents", { token, method: "PATCH", body: { settings: documents } });
  assert.equal((await prisma.tenant.findUnique({ where: { id: tenantId } })).operationalSettings.documents.purchaseOrder.termsText, "Net 30 from invoice.");
  const tooLong = await raw(base, "/api/settings-runtime/documents", { token, method: "PATCH", body: { settings: { ...documents, purchaseOrder: { ...documents.purchaseOrder, footerText: "x".repeat(501) } } } });
  assert.deepEqual([tooLong.status, tooLong.payload.code], [400, "DOCUMENT_SETTING_TOO_LONG"]);
  const viewerToken = (await signInThroughEmailLink(base, prisma, { tenantId, email: viewerEmail })).token;
  const denied = await raw(base, "/api/settings-runtime/documents", { token: viewerToken, method: "PATCH", body: { settings: documents } });
  assert.equal(denied.status, 403);
  assert.equal((await request(base, "/api/settings-runtime", { token: viewerToken })).documents.letterhead.addressLines[0], "12 Pier Road");

  // Print layouts are the workspace's: saved with the section, unknown keys dropped,
  // readable by a viewer who prints, refused over the limits and without the permission.
  const layout = (id) => ({
    id, name: "Dock receipt", documentType: "receive_sheet", isDefault: false, version: 1,
    page: { paper: "A4", orientation: "portrait", width: 794, height: 1123, margin: 52 },
    elements: [{ id: "company", type: "field", title: "Company", field: "companyName", x: 52, y: 42, width: 690, height: 30, visible: true, draggable: true, resizable: true, style: { fontSize: 14, bold: true }, script: "dropped" }],
  });
  const withLayouts = { ...documents, layouts: [layout("receive_sheet-custom")] };
  const savedLayouts = await request(base, "/api/settings-runtime/documents", { token, method: "PATCH", body: { settings: withLayouts } });
  assert.deepEqual(savedLayouts.settings.layouts.map((item) => item.id), ["receive_sheet-custom"]);
  assert.equal("script" in savedLayouts.settings.layouts[0].elements[0], false);
  assert.equal("isDefault" in savedLayouts.settings.layouts[0], false);
  assert.equal((await prisma.tenant.findUnique({ where: { id: tenantId } })).operationalSettings.documents.purchaseOrder.termsText, "Net 30 from invoice.", "the rest of the section is kept");
  assert.deepEqual((await request(base, "/api/settings-runtime", { token: viewerToken })).documents.layouts.map((item) => item.id), ["receive_sheet-custom"]);
  const tooMany = await raw(base, "/api/settings-runtime/documents", { token, method: "PATCH", body: { settings: { ...withLayouts, layouts: Array.from({ length: 21 }, (_, index) => layout(`receive_sheet-${index}`)) } } });
  assert.deepEqual([tooMany.status, tooMany.payload.code, tooMany.payload.details?.field, tooMany.payload.details?.limit], [400, "DOCUMENT_LAYOUTS_TOO_MANY", "layouts", 20]);
  const terms = (index) => ({ ...layout(`receive_sheet-terms-${index}`), elements: [{ id: "terms", type: "terms", title: "Terms", value: "x".repeat(4000), x: 52, y: 700, width: 690, height: 110, visible: true, draggable: true, resizable: true }] });
  const tooLarge = await raw(base, "/api/settings-runtime/documents", { token, method: "PATCH", body: { settings: { ...withLayouts, layouts: Array.from({ length: 17 }, (_, index) => terms(index)) } } });
  assert.deepEqual([tooLarge.status, tooLarge.payload.code, tooLarge.payload.details?.field], [400, "DOCUMENT_LAYOUTS_TOO_LARGE", "layouts"]);
  const badShape = await raw(base, "/api/settings-runtime/documents", { token, method: "PATCH", body: { settings: { ...withLayouts, layouts: [{ ...layout("receive_sheet-x"), documentType: "purchase_order" }] } } });
  assert.deepEqual([badShape.status, badShape.payload.code, badShape.payload.details?.field], [400, "DOCUMENT_LAYOUT_INVALID", "layouts.0.documentType"]);
  const layoutDenied = await raw(base, "/api/settings-runtime/documents", { token: viewerToken, method: "PATCH", body: { settings: withLayouts } });
  assert.equal(layoutDenied.status, 403);
  assert.deepEqual((await prisma.tenant.findUnique({ where: { id: tenantId } })).operationalSettings.documents.layouts.map((item) => item.id), ["receive_sheet-custom"], "a refused save changes nothing");

  await prisma.tenant.update({ where: { id: tenantId }, data: { openingBalanceLockedAt: new Date() } });
  workspace = await request(base, "/api/workspace", { token });
  const locked = await raw(base, "/api/workspace", { token, method: "PATCH", body: { ...workspace, baseCurrency: "USD" } });
  assert.equal(locked.status, 409);
  assert.equal(locked.payload.code, "BASE_CURRENCY_LOCKED");
  const audits = await request(base, "/api/audit-log?limit=100", { token });
  assert.ok(audits.some(entry => entry.action === "workspace_settings_updated" && entry.before && entry.after));
  assert.ok(audits.some(entry => entry.action === "profile_settings_updated" && entry.before && entry.after));
  assert.ok(audits.some(entry => entry.action === "numbering_settings_updated" && entry.before && entry.after));

  await stop(server);
  server = startApi(env);
  await waitFor(`${base}/api/health`);
  token = (await signInThroughEmailLink(base, prisma, { tenantId, email })).token;
  const persistedWorkspace = await request(base, "/api/workspace", { token });
  const persistedSettings = await request(base, "/api/settings-runtime", { token });
  assert.equal(persistedWorkspace.defaultLanguage, "en-US");
  assert.equal(persistedWorkspace.locale, "zh-CN");
  assert.equal(persistedWorkspace.timezone, "America/Chicago");
  assert.equal(persistedWorkspace.baseCurrency, "CNY");
  assert.equal(persistedSettings.numbering.rules.find(rule => rule.id === "NUM-RR").prefix, "RTR");
  console.log("Workspace settings API acceptance: 1 passed, 0 failed, 0 skipped");
} finally {
  await stop(server);
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
