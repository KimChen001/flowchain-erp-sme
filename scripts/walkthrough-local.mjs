// A self-contained local walkthrough of FlowChain on public data: its own
// embedded PostgreSQL, two workspaces seeded from public datasets, and the
// English UI with email sign-in through a local outbox.
//
//   m5   Walmart store CA_1 (M5), USD    on the app port (default 15201)
//   uci  UK online gift retailer (UCI Online Retail II), GBP
//                                        on the second app port (app port + 1)
// FLOWCHAIN_WALKTHROUGH_PRIMARY=uci puts UCI on the app port and M5 on the
// second one.
//
// Sales come from the public data; suppliers, purchasing and stock are
// assumed by stated rules (docs/public-data-workspaces.md), and each workspace shows
// a note saying so. Dates are moved so the last day of the data is the day
// before the first run.
//
// It seeds from a local extract of the two datasets, which is never committed
// (scripts/public-data/extract_public_data.py writes it). It never reads
// .env.local or .local/, never touches another database and calls no paid
// service. Everything it keeps lives under FLOWCHAIN_WALKTHROUGH_DIR (default
// ~/flowchain-data/public-data), so a rerun resumes the same workspaces.
// Delete that folder (or pass --reset) to start over.
//
//   npm run walkthrough:local                       start (seeds on the first run)
//   npm run walkthrough:local -- --reset            delete the walkthrough data first
//   npm run walkthrough:local -- --extract=<file>   the extract (default
//                                                   FLOWCHAIN_PUBLIC_DATA_EXTRACT or
//                                                   ~/flowchain-data/public-data-extract.json)
//   npm run walkthrough:local -- --as-of=YYYY-MM-DD seed as of that day instead of today
//                                                   (the data's last day is the day before)
//   npm run walkthrough:local -- --ai-env=<file>    also use the assistant's model
//
// --ai-env is the one exception to "calls no paid service", and only when
// given: it reads a model provider from a file outside this checkout (the
// owner's provider settings, for example another worktree's
// .local/ai-provider.env) and switches assistant v2 on. Without it the
// assistant shows the notice that no model is set up. Only the AI provider
// and knowledge settings in it are used, and the key is never printed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { PUBLIC_DATA_WORKSPACE_DATASETS, publicDataExtractMissingMessage } from "./public-data/plan.mjs";

const root = resolve(import.meta.dirname, "..");
const dataRoot = resolve(process.env.FLOWCHAIN_WALKTHROUGH_DIR || join(homedir(), "flowchain-data", "public-data"));
const pgPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_PG_PORT || 55433);
const apiPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_API_PORT || 18801);
const appPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_APP_PORT || 15201);
const secondApiPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_SECOND_API_PORT || apiPort + 1);
const secondAppPort = Number(process.env.FLOWCHAIN_WALKTHROUGH_SECOND_APP_PORT || appPort + 1);
const database = "flowchain_walkthrough";
const user = "flowchain_walkthrough";
const extractArg = process.argv.find((arg) => arg.startsWith("--extract="));
const asOfArg = process.argv.find((arg) => arg.startsWith("--as-of="));
const extractPath = resolve(extractArg ? extractArg.slice("--extract=".length) : process.env.FLOWCHAIN_PUBLIC_DATA_EXTRACT || join(homedir(), "flowchain-data", "public-data-extract.json"));

// The server fills any empty variable from .env.local, .env and, in local
// development, .local/ai-provider.env and .local/openai.env. Run only from a
// checkout without them, so a real key or another database is never picked up.
const localFiles = [".env.local", ".env", ".local"].filter((name) => existsSync(join(root, name)));
if (localFiles.length) {
  console.error(`[walkthrough] Refusing to start: ${localFiles.join(", ")} found in ${root}.`);
  console.error("[walkthrough] Run it from a clean checkout (for example a new git worktree) so no local key or database is used.");
  process.exit(1);
}

