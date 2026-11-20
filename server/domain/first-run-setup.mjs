import { capabilityForEnvironment } from './capability-registry.mjs'
import { CUSTOMER_NAMESPACE, ITEM_SUPPLIER_NAMESPACE } from './master-data-commands.mjs'
import { firstRunSetupSteps } from './today-work.mjs'

// The first-day checklist's inputs, read one way for every page that shows
// it: Today (GET /api/home/overview, today-work-read-service.mjs) and the
// assistant's setup_status tool and readiness flag. Both build the steps with
// firstRunSetupSteps (today-work.mjs) from these, so they cannot disagree.
//
//   counts   items, suppliers, customers, items with stock on hand, active
//            users and pending invitations, in the reader's workspace; and,
//            for the notes under two steps, the items' suppliers (active
//            item-supplier links, and items with a preferred supplier) and
//            the opening-stock adjustments drafted but not posted yet;
//   options  the steps the reader may do (access.home.setup, from
//            reportReadAccessFor), and whether import and inventory
//            adjustments are turned on, which decides each step's page.

// Whether any active item-supplier link exists: active is a field of the
// stored record, so links are read a page at a time, stopping at the first
// active one (a large workspace never reads them all).
const LINK_PAGE = 200
async function anyActiveItemSupplierLink(prisma, tenantId) {
  for (let cursor = null; ;) {
    const page = await prisma.runtimeRecord.findMany({
      where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE },
      select: { id: true, payload: true },
      orderBy: { id: 'asc' },
      take: LINK_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if ((page || []).some((row) => row?.payload?.active !== false)) return true
    if (!page || page.length < LINK_PAGE) return false
    cursor = page[page.length - 1].id
  }
}

export async function readFirstRunSetupCounts(prisma, { tenantId, now = new Date() }) {
  const [items, suppliers, customers, stockedItems, activeUsers, pendingInvitations, itemsWithPreferred, openingStockToPost] = await Promise.all([
    prisma.item.count({ where: { tenantId } }),
    prisma.supplier.count({ where: { tenantId } }),
    prisma.runtimeRecord.count({ where: { tenantId, namespace: CUSTOMER_NAMESPACE } }),
    prisma.inventoryBalance.count({ where: { tenantId, onHandQuantity: { gt: 0 } } }),
    prisma.user.count({ where: { tenantId, status: 'active' } }),
    prisma.workspaceInvitation.count({ where: { tenantId, status: 'pending', expiresAt: { gt: now } } }),
    // An item with a preferred supplier can name one (a purchase request offers it).
    prisma.item.count({ where: { tenantId, preferredSupplierId: { not: null } } }),
    // Opening stock drafted as adjustments (imported or by hand), not posted yet.
    prisma.inventoryAdjustmentDocument.count({ where: { tenantId, reasonCode: 'opening_balance', postingStatus: 'unposted', workflowStatus: { in: ['draft', 'ready'] } } }),
  ])
  // itemSupplierSources is above 0 when some item can name a supplier: the
  // cheap count first; the link scan only when it is 0.
  const itemSupplierSources = itemsWithPreferred > 0 ? itemsWithPreferred : (await anyActiveItemSupplierLink(prisma, tenantId)) ? 1 : 0
  return { items, suppliers, customers, stockedItems, activeUsers, pendingInvitations, itemSupplierSources, openingStockToPost }
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
