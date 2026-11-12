-- The permission to email a supplier from FlowChain
-- (docs/drafted-decisions-design.md §4.11, DD-9): a follow-up on an overdue
-- purchase order, sent only after the person confirms the text and then the
-- address. Running this file a second time changes nothing.

-- Extend the code-owned permission catalog without rewriting prior migrations,
-- unless it already allows the new code.
DO $$
DECLARE
  prior_definition TEXT;
  prior_expression TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO prior_definition
    FROM pg_constraint
   WHERE conrelid = '"TenantRolePermission"'::regclass
     AND conname = 'TenantRolePermission_permissionCode_catalog_check';

  IF prior_definition IS NULL THEN
    RAISE EXCEPTION 'FLOWCHAIN_PERMISSION_CATALOG_CONSTRAINT_MISSING';
  END IF;

  IF position('procurement.supplier_message.send' IN prior_definition) > 0 THEN
    RETURN;
  END IF;

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" IN (''procurement.supplier_message.send''))';
END $$;

-- Existing default roles receive the same grants as a fresh authorization
-- backfill (defaultRoleTemplates in server/auth/permission-catalog.mjs):
-- administrators, operations managers and procurement specialists. Nothing is
-- sent until an administrator also turns supplier email on for the workspace.
-- Administrators can remove these grants afterwards and they stay removed.
-- Custom roles are left to workspace administrators.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT
  'AUTH-' || substr(md5(role."tenantId" || ':' || role."id" || ':' || grant_row.code), 1, 28),
  role."tenantId",
  role."id",
  grant_row.code
FROM "TenantRole" AS role
JOIN (VALUES
  ('workspace-administrator', 'procurement.supplier_message.send'),
  ('operations-manager', 'procurement.supplier_message.send'),
  ('procurement-specialist', 'procurement.supplier_message.send')
) AS grant_row(role_key, code) ON grant_row.role_key = role."roleKey"
WHERE role."isDefaultTemplate" = true
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
