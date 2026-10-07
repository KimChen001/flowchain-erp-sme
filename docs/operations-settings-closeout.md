# Phase 4C Operations Productization and Settings Closeout

Phase 4C consolidates workspace configuration on the existing PostgreSQL `Tenant` and `User` authorities. It does not introduce a parallel workspace model.

## Authoritative settings

- `Tenant.name`: workspace name
- `Tenant.legalName`: company name
- `Tenant.currency`: ISO 4217 base currency
- `Tenant.timezone`: governed IANA timezone
- `Tenant.locale`: regional formatting (`zh-CN` or `en-US`)
- `Tenant.defaultLanguage`: default interface language (`zh-CN` or `en-US`)
- `Tenant.operationalSettings`: numbering, lightweight review, module, AI-governance, advanced, and documents settings. The documents section (document language, letterhead, purchase order and invoice templates) is in effect: the PO and invoice documents print it. Saving it needs `settings.workspace.manage` and replaces the whole section.
- `User.languagePreference`: `null` to follow the workspace, otherwise `zh-CN` or `en-US`

The effective interface language is resolved as user preference, then workspace default, then `zh-CN`. Locale and timezone never select the interface language.

Base currency changes fail with `BASE_CURRENCY_LOCKED` after posted transaction facts or a posted opening balance exist. Historical documents are never rewritten and no FX conversion is inferred.

## Save and audit behavior

Workspace, profile, numbering, and review updates use PostgreSQL transactions. Every successful save creates an `AuditLog` row containing the signed actor, timestamp, before snapshot, and after snapshot. Database mode does not use Runtime JSON as the authority for these settings.

## Product surface

The formal settings navigation contains one entry for each supported page and removes the former duplicate Pilot entries. Chinese and English route labels, shell navigation, settings controls, formatting previews, and capability-disabled copy use the shared i18n layer. Page headers include the current workspace name.

Timezones and currencies use searchable governed selectors. Free text cannot become the stored timezone or base currency.

## Acceptance

- `npm run test:api:settings`
- `npm run test:browser:settings`

The API gate runs against fresh PostgreSQL migrations and verifies persistence across a server restart. The browser gate verifies both languages, user override, follow-workspace behavior, refresh persistence, locale formatting, timezone independence, formal navigation cleanup, and localized capability-disabled copy.
