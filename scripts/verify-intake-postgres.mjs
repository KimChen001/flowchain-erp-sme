import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createIntakeServices } from "../server/domain/intake-services.mjs";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";
import { createDbIntakeRepository } from "../server/repositories/db-intake-repository.mjs";
import { LocalArtifactStorage } from "../server/storage/artifact-storage.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
const intakeMigration = "20260727010000_schema_aware_structured_intake";
let assertions = 0;

const check = (value, message) => {
  assert.ok(value, message);
  assertions += 1;
};

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

async function cluster(label) {
  const port = await freePort();
  const password = `${label}-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), `flowchain-${label}-pg-`));
  const database = `flowchain_${label.replaceAll("-", "_")}`;
  const user = `flowchain_${label.replaceAll("-", "_")}`;
  const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
  const pg = new EmbeddedPostgres({ databaseDir: directory, user, password, port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  return {
    url,
    async stop() {
      await pg.stop().catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function migrate(url, schemaPath = join(root, "prisma", "schema.prisma")) {
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function seedActor(prisma, tenantId, userId, email) {
  await prisma.tenant.create({ data: { id: tenantId, name: tenantId } });
  await prisma.user.create({ data: { id: userId, tenantId, email, name: userId, role: "admin", status: "active" } });
  return {
    tenantId,
    user: { id: userId },
    complete: true,
    authenticated: true,
    permissionCodes: new Set(),
    roleIds: [],
    permissionSourceRoleIds: new Map(),
  };
}

async function verifyAdditiveUpgrade() {
  const pg = await cluster("intake-upgrade");
  const migrationRoot = await mkdtemp(join(tmpdir(), "flowchain-intake-migrations-"));
  const tempPrisma = join(migrationRoot, "prisma");
  try {
    await mkdir(join(tempPrisma, "migrations"), { recursive: true });
    await cp(join(root, "prisma", "schema.prisma"), join(tempPrisma, "schema.prisma"), { recursive: true });
    await cp(join(root, "prisma", "migrations", "migration_lock.toml"), join(tempPrisma, "migrations", "migration_lock.toml"), { recursive: true });
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(join(root, "prisma", "migrations"), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name >= intakeMigration) continue;
      await cp(join(root, "prisma", "migrations", entry.name), join(tempPrisma, "migrations", entry.name), { recursive: true });
    }
    await migrate(pg.url, join(tempPrisma, "schema.prisma"));
    let prisma = await createPrismaClient({ ...process.env, DATABASE_URL: pg.url });
    await prisma.tenant.create({ data: { id: "upgrade-tenant", name: "Upgrade Tenant" } });
    await prisma.$disconnect();
    await cp(join(root, "prisma", "migrations", intakeMigration), join(tempPrisma, "migrations", intakeMigration), { recursive: true });
    await migrate(pg.url, join(tempPrisma, "schema.prisma"));
    prisma = await createPrismaClient({ ...process.env, DATABASE_URL: pg.url });
    check(await prisma.tenant.count({ where: { id: "upgrade-tenant" } }) === 1, "additive upgrade preserves existing tenant");
    check(await prisma.inboundArtifact.count() === 0, "additive upgrade creates empty Intake tables");
    await prisma.$disconnect();
  } finally {
    await pg.stop();
    await rm(migrationRoot, { recursive: true, force: true });
  }
}

async function verifyFreshRuntime() {
  const pg = await cluster("intake-fresh");
  const storageRoot = await mkdtemp(join(tmpdir(), "flowchain-intake-artifacts-"));
  let prisma;
  try {
    await migrate(pg.url);
    prisma = await createPrismaClient({ ...process.env, DATABASE_URL: pg.url });
    const tables = await prisma.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('InboundArtifact','IntakeBatch','IntakeRecord','MappingProfile','FieldMapping','ValidationIssue','ReviewSession','CommitAttempt','SourceReference')`);
    check(tables.length === 9, "fresh migration creates all nine Intake tables");
    const constraints = await prisma.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE conname LIKE '%tenantId%_fkey' OR conname = 'ValidationIssue_tenant_record_guard_fkey'`);
    check(constraints.some(row => row.conname === "IntakeBatch_tenantId_artifactId_fkey"), "batch/artifact tenant FK exists");
    check(constraints.some(row => row.conname === "ValidationIssue_tenant_record_guard_fkey"), "issue/record tenant guard exists");

    const actorA = await seedActor(prisma, "tenant-a", "user-a", "a@example.com");
    const actorB = await seedActor(prisma, "tenant-b", "user-b", "b@example.com");
    const repository = createDbIntakeRepository({ prisma, env: { DATABASE_URL: pg.url } });
    const storage = new LocalArtifactStorage({ rootDirectory: storageRoot });
    const services = createIntakeServices({ repository, storage });
    const contextA = { actor: actorA, requestId: "request-a" };
    const contextB = { actor: actorB, requestId: "request-b" };
    const contentBase64 = Buffer.from("name,amount\nWidget,12.50\n").toString("base64");

    const artifactA = await services.artifacts.register({ sourceType: "manual_upload", originalFilename: "../safe.csv", mimeType: "text/csv", contentBase64 }, contextA);
    check(artifactA.originalFilename === "safe.csv", "artifact filename is metadata-only and sanitized");
    check(!("storageKey" in artifactA) && !("storageProvider" in artifactA), "artifact DTO hides storage internals");
    await assert.rejects(
      () => services.artifacts.register({ sourceType: "manual_upload", originalFilename: "duplicate.csv", mimeType: "text/csv", contentBase64 }, contextA),
      error => error.code === "INTAKE_ARTIFACT_DUPLICATE",
    );
    assertions += 1;
    const artifactB = await services.artifacts.register({ sourceType: "manual_upload", originalFilename: "tenant-b.csv", mimeType: "text/csv", contentBase64 }, contextB);
    check(artifactB.id !== artifactA.id, "duplicate checksum is scoped by tenant");
    check((await services.artifacts.list({}, contextB)).artifacts.every(row => row.id !== artifactA.id), "artifact list is tenant isolated");
    await assert.rejects(() => services.batches.create({ artifactId: artifactA.id, batchType: "generic" }, contextB), error => error.code === "INTAKE_ARTIFACT_NOT_FOUND");
    assertions += 1;

    const batch = await services.batches.create({ artifactId: artifactA.id, batchType: "generic" }, contextA);
    check(batch.status === "uploaded" && batch.version === 0, "batch starts uploaded at version zero");
    await assert.rejects(
      () => prisma.intakeBatch.create({ data: { id: randomUUID(), tenantId: "tenant-b", artifactId: artifactA.id, batchType: "probe", createdByUserId: "user-b" } }),
      error => error.code === "P2003",
    );
    assertions += 1;
    const profiling = await services.batches.transition(batch.id, "profiling", { expectedVersion: 0 }, contextA);
    check(profiling.status === "profiling" && profiling.version === 1, "state transition increments version");
    await assert.rejects(() => services.batches.transition(batch.id, "completed", { expectedVersion: 1 }, contextA), error => error.code === "INTAKE_BATCH_TRANSITION_INVALID");
    assertions += 1;
    const recordResult = await services.batches.addRecords(batch.id, {
      rules: [{ field: "name", required: true }, { field: "amount", type: "decimal" }],
      records: [{ name: "", amount: "bad" }, { name: "Widget", amount: "12.50", supplierTokenNumber: "NORMAL-1" }],
    }, contextA);
    check(recordResult.counts.added === 2 && recordResult.counts.errors === 1 && recordResult.counts.valid === 1, "generic record validation persists honest counts");
    const mappingRequired = await services.batches.transition(batch.id, "mapping_required", { expectedVersion: 1 }, contextA);
    check(mappingRequired.status === "mapping_required", "batch requires mapping before normalization");
    const normalizing = await services.batches.transition(batch.id, "normalizing", { expectedVersion: 2 }, contextA);
    check(normalizing.status === "normalizing", "batch enters normalizing");
    const validation = await services.batches.transition(batch.id, "validation_required", { expectedVersion: 3 }, contextA);
    check(validation.status === "validation_required", "batch enters validation_required");
    await assert.rejects(() => services.batches.transition(batch.id, "ready_for_review", { expectedVersion: 4 }, contextA), error => error.code === "INTAKE_UNRESOLVED_ERRORS");
    assertions += 1;
    const issueList = await services.issues.list(batch.id, {}, contextA);
    check(issueList.issues.length === 2 && issueList.issues.every(issue => !issue.resolved), "validation issues persist");
    for (const issue of issueList.issues) await services.issues.resolve(issue.id, contextA);
    const ready = await services.batches.transition(batch.id, "ready_for_review", { expectedVersion: 4 }, contextA);
    check(ready.status === "ready_for_review", "resolved errors permit review readiness");
    const review = await services.reviews.open(batch.id, { comment: "Review foundation" }, contextA);
    const approved = await services.reviews.decide(review.id, "approved", { comment: "Approved for future adapter review only" }, contextA);
    check(approved.status === "approved" && approved.decision === "approved", "review decision persists without business commit");

    const mappingV1 = await services.mappings.create({
      name: "Generic mapping", recordType: "generic", sourceSignature: "name|amount",
      fieldMappings: [{ sourceField: "name", targetField: "name", transformType: "trim" }],
    }, contextA);
    await services.mappings.activate(mappingV1.id, contextA);
    const mappingV2 = await services.mappings.create({
      name: "Generic mapping v2", recordType: "generic", sourceSignature: "name|amount",
      fieldMappings: [{ sourceField: "amount", targetField: "amount", transformType: "decimal" }],
    }, contextA);
    await services.mappings.activate(mappingV2.id, contextA);
    const profiles = (await services.mappings.list({}, contextA)).mappingProfiles;
    check(profiles.find(row => row.id === mappingV1.id)?.status === "retired", "activating a revision retires the previous active mapping");
    check(profiles.find(row => row.id === mappingV2.id)?.version === 2, "mapping revisions increment version");

    const businessCountsBefore = await Promise.all([prisma.supplier.count(), prisma.item.count(), prisma.purchaseOrder.count(), prisma.inventoryMovement.count()]);
    const blocked = await services.commits.attempt(batch.id, { idempotencyKey: "commit-key-1" }, contextA);
    check(blocked.code === "FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED" && blocked.status === "blocked", "commit attempt fails closed");
    const replay = await services.commits.attempt(batch.id, { idempotencyKey: "commit-key-1" }, contextA);
    check(replay.idempotentReplay === true && replay.attemptId === blocked.attemptId, "blocked commit attempt is idempotent");
    const businessCountsAfter = await Promise.all([prisma.supplier.count(), prisma.item.count(), prisma.purchaseOrder.count(), prisma.inventoryMovement.count()]);
    check(JSON.stringify(businessCountsBefore) === JSON.stringify(businessCountsAfter), "commit attempt writes no business tables");
    check(await prisma.commitAttempt.count({ where: { tenantId: "tenant-a", status: "blocked" } }) === 1, "blocked attempt is durable");
    check(await prisma.auditLog.count({ where: { tenantId: "tenant-a", source: "universal_intake" } }) >= 10, "Intake lifecycle writes compact audit evidence");

    await prisma.$disconnect();
    prisma = await createPrismaClient({ ...process.env, DATABASE_URL: pg.url });
    const restarted = createIntakeServices({ repository: createDbIntakeRepository({ prisma, env: { DATABASE_URL: pg.url } }), storage });
    check((await restarted.batches.get(batch.id, contextA)).reviewStatus === "approved", "batch and review survive client restart");
    check((await restarted.batches.listRecords(batch.id, {}, contextA)).records.length === 2, "records survive client restart");
  } finally {
    await prisma?.$disconnect().catch(() => {});
    await pg.stop();
    await rm(storageRoot, { recursive: true, force: true });
  }
}

try {
  await verifyAdditiveUpgrade();
  await verifyFreshRuntime();
  console.log(`Universal Intake PostgreSQL gate: ${assertions} passed, 0 failed, 0 skipped`);
} catch (error) {
  console.error(`Universal Intake PostgreSQL gate: FAIL\n${String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\\s]+/gi, "[REDACTED_DATABASE_URL]")}`);
  process.exitCode = 1;
}
