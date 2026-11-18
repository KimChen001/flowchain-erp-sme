import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SELF_APPROVAL_BLOCKED, lastActorOf, otherApproverCount, selfApprovalCheck, selfApprovalRefusal } from './self-approval.mjs'
import { APPROVAL_ROW_PERMISSIONS, buildTodayWork, rowForApprover } from './today-work.mjs'
import { DECISION_PERMISSION, DECISION_PERMISSIONS, DRAFTED_DECISION_KINDS, decisionPermissionOf } from './decision-items.mjs'
import { createAuthorizationAdminService } from '../auth/authorization-admin-service.mjs'

// Design audit batch C4 (2026-11-17), approvals and role governance:
// L1-08 = L4-10 = L11-14 and L8-25 (no self-approval, except a sole approver,
// audited), L11-12 (approval rows on Today), L11-09 (a decision permission per
// kind), L4-30 (role managers grant only what they hold).
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

// A client whose user.count answers `others` and records the query.
const counting = (others) => {
  const calls = []
  return { calls, user: { count: async (query) => { calls.push(query); return others } } }
}

test('who raised or submitted a document does not approve it while someone else may', async () => {
  const client = counting(2)
  const blocked = await selfApprovalCheck(client, { tenantId: 'T', actorId: 'U1', authorIds: ['U1', null, 'U9'], permissionCode: 'procurement.purchase_order.approve' })
  assert.deepEqual(blocked, { self: true, blocked: true, auditFlag: null })
  // Only active users of the workspace other than the approver, with the
  // permission through an active role, or a legacy role holding it.
  const where = client.calls[0].where
  assert.equal(where.tenantId, 'T')
  assert.equal(where.status, 'active')
  assert.deepEqual(where.id, { not: 'U1' })
  assert.deepEqual(where.OR[0], { roleAssignments: { some: { status: 'active', role: { status: 'active', permissions: { some: { permissionCode: 'procurement.purchase_order.approve' } } } } } })
  assert.deepEqual(where.OR[1].role.in.sort(), ['admin', 'manager'])
  assert.equal(where.OR[1].rolesAssignedAt, null)
  // The approval emails and addresses findApprovalRecipients needs play no part.
  assert.equal(JSON.stringify(where).includes('approvalEmailsEnabled'), false)
})

test('a sole approver may approve their own document, and the approval says so', async () => {
  assert.deepEqual(await selfApprovalCheck(counting(0), { tenantId: 'T', actorId: 'U1', authorIds: ['U1'], permissionCode: 'finance.supplier_invoice.approve' }), { self: true, blocked: false, auditFlag: 'only_approver' })
  // Someone else's document is never asked about.
  const client = counting(5)
  assert.deepEqual(await selfApprovalCheck(client, { tenantId: 'T', actorId: 'U2', authorIds: ['U1'], permissionCode: 'finance.supplier_invoice.approve' }), { self: false, blocked: false, auditFlag: null })
  assert.equal(client.calls.length, 0)
  assert.equal(await otherApproverCount(counting(3), { tenantId: 'T', actorId: 'U1', permissionCode: 'finance.customer_invoice.approve' }), 3)
  const refusal = selfApprovalRefusal('purchase request')
  assert.equal(refusal.code, SELF_APPROVAL_BLOCKED)
  assert.equal(refusal.status, 409)
  assert.match(refusal.message, /^You raised or submitted this purchase request\. Someone else who may approve it has to approve it\.$/)
  assert.equal(lastActorOf([{ action: 'submit', actorId: 'A' }, { action: 'return_for_revision', actorId: 'B' }, { action: 'submit', actorId: 'C' }], 'submit'), 'C')
  assert.equal(lastActorOf(undefined, 'submit'), null)
})

