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

Deploy this migration once through the normal release process before serving the
updated interface. Existing sessions pick up the new preference on page reload.
The login language preference is browser-local and does not override the signed-in
profile or workspace. An explicit workspace default still takes precedence over
the product fallback.

## Remaining localization work

This change establishes the default and localizes the login entry. It is not a
claim of complete English coverage. The AI panel, response cards, server-generated
answers, and several business pages still contain Chinese literals. These require
an incremental translation pass with English and Chinese acceptance scenarios.

For the conversational agent, carry an explicit response language through the
request, tool presentation, provider instructions, validation, and fallback.
UI language must not change business routing or authorization. Do not display
English prompt suggestions whose backend intents are still unsupported.
