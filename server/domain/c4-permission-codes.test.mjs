import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultRoleTemplates, permissionCatalog } from '../auth/permission-catalog.mjs'
import { PURCHASE_REQUEST_PERMISSIONS } from '../services/procurement-request-command-service.mjs'
import { SUPPLIER_BANK_FIELDS, supplierInputIssues } from './supplier-master-command.mjs'

// Design audit batch C4, part 2 (2026-11-17): the permission codes.
// Purchase requests get their own (L1-07 = L4-11 = L7-32), a supplier's bank
// details theirs (L4-10), holding a sales order its own (L4-16). Every role
// keeps exactly what it could do: the migration gives each new code to the
// roles holding the code that allowed the same act before.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const migration = read('prisma/migrations/20261117120000_c4_permission_codes/migration.sql')
const NEW_CODES = [
  'procurement.purchase_request.read', 'procurement.purchase_request.create', 'procurement.purchase_request.submit',
  'procurement.purchase_request.approve', 'procurement.purchase_request.reject', 'master_data.supplier.bank.manage', 'sales_order.hold',
]
// What allowed each act before: the migration's mapping, old code to new.
const MAPPING = [
  ['procurement.purchase_order.read', 'procurement.purchase_request.read'],
  ['procurement.purchase_order.revise', 'procurement.purchase_request.create'],
  ['procurement.purchase_order.revise', 'procurement.purchase_request.submit'],
  ['procurement.purchase_order.approve', 'procurement.purchase_request.approve'],
  ['procurement.purchase_order.reject', 'procurement.purchase_request.reject'],
  ['master_data.supplier.manage', 'master_data.supplier.bank.manage'],
  ['sales_order.cancel', 'sales_order.hold'],
]

test('the catalog has the new codes, and the migration lets the database store each of them', () => {
  const codes = new Set(permissionCatalog.map((permission) => permission.code))
  for (const code of NEW_CODES) {
    assert.ok(codes.has(code), code)
    assert.ok(migration.includes(`'''${code}''`), `${code} in the CHECK constraint`)
  }
  // Run twice, it changes nothing.
  assert.match(migration, /IF position\('procurement\.purchase_request\.read' IN prior_definition\) > 0 THEN\s+RETURN;/)
  assert.match(migration, /ON CONFLICT \("roleId", "permissionCode"\) DO NOTHING;/)
})

test('the migration gives each new code to every role holding the code that allowed the same act', () => {
  const values = [...migration.matchAll(/\('([a-z_.]+)', '([a-z_.]+)'\)/g)].map(([, from, to]) => [from, to])
  assert.deepEqual(values, MAPPING)
  // Every role, default or custom: no roleKey or isDefaultTemplate filter.
  const insert = migration.slice(migration.indexOf('INSERT INTO "TenantRolePermission"'))
  assert.doesNotMatch(insert, /isDefaultTemplate|roleKey/)
  assert.match(insert, /FROM "TenantRolePermission" AS existing/)
})

