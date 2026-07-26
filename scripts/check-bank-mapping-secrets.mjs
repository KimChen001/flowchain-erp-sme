import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { findBankMappingSecretPaths } from "../server/domain/bank-projection-policy.mjs";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer().on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function isolatedEnvironment() {
  const configuredUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (configuredUrl) {
    return {
      env: { ...process.env, DATABASE_URL: configuredUrl },
      cleanup: async () => {},
    };
  }

  const port = await freePort();
  const password = `bank-scan-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "flowchain-bank-mapping-scan-"));
  const database = "flowchain_bank_mapping_scan";
  const url = `postgresql://flowchain_bank_scan:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
  const pg = new EmbeddedPostgres({
    databaseDir: directory,
    user: "flowchain_bank_scan",
    password,
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, NODE_ENV: "test" };
  await execFileAsync(node, [prismaCli, "migrate", "deploy"], {
    cwd: root,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    env,
    cleanup: async () => {
      await pg.stop().catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const runtime = await isolatedEnvironment();
const prisma = await createPrismaClient(runtime.env);
try {
  const mappings = await prisma.bankStatementMappingTemplate.findMany({
    select: { id: true, tenantId: true, templateCode: true, version: true, columnMapping: true, metadata: true },
    orderBy: [{ tenantId: "asc" }, { templateCode: "asc" }, { version: "asc" }],
  });
  const violations = mappings.flatMap((mapping) => {
    const paths = findBankMappingSecretPaths({ columnMapping: mapping.columnMapping, metadata: mapping.metadata });
    return paths.length
      ? [{ id: mapping.id, tenantId: mapping.tenantId, templateCode: mapping.templateCode, version: mapping.version, paths }]
      : [];
  });
  if (violations.length) {
    console.error(JSON.stringify({
      code: "BANK_MAPPING_SECRET_FIELD_FORBIDDEN",
      message: "Bank mapping security scan failed. Values were not inspected in output.",
      violations,
    }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ status: "passed", scannedMappings: mappings.length, violations: 0 }));
  }
} finally {
  await prisma.$disconnect();
  await runtime.cleanup();
}