// The opt-in model provider (see the top of this file).
const AI_ENV_KEYS = new Set([
  "FLOWCHAIN_AI_RUNTIME_MODE", "FLOWCHAIN_AI_PROVIDER_KIND", "FLOWCHAIN_AI_PROVIDER_ENDPOINT", "FLOWCHAIN_AI_PROVIDER_MODEL",
  "FLOWCHAIN_AI_PROVIDER_API_KEY", "FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS", "FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS", "FLOWCHAIN_AI_PROVIDER_SESSION_HEADER",
  "FLOWCHAIN_KNOWLEDGE_PROVIDER", "FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER",
]);
const aiEnvArg = process.argv.find((arg) => arg.startsWith("--ai-env="));
const aiEnv = {};
if (aiEnvArg) {
  const file = resolve(aiEnvArg.slice("--ai-env=".length));
  if (file.toLowerCase().startsWith(root.toLowerCase())) {
    console.error("[walkthrough] --ai-env must point outside this checkout, so no key is ever kept in it.");
    process.exit(1);
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && AI_ENV_KEYS.has(match[1])) aiEnv[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!aiEnv.FLOWCHAIN_AI_PROVIDER_KIND || !aiEnv.FLOWCHAIN_AI_PROVIDER_API_KEY) {
    console.error("[walkthrough] --ai-env needs FLOWCHAIN_AI_PROVIDER_KIND and FLOWCHAIN_AI_PROVIDER_API_KEY.");
    process.exit(1);
  }
  // Assistant v2 answers every question; with the rules engine removed
  // (2026-11-07), a server with a model but another mode shows the notice.
  aiEnv.FLOWCHAIN_AI_ASSISTANT_MODE = "assistant_v2";
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
const seededPath = join(dataRoot, "seeded.json");
const firstRun = !existsSync(join(pgDir, "PG_VERSION"));
if (!firstRun && !existsSync(seededPath)) {
  console.error(`[walkthrough] ${dataRoot} has a database but its public data seed did not finish. Start over with --reset.`);
  process.exit(1);
}
if (firstRun && !existsSync(extractPath)) {
  console.error(`[walkthrough] ${publicDataExtractMissingMessage(extractPath)}`);
  process.exit(1);
}
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user, password: secrets.password, port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });

const primary = String(process.env.FLOWCHAIN_WALKTHROUGH_PRIMARY || "m5").trim().toLowerCase();
if (!["m5", "uci"].includes(primary)) {
  console.error(`[walkthrough] FLOWCHAIN_WALKTHROUGH_PRIMARY must be m5 or uci, not "${primary}".`);
  process.exit(1);
}
const [first, second] = primary === "uci" ? ["uci", "m5"] : ["m5", "uci"];
const workspaces = [
  { ...PUBLIC_DATA_WORKSPACE_DATASETS[first], apiPort, appPort },
  { ...PUBLIC_DATA_WORKSPACE_DATASETS[second], apiPort: secondApiPort, appPort: secondAppPort },
];

const sharedEnv = {
  ...process.env,
  NODE_ENV: "development",
  FLOWCHAIN_DEV_LOCAL: "true",
  DATABASE_URL: `postgresql://${user}:${encodeURIComponent(secrets.password)}@127.0.0.1:${pgPort}/${database}?schema=public`,
  FLOWCHAIN_LOCAL_SESSION_SECRET: secrets.session,
  FLOWCHAIN_SYNC_CURSOR_SECRET: secrets.syncCursor,
  FLOWCHAIN_MAIL_PROVIDER: "outbox",
  // The US trial capability set (deploy/README.md).
  FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true",
  FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: "true",
  FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: "true",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "false",
  FLOWCHAIN_ENABLE_DATA_IMPORT: "true",
  // Contracts are on in the walkthrough and off in the trial
  // (docs/contracts-module-design.md, D10).
  FLOWCHAIN_ENABLE_CONTRACTS: "true",
  // No model provider: the assistant answers from workspace data only,
  // unless --ai-env opts in.
  OPENAI_API_KEY: "",
  FLOWCHAIN_KNOWLEDGE_PROVIDER: "",
  FLOWCHAIN_PUBLIC_DATA_EXTRACT: extractPath,
  ...aiEnv,
};

