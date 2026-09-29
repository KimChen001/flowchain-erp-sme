// Strict verification: runs the fast suite AND the real-PostgreSQL gates that
// carry the business transaction invariants, then proves each gate actually
// executed tests.
//
// `npm test` stays the fast command. It deliberately does not open a database,
// so the transaction suites report SKIP there. A run of `npm test` alone is
// therefore not evidence that receiving, outbound, inventory, finance,
// authorization or award behaviour still works. This command is that evidence.
//
// Every gate provisions its own throwaway PostgreSQL instance and sets
// FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS=true, so a suite that cannot run fails
// instead of being skipped. No existing database is touched and no external
// service is contacted.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Local CLIs whose executable name differs from their package name. Their
// bin entry is a JS file with a shebang, so node can run it directly and we
// never depend on a platform-specific .cmd shim.
const BINARY_PACKAGES = { tsc: "typescript" };

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Resolved from package.json so this list cannot drift from the real commands.
const FAST_STEPS = ["typecheck", "test"];
const DATABASE_GATES = [
  "test:db:receiving",
  "test:db:outbound",
  "test:db:inventory-operations",
  "test:db:operational-finance",
  "test:db:po-command-atomicity",
  "test:db:authorization",
  "test:db:rfq-award-decision",
];

const only = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
const skipFast = process.argv.includes("--db-only");

function commandsFor(scriptName) {
  const declared = packageJson.scripts?.[scriptName];
  if (!declared) throw new Error(`package.json has no script "${scriptName}".`);
  return declared.split("&&").map((part) => {
    const tokens = part.trim().split(/\s+/);
    const [binary, ...rest] = tokens;
    if (binary === "node") return rest;

    const packageName = BINARY_PACKAGES[binary];
    const candidates = [
      packageName && join(root, "node_modules", packageName, "bin", binary),
      join(root, "node_modules", binary, "bin", binary),
      join(root, "node_modules", ".bin", binary),
    ].filter(Boolean);
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) {
      throw new Error(
        `Script "${scriptName}" runs "${binary}", which could not be resolved to a local JS entry point. ` +
          "Add it to BINARY_PACKAGES in scripts/run-strict-verification.mjs so strict verification keeps running the real command.",
      );
    }
    return [entry, ...rest];
  });
}

function runNode(args) {
  return new Promise((resolvePromise) => {
    let output = "";
    const child = spawn(process.execPath, args, { cwd: root, env: process.env });
    const capture = (chunk) => {
      const textChunk = String(chunk);
      output += textChunk;
      process.stdout.write(textChunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => resolvePromise({ code: 1, output: `${output}\n${error.message}` }));
    child.once("exit", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

// node:test prints both a TAP-ish and an "ℹ pass N" summary depending on
// reporter. Accept either, and sum across multiple summaries in one gate.
function countPassed(output) {
  let total = 0;
  for (const match of output.matchAll(/^(?:#|ℹ)\s*pass\s+(\d+)\s*$/gm)) total += Number(match[1]);
  for (const match of output.matchAll(/^\s*(\d+) passed/gm)) total += Number(match[1]);
  return total;
}

// Some gates are bespoke verifiers rather than node:test suites and report a
// single "<name> verification: PASS" or "<name> gate: PASS" line instead of a
// tally. Those count as executed too; only a gate that emits neither has
// silently done nothing.
function hasGatePassLine(output) {
  return /^.*(?:verification|gate):\s*PASS\b.*$/m.test(output);
}

function countFailed(output) {
  let total = 0;
  for (const match of output.matchAll(/^(?:#|ℹ)\s*fail\s+(\d+)\s*$/gm)) total += Number(match[1]);
  return total;
}

const results = [];

async function runStep(scriptName, { requireExecutedTests }) {
  process.stdout.write(`\n=== ${scriptName} ===\n`);
  let commands;
  try {
    commands = commandsFor(scriptName);
  } catch (error) {
    results.push({ scriptName, status: "error", detail: error.message });
    process.stdout.write(`${error.message}\n`);
    return;
  }

  let output = "";
  let code = 0;
  for (const args of commands) {
    const attempt = await runNode(args);
    output += attempt.output;
    code = attempt.code;
    if (code !== 0) break;
  }

  const passed = countPassed(output);
  const failed = countFailed(output);

  if (code !== 0) {
    results.push({ scriptName, status: "failed", detail: `exit ${code}, ${failed} failing assertions`, passed });
    return;
  }
  // A gate that exits 0 having executed nothing is the exact failure mode this
  // command exists to catch.
  const gateLine = hasGatePassLine(output);
  if (requireExecutedTests && passed === 0 && !gateLine) {
    results.push({
      scriptName,
      status: "not-executed",
      detail: "exited 0 but reported neither passing tests nor a gate PASS line, so it did not actually run",
      passed,
    });
    return;
  }
  let detail;
  if (passed > 0) detail = `${passed} passed${gateLine ? " + gate PASS" : ""}`;
  else if (gateLine) detail = "gate PASS";
  else detail = "exit 0, no test tally reported";
  results.push({ scriptName, status: "passed", detail, passed });
}

const selectedFast = only.length ? FAST_STEPS.filter((step) => only.includes(step)) : FAST_STEPS;
const selectedGates = only.length ? DATABASE_GATES.filter((gate) => only.includes(gate)) : DATABASE_GATES;

if (!skipFast) {
  for (const step of selectedFast) {
    await runStep(step, { requireExecutedTests: step === "test" });
  }
}
for (const gate of selectedGates) {
  await runStep(gate, { requireExecutedTests: true });
}

process.stdout.write("\n===== STRICT VERIFICATION SUMMARY =====\n");
for (const result of results) {
  const label = result.status === "passed" ? "PASS" : result.status.toUpperCase();
  process.stdout.write(`${label.padEnd(13)} ${result.scriptName.padEnd(34)} ${result.detail}\n`);
}
const broken = results.filter((result) => result.status !== "passed");
process.stdout.write(
  `\n${results.length - broken.length}/${results.length} steps passed. ` +
    `Database gates run against throwaway PostgreSQL instances.\n`,
);
if (broken.length) {
  process.stdout.write(`\nFailing steps: ${broken.map((result) => result.scriptName).join(", ")}\n`);
  process.exit(1);
}
