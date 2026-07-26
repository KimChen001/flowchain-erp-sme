import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { createCustomFieldService } from "../server/domain/custom-field-service.mjs";
import { createIntakeServices } from "../server/domain/intake-services.mjs";
import { createStructuredIntakeService } from "../server/domain/structured-intake-service.mjs";
import { resolveTenantEntitySchema } from "../server/domain/tenant-schema-resolver.mjs";
import { createPrismaClient } from "../server/persistence/prisma-client.mjs";
import { createDbIntakeRepository } from "../server/repositories/db-intake-repository.mjs";
import { LocalArtifactStorage } from "../server/storage/artifact-storage.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
let assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer().on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const port = await freePort();
const password = `structured-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), "flowchain-structured-pg-"));
const storageRoot = await mkdtemp(join(tmpdir(), "flowchain-structured-storage-"));
const url = `postgresql://flowchain_structured:${encodeURIComponent(password)}@127.0.0.1:${port}/flowchain_structured?schema=public`;
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_structured", password, port, persistent: false, onLog: () => {}, onError: () => {} });
let prisma;

const actor = (tenantId, userId) => ({
  tenantId, user: { id: userId }, complete: true, authenticated: true,
  permissionCodes: new Set(), roleIds: [], permissionSourceRoleIds: new Map(),
});

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("flowchain_structured");
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", join(root, "prisma", "schema.prisma")], {
    cwd: root, env: { ...process.env, DATABASE_URL: url }, maxBuffer: 20 * 1024 * 1024,
  });
  prisma = await createPrismaClient({ ...process.env, DATABASE_URL: url });
  for (const [tenantId, userId] of [["tenant-a", "user-a"], ["tenant-b", "user-b"]]) {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId } });
    await prisma.user.create({ data: { id: userId, tenantId, email: `${userId}@example.com`, name: userId, role: "admin", status: "active" } });
  }
  const repository = createDbIntakeRepository({ prisma, env: { DATABASE_URL: url } });
  const storage = new LocalArtifactStorage({ rootDirectory: storageRoot });
  const baseServices = createIntakeServices({ repository, storage });
  const customFields = createCustomFieldService({ repository });
  const structured = createStructuredIntakeService({ repository, storage, baseServices });
  const contextA = { actor: actor("tenant-a", "user-a"), requestId: "structured-a" };
  const contextB = { actor: actor("tenant-b", "user-b"), requestId: "structured-b" };

  const definition = await customFields.create({
    entityType: "supplier", fieldKey: "strategic_grade", label: "Strategic Grade", dataType: "single_select",
    options: [{ value: "A", label: "Grade A" }, { value: "B", label: "Grade B" }],
  }, contextA);
  check(definition.status === "draft" && definition.revisions[0].version === 1, "custom field starts as an immutable draft revision");
  const published = await customFields.publish(definition.id, { revisionId: definition.revisions[0].id }, contextA);
  check(published.status === "published" && published.currentRevisionId === definition.revisions[0].id, "custom field revision publishes explicitly");
  check((await customFields.list({ entityType: "supplier" }, contextB)).customFields.length === 0, "custom fields are tenant isolated");
  await assert.rejects(() => customFields.get(definition.id, contextB), error => error.code === "CUSTOM_FIELD_NOT_FOUND");
  assertions += 1;
  await assert.rejects(() => customFields.revise(definition.id, { label: "Changed Type", dataType: "date" }, contextA), error => error.code === "CUSTOM_FIELD_TYPE_IMMUTABLE");
  assertions += 1;
  await assert.rejects(() => customFields.create({ entityType: "supplier", fieldKey: "invalid_select", label: "Invalid", dataType: "single_select" }, contextA), error => error.code === "CUSTOM_FIELD_OPTIONS_REQUIRED");
  assertions += 1;

  const resolved = await resolveTenantEntitySchema({ repository, tenantId: "tenant-a", recordType: "supplier" });
  check(resolved.fields.some(field => field.fieldPath === "supplier.custom.strategic_grade"), "published custom field enters resolved tenant schema");
  await prisma.supplier.create({ data: { id: "supplier-existing", tenantId: "tenant-a", code: "SUP-NEW", name: "Suzhou Components", status: "active", metadata: { currency: "CNY" } } });
  const csv = Buffer.from("供应商编码,供应商名称,strategic_grade\nSUP-NEW,Suzhou Components,A\n", "utf8");
  const artifact = await baseServices.artifacts.register({
    sourceType: "manual_upload", originalFilename: "suppliers.csv", mimeType: "text/csv", contentBase64: csv.toString("base64"),
  }, contextA);
  const batch = await baseServices.batches.create({ artifactId: artifact.id, batchType: "supplier" }, contextA);
  const profiled = await structured.profile(batch.id, {}, contextA);
  check(profiled.batch.status === "mapping_required" && profiled.profile.rowCount === 1, "parser owns record creation after artifact profiling");
  check(await prisma.intakeRecord.count({ where: { tenantId: "tenant-a", batchId: batch.id } }) === 1, "parser-created IntakeRecord is PostgreSQL durable");
  const snapshot = await prisma.intakeSchemaSnapshot.findFirst({ where: { tenantId: "tenant-a", batchId: batch.id } });
  check(snapshot?.tenantSchemaHash === resolved.tenantSchemaHash, "batch captures an immutable resolved schema snapshot");
  await assert.rejects(() => structured.schema(batch.id, contextB), error => error.code === "INTAKE_BATCH_NOT_FOUND");
  assertions += 1;
  const suggestions = await structured.suggestions(batch.id, contextA);
  check(suggestions.suggestions.every(value => value.targetFieldPath), "Chinese aliases produce deterministic mapping suggestions");
  await structured.confirmMapping(batch.id, {
    mappings: [
      { sourceField: "供应商编码", targetFieldPath: "supplier.code", transformType: "trim" },
      { sourceField: "供应商名称", targetFieldPath: "supplier.name", transformType: "trim" },
      { sourceField: "strategic_grade", targetFieldPath: "supplier.custom.strategic_grade", transformType: "identity" },
    ],
  }, contextA);
  const normalized = await structured.normalize(batch.id, contextA);
  check(normalized.batch.status === "validation_required", "normalization reaches validation_required");
  const validation = await structured.validate(batch.id, contextA);
  check(validation.batch.status === "ready_for_review" && validation.counts.valid === 1, "valid structured preview reaches ready_for_review");
  check(validation.counts.existingIdentical === 1 && validation.counts.existingDifferent === 0, "reference preview distinguishes an identical PostgreSQL supplier");
  const record = await prisma.intakeRecord.findFirst({ where: { tenantId: "tenant-a", batchId: batch.id } });
  check(record.normalizedPayload.customFields.strategic_grade === "A", "normalization separates tenant customFields");
  check(record.normalizationEvidence.every(value => value.mappingProfileId), "normalization evidence identifies mapping profile and version");
  check(await prisma.supplier.count() === 1 && await prisma.item.count() === 0, "structured intake never creates business master data");

  const later = await customFields.create({ entityType: "supplier", fieldKey: "later_flag", label: "Later Flag", dataType: "boolean" }, contextA);
  await customFields.publish(later.id, {}, contextA);
  const unchanged = await structured.schema(batch.id, contextA);
  check(unchanged.tenantSchemaHash === snapshot.tenantSchemaHash && !unchanged.fields.some(field => field.fieldPath.endsWith("later_flag")), "published fields do not mutate an in-flight batch snapshot");
  check(await prisma.auditLog.count({ where: { tenantId: "tenant-a", module: "universal-intake" } }) >= 10, "custom field and structured lifecycle writes compact audit evidence");

  console.log(`Structured Intake PostgreSQL gate: ${assertions} passed, 0 failed, 0 skipped`);
} catch (error) {
  console.error(`Structured Intake PostgreSQL gate: FAIL\n${String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")}`);
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
}
