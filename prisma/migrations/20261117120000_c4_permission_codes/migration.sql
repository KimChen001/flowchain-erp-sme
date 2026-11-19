-- Design audit C4 (2026-11-17), the permission codes:
--   procurement.purchase_request.read / create / submit / approve / reject
--     (L1-07 = L4-11 = L7-32): requests had no codes of their own and
--     borrowed the purchase order's, so "may raise a request but not order"
--     could not be set up;
--   master_data.supplier.bank.manage (L4-10): changing a supplier's bank
--     details, apart from the rest of the supplier record;
--   sales_order.hold (L4-16): holding a sales order needed the cancel
--     permission.
-- Running this file a second time changes nothing.

-- Extend the code-owned permission catalog without rewriting prior
-- migrations, unless it already allows the new codes.
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

  IF position('procurement.purchase_request.read' IN prior_definition) > 0 THEN
    RETURN;
  END IF;

  prior_expression := regexp_replace(prior_definition, '^CHECK \((.*)\)$', '\1');
  EXECUTE 'ALTER TABLE "TenantRolePermission" DROP CONSTRAINT "TenantRolePermission_permissionCode_catalog_check"';
  EXECUTE 'ALTER TABLE "TenantRolePermission" ADD CONSTRAINT "TenantRolePermission_permissionCode_catalog_check" CHECK ('
    || prior_expression
    || ' OR "permissionCode" IN ('
    || '''procurement.purchase_request.read'', '
    || '''procurement.purchase_request.create'', '
    || '''procurement.purchase_request.submit'', '
    || '''procurement.purchase_request.approve'', '
    || '''procurement.purchase_request.reject'', '
    || '''master_data.supplier.bank.manage'', '
    || '''sales_order.hold'''
    || '))';
END $$;

-- Every role, default or custom, keeps exactly what it could do: each new
-- code goes to the roles holding the code that allowed the same act until
-- now. A role that could read purchase orders could read requests; "revise"
-- created, edited, submitted, withdrew, reopened and cancelled requests;
-- "approve" and "reject" decided them; managing a supplier changed its bank
-- details; cancelling a sales order was needed to hold it. New workspaces
-- get the templates in server/auth/permission-catalog.mjs instead, where
-- the operations manager no longer changes bank details by default and the
-- operations specialist may raise requests.
INSERT INTO "TenantRolePermission" ("id", "tenantId", "roleId", "permissionCode")
SELECT DISTINCT
  'AUTH-' || substr(md5(existing."tenantId" || ':' || existing."roleId" || ':' || mapping.new_code), 1, 28),
  existing."tenantId",
  existing."roleId",
  mapping.new_code
FROM "TenantRolePermission" AS existing
JOIN (VALUES
  ('procurement.purchase_order.read', 'procurement.purchase_request.read'),
  ('procurement.purchase_order.revise', 'procurement.purchase_request.create'),
  ('procurement.purchase_order.revise', 'procurement.purchase_request.submit'),
  ('procurement.purchase_order.approve', 'procurement.purchase_request.approve'),
  ('procurement.purchase_order.reject', 'procurement.purchase_request.reject'),
  ('master_data.supplier.manage', 'master_data.supplier.bank.manage'),
  ('sales_order.cancel', 'sales_order.hold')
) AS mapping(old_code, new_code) ON mapping.old_code = existing."permissionCode"
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
