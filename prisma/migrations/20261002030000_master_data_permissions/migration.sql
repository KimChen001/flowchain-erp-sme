-- Master data writes move from the legacy User.role to Roles & permissions.
-- Running this file a second time changes nothing.

-- Extend the code-owned permission catalog without rewriting prior migrations,
-- unless it already allows the new codes.
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

  IF position('master_data.item.manage' IN prior_definition) > 0 THEN
    RETURN;
  END IF;

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" IN (''master_data.item.manage'',''master_data.supplier.manage'',''master_data.customer.manage''))';
END $$;

-- Existing default roles receive the same grants as a fresh authorization
-- backfill (defaultRoleTemplates in server/auth/permission-catalog.mjs), so
-- the people who could change master data under their legacy role still can.
-- The backfill is no substitute: it runs only when a user who never had a
-- role signs in, and it never adds grants to a default role an administrator
-- has saved. Administrators can remove these grants afterwards and they stay
-- removed. Custom roles are left to workspace administrators.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT
  'AUTH-' || substr(md5(role."tenantId" || ':' || role."id" || ':' || grant_row.code), 1, 28),
  role."tenantId",
  role."id",
  grant_row.code
FROM "TenantRole" AS role
JOIN (VALUES
  ('workspace-administrator', 'master_data.item.manage'),
  ('workspace-administrator', 'master_data.supplier.manage'),
  ('workspace-administrator', 'master_data.customer.manage'),
  ('operations-manager', 'master_data.item.manage'),
  ('operations-manager', 'master_data.supplier.manage'),
  ('operations-manager', 'master_data.customer.manage'),
  ('operations-specialist', 'master_data.item.manage'),
  ('operations-specialist', 'master_data.supplier.manage'),
  ('operations-specialist', 'master_data.customer.manage'),
  ('procurement-specialist', 'master_data.item.manage'),
  ('procurement-specialist', 'master_data.supplier.manage')
) AS grant_row(role_key, code) ON grant_row.role_key = role."roleKey"
WHERE role."isDefaultTemplate" = true
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
