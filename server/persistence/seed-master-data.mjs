import { buildMasterDataSeedPlan, buildMasterDataSeedRows } from './seed-master-data-plan.mjs'
import { envForTestDatabase } from './test-db-config.mjs'
import { getPrismaClient } from './prisma-client.mjs'

function countRows(rows = {}) {
  return {
    tenants: rows.tenant ? 1 : 0,
    paymentTerms: rows.paymentTerms?.length || 0,
    taxCodes: rows.taxCodes?.length || 0,
    suppliers: rows.suppliers?.length || 0,
    warehouses: rows.warehouses?.length || 0,
    items: rows.items?.length || 0,
  }
}

async function upsertMany(model, rows = [], toWhere = (row) => ({ id: row.id })) {
  let upserted = 0
  for (const row of rows) {
    await model.upsert({
      where: toWhere(row),
      update: row,
      create: row,
    })
    upserted += 1
  }
  return upserted
}

export function buildMasterDataSeedPreview(db = {}, options = {}) {
  const rows = buildMasterDataSeedRows(db, options)
  return {
    plan: buildMasterDataSeedPlan(db, options),
    rowCounts: countRows(rows),
    rows,
    mutatesSource: false,
  }
}

export async function seedMasterData(db = {}, options = {}) {
  const dryRun = options.dryRun !== false
  const preview = buildMasterDataSeedPreview(db, { ...options, dryRun })
  if (dryRun) return { mode: 'dry-run', ...preview }

  const clientEnv = envForTestDatabase(options.env || process.env)
  if (clientEnv.DATABASE_URL) process.env.DATABASE_URL = clientEnv.DATABASE_URL
  const prisma = options.prisma || await getPrismaClient(clientEnv)
  const rows = preview.rows

  const counts = {
    tenants: await upsertMany(prisma.tenant, [rows.tenant]),
    paymentTerms: await upsertMany(prisma.paymentTerm, rows.paymentTerms),
    taxCodes: await upsertMany(prisma.taxCode, rows.taxCodes),
    suppliers: await upsertMany(prisma.supplier, rows.suppliers),
    warehouses: await upsertMany(prisma.warehouse, rows.warehouses),
    items: await upsertMany(prisma.item, rows.items),
  }

  return {
    mode: 'apply',
    plan: preview.plan,
    rowCounts: preview.rowCounts,
    upsertedCounts: counts,
    mutatesSource: false,
  }
}
