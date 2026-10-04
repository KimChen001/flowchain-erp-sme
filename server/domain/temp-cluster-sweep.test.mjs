import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepAbandonedClusters, UNSTARTED_CLUSTER_MAX_AGE_MS } from "../../scripts/test-support/temp-cluster.mjs";

const prefix = "flowchain-sweep-test-";
const windows = process.platform === "win32";

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  return child.pid;
}

// On Windows the sweep also checks the image name, so the stand-in postmaster
// is a copy of node called postgres.exe.
async function runningPostgres(parent) {
  const executable = join(parent, windows ? "postgres.exe" : "postgres");
  await copyFile(process.execPath, executable);
  const child = spawn(executable, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  await new Promise((resolveSpawn, reject) => child.once("spawn", resolveSpawn).once("error", reject));
  return child;
}

async function cluster(parent, suffix, postmasterPid) {
  const directory = join(parent, `${prefix}${suffix}`);
  await mkdir(join(directory, "base"), { recursive: true });
  if (postmasterPid !== undefined) await writeFile(join(directory, "postmaster.pid"), `${postmasterPid}\n${directory}\n1790966064\n50879\n`);
  return directory;
}

const names = (parent, directories) => directories.map((directory) => directory.slice(parent.length + 1)).sort();

test("the cluster sweep removes only clusters whose postmaster is gone or that never started long ago", async () => {
  const parent = await mkdtemp(join(tmpdir(), "flowchain-sweep-parent-"));
  const postgres = await runningPostgres(parent);
  try {
    await cluster(parent, "Dead01", await exitedPid());
    await cluster(parent, "Alive1", postgres.pid);
    // This test's own node process stands in for an unrelated process that
    // inherited a dead postmaster's PID, which Windows does within minutes.
    await cluster(parent, "Reuse1", process.pid);
    await cluster(parent, "NoPid1");
    await cluster(parent, "Junk01", "not-a-pid");
    await cluster(parent, "toolong7", await exitedPid());
    await mkdir(join(parent, "flowchain-other-browser-Dead02"));

    const fresh = await sweepAbandonedClusters(prefix, { parent });
    assert.deepEqual(names(parent, fresh), windows ? [`${prefix}Dead01`, `${prefix}Reuse1`] : [`${prefix}Dead01`]);

    // Hours later, the directories that never got a postmaster count as stopped.
    const later = await sweepAbandonedClusters(prefix, { parent, now: Date.now() + UNSTARTED_CLUSTER_MAX_AGE_MS + 60_000 });
    assert.deepEqual(names(parent, later), [`${prefix}Junk01`, `${prefix}NoPid1`]);

    // A running postmaster and any name that mkdtemp did not produce are never touched.
    const kept = (await readdir(parent)).filter((name) => name.startsWith("flowchain-")).sort();
    assert.deepEqual(kept, ["flowchain-other-browser-Dead02", `${prefix}Alive1`, ...(windows ? [] : [`${prefix}Reuse1`]), `${prefix}toolong7`]);
  } finally {
    postgres.kill();
    await new Promise((resolveExit) => (postgres.exitCode === null ? postgres.once("exit", resolveExit) : resolveExit()));
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});
