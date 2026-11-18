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

// The latest actor of an action in a timeline ([{ action, actorId }]).
export function lastActorOf(timeline, action) {
  const entries = Array.isArray(timeline) ? timeline : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.action === action) return text(entries[index].actorId) || null;
  }
  return null;
}
