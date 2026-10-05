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
- Email sign-in: the email-only sign-in page, "Check your email", the
  `/sign-in/confirm` page and its errors have English and Chinese copy
  (`src/app/SignInScreens.tsx`, browser spec `email-link-sign-in.spec.ts`).
  The sign-in email is server-generated: US English by default, Chinese when
  the user's language preference, or else the workspace default, is zh-CN
  (`server/mail/sign-in-email.mjs`). Before sign-in the page follows the
  browser-local selector; the email follows the stored preference.
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
- The local US development workspace includes one USD RFQ with two authoritative supplier
  quotation revisions so the complete comparison and award path is reviewable.
- The report dashboards' visuals, KPIs, key insights, chart data tables and
  downloads use the active language; status codes use the shared status labels and
  business names stay as recorded (`docs/report-dashboards.md`).
- The assistant's compound answers (a question with several parts) have English and
  Chinese copy for the answer title, the "first parts only" limitation and the card's
  section heading; each section is its skill's own answer in the question's language.
- Prefilled forms: the purchase request form opened from the assistant shows its
  "Prefilled from…" banner and each field's source label in English and Chinese
  (`src/components/prefill/PrefillSource.tsx`). A reason the assistant wrote is kept in
  the language it was written in, as stored business text.

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

The global search dropdown still shows Chinese literals for its heading, loading,
empty and overflow states, and the server builds the search source hint and the
evidence-graph risk summaries in Chinese. The notes that a role hides record
types from search (`top.searchRestricted`) or cannot open an evidence chain
(`evidence.restricted`) use the i18n context in both languages.

For the conversational agent, carry an explicit response language through the
request, tool presentation, provider instructions, validation, and fallback.
UI language must not change business routing or authorization. Do not display
English prompt suggestions whose backend intents are still unsupported.

The assistant answers in the language the question is phrased in, and falls
back to the UI language only when the question has no language of its own
(`PO-012`, `SKU ATP`). The gateway decides this once per request
(`aiSkillQuestionLanguage` in `server/domain/ai-skill-copy.mjs`) and passes it to
the knowledge, business query and skill paths and to error messages. A question
is phrased by its frame words (English question and function words; Chinese
question words, particles and pronouns), not by the names it carries: "How many
未结采购订单 do we have?" is answered in English and "PO-012 的状态是什么？" in
Chinese. Supplier, item and record names are shown as stored. The original
`answerLanguage` from the client is kept as `interfaceLanguage`.

Checked in both languages in the browser (product recovery suite): the
assistant's scope line, input placeholder and answer on a purchase order's
page, its refusal of an instruction to act, the action draft review dialog's
field labels, the purchase request form an assistant draft prefills (banner
and source labels), and the sales order evidence graph. Follow-ups and
compound answers are checked in the browser in English only.

Checked in both languages: the workspace skill answers (every skill, both
languages, the same ids, counts and amounts) and the business query labels the
assistant evaluation reaches. Knowledge answers depend on the configured provider
and are not covered by the offline evaluation.
