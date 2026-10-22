-- Contract permissions (docs/contracts-module-design.md §4, D7).
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

  IF position('contracts.contract.read' IN prior_definition) > 0 THEN
    RETURN;
  END IF;

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" IN (''contracts.contract.read'',''contracts.contract.manage''))';
END $$;

-- Existing default roles receive the same grants as a fresh authorization
-- backfill (defaultRoleTemplates in server/auth/permission-catalog.mjs):
-- administrators, operations managers and procurement specialists read and
-- manage contracts; finance and operations specialists and read-only viewers
-- read them. Administrators can remove these grants afterwards and they stay
-- removed. Custom roles are left to workspace administrators.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT
  'AUTH-' || substr(md5(role."tenantId" || ':' || role."id" || ':' || grant_row.code), 1, 28),
  role."tenantId",
  role."id",
  grant_row.code
FROM "TenantRole" AS role
JOIN (VALUES
  ('workspace-administrator', 'contracts.contract.read'),
  ('workspace-administrator', 'contracts.contract.manage'),
  ('operations-manager', 'contracts.contract.read'),
  ('operations-manager', 'contracts.contract.manage'),
  ('procurement-specialist', 'contracts.contract.read'),
  ('procurement-specialist', 'contracts.contract.manage'),
  ('finance-specialist', 'contracts.contract.read'),
  ('operations-specialist', 'contracts.contract.read'),
  ('read-only-viewer', 'contracts.contract.read')
) AS grant_row(role_key, code) ON grant_row.role_key = role."roleKey"
WHERE role."isDefaultTemplate" = true
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