test('a request command needs the request code its act maps from, so no role loses or gains an act through the backfill', () => {
  const before = {
    read: 'procurement.purchase_order.read', create: 'procurement.purchase_order.revise', update: 'procurement.purchase_order.revise',
    submit: 'procurement.purchase_order.revise', withdraw: 'procurement.purchase_order.revise', reopen: 'procurement.purchase_order.revise',
    cancel: 'procurement.purchase_order.revise', approve: 'procurement.purchase_order.approve', reject: 'procurement.purchase_order.reject',
  }
  for (const [command, old] of Object.entries(before)) {
    const now = PURCHASE_REQUEST_PERMISSIONS[command]
    assert.ok(MAPPING.some(([from, to]) => from === old && to === now), `${command}: ${old} -> ${now}`)
  }
  // Turning a request into an RFQ or orders is ordering: unchanged.
  for (const command of ['createRfq', 'createPurchaseOrders', 'openRfq', 'cancelRfq']) assert.equal(PURCHASE_REQUEST_PERMISSIONS[command], 'procurement.purchase_order.revise')
  // Holding a sales order: from cancel to its own code, resuming unchanged.
  assert.match(read('server/domain/sales-order-workbench-service.mjs'), /commandType === 'hold_sales_order' \? 'sales_order\.hold' : 'sales_order\.submit'/)
  // Who reads requests, gets their approval emails and their Today rows.
  assert.match(read('server/domain/report-read-access.mjs'), /purchaseRequests: 'procurement\.purchase_request\.read',/)
  assert.match(read('server/notifications/approval-notifier.mjs'), /purchase_request: \{\s+\/\/[^\n]*\n\s+permission: "procurement\.purchase_request\.approve",/)
  assert.match(read('server/domain/today-work.mjs'), /purchase_request_to_approve: 'procurement\.purchase_request\.approve',/)
  assert.match(read('server/domain/ai-skill-registry.mjs'), /purchase_requests: Object\.freeze\(\{ permission: 'procurement\.purchase_request\.read'/)
  // The request page's buttons ask for the same codes.
  const panel = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  for (const [action, code] of [['edit', 'create'], ['submit', 'submit'], ['approve', 'approve'], ['reject', 'reject'], ['withdraw', 'submit'], ['reopen', 'create'], ['cancel', 'create']]) {
    assert.match(panel, new RegExp(`  ${action}: "procurement\\.purchase_request\\.${code}",`), action)
  }
})

test('new workspaces: the operations specialist raises requests, and the operations manager no longer changes bank details', () => {
  const template = (key) => new Set(defaultRoleTemplates.find((role) => role.roleKey === key).permissions)
  const admin = template('workspace-administrator')
  for (const code of NEW_CODES) assert.ok(admin.has(code), `administrator: ${code}`)
  const manager = template('operations-manager')
  for (const code of ['read', 'create', 'submit', 'approve', 'reject']) assert.ok(manager.has(`procurement.purchase_request.${code}`), `manager: ${code}`)
  assert.ok(manager.has('sales_order.hold'))
  // Paying suppliers and changing where the money goes stay apart; the
  // manager keeps their payment permissions (owner decision 2026-11-17).
  assert.ok(manager.has('master_data.supplier.manage'))
  assert.ok(!manager.has('master_data.supplier.bank.manage'))
  assert.ok(manager.has('finance.payable.record_payment'))
  const specialist = template('operations-specialist')
  for (const code of ['read', 'create', 'submit']) assert.ok(specialist.has(`procurement.purchase_request.${code}`), `specialist: ${code}`)
  for (const code of ['approve', 'reject']) assert.ok(!specialist.has(`procurement.purchase_request.${code}`), `specialist: ${code}`)
  assert.ok(!specialist.has('master_data.supplier.bank.manage'))
  assert.ok(specialist.has('sales_order.hold'))
  const buyer = template('procurement-specialist')
  for (const code of ['read', 'create', 'submit']) assert.ok(buyer.has(`procurement.purchase_request.${code}`), `buyer: ${code}`)
  assert.ok(!buyer.has('procurement.purchase_request.approve'))
  assert.ok(!buyer.has('master_data.supplier.bank.manage'))
  for (const key of ['finance-specialist', 'read-only-viewer', 'intake-uploader', 'intake-reviewer']) {
    const role = template(key)
    assert.ok(!NEW_CODES.some((code) => role.has(code) && !code.endsWith('.read')), key)
  }
  // Every template that held an old code still holds what it allowed, except
  // the one owner-decided split: bank details apart from the supplier record.
  for (const role of defaultRoleTemplates) {
    const codes = new Set(role.permissions)
    for (const [from, to] of MAPPING) {
      if (!codes.has(from) || to === 'master_data.supplier.bank.manage' || to === 'procurement.purchase_request.read') continue
      if (role.roleKey === 'operations-specialist' || role.roleKey === 'procurement-specialist') {
        if (to.endsWith('.approve') || to.endsWith('.reject')) continue
      }
      assert.ok(codes.has(to), `${role.roleKey}: ${from} -> ${to}`)
    }
  }
})

test('a change to a supplier\'s bank details needs the bank permission; the rest of the record does not', () => {
  assert.deepEqual([...SUPPLIER_BANK_FIELDS], ['bankName', 'bankAccountName', 'bankAccountNumber'])
  const old = { code: 'SUP-1', name: 'Harbour', status: 'active', metadata: { bankName: 'First Bank', bankAccountName: 'Harbour Ltd', bankAccountNumber: '12345678', version: 3 } }
  const issues = (input, bankFieldsWritable) => supplierInputIssues(input, old, { sensitiveFieldsWritable: true, bankFieldsWritable }).issues.map((issue) => [issue.field, issue.code])
  // Without the permission: a new account number is refused, under its field.
  assert.deepEqual(issues({ bankAccountNumber: '87654321' }, false), [['bankAccountNumber', 'BANK_DETAILS_PERMISSION_REQUIRED']])
  assert.deepEqual(issues({ bankName: 'Other Bank' }, false), [['bankName', 'BANK_DETAILS_PERMISSION_REQUIRED']])
  // Sending the stored values, or changing anything else, is fine.
  assert.deepEqual(issues({ bankName: 'First Bank', bankAccountNumber: '12345678', contactName: 'Ann' }, false), [])
  // With it, or for a caller that does not say (the import of new suppliers).
  assert.deepEqual(issues({ bankAccountNumber: '87654321' }, true), [])
  assert.deepEqual(issues({ bankAccountNumber: '87654321' }, undefined), [])
  // The route says, from the writer's own permission; the form translates the message.
  assert.match(read('server/routes/master-data.routes.mjs'), /bankFieldsWritable: can\(\{ actor: await provisionedActor\(\), permission: 'master_data\.supplier\.bank\.manage', tenantId: ctx\.identity\.tenantId \}\),/)
  assert.match(read('src/modules/srm/supplierCopy.ts'), /"Changing a supplier's bank details needs the Manage supplier bank details permission\.": '修改供应商银行信息需要“管理供应商银行信息”权限。'/)
  assert.match(read('src/modules/settings/permissionLabels.ts'), /"master_data\/supplier_bank": \["supplier bank details", "供应商银行信息"\]/)
  assert.match(read('src/modules/settings/permissionLabels.ts'), /"procurement\/purchase_request": \["purchase requests", "采购申请"\]/)
})
