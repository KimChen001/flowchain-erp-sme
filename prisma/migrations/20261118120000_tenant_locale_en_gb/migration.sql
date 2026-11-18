-- Design audit L11-27: a workspace's regional format may be en-GB (day
-- before month, as a UK workspace writes dates). The regional format sets how
-- dates and numbers are written; the interface language never changes it.
ALTER TABLE "Tenant" DROP CONSTRAINT "Tenant_locale_supported_check";
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_locale_supported_check"
    CHECK ("locale" IN ('zh-CN', 'en-US', 'en-GB'));
