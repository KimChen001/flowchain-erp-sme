import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const names = {
  image: `flowchain-production-smoke:${suffix}`,
  network: `flowchain-production-smoke-${suffix}`,
  postgres: `flowchain-production-postgres-${suffix}`,
  app: `flowchain-production-app-${suffix}`,
  volume: `flowchain-production-attachments-${suffix}`,
};
const database = "flowchain_production_smoke";
const databaseUser = "flowchain_smoke";
const databasePassword = `ci-only-${suffix}-password`;
const tenantId = `tenant-container-${suffix}`;
const userId = `user-container-${suffix}`;
const email = `container-${suffix}@flowchain.invalid`;
const purchaseOrderId = `CI-PO-${suffix}`;
const sessionSecret = `ci-only-session-${suffix}-at-least-32-characters`;
const databaseUrl = `postgresql://${databaseUser}:${databasePassword}@${names.postgres}:5432/${database}?schema=public`;
const commitSha = process.env.FLOWCHAIN_COMMIT_SHA || process.env.GITHUB_SHA || "container-smoke-local";
const branch = process.env.FLOWCHAIN_BRANCH || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "container-smoke";

const redactions = [databasePassword, sessionSecret, databaseUrl];
function sanitize(value) {
  let safe = String(value || "");
  for (const secret of redactions) safe = safe.replaceAll(secret, "[REDACTED]");
  return safe.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]");
}

