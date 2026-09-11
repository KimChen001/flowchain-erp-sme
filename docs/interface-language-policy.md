# Interface language policy

English (`en-US`) is the product default. Chinese (`zh-CN`) remains a supported,
user-selectable interface language. Develop new user-facing copy in English and
provide the Chinese counterpart in the same change.

Language selection is separate from currency, country, number/date formatting,
and timezone. Never translate stored business identifiers, statuses, customer
names, or supplier names in place. Translate their presentation where appropriate.

## Current change

- English bootstrap and fallback in the interface language provider.
- English login copy, with an English/Chinese selector before authentication.
- Existing signed-in profile language selection remains in Settings > Profile.
- New tenants inherit English from the database default.
- Migration `20260908120000_english_default_interface` changes existing workspace
  defaults to English and resets explicit Chinese user preferences to English
  once, as requested by the product owner. Null preferences follow the workspace.
- The migration increments affected row versions to reject stale settings saves.
- Users can select Chinese again after migration; startup never resets preferences.
- Locale, currency, timezone, and operational data remain unchanged.
- The RFQ list, authoritative detail, supplier-response editor, quotation
  comparison, error states, and reviewed award decision use the active language.
- The local US demo includes one USD RFQ with two authoritative supplier
  quotation revisions so the complete comparison and award path is reviewable.

Deploy this migration once through the normal release process before serving the
updated interface. Existing sessions pick up the new preference on page reload.
The login language preference is browser-local and does not override the signed-in
profile or workspace. An explicit workspace default still takes precedence over
the product fallback.

## Remaining localization work

The primary navigation, every registered route/breadcrumb label, item workspace,
purchasing workbench, and sales-order workbench now use the active UI language.
Stored seeded and business values remain unchanged. Run `npm run audit:i18n` to rank
remaining potential display literals; the report is deliberately heuristic because
Chinese business values and API status enums must not be rewritten as UI copy.

This is not yet a claim of complete English coverage. Supplier details, other
purchasing detail views, receiving, returns/quarantine, and some AI response surfaces are the
largest remaining areas. Translate them at their presentation boundary with both
English and Chinese acceptance scenarios. A regression test requires every Chinese
route, module, breadcrumb, and primary-navigation label to have an English mapping.

For the conversational agent, carry an explicit response language through the
request, tool presentation, provider instructions, validation, and fallback.
UI language must not change business routing or authorization. Do not display
English prompt suggestions whose backend intents are still unsupported.
