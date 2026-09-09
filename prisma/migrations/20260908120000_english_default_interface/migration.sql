-- One-time product language reset requested for existing workspaces.
-- Apply once through the normal migration release step, never at startup.
-- Date/number locale, currency, timezone, and business records are unchanged.
BEGIN;
ALTER TABLE "Tenant" ALTER COLUMN "defaultLanguage" SET DEFAULT 'en-US';
UPDATE "Tenant"
SET "defaultLanguage" = 'en-US', "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "defaultLanguage" IS DISTINCT FROM 'en-US';
-- Reset explicit Chinese UI preferences once. Users can select Chinese again
-- in Settings > Profile after deployment; later choices are never overwritten.
UPDATE "User"
SET "languagePreference" = 'en-US', "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "languagePreference" = 'zh-CN';
COMMIT;
