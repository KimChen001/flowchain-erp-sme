import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { requireTenantId, safePage } from "../domain/intake-contracts.mjs";

const requireId = (value, label = "id") => {
  const id = String(value || "").trim();
  if (!id) {
    const error = new Error(`${label} is required.`);
    error.code = "INTAKE_ID_REQUIRED";
    error.status = 422;
    throw error;
  }
  return id;
};

function createRepository(resolveClient) {
  const client = () => resolveClient();
  return {
    mode: "database",
    adapter: "db-intake-v1",
    transaction: async callback => {
      const db = await client();
      return db.$transaction(tx => callback(createRepository(async () => tx)));
    },
    createArtifact: async data => (await client()).inboundArtifact.create({ data }),
    findArtifactByChecksum: async (tenantId, checksumSha256) => (await client()).inboundArtifact.findUnique({
      where: { tenantId_checksumSha256: { tenantId: requireTenantId(tenantId), checksumSha256: requireId(checksumSha256, "checksumSha256") } },
    }),
    getArtifact: async (tenantId, id) => (await client()).inboundArtifact.findFirst({ where: { tenantId: requireTenantId(tenantId), id: requireId(id), deletedAt: null } }),
    listArtifacts: async (tenantId, page = {}) => {
      const { limit, cursor } = safePage(page);
      const rows = await (await client()).inboundArtifact.findMany({
        where: { tenantId: requireTenantId(tenantId), deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return { rows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    createSourceReference: async data => (await client()).sourceReference.create({ data }),
    createBatch: async data => (await client()).intakeBatch.create({ data }),
    getBatch: async (tenantId, id, include = {}) => (await client()).intakeBatch.findFirst({ where: { tenantId: requireTenantId(tenantId), id: requireId(id) }, include }),
    listBatches: async (tenantId, page = {}) => {
      const { limit, cursor } = safePage(page);
      const rows = await (await client()).intakeBatch.findMany({
        where: { tenantId: requireTenantId(tenantId) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return { rows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    transitionBatch: async ({ tenantId, id, from, to, expectedVersion, data = {} }) => {
      const result = await (await client()).intakeBatch.updateMany({
        where: { tenantId: requireTenantId(tenantId), id: requireId(id), status: from, version: expectedVersion },
        data: { ...data, status: to, version: { increment: 1 } },
      });
      return result.count;
    },
    createRecord: async data => (await client()).intakeRecord.create({ data }),
    createIssue: async data => (await client()).validationIssue.create({ data }),
    updateBatchCounts: async (tenantId, id, data) => (await client()).intakeBatch.updateMany({
      where: { tenantId: requireTenantId(tenantId), id: requireId(id) },
      data,
    }),
    listRecords: async (tenantId, batchId, page = {}) => {
      const { limit, cursor } = safePage(page);
      const rows = await (await client()).intakeRecord.findMany({
        where: { tenantId: requireTenantId(tenantId), batchId: requireId(batchId, "batchId") },
        orderBy: [{ rowNumber: "asc" }, { id: "asc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return { rows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    listRecordFingerprints: async (tenantId, batchId) => (await client()).intakeRecord.findMany({
      where: { tenantId: requireTenantId(tenantId), batchId: requireId(batchId, "batchId") },
      select: { fingerprint: true },
      take: 5_000,
    }),
    createMappingProfile: async data => (await client()).mappingProfile.create({ data }),
    getMappingProfile: async (tenantId, id) => (await client()).mappingProfile.findFirst({
      where: { tenantId: requireTenantId(tenantId), id: requireId(id) },
      include: { fieldMappings: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
    }),
    listMappingProfiles: async (tenantId, page = {}) => {
      const { limit, cursor } = safePage(page);
      const rows = await (await client()).mappingProfile.findMany({
        where: { tenantId: requireTenantId(tenantId) },
        include: { fieldMappings: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return { rows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    nextMappingVersion: async (tenantId, recordType, sourceSignature) => {
      const row = await (await client()).mappingProfile.aggregate({
        where: { tenantId: requireTenantId(tenantId), recordType, sourceSignature },
        _max: { version: true },
      });
      return Number(row._max.version || 0) + 1;
    },
    createFieldMappings: async data => (await client()).fieldMapping.createMany({ data }),
    updateMappingStatus: async (tenantId, id, status) => (await client()).mappingProfile.updateMany({
      where: { tenantId: requireTenantId(tenantId), id: requireId(id) },
      data: { status },
    }),
    retireActiveMappings: async (tenantId, recordType, sourceSignature, exceptId) => (await client()).mappingProfile.updateMany({
      where: { tenantId: requireTenantId(tenantId), recordType, sourceSignature, status: "active", id: { not: exceptId } },
      data: { status: "retired" },
    }),
    listIssues: async (tenantId, batchId, page = {}) => {
      const { limit, cursor } = safePage(page);
      const rows = await (await client()).validationIssue.findMany({
        where: { tenantId: requireTenantId(tenantId), batchId: requireId(batchId, "batchId") },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return { rows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    },
    unresolvedErrorCount: async (tenantId, batchId) => (await client()).validationIssue.count({
      where: { tenantId: requireTenantId(tenantId), batchId: requireId(batchId, "batchId"), severity: "error", resolved: false },
    }),
    resolveIssue: async (tenantId, id, resolvedByUserId, resolvedAt) => (await client()).validationIssue.updateMany({
      where: { tenantId: requireTenantId(tenantId), id: requireId(id), resolved: false },
      data: { resolved: true, resolvedByUserId, resolvedAt },
    }),
    createReview: async data => (await client()).reviewSession.create({ data }),
    getReview: async (tenantId, id) => (await client()).reviewSession.findFirst({ where: { tenantId: requireTenantId(tenantId), id: requireId(id) } }),
    completeReview: async (tenantId, id, status, decision, comment, completedAt) => (await client()).reviewSession.updateMany({
      where: { tenantId: requireTenantId(tenantId), id: requireId(id), status: "open" },
      data: { status, decision, comment, completedAt },
    }),
    createCommitAttempt: async data => (await client()).commitAttempt.create({ data }),
    findCommitAttempt: async (tenantId, idempotencyKey) => (await client()).commitAttempt.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: requireTenantId(tenantId), idempotencyKey: requireId(idempotencyKey, "idempotencyKey") } },
    }),
    createAudit: async data => (await client()).auditLog.create({ data }),
  };
}

export function createDbIntakeRepository({ prisma, env = process.env } = {}) {
  return createRepository(async () => prisma || getPrismaClient(env));
}
