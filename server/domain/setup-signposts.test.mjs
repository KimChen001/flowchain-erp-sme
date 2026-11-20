import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultRoleTemplates } from '../auth/permission-catalog.mjs'

// Product review 2026-11-20: first-day messages that pointed to the wrong
// page, or to nowhere. Read from the source, as the other copy checks are.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('no message sends people to the item\'s page for its suppliers', () => {
  for (const file of [
    'src/modules/purchase-requests/CanonicalProcurementPanel.tsx', 'src/modules/master-data/dataImportCopy.ts',
    'server/domain/data-import-service.mjs', 'server/domain/procurement-workflow.mjs',
  ]) {
    const source = read(file)
    assert.doesNotMatch(source, /on the item's page|on the item first|preferred supplier on the item|在物料页面|在物料中更改/i, file)
  }
  const request = read('src/modules/purchase-requests/CanonicalProcurementPanel.tsx')
  assert.match(request, /ITEM_HAS_NO_APPROVED_SUPPLIER: \["This item has no approved supplier yet\. Add it under Supplied items on a supplier's page \(Suppliers in the sidebar\) first\.", "[^"]*可供应物料[^"]*"\]/)
  assert.match(read('server/domain/procurement-workflow.mjs'), /"This item has no approved supplier yet\. Add it under Supplied items on a supplier's page first\."/)
  // The import's preferred-supplier messages say what to do, on which page.
  const copy = read('src/modules/master-data/dataImportCopy.ts')
  assert.match(copy, /PREFERRED_EXISTS: \["This item already prefers \{supplierCode\}\. To make this supplier preferred, first add the item under Supplied items on this supplier's page, then use Set as preferred there; or write No\.", "[^"]+"\]/)
  assert.match(copy, /PREFERRED_WOULD_CLEAR: \["\{supplierCode\} is this item's preferred supplier\. Leave Preferred blank or write Yes, or make another supplier preferred with Set as preferred under its Supplied items\.", "[^"]+"\]/)
  const item = read('src/modules/master-data/ItemMasterWorkbench.tsx')
  assert.match(item, /data-testid="item-detail-suppliers-hint"/)
  assert.match(item, /<Link to="\/app\/master-data\/suppliers"/)
})

test('warehouses, bins and print templates say where they are edited, linking only for those who may open Settings', () => {
  const page = read('src/modules/master-data/Page.tsx')
  assert.match(page, /warehouses: \{ text: "Warehouses and their locations are added and edited in Settings › Warehouses & access\.", link: "Open Warehouses & access", to: "\/app\/settings\/warehouse-access", routeId: "settings:warehouse-access" \}/)
  assert.match(page, /"print-templates": \{ text: "These are the built-in print layouts\. To change what prints \(the letterhead, document titles, columns and the notes on each document\), use Settings › Company & workspace › Documents\.", link: "Open document settings", to: "\/app\/settings\/company", routeId: "settings:company" \}/)
  assert.match(page, /\{canOpenRoute\(SETTINGS_SIGNPOSTS\[tab\]\.routeId\) && <>\{" "\}<Link to=\{SETTINGS_SIGNPOSTS\[tab\]\.to\}/)
  assert.match(read('src/modules/master-data/BinListPage.tsx'), /\{canOpenRoute\("settings:warehouse-access"\) && <>\{" "\}<Link to="\/app\/settings\/warehouse-access"/)
  // There is no logo setting, and copies of templates are gone for good.
  assert.doesNotMatch(page, /logo/i)
  assert.match(page, /<PrintTemplateTable templates=\{filteredTemplates\} \/>/)
  for (const file of ['src/modules/master-data/StandardMasterTables.tsx', 'src/modules/master-data/standardData.ts', 'src/modules/master-data/masterDataFormat.ts', 'src/modules/master-data/Page.tsx']) {
    assert.doesNotMatch(read(file), /Copy template|copyOf|\{name\} \(copy\)/, file)
  }
  // Every new line has its Chinese, and the settings heading is named as it reads (单据文件).
  const zh = read('src/modules/master-data/masterDataFormat.ts')
  for (const english of [
    "Suppliers for this item are added on each supplier's page, under Supplied items; Set as preferred there makes one the default.",
    'Open suppliers', 'Warehouses and their locations are added and edited in Settings › Warehouses & access.', 'Open Warehouses & access',
    'No warehouses yet. Add them in Settings › Warehouses & access.',
    'Bins listed here hold stock. To add a location before stock arrives, use Settings › Warehouses & access.',
    'These are the built-in print layouts. To change what prints (the letterhead, document titles, columns and the notes on each document), use Settings › Company & workspace › Documents.',
    'Open document settings',
  ]) assert.ok(zh.includes(`${JSON.stringify(english)}: "`), english)
  assert.match(zh, /“设置 › 公司与工作区 › 单据文件”/)
})

test('every default role may open My profile; its four reads ask no permission on the server', () => {
  // The route gate: settings:profile has no required permission (the route
  // governance test pins it), so no role is turned away; the specialists, who
  // lack settings.workspace.read, were.
  const specialists = defaultRoleTemplates.filter((role) => /specialist/.test(role.roleKey))
  assert.ok(specialists.length >= 3)
  for (const role of specialists) assert.ok(!role.permissions.includes('settings.workspace.read'), role.roleKey)
  // The server: each read My profile makes resolves the member and checks no
  // permission (an adminActor or assertAuthorized would turn a specialist away).
  const routes = read('server/routes/pilot-workspace.routes.mjs')
  const blockOf = (path) => {
    const start = routes.indexOf(`ctx.req.method === 'GET' && ctx.url.pathname === '${path}'`)
    assert.ok(start > 0, path)
    return routes.slice(start, routes.indexOf('return true', start))
  }
  for (const path of ['/api/me/profile', '/api/workspace', '/api/workspace/warehouses']) {
    const block = blockOf(path)
    assert.match(block, /resolveProvisionedActor\(prisma, ctx\.identity\)/, path)
    assert.doesNotMatch(block, /adminActor|assertAuthorized/, path)
  }
  const context = read('server/routes/authorization.routes.mjs')
  const start = context.indexOf('url.pathname === "/api/authorization/context"')
  assert.ok(start > 0)
  assert.doesNotMatch(context.slice(start, context.indexOf('return true', start)), /assertAuthorized|requirePermission/)
})

test('Members says where warehouse access is set; the user menu and the trail send nobody to Access denied', () => {
  assert.match(read('src/modules/settings/WorkspaceMembers.tsx'), /A new member sees no warehouse until you give them access on Warehouses & access\./)
  const app = read('src/app/FlowChainApp.tsx')
  assert.match(app, /const settingsMenuTarget = authorizationLoadState !== "ready"\s*\? "settings:company"\s*: SETTINGS_MENU_TABS\.find\(\(routeId\) => canOpenRoute\(routeId\)\) \|\| null;/)
  assert.match(app, /const SETTINGS_MENU_TABS = \["settings:company", [^\]]*"settings:audit"[^\]]*\];/)
  assert.match(read('src/components/navigation/AppBreadcrumb.tsx'), /const href = current \|\| !canOpenRoute\(item\.id\) \? null : crumbHref\(item\);/)
})
