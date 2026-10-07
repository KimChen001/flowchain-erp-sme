import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The test harnesses run a throwaway embedded PostgreSQL cluster in a mkdtemp
// directory and delete it in cleanup(). That path only runs on a normal exit or
// from a SIGINT/SIGTERM handler, and on Windows Playwright stops its webServer
// processes with `taskkill /T /F`, so every browser run used to leave a ~73 MB
// cluster behind. Each harness therefore removes the abandoned clusters of its
// own prefix whenever it creates a new one.

// A cluster without postmaster.pid is either still in initdb (seconds) or was
// stopped and never removed, so only its age tells the two apart.
export const UNSTARTED_CLUSTER_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// The prefixes the harnesses pass to createTempClusterDirectory, for the
// command-line sweep at the bottom of this file.
const HARNESS_CLUSTER_PREFIXES = [
  "flowchain-inventory-browser-",
  "flowchain-inventory-operations-api-",
  "flowchain-operational-finance-browser-",
  "flowchain-outbound-browser-",
  "flowchain-phase-5-2c1-pg-",
  "flowchain-product-recovery-",
  "flowchain-receiving-browser-",
  "flowchain-returns-browser-",
  "flowchain-settings-browser-",
  // The settings harness kept its intake artifacts in a sibling directory
  // before they moved inside the cluster directory. These never had a
  // postmaster.pid, so the age rule decides.
  "flowchain-intake-browser-artifacts-",
];

// Playwright output folders that used to be named after a process id.
const LEGACY_PLAYWRIGHT_OUTPUT_PARENTS = ["flowchain-playwright-results", "flowchain-attachment-restart-playwright"];

const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

// Windows hands PIDs out again within minutes, so the postmaster.pid of a
// killed cluster often names a live browser or service process instead.
async function isPostmasterRunning(pid) {
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
    const image = stdout.match(/^"([^"]+)","(\d+)"/m);
    return Boolean(image) && Number(image[2]) === pid && image[1].toLowerCase() === "postgres.exe";
  } catch {
    // Cannot tell what the process is, so keep the cluster.
    return true;
  }
}

async function postmasterPid(directory) {
  try {
    const [firstLine] = (await readFile(join(directory, "postmaster.pid"), "utf8")).split(/\r?\n/, 1);
    const pid = Number(firstLine.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function isAbandonedCluster(directory, { now = Date.now(), maxAgeMs = UNSTARTED_CLUSTER_MAX_AGE_MS }) {
  const pid = await postmasterPid(directory);
  if (pid) return !(await isPostmasterRunning(pid));
  const info = await stat(directory).catch(() => null);
  if (!info) return false;
  return now - (info.birthtimeMs || info.mtimeMs) > maxAgeMs;
}

export async function sweepAbandonedClusters(prefix, { parent = tmpdir(), ...options } = {}) {
  const removed = [];
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    if (!MKDTEMP_SUFFIX.test(entry.name.slice(prefix.length))) continue;
    const directory = join(parent, entry.name);
    if (!(await isAbandonedCluster(directory, options))) continue;
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      removed.push(directory);
    } catch {
      // Still locked by a process that is shutting down; a later sweep retries.
    }
  }
  return removed;
}

// Starts removing abandoned siblings, then creates the new cluster directory.
// The sweep is not awaited: deleting a cluster takes seconds, and the browser
// harnesses must pass Playwright's 30 s webServer health check. A short-lived
// script stays alive until its pending sweep finishes.
export async function createTempClusterDirectory(prefix) {
  sweepAbandonedClusters(prefix).catch(() => {});
  return mkdtemp(join(tmpdir(), prefix));
}

async function sweepLegacyPlaywrightOutput() {
  const removed = [];
  for (const name of LEGACY_PLAYWRIGHT_OUTPUT_PARENTS) {
    const parent = join(tmpdir(), name);
    for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || isProcessAlive(Number(entry.name))) continue;
      const directory = join(parent, entry.name);
      await rm(directory, { recursive: true, force: true, maxRetries: 3 }).then(() => removed.push(directory), () => {});
    }
  }
  return removed;
}

// `npm run test:clean-temp` clears what earlier runs left behind: abandoned
// harness clusters and per-PID Playwright output folders.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let clusters = 0;
  for (const prefix of HARNESS_CLUSTER_PREFIXES) {
    const removed = await sweepAbandonedClusters(prefix);
    if (removed.length) console.log(`${prefix}*: removed ${removed.length}`);
    clusters += removed.length;
  }
  const outputFolders = (await sweepLegacyPlaywrightOutput()).length;
  console.log(`Removed ${clusters} abandoned cluster directories and ${outputFolders} per-PID Playwright output folders from ${tmpdir()}.`);
}