// One workspace's server settings: its tenant, ports and files.
const envFor = (workspace) => ({
  ...sharedEnv,
  FLOWCHAIN_DEFAULT_TENANT_ID: workspace.tenantId,
  FLOWCHAIN_PILOT_WORKSPACE_NAME: workspace.workspaceName,
  SCM_API_PORT: String(workspace.apiPort),
  FLOWCHAIN_PUBLIC_BASE_URL: `http://127.0.0.1:${workspace.appPort}`,
  FLOWCHAIN_ARTIFACT_STORAGE_ROOT: join(dataRoot, workspace.dataset, "artifacts"),
  FLOWCHAIN_UPLOAD_STORAGE_DIR: join(dataRoot, workspace.dataset, "uploads"),
  FLOWCHAIN_MAIL_OUTBOX_PATH: join(dataRoot, workspace.dataset, "mail-outbox.json"),
  FLOWCHAIN_VITE_CACHE_DIR: join(dataRoot, workspace.dataset, "vite-cache"),
  // The Vite dev server proxies /api to the workspace's API.
  PLAYWRIGHT_APP_PORT: String(workspace.appPort),
  PLAYWRIGHT_API_PORT: String(workspace.apiPort),
});

const step = (label) => console.log(`\n[walkthrough] ${label}`);
const runNode = (args, label, env = sharedEnv) => new Promise((resolveRun, reject) => {
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
    for (const workspace of workspaces) {
      mkdirSync(join(dataRoot, workspace.dataset), { recursive: true });
      await runNode(["scripts/setup-pilot-workspace.mjs"], `Creating workspace ${workspace.workspaceName}, roles and sign-in users`, envFor(workspace));
    }
    // One after the other: side by side, their serializable postings keep
    // aborting each other in the one database.
    const started = Date.now();
    for (const workspace of workspaces) {
      await runNode(["scripts/public-data/seed-cli.mjs", `--dataset=${workspace.dataset}`, `--extract=${extractPath}`, ...(asOfArg ? [asOfArg] : [])], `Seeding ${workspace.workspaceName} from public data`, envFor(workspace));
    }
    writeFileSync(seededPath, JSON.stringify({ seededAt: new Date().toISOString(), asOf: asOfArg ? asOfArg.slice("--as-of=".length) : null, seconds: Math.round((Date.now() - started) / 1000), extract: extractPath }, null, 2));
  } else {
    step("Workspaces already seeded; keeping their data (use --reset to start over)");
  }

  for (const workspace of workspaces) {
    const env = envFor(workspace);
    step(`Starting ${workspace.workspaceName}: API on http://127.0.0.1:${workspace.apiPort}, app on http://127.0.0.1:${workspace.appPort}`);
    children.push(spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: "inherit" }));
    children.push(spawn(process.execPath, ["scripts/browser-uat-vite.mjs"], { cwd: root, env, stdio: "inherit" }));
  }
  for (const child of children) child.once("exit", (code) => { if (!stopping) stop(code ?? 1); });

  console.log(`
[walkthrough] Ready:
[walkthrough]   ${workspaces[0].workspaceName}: http://127.0.0.1:${workspaces[0].appPort}
[walkthrough]   ${workspaces[1].workspaceName}: http://127.0.0.1:${workspaces[1].appPort}
[walkthrough] Sign in with admin@flowchain.local or kim@example.com (UCI also daniel@example.com), then open
[walkthrough] "View the sign-in link" on the sign-in page (local outbox only).
[walkthrough] Data folder: ${dataRoot}   Stop with Ctrl+C.
[walkthrough] Model features: ${aiEnvArg ? `on (${aiEnv.FLOWCHAIN_AI_PROVIDER_KIND}, ${aiEnv.FLOWCHAIN_AI_PROVIDER_MODEL || "default model"}; assistant v2, knowledge ${aiEnv.FLOWCHAIN_KNOWLEDGE_PROVIDER || "off"})` : "off"}`);
} catch (error) {
  console.error(`[walkthrough] ${error.message}`);
  await stop(1);
}
