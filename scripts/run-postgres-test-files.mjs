import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const files = process.argv.slice(2);
if (!files.length) throw new Error("At least one PostgreSQL test file is required.");

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolvePort(port));
  });
});

const port = await freePort();
const password = `phase-5-2c1-${randomUUID()}`;
const user = "flowchain_phase_5_2c1";
const database = "flowchain_phase_5_2c1_tests";
const directory = await mkdtemp(join(tmpdir(), "flowchain-phase-5-2c1-pg-"));
const storageDirectory = join(directory, "attachments");
const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port, persistent: false, onLog: () => {}, onError: () => {} });
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_TEST: url,
  FLOWCHAIN_PERSISTENCE_MODE: "database",
  FLOWCHAIN_ENABLE_DB_MOBILE_SYNC: "true",
  FLOWCHAIN_ENABLE_DB_MOBILE_OPERATIONS: "true",
  FLOWCHAIN_ENABLE_DB_RECEIVING_POSTING: "true",
  FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: "true",
  FLOWCHAIN_ENABLE_DB_INTERNAL_SETTLEMENT: "true",
  FLOWCHAIN_ENABLE_DB_SETTLEMENT_WORKFLOW: "true",
  FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID: "phase-5-2c1-current",
  FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET: "phase-5-2c1-current-secret-at-least-32-characters",
  FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER: "local",
  FLOWCHAIN_UPLOAD_STORAGE_DIR: storageDirectory,
  FLOWCHAIN_ALLOW_TEST_TEMP_ATTACHMENT_STORAGE: "true",
  FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS: "true",
  NODE_ENV: "test",
};

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 30 * 1024 * 1024 });
  const child = await execFileAsync(process.execPath, ["--test", ...files], { cwd: root, env, maxBuffer: 30 * 1024 * 1024 });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
} catch (error) {
  process.stdout.write(error.stdout || "");
  process.stderr.write(error.stderr || "");
  throw error;
} finally {
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
