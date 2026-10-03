import { PilotIdentityError, resolveProvisionedActor } from './pilot-identity.mjs'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { countActiveRoleManagers } from '../auth/authorization-admin-service.mjs'

const fail = (code, message, status = 400) => { throw new PilotIdentityError(code, message, status) }
const DATASETS = new Set(['receiving_documents', 'inventory_movements', 'inventory_balances', 'import_issues'])

export function createPilotOperationsService({ prisma, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('Prisma client is required for Pilot operations.')

  async function diagnostics(identity) {
    const actor = await resolveProvisionedActor(prisma, identity)
    assertAuthorized({ actor, permission: 'settings.diagnostics.read', tenantId: actor.tenantId })
    // Counted from role assignments and warehouse scopes. The legacy User.role
    // grants nothing: an admin by that name sees only their scoped warehouses.
    const [tenant, activeWarehouses, activeUsers, roleManagers, unscopedUsers, pendingImports, failedImports, migrationRows] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { workspaceCompletedAt: true, openingBalanceLockedAt: true } }),
      prisma.warehouse.count({ where: { tenantId: actor.tenantId, status: 'active' } }),
      prisma.user.count({ where: { tenantId: actor.tenantId, status: 'active' } }),
      countActiveRoleManagers(prisma, actor.tenantId),
      prisma.user.count({ where: { tenantId: actor.tenantId, status: 'active', warehouseScopes: { none: {} } } }),
      prisma.importBatch.count({ where: { tenantId: actor.tenantId, status: { in: ['uploaded', 'validated', 'ready', 'committing'] } } }),
      prisma.importBatch.count({ where: { tenantId: actor.tenantId, status: { in: ['blocked', 'failed'] } } }),
      prisma.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
    ])
    const checks = [
      { id: 'migrations', status: Number(migrationRows[0]?.count || 0) >= 4 ? 'pass' : 'fail', detail: `${Number(migrationRows[0]?.count || 0)} migrations applied` },
      { id: 'workspace', status: tenant?.workspaceCompletedAt ? 'pass' : 'warn', detail: tenant?.workspaceCompletedAt ? 'Workspace profile complete' : 'Workspace profile incomplete' },
      { id: 'warehouses', status: activeWarehouses > 0 ? 'pass' : 'fail', detail: `${activeWarehouses} active warehouses` },
      { id: 'users', status: activeUsers > 0 && roleManagers > 0 ? 'pass' : 'fail', detail: `${activeUsers} active users; ${roleManagers} can manage roles` },
      { id: 'warehouse_scopes', status: unscopedUsers === 0 ? 'pass' : 'warn', detail: `${unscopedUsers} active users without warehouse scope` },
      { id: 'imports', status: failedImports === 0 ? 'pass' : 'warn', detail: `${pendingImports} pending; ${failedImports} blocked or failed` },
    ]
    return { generatedAt: now().toISOString(), workspaceId: actor.tenantId, overall: checks.some(row => row.status === 'fail') ? 'not_ready' : checks.some(row => row.status === 'warn') ? 'attention' : 'ready', checks, openingBalanceLocked: Boolean(tenant?.openingBalanceLockedAt), safe: true }
  }

  async function exportDataset(dataset, identity) {
    const actor = await resolveProvisionedActor(prisma, identity)
    assertAuthorized({ actor, permission: 'settings.export.read', tenantId: actor.tenantId })
    if (!DATASETS.has(dataset)) fail('EXPORT_DATASET_UNSUPPORTED', 'Pilot export dataset is not supported.', 404)
    const warehouseWhere = actor.allWarehouses ? {} : { warehouseId: { in: [...actor.readWarehouseIds] } }
    let rows = []
    if (dataset === 'receiving_documents') rows = await prisma.receivingDocument.findMany({ where: { tenantId: actor.tenantId, ...warehouseWhere }, orderBy: { updatedAt: 'desc' }, take: 5001, select: { documentNumber: true, poId: true, status: true, workflowStatus: true, postingStatus: true, warehouseId: true, postedAt: true, updatedAt: true } })
    if (dataset === 'inventory_movements') rows = await prisma.inventoryMovement.findMany({ where: { tenantId: actor.tenantId, ...warehouseWhere }, orderBy: { occurredAt: 'desc' }, take: 5001, select: { id: true, movementType: true, sku: true, warehouseId: true, location: true, quantityIn: true, quantityOut: true, adjustmentQty: true, sourceDocument: true, status: true, occurredAt: true } })
    if (dataset === 'inventory_balances') rows = await prisma.inventoryBalance.findMany({ where: { tenantId: actor.tenantId, ...warehouseWhere }, orderBy: [{ sku: 'asc' }, { warehouseId: 'asc' }], take: 5001, select: { sku: true, warehouseId: true, location: true, onHandQuantity: true, availableQuantity: true, reservedQuantity: true, unit: true, status: true, updatedAt: true } })
    if (dataset === 'import_issues') rows = await prisma.importIssue.findMany({ where: { tenantId: actor.tenantId }, orderBy: [{ createdAt: 'desc' }, { rowNumber: 'asc' }], take: 5001, select: { importBatchId: true, rowNumber: true, field: true, code: true, message: true, rawValue: true, createdAt: true } })
    const truncated = rows.length > 5000
    return { dataset, generatedAt: now().toISOString(), rows: rows.slice(0, 5000), rowCount: Math.min(rows.length, 5000), truncated, tenantScoped: true, warehouseScoped: dataset !== 'import_issues' }
  }
  return { diagnostics, exportDataset }
}
