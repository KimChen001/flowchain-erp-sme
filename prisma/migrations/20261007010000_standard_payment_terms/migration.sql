-- Every workspace starts with the standard payment terms (owner decision D2,
-- 2026-10-07); tenant:provision adds them to new workspaces. This adds the
-- same terms to workspaces created before that which have no payment terms at
-- all, so a supplier file that says NET30 imports. A workspace that already
-- has any payment term keeps exactly what it has. The list matches
-- STANDARD_PAYMENT_TERMS in server/domain/standard-payment-terms.mjs.
INSERT INTO "PaymentTerm" ("id", "tenantId", "code", "name", "days", "createdAt", "updatedAt")
SELECT 'PT-' || md5(t."id" || E'\x1f' || s.code), t."id", s.code, s.name, s.days, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (VALUES
  ('DUE', 'Due on receipt', 0),
  ('NET15', 'Net 15', 15),
  ('NET30', 'Net 30', 30),
  ('NET45', 'Net 45', 45),
  ('NET60', 'Net 60', 60)
) AS s(code, name, days)
WHERE NOT EXISTS (SELECT 1 FROM "PaymentTerm" p WHERE p."tenantId" = t."id");
