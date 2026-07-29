import { randomUUID } from 'node:crypto'
import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs'
import { backfillTenantAuthorization } from '../server/auth/authorization-backfill.mjs'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'

const args = new Map(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=')
  return [key, rest.join('=') || 'true']
}))
const value = (name, fallback = '') => String(args.get(name) || process.env[`FLOWCHAIN_PILOT_${name.replace(/-/g, '_').toUpperCase()}`] || fallback).trim()
assertLocalDevelopment(process.env, 'pilot:setup')

const tenantId = value('tenant-id', process.env.FLOWCHAIN_DEFAULT_TENANT_ID)
if (!tenantId) throw new Error('--tenant-id or FLOWCHAIN_DEFAULT_TENANT_ID is required.')
const config = {
  tenantId,
  workspaceName: value('workspace-name', 'FlowChain Local Workspace'),
  adminEmail: value('admin-email', 'admin@flowchain.local').toLowerCase(),
  adminName: value('admin-name', 'Initial Admin'),
  warehouseCode: value('warehouse-code', 'MAIN'),
  warehouseName: value('warehouse-name', 'Local 主仓'),
}

const prisma = await getPrismaClient(process.env)
try {
  const result = await prisma.$transaction(async tx => {
    let tenant = await tx.tenant.findUnique({ where: { id: config.tenantId } })
    if (!tenant) tenant = await tx.tenant.create({ data: { id: config.tenantId, name: config.workspaceName } })
    let warehouse = await tx.warehouse.findFirst({ where: { tenantId: tenant.id, code: config.warehouseCode } })
    if (!warehouse) warehouse = await tx.warehouse.create({ data: { id: `WH-${randomUUID()}`, tenantId: tenant.id, code: config.warehouseCode, name: config.warehouseName, status: 'active' } })
    let admin = await tx.user.findFirst({ where: { tenantId: tenant.id, email: config.adminEmail } })
    if (!admin) admin = await tx.user.create({ data: { id: `USR-${randomUUID()}`, tenantId: tenant.id, email: config.adminEmail, name: config.adminName, role: 'admin', status: 'active', defaultWarehouseId: warehouse.id } })
    let kim = await tx.user.findFirst({ where: { tenantId: tenant.id, email: 'kim@example.com' } })
    if (!kim) kim = await tx.user.create({ data: { id: `USR-${randomUUID()}`, tenantId: tenant.id, email: 'kim@example.com', name: 'Kim', role: 'manager', jobTitle: '供应链经理', status: 'active', defaultWarehouseId: warehouse.id } })
    // Warehouse scope is deliberately limited to the schema's read/operate
    // boundary. Administrative authority comes from formal role assignments.
    for (const [userId, accessLevel] of [[admin.id, 'operate'], [kim.id, 'operate']]) {
      await tx.userWarehouseScope.upsert({ where: { tenantId_userId_warehouseId: { tenantId: tenant.id, userId, warehouseId: warehouse.id } }, create: { id: randomUUID(), tenantId: tenant.id, userId, warehouseId: warehouse.id, accessLevel }, update: {} })
    }
    return { tenantId: tenant.id, workspaceName: tenant.name, warehouseId: warehouse.id, admin, kim }
  })
  await backfillTenantAuthorization(prisma, result.tenantId, { actorId: result.admin.id })
  const assignments = await prisma.userRoleAssignment.findMany({
    where: { tenantId: result.tenantId, userId: { in: [result.admin.id, result.kim.id] }, status: 'active' },
    include: { role: true },
  })
  const roleFor = userId => assignments.find(row => row.userId === userId)?.role?.roleKey || 'unassigned'
  console.log([
    'Pilot workspace ready',
    `tenant id: ${result.tenantId}`,
    `workspace name: ${result.workspaceName}`,
    `warehouse id: ${result.warehouseId}`,
    `admin user id: ${result.admin.id}`,
    `admin email: ${result.admin.email}`,
    `admin role: ${roleFor(result.admin.id)}`,
    `manager user id: ${result.kim.id}`,
    `manager email: ${result.kim.email}`,
    `manager role: ${roleFor(result.kim.id)}`,
  ].join('\n'))
} finally {
  await disconnectPrismaClient()
}
