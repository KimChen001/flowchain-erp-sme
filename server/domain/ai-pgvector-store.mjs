import { createHash } from 'node:crypto'

const dimensions = value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 4096 ? Number(value) : null
const vectorLiteral = vector => `[${vector.map(value => Number(value)).join(',')}]`
const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`

export async function hasPgvectorKnowledgeStore(prisma) {
  if (typeof prisma?.$queryRawUnsafe !== 'function') return false
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'AiKnowledgeChunk' AND column_name = 'embeddingVector') AS enabled`)
    return rows?.[0]?.enabled === true
  } catch { return false }
}

export async function persistPgvectorEmbeddings(prisma, chunks, embedded) {
  const size = dimensions(embedded?.dimensions)
  if (!size || !embedded?.ok || !(await hasPgvectorKnowledgeStore(prisma))) return { enabled: false }
  try {
    for (let index = 0; index < chunks.length; index += 1) await prisma.$executeRawUnsafe(`UPDATE "AiKnowledgeChunk" SET "embeddingVector" = $1::vector WHERE id = $2`, vectorLiteral(embedded.vectors[index]), chunks[index].id)
    const suffix = createHash('sha256').update(`${embedded.model}:${size}`).digest('hex').slice(0, 12)
    const indexName = `AiKnowledgeChunk_embedding_hnsw_${suffix}`
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "AiKnowledgeChunk" USING hnsw (("embeddingVector"::vector(${size})) vector_cosine_ops) WHERE "embeddingModel" = ${sqlLiteral(embedded.model)} AND "embeddingDimensions" = ${size}`)
    return { enabled: true, indexName }
  } catch { return { enabled: false } }
}

export async function pgvectorKnowledgeRanks(prisma, actor, queryVector, model, limit = 50) {
  const size = dimensions(queryVector?.length)
  if (!size || !(await hasPgvectorKnowledgeStore(prisma))) return null
  const permissions = [...(actor.permissionCodes || [])]
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT c.id, 1 - (c."embeddingVector"::vector(${size}) <=> $1::vector(${size})) AS score FROM "AiKnowledgeChunk" c JOIN "AiKnowledgeDocument" d ON d.id = c."documentId" WHERE d."tenantId" = $2 AND d.status = 'active' AND c."embeddingVector" IS NOT NULL AND c."embeddingModel" = $3 AND c."embeddingDimensions" = ${size} AND (d."requiredPermission" IS NULL OR d."requiredPermission" = ANY($4::text[])) ORDER BY c."embeddingVector"::vector(${size}) <=> $1::vector(${size}) LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 100)}`, vectorLiteral(queryVector), actor.tenantId, model, permissions)
    return rows.map(row => ({ id: row.id, score: Number(row.score) }))
  } catch { return null }
}