function runDocker(args, { input, allowFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", args, { cwd: root, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`Docker is unavailable: ${sanitize(error.message)}`)));
    child.on("exit", (code) => {
      const result = { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0 || allowFailure) resolveRun(result);
      else reject(new Error(`Docker command failed (${args[0]}, exit ${code}): ${sanitize(result.stderr || result.stdout)}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // The dependency is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms.`);
}

function appEnvironmentArgs() {
  return [
    "-e", `DATABASE_URL=${databaseUrl}`,
    "-e", "FLOWCHAIN_PERSISTENCE_MODE=database",
    "-e", `FLOWCHAIN_DEFAULT_TENANT_ID=${tenantId}`,
    "-e", `FLOWCHAIN_LOCAL_SESSION_SECRET=${sessionSecret}`,
    "-e", "FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER=local",
    "-e", "FLOWCHAIN_UPLOAD_STORAGE_DIR=/var/lib/flowchain/uploads",
    "-e", "FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP=false",
    "-e", "FLOWCHAIN_ENABLE_DB_MOBILE_SYNC=false",
  ];
}

const seedSource = `
import { createPrismaClient } from "./server/persistence/prisma-client.mjs";
const prisma = await createPrismaClient(process.env);
try {
  await prisma.tenant.create({ data: { id: ${JSON.stringify(tenantId)}, name: "Container Smoke Tenant" } });
  await prisma.user.create({ data: { id: ${JSON.stringify(userId)}, tenantId: ${JSON.stringify(tenantId)}, email: ${JSON.stringify(email)}, name: "Container Smoke User", role: "manager", status: "active" } });
  await prisma.purchaseOrder.create({
    data: {
      id: ${JSON.stringify(purchaseOrderId)},
      tenantId: ${JSON.stringify(tenantId)},
      status: "issued",
      supplierName: "Container Smoke Supplier",
      amount: "125.00",
      currency: "CNY",
      lines: {
        create: [{
          id: ${JSON.stringify(`${purchaseOrderId}-LINE-1`)},
          sku: "CI-SKU-1",
          itemName: "Container Smoke Item",
          orderedQuantity: "5",
          receivedQuantity: "0",
          unit: "EA",
          unitPrice: "25.00",
          amount: "125.00",
        }],
      },
    },
  });
} finally {
  await prisma.$disconnect();
}
`;

let appPort;
let completed = false;
try {
  console.log("[container-smoke] building immutable Node 24 image");
  await runDocker(["build", "--pull", "--build-arg", `FLOWCHAIN_COMMIT_SHA=${commitSha}`, "--build-arg", `FLOWCHAIN_BRANCH=${branch}`, "-t", names.image, "."]);
  await runDocker(["network", "create", names.network]);
  await runDocker(["volume", "create", names.volume]);
  await runDocker([
    "run", "-d", "--name", names.postgres, "--network", names.network,
    "-e", `POSTGRES_USER=${databaseUser}`,
    "-e", `POSTGRES_PASSWORD=${databasePassword}`,
    "-e", `POSTGRES_DB=${database}`,
    "postgres:16",
  ]);
  await waitFor(async () => (await runDocker(["exec", names.postgres, "pg_isready", "-U", databaseUser, "-d", database], { allowFailure: true })).code === 0, "PostgreSQL 16");

  console.log("[container-smoke] applying Prisma migrations as a separate release step");
  await runDocker(["run", "--rm", "--network", names.network, "-e", `DATABASE_URL=${databaseUrl}`, names.image, "npx", "prisma", "migrate", "deploy"]);
  await runDocker(["run", "--rm", "-i", "--network", names.network, "-e", `DATABASE_URL=${databaseUrl}`, "-e", "FLOWCHAIN_PERSISTENCE_MODE=database", names.image, "node", "--input-type=module", "-"], { input: seedSource });

  appPort = await freePort();
  await runDocker([
    "run", "-d", "--name", names.app, "--network", names.network,
    "-p", `${appPort}:8787`, "-v", `${names.volume}:/var/lib/flowchain/uploads`,
    ...appEnvironmentArgs(), names.image,
  ]);
  const base = `http://127.0.0.1:${appPort}`;
  const health = await waitFor(async () => {
    const response = await fetch(`${base}/api/health`);
    return response.ok ? response.json() : null;
  }, "/api/health");
  assert.equal(health.live, true);
  assert.equal(health.commitSha, commitSha);
  assert.equal(health.authority, "postgresql");

  const readiness = await waitFor(async () => {
    const response = await fetch(`${base}/api/ready`);
    return response.ok ? response.json() : null;
  }, "/api/ready");
  assert.equal(readiness.ready, true);
  assert.equal(readiness.checks.database, "ready");
  assert.equal(readiness.checks.tenant, "ready");
  assert.equal(readiness.checks.attachmentStorage, "ready");

  const loginResponse = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name: "Container Smoke User", company: "Container Smoke Tenant" }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.equal(login.user.tenantId, tenantId);
  const detailResponse = await fetch(`${base}/api/procurement/documents/po/${encodeURIComponent(purchaseOrderId)}`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.document.id, purchaseOrderId);

  console.log("[container-smoke] sending SIGTERM and verifying a clean exit");
  await runDocker(["kill", "--signal=SIGTERM", names.app]);
  const waited = await runDocker(["wait", names.app]);
  assert.equal(waited.stdout.trim(), "0");
  const logs = await runDocker(["logs", names.app]);
  assert.match(logs.stdout, /\[lifecycle\] shutdown complete/);
  completed = true;
  console.log("[container-smoke] PASS: migration, health, readiness, login, procurement read, and graceful shutdown");
} catch (error) {
  const logs = await runDocker(["logs", names.app], { allowFailure: true }).catch(() => ({ stdout: "", stderr: "" }));
  if (logs.stdout || logs.stderr) process.stderr.write(`[container-smoke] application logs:\n${sanitize(logs.stdout + logs.stderr)}\n`);
  throw error;
} finally {
  await runDocker(["rm", "-f", names.app], { allowFailure: true }).catch(() => {});
  await runDocker(["rm", "-f", names.postgres], { allowFailure: true }).catch(() => {});
  await runDocker(["network", "rm", names.network], { allowFailure: true }).catch(() => {});
  await runDocker(["volume", "rm", names.volume], { allowFailure: true }).catch(() => {});
  await runDocker(["image", "rm", names.image], { allowFailure: true }).catch(() => {});
  if (!completed) process.exitCode = 1;
}
