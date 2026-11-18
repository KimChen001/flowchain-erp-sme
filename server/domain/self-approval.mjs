import { defaultRoleTemplates, legacyRoleTemplateMap } from "../auth/permission-catalog.mjs";

// Who raised or submitted a document does not give it its first approval
// (design audit C4: L1-08 = L4-10 = L11-14, L8-25). This extends OC3, which
// covered only order changes (docs/order-changes-history-reverse-design.md),
// to the first approval of purchase requests, purchase orders, supplier
// invoices, customer invoices and return authorizations.
//
// The one exception is a workspace where no one else may approve: refusing
// there would leave the document stuck. The approval then goes ahead and
// its audit row says so (`selfApproval: "only_approver"`), so a reviewer
// can find every such approval.

export const SELF_APPROVAL_BLOCKED = "SELF_APPROVAL_BLOCKED";
export const SELF_APPROVAL_ONLY_APPROVER = "only_approver";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

// Legacy roles whose template holds the permission: a user whose roles were
// never set gets that template on first sign-in (authorization-service.mjs),
// so such a user can approve too.
function legacyRolesHolding(permissionCode) {
  return Object.entries(legacyRoleTemplateMap)
    .filter(([, roleKey]) => (defaultRoleTemplates.find((template) => template.roleKey === roleKey)?.permissions || []).includes(permissionCode))
    .map(([legacyRole]) => legacyRole);
}

// Active users of the workspace other than `actorId` who may approve: the
// permission through an active assignment of an active role, as
// resolveAuthorizationContext reads it, or a legacy role not yet turned into
// assignments; and, when the approval itself checks warehouses (a return's),
// read access to each of them. Approval emails and addresses play no part.
export async function otherApproverCount(client, { tenantId, actorId, permissionCode, warehouseIds = [] }) {
  const legacyRoles = legacyRolesHolding(permissionCode);
  const warehouses = [...new Set(warehouseIds.map(text).filter(Boolean))];
  return client.user.count({
    where: {
      tenantId,
      status: "active",
      id: { not: text(actorId) },
      OR: [
        { roleAssignments: { some: { status: "active", role: { status: "active", permissions: { some: { permissionCode } } } } } },
        ...(legacyRoles.length ? [{ rolesAssignedAt: null, roleAssignments: { none: {} }, role: { in: legacyRoles } }] : []),
      ],
      ...(warehouses.length ? { AND: warehouses.map((warehouseId) => ({ warehouseScopes: { some: { warehouseId, accessLevel: { in: ["read", "operate"] } } } })) } : {}),
    },
  });
}

// The authors of a document are the people who raised or submitted it. A
// document none of them is approving is not a self-approval. Otherwise
// `blocked` says whether someone else could approve it instead.
export async function selfApprovalCheck(client, { tenantId, actorId, authorIds = [], permissionCode, warehouseIds = [] }) {
  const actor = text(actorId);
  const authors = new Set(authorIds.map(text).filter(Boolean));
  if (!actor || !authors.has(actor)) return { self: false, blocked: false, auditFlag: null };
  const others = await otherApproverCount(client, { tenantId, actorId: actor, permissionCode, warehouseIds });
  return others > 0
    ? { self: true, blocked: true, auditFlag: null }
    : { self: true, blocked: false, auditFlag: SELF_APPROVAL_ONLY_APPROVER };
}

// The refusal, for each service's own fail(): the same code and sentence
// everywhere; the page says it in the reader's language.
export function selfApprovalRefusal(documentLabel) {
  return {
    code: SELF_APPROVAL_BLOCKED,
    message: `You raised or submitted this ${documentLabel}. Someone else who may approve it has to approve it.`,
    status: 409,
  };
}

// Each approval's permission and the authors of its document: the one table
// both the approval commands and the reads take them from, so a page offers
// Approve exactly when the command would accept it (canApprove).
export const APPROVAL_KINDS = Object.freeze({
  purchase_request: Object.freeze({ permission: "procurement.purchase_request.approve", authors: (row) => [row?.requester, row?.metadata?.requesterId, lastActorOf(row?.metadata?.timeline, "submit")] }),
  purchase_order: Object.freeze({ permission: "procurement.purchase_order.approve", authors: (row) => [row?.metadata?.createdBy, row?.metadata?.createdById, lastActorOf(row?.metadata?.approvalTimeline, "submit")] }),
  supplier_invoice: Object.freeze({ permission: "finance.supplier_invoice.approve", authors: (row) => [row?.submittedById] }),
  customer_invoice: Object.freeze({ permission: "finance.customer_invoice.approve", authors: (row) => [row?.submittedById] }),
  return_authorization: Object.freeze({ permission: "returns.authorization.approve", authors: (row) => [row?.requestedById, row?.submittedById] }),
});

// The authors of a stored document (the database row, with its metadata).
export function approvalAuthorIds(kind, row) {
  return [...new Set((APPROVAL_KINDS[kind]?.authors(row) || []).map(text).filter(Boolean))];
}

// What a reader may approve, counted once for a whole list: the approval
// permissions of `kinds` they hold (`holds(permission)`), and those no one
// else in the workspace holds, where approving their own document is allowed.
// A count that cannot be read counts as someone else: the reader's own
// documents then show no Approve, and the command still decides.
export async function approverStanding(client, actor, holds, kinds = Object.keys(APPROVAL_KINDS)) {
  const userId = text(actor?.user?.id || actor?.userId);
  const held = new Set([...new Set(kinds.map((kind) => APPROVAL_KINDS[kind]?.permission).filter(Boolean))].filter((permission) => holds(permission)));
  const sole = new Set();
  if (client?.user && userId) {
    for (const permission of held) {
      try {
        if ((await otherApproverCount(client, { tenantId: actor.tenantId, actorId: userId, permissionCode: permission })) === 0) sole.add(permission);
      } catch { /* someone else, as above */ }
    }
  }
  return { userId, held, sole };
}

// Whether the reader may approve a document with these authors now: the
// permission, and not a self-approval that someone else could give (C4). A
// return's other approvers must read its warehouses too, so its pages ask
// selfApprovalCheck with them instead.
export function mayApprove(standing, kind, authorIds = []) {
  const permission = APPROVAL_KINDS[kind]?.permission;
  if (!standing || !permission || !standing.held?.has(permission)) return false;
  const authors = new Set(authorIds.map(text).filter(Boolean));
  return !authors.has(standing.userId) || standing.sole.has(permission);
}

// The latest actor of an action in a timeline ([{ action, actorId }]).
export function lastActorOf(timeline, action) {
  const entries = Array.isArray(timeline) ? timeline : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.action === action) return text(entries[index].actorId) || null;
  }
  return null;
}
