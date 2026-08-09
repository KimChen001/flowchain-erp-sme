-- Extend the code-owned permission catalog without rewriting prior migrations.
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

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" IN (''procurement.rfq_response.create'',''procurement.rfq_response.revise''))';
END $$;

-- Existing default roles receive the same grants as a fresh authorization backfill.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT
  'AUTH-' || substr(md5(role."tenantId" || ':' || role."id" || ':' || permission.code), 1, 28),
  role."tenantId",
  role."id",
  permission.code
FROM "TenantRole" AS role
CROSS JOIN (VALUES
  ('procurement.rfq_response.create'),
  ('procurement.rfq_response.revise')
) AS permission(code)
WHERE role."isDefaultTemplate" = true
  AND role."roleKey" IN ('workspace-administrator', 'operations-manager', 'procurement-specialist')
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