test('each first approval checks its own authors and permission, and audits a sole approver', () => {
  const cases = [
    ['server/services/procurement-request-command-service.mjs', /authorIds: \[row\.requester, row\.metadata\?\.requesterId, lastActorOf\(row\.metadata\?\.timeline, "submit"\)\], permissionCode: PURCHASE_REQUEST_PERMISSIONS\.approve/, /\.\.\.\(selfApproval \? \{ selfApproval \} : \{\}\)/],
    ['server/domain/procurement-db-command-service.mjs', /authorIds: \[row\.metadata\?\.createdBy, row\.metadata\?\.createdById, lastActorOf\(row\.metadata\?\.approvalTimeline, "submit"\)\], permissionCode: permission/, /\.\.\.\(selfApproval \? \{ selfApproval \} : \{\}\)/],
    ['server/domain/operational-finance-command-service.mjs', /authorIds: \[current\.submittedById\],\s+permissionCode: "finance\.supplier_invoice\.approve"/, /\.\.\.\(selfApproval\.auditFlag \? \{ selfApproval: selfApproval\.auditFlag \} : \{\}\)/],
    ['server/domain/operational-finance-o2c-command-service.mjs', /authorIds: \[current\.submittedById\],\s+permissionCode: "finance\.customer_invoice\.approve"/, /\.\.\.\(selfApproval\?\.auditFlag \? \{ selfApproval: selfApproval\.auditFlag \} : \{\}\)/],
    ['server/domain/return-governance-command-service.mjs', /authorIds: \[current\.requestedById, current\.submittedById\],\s+permissionCode: "returns\.authorization\.approve"/, /\.\.\.\(selfApproval\.auditFlag \? \{ selfApproval: selfApproval\.auditFlag \} : \{\}\)/],
  ]
  for (const [file, check, flag] of cases) {
    const source = read(file)
    assert.match(source, check, file)
    assert.match(source, flag, file)
    assert.match(source, /selfApprovalRefusal\("[a-z ]+"\)/, file)
  }
  // The PO's check runs on approve only, inside the command, before the update.
  const po = read('server/domain/procurement-db-command-service.mjs')
  assert.ok(po.indexOf('if (action === "approve") {') < po.indexOf('await tx.purchaseOrder.update({ where: { id: row.id }, data: { status: nextStatus'))
  // The two invoice previews say so before the click.
  assert.match(read('server/domain/operational-finance-command-service.mjs'), /if \(selfApproval\.blocked\) blockingIssues\.push\(selfApprovalRefusal\("supplier invoice"\)\);/)
  assert.match(read('server/domain/operational-finance-o2c-command-service.mjs'), /if \(check\.blocked\) blockingIssues\.push\(selfApprovalRefusal\("customer invoice"\)\);/)
  // The page says it in the reader's language; the phone does not call it a conflict.
  assert.match(read('src/lib/apiErrorText.ts'), /SELF_APPROVAL_BLOCKED: \["You raised or submitted this, so someone else who may approve it has to approve it\.", "这张单据是你提交的，需要由其他有审批权限的人来审批。"\]/)
  assert.match(read('src/modules/finance/FinanceControls.tsx'), /knownCodeText\(issue\.code, language\)/)
  assert.match(read('src/modules/mobile/MobileOperationsPage.tsx'), /caught\?\.code !== "SELF_APPROVAL_BLOCKED" && \(caught\?\.status === 409/)
  // The public-data seed approves bills as a second person (seed-history.mjs).
  assert.match(read('scripts/public-data/seed.mjs'), /approver: await scenarioApprover\(prisma, tenantId, financeActor, 'finance\.supplier_invoice\.approve'\)/)
  assert.match(read('scripts/public-data/seed-payables.mjs'), /context: approverContext/)
})

test('Today shows an approval row only to someone who may give it (L11-12)', () => {
  const approver = (codes, sole = []) => ({ userId: 'U1', permissionCodes: new Set(codes), soleApprover: new Set(sole) })
  const request = { kind: 'purchase_request_to_approve', recordId: 'PR-1' }
  const requesterOf = (id) => (id === 'PR-1' ? 'U1' : 'U2')
  // Without a reader (no database) every row stays, as before.
  assert.equal(rowForApprover(request, null, requesterOf), true)
  // A reader without the permission does not get it.
  assert.equal(rowForApprover(request, approver([]), requesterOf), false)
  assert.equal(rowForApprover({ kind: 'bill_to_approve', recordId: 'B-1' }, approver(['procurement.purchase_order.approve']), requesterOf), false)
  // Nor its own requester, unless no one else may approve it.
  assert.equal(rowForApprover(request, approver(['procurement.purchase_order.approve']), requesterOf), false)
  assert.equal(rowForApprover(request, approver(['procurement.purchase_order.approve'], ['procurement.purchase_order.approve']), requesterOf), true)
  assert.equal(rowForApprover({ ...request, recordId: 'PR-2' }, approver(['procurement.purchase_order.approve']), requesterOf), true)
  // Other rows are not approvals.
  assert.equal(rowForApprover({ kind: 'purchase_request_to_convert', recordId: 'PR-1' }, approver([]), requesterOf), true)
  assert.deepEqual(Object.keys(APPROVAL_ROW_PERMISSIONS).sort(), ['bill_to_approve', 'purchase_order_to_approve', 'purchase_request_to_approve'])

  const sources = { purchaseRequests: [
    { id: 'PR-1', number: 'PR-1', status: 'submitted', requesterId: 'U1', lines: [] },
    { id: 'PR-2', number: 'PR-2', status: 'submitted', requesterId: 'U2', lines: [] },
  ] }
  const now = new Date('2026-11-17T15:00:00Z')
  const kinds = (work) => work.all.filter((row) => row.kind === 'purchase_request_to_approve').map((row) => row.recordId).sort()
  assert.deepEqual(kinds(buildTodayWork(sources, { now })), ['PR-1', 'PR-2'])
  assert.deepEqual(kinds(buildTodayWork(sources, { now, approver: approver(['procurement.purchase_order.approve']) })), ['PR-2'])
  assert.deepEqual(kinds(buildTodayWork(sources, { now, approver: approver([]) })), [])
  // The read service resolves the reader's approvals with the same count.
  const service = read('server/services/today-read-service.mjs')
  assert.match(service, /todayWorkOf\(context, read\.sources, \{ now, timeZone, approver: await todayApprover\(ctx\) \}\)/)
  assert.match(service, /await otherApproverCount\(prisma, \{ tenantId: actor\.tenantId, actorId: actor\.user\.id, permissionCode: permission \}\) === 0/)
})

test('each kind of Today decision needs its own permission (L11-09)', () => {
  assert.deepEqual(Object.keys(DECISION_PERMISSIONS).sort(), [...DRAFTED_DECISION_KINDS].sort())
  assert.equal(decisionPermissionOf('bill_exception'), 'finance.match_exception.review')
  for (const kind of ['reorder_now', 'purchase_order_overdue', 'purchase_request_to_convert']) assert.equal(decisionPermissionOf(kind), DECISION_PERMISSION)
  const route = read('server/routes/decision-items.routes.mjs')
  assert.match(route, /if \(!can\(\{ actor, permission: decisionPermissionOf\(row\.kind\), tenantId: actor\.tenantId \}\)\) throw fail\(403, 'DECISION_NOT_ALLOWED'/)
  assert.match(read('server/services/today-read-service.mjs'), /decideKinds = DRAFTED_DECISION_KINDS\.filter\(\(kind\) => can\(\{ actor, permission: decisionPermissionOf\(kind\), tenantId: actor\.tenantId \}\)\)/)
  assert.match(read('src/modules/overview/DecisionCards.tsx'), /const canDecide = canDecideSome && \(!decideKinds \|\| decideKinds\.includes\(row\.kind\)\);/)
})

// A fake database for the role service: one transaction over in-memory rows.
function rolesDatabase({ roles, assignments }) {
  const tx = {
    user: { findFirst: async ({ where }) => ({ id: where.id, email: `${where.id}@example.com`, rolesAssignedAt: new Date() }), update: async () => ({}), count: async () => 1 },
    tenantRole: {
      findMany: async ({ where }) => roles.filter((role) => where.id.in.includes(role.id)),
      findFirst: async ({ where }) => roles.find((role) => role.id === where.id) || null,
      update: async ({ where }) => ({ ...roles.find((role) => role.id === where.id), assignments: [], updatedBy: null }),
    },
    tenantRolePermission: { deleteMany: async () => ({}), upsert: async () => ({}) },
    userRoleAssignment: {
      findMany: async ({ where }) => assignments.filter((row) => row.userId === where.userId).map(({ roleId }) => ({ roleId })),
      deleteMany: async () => ({}), upsert: async () => ({}),
    },
    auditLog: { create: async () => ({}) },
    workspaceSession: { updateMany: async () => ({ count: 0 }) },
    workspaceSignInLink: { updateMany: async () => ({ count: 0 }) },
  }
  return { $transaction: async (work) => work(tx) }
}
const role = (id, codes, version = 1) => ({ id, name: id, status: 'active', version, permissions: codes.map((permissionCode) => ({ permissionCode })), assignments: [] })
const manager = (codes) => ({ complete: true, authenticated: true, tenantId: 'T', userId: 'U1', permissionCodes: new Set(['settings.roles.assign', 'settings.roles.manage', ...codes]) })

test('a role manager gives no one a role beyond their own permissions, and never themselves (L4-30)', async () => {
  const roles = [role('buyer', ['procurement.purchase_order.revise']), role('admin', ['settings.roles.manage', 'finance.payable.record_payment'])]
  const service = createAuthorizationAdminService({ prisma: rolesDatabase({ roles, assignments: [{ userId: 'U1', roleId: 'buyer' }] }) })
  const actor = manager(['procurement.purchase_order.revise'])
  await assert.rejects(service.assignUserRoles(actor, 'U1', ['buyer', 'admin']), { code: 'AUTHORIZATION_SELF_ASSIGNMENT', status: 403 })
  await assert.rejects(service.assignUserRoles(actor, 'U2', ['admin']), { code: 'AUTHORIZATION_GRANT_EXCEEDS_OWN', status: 403 })
  // A role whose permissions they hold, and taking one away, are fine.
  assert.deepEqual(await service.assignUserRoles(actor, 'U2', ['buyer']), { userId: 'U2', roleIds: ['buyer'] })
  assert.deepEqual(await service.assignUserRoles(actor, 'U1', []), { userId: 'U1', roleIds: [] })
})

test('editing a role adds only permissions the editor holds, and a stale edit is refused (L4-30)', async () => {
  const roles = [role('custom', ['procurement.purchase_order.read'], 4)]
  const service = createAuthorizationAdminService({ prisma: rolesDatabase({ roles, assignments: [] }) })
  const actor = manager(['procurement.purchase_order.read'])
  await assert.rejects(service.updateRole(actor, 'custom', { permissionCodes: ['procurement.purchase_order.read', 'finance.payable.record_payment'], expectedVersion: 4 }), { code: 'AUTHORIZATION_GRANT_EXCEEDS_OWN' })
  await assert.rejects(service.updateRole(actor, 'custom', { name: 'Renamed', expectedVersion: 3 }), { code: 'AUTHORIZATION_ROLE_VERSION_CONFLICT', status: 409 })
  // Creating a role: the same rule (assertGrantsHeld).
  assert.match(read('server/auth/authorization-admin-service.mjs'), /const codes = permissions\.length \? permissions : source\?\.permissions\.map\(\(grant\) => grant\.permissionCode\) \|\| \[\]\n\s+assertGrantsHeld\(actor, codes\)/)
  assert.match(read('src/modules/settings/AuthorizationWorkbench.tsx'), /permissionCodes: draft\.permissionCodes, expectedVersion: draft\.version \}/)
})
