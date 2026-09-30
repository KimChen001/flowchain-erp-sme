import { buildTodayCockpit } from './today-cockpit-read-model.mjs'
import { buildUserDataScope } from './user-data-contract.mjs'

function isRepositoryAvailable(repository, methods = []) {
  return repository && methods.every((method) => typeof repository[method] === 'function')
}

async function readProcurement(repository, scope) {
  if (!isRepositoryAvailable(repository, ['listDocuments', 'listFollowups', 'getSummary'])) return null
  const [procurementDocuments, procurementFollowups, procurementSummary] = await Promise.all([
    repository.listDocuments(scope),
    repository.listFollowups(scope),
    repository.getSummary(scope),
  ])
  return { procurementDocuments, procurementFollowups, procurementSummary }
}

async function readInventory(repository, scope) {
  if (!isRepositoryAvailable(repository, ['listItems', 'listExceptions', 'getSummary'])) return null
  const [inventoryItems, inventoryExceptions, inventorySummary] = await Promise.all([
    repository.listItems(scope),
    repository.listExceptions(scope),
    repository.getSummary(scope),
  ])
  return { inventoryItems, inventoryExceptions, inventorySummary }
}

async function readMasterData(repository, scope) {
  if (!isRepositoryAvailable(repository, ['listItems', 'listSuppliers'])) return null
  const [items, suppliers] = await Promise.all([
    repository.listItems(scope),
    repository.listSuppliers(scope),
  ])
  return { items, suppliers }
}

export async function buildAiReadContext(db = {}, ctx = {}) {
  const repositories = ctx.repositories || {}
  const dataMode = ctx.dataMode || db.__dataMode || 'test'
  let userDataRuntime = null
  let contextDb = ctx.businessReadDb || db

  if (dataMode === 'user' && isRepositoryAvailable(repositories.userDataRuntime, ['getAIReadableContext'])) {
    const scope = buildUserDataScope(ctx.userDataScope || ctx.scope || {})
    const userContext = await repositories.userDataRuntime.getAIReadableContext(scope)
    userDataRuntime = userContext
      ? {
          active: true,
          scope,
          datasetId: userContext.datasetId,
          importBatchId: userContext.importBatchId,
          recordCounts: userContext.recordCounts,
        }
      : {
          active: false,
          scope,
          reason: 'no_active_user_dataset',
          recordCounts: {},
        }
    if (userContext?.db) contextDb = userContext.db
  }

  // Read only the signed-in workspace. The repositories reject a missing tenant.
  const tenantScope = { tenantId: ctx.identity?.tenantId }
  const [procurement, inventory, masterData] = await Promise.all([
    readProcurement(repositories.procurementRead, tenantScope),
    readInventory(repositories.inventoryRead, tenantScope),
    readMasterData(repositories.masterData, tenantScope),
  ])

  const repositoryBacked = {
    procurementRead: Boolean(procurement),
    inventoryRead: Boolean(inventory),
    masterData: Boolean(masterData),
  }
  const cache = {}

  if (procurement || inventory) {
    const aiEvidenceReuse = {
      procurementDocuments: procurement?.procurementDocuments || [],
      procurementFollowups: procurement?.procurementFollowups || [],
      procurementSummary: procurement?.procurementSummary || {},
      inventoryItems: inventory?.inventoryItems || [],
      inventoryExceptions: inventory?.inventoryExceptions || [],
      inventorySummary: inventory?.inventorySummary || {},
    }
    aiEvidenceReuse.todayCockpit = buildTodayCockpit(contextDb, aiEvidenceReuse)
    cache.aiEvidenceReuse = aiEvidenceReuse
  }

  return {
    db: contextDb,
    dataMode,
    cache,
    repositoryBacked,
    userDataRuntime,
    masterData: masterData || null,
    businessReadContext: ctx.businessReadContext || null,
    dataLimitations: ctx.businessReadContext?.dataLimitations || [],
  }
}
