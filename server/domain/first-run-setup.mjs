import { capabilityForEnvironment } from './capability-registry.mjs'
import { CUSTOMER_NAMESPACE } from './master-data-commands.mjs'
import { firstRunSetupSteps } from './today-work.mjs'

// The first-day checklist's inputs, read one way for every page that shows
// it: Today (GET /api/home/overview, today-work-read-service.mjs) and the
// assistant's setup_status tool and readiness flag. Both build the steps with
// firstRunSetupSteps (today-work.mjs) from these, so they cannot disagree.
//
//   counts   items, suppliers, customers, items with stock on hand, active
//            users and pending invitations, in the reader's workspace;
//   options  the steps the reader may do (access.home.setup, from
//            reportReadAccessFor), and whether import and inventory
//            adjustments are turned on, which decides each step's page.

export async function readFirstRunSetupCounts(prisma, { tenantId, now = new Date() }) {
  const [items, suppliers, customers, stockedItems, activeUsers, pendingInvitations] = await Promise.all([
    prisma.item.count({ where: { tenantId } }),
    prisma.supplier.count({ where: { tenantId } }),
    prisma.runtimeRecord.count({ where: { tenantId, namespace: CUSTOMER_NAMESPACE } }),
    prisma.inventoryBalance.count({ where: { tenantId, onHandQuantity: { gt: 0 } } }),
    prisma.user.count({ where: { tenantId, status: 'active' } }),
    prisma.workspaceInvitation.count({ where: { tenantId, status: 'pending', expiresAt: { gt: now } } }),
  ])
  return { items, suppliers, customers, stockedItems, activeUsers, pendingInvitations }
}

export function firstRunSetupOptions(access, env = process.env) {
  return {
    permissions: access?.home?.setup || {},
    importEnabled: Boolean(capabilityForEnvironment('data-import', env)?.enabled),
    adjustmentsEnabled: Boolean(capabilityForEnvironment('inventory-adjustment-document', env)?.enabled),
  }
}

// The checklist with every step, done or not: { steps, done, total }.
export async function readFirstRunSetup(prisma, { tenantId, now = new Date(), access, env = process.env }) {
  return firstRunSetupSteps(await readFirstRunSetupCounts(prisma, { tenantId, now }), firstRunSetupOptions(access, env))
}
