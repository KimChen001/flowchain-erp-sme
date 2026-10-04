// A self-contained local walkthrough of FlowChain: its own embedded PostgreSQL,
// the US workspace, the walkthrough scenario (dated relative to the first run)
// and the English UI with email sign-in through a local outbox.
//
// It never reads .env.local or .local/, never touches another database and
// calls no paid service. Everything it keeps lives under
// FLOWCHAIN_WALKTHROUGH_DIR (default ~/flowchain-data/walkthrough), so a rerun
// resumes the same workspace. Delete that folder to start over.
//
//   npm run walkthrough:local            start (seeds on the first run)
//   npm run walkthrough:local -- --reset delete the walkthrough data first
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const root = resolve(import.meta.dirname, "..");
const dataRoot = resolve(process.env.FLOWCHAIN_WALKTHROUGH_DIR || join(homedir(), "flowchain-data", "walkthrough"));
const pgPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_PG_PORT || 55433);
const apiPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_API_PORT || 18801);
const appPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_APP_PORT || 15201);
const database = "flowchain_walkthrough";
const user = "flowchain_walkthrough";

// The server fills any empty variable from .env.local, .env and, in local
// development, .local/ai-provider.env and .local/openai.env. Run only from a
// checkout without them, so a real key or another database is never picked up.
const localFiles = [".env.local", ".env", ".local"].filter((name) => existsSync(join(root, name)));
if (localFiles.length) {
  console.error(`[walkthrough] Refusing to start: ${localFiles.join(", ")} found in ${root}.`);
  console.error("[walkthrough] Run it from a clean checkout (for example a new git worktree) so no local key or database is used.");
  process.exit(1);
}

if (process.argv.includes("--reset")) rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });

// Secrets are generated once and kept next to the data, never in the repo.
const secretsPath = join(dataRoot, "secrets.json");
const secrets = existsSync(secretsPath)
  ? JSON.parse(readFileSync(secretsPath, "utf8"))
  : { password: randomBytes(18).toString("base64url"), session: randomBytes(48).toString("base64url"), syncCursor: randomBytes(48).toString("base64url") };
writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });

const pgDir = join(dataRoot, "pg");
const firstRun = !existsSync(join(pgDir, "PG_VERSION"));
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user, password: secrets.password, port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });

const env = {
  ...process.env,
  NODE_ENV: "development",
  FLOWCHAIN_DEV_LOCAL: "true",
  DATABASE_URL: `postgresql://${user}:${encodeURIComponent(secrets.password)}@127.0.0.1:${pgPort}/${database}?schema=public`,
  FLOWCHAIN_DEFAULT_TENANT_ID: "tenant-flowchain-walkthrough",
  FLOWCHAIN_PILOT_WORKSPACE_NAME: "FlowChain Walkthrough",
  FLOWCHAIN_LOCAL_SESSION_SECRET: secrets.session,
  FLOWCHAIN_SYNC_CURSOR_SECRET: secrets.syncCursor,
  SCM_API_PORT: String(apiPort),
  FLOWCHAIN_PUBLIC_BASE_URL: `http://127.0.0.1:${appPort}`,
  FLOWCHAIN_ARTIFACT_STORAGE_ROOT: join(dataRoot, "artifacts"),
  FLOWCHAIN_UPLOAD_STORAGE_DIR: join(dataRoot, "uploads"),
  FLOWCHAIN_MAIL_PROVIDER: "outbox",
  FLOWCHAIN_MAIL_OUTBOX_PATH: join(dataRoot, "mail-outbox.json"),
  // The US trial capability set (deploy/README.md).
  FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true",
  FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "true",
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "false",
  // No model provider: the assistant answers from workspace data only.
  OPENAI_API_KEY: "",
  FLOWCHAIN_KNOWLEDGE_PROVIDER: "",
  // The Vite dev server proxies /api to the local API.
  PLAYWRIGHT_APP_PORT: String(appPort),
  PLAYWRIGHT_API_PORT: String(apiPort),
};

const step = (label) => console.log(`\n[walkthrough] ${label}`);
const runNode = (args, label) => new Promise((resolveRun, reject) => {
  step(label);
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  child.once("exit", (code) => (code === 0 ? resolveRun() : reject(new Error(`${label} exited with code ${code}`))));
  child.once("error", reject);
});

const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  await pg.stop().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

try {
  step(`PostgreSQL ${firstRun ? "initialising" : "resuming"} in ${pgDir} on port ${pgPort}`);
  if (firstRun) await pg.initialise();
  await pg.start();
  if (firstRun) await pg.createDatabase(database);

  await runNode([join(root, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], "Applying database migrations");
  if (firstRun) {
    await runNode(["scripts/setup-pilot-workspace.mjs"], "Creating the US workspace, roles and sign-in users");
    await runNode(["scripts/setup-local-demo.mjs"], "Loading master data (items, suppliers, warehouses)");
    await runNode(["scripts/setup-local-scenario.mjs"], "Seeding the walkthrough scenario relative to today");
  } else {
    step("Workspace already seeded; keeping its data (use --reset to start over)");
  }

  step(`Starting the API on http://127.0.0.1:${apiPort}`);
  children.push(spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: "inherit" }));
  step(`Starting the app on http://127.0.0.1:${appPort}`);
  children.push(spawn(process.execPath, ["scripts/browser-uat-vite.mjs"], { cwd: root, env, stdio: "inherit" }));
  for (const child of children) child.once("exit", (code) => { if (!stopping) stop(code ?? 1); });

  console.log(`
[walkthrough] Ready: http://127.0.0.1:${appPort}
[walkthrough] Sign in with admin@flowchain.local or kim@example.com, then open
[walkthrough] "View the sign-in link" on the sign-in page (local outbox only).
[walkthrough] Data folder: ${dataRoot}   Stop with Ctrl+C.`);
} catch (error) {
  console.error(`[walkthrough] ${error.message}`);
  await stop(1);
}
