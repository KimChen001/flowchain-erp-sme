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
- Approval emails are server-generated too, per recipient: US English, or
  Chinese when that approver's language preference, or else the workspace
  default, is zh-CN (`server/mail/approval-waiting-email.mjs`). They carry
  the document type in the recipient's language and the document number as
  recorded. The Settings > My Profile switch for them has both languages.
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
- Supplier invoices are "Bills" / 采购发票 and customer invoices "Invoices" /
  销售发票 in navigation, page titles, buttons and links; Finance is "Payables &
  receivables" / 应付与应收 (`docs/bills-invoices-and-accounting-handoff.md`).
  Field labels that name the supplier's own number still say "Invoice number".
- The assistant's compound answers (a question with several parts) have English and
  Chinese copy for the answer title, the "first parts only" limitation and the card's
  section heading; each section is its skill's own answer in the question's language.
- Prefilled forms: the purchase request form opened from the assistant shows its
  "Prefilled from…" banner and each field's source label in English and Chinese
  (`src/components/prefill/PrefillSource.tsx`). A reason the assistant wrote is kept in
  the language it was written in, as stored business text.
- The draft review shows supplier message drafts (recipient, subject, message, open
  lines, "Open in email") with English and Chinese labels. The message text is the
  assistant's, in the answer language.
- Assistant answer lines state their next step ("Next: …" / "下一步：…"), and supplier
  message drafts (greeting, one line per open PO line, closing, subject) are written in
  the answer language from English and Chinese templates. Names, SKUs, units and the
  supplier's contact stay as stored; dates and numbers follow the workspace locale in
  both languages.
- The receiving form (warehouse, arrival time, accepted quantities) and the RFQ supplier
  response dialog (quantities and delivery dates from the RFQ lines) label their prefilled
  values in English and Chinese.
- Settings > Warehouse access: the Warehouses and Bins section has English and Chinese
  copy (`src/modules/settings/WarehouseMaster.tsx`). Server messages for these writes are
  English; the UI shows each known error, validation and in-use reason code in the
  active language. Warehouse and bin codes and names stay as recorded.
- The inventory reorder list (`/app/inventory/reorder`) has English and Chinese copy
  (`src/modules/inventory/reorderListCopy.ts`): headings, the scope and rule notes, row
  flags, empty states and its "Create purchase request" action. The purchase request it
  opens is labelled "Prefilled from the reorder list" / 已根据补货清单预填, and the reason
  it suggests is written in the interface language. SKUs, units, supplier names and
  purchase order numbers stay as stored; order-by dates are workspace days. The note
  that a purchase order line in another unit than the item's stock unit is not counted
  as incoming is in both languages on the reports page and in the assistant's stock and
  order answers.
- English trial screens (pilot item 7, first part). Sales delivery risks and order
  evidence (`src/modules/sales/Page.tsx`) translate the sales order read API's status
  and risk labels, the unnamed-customer name and the multi-line item name when shown
  (`src/modules/sales/salesDemandCopy.ts`); the evidence error is translated. The API
  still sends its Chinese labels; only the display changes. `server/domain/interface-language-coverage.test.mjs` lists the
  English-covered screens (the five operational finance screens, inventory operations,
  the reorder list, procurement document detail, three-way match, the receiving list,
  AI suggestions, sales risks and evidence, and the business object detail panels):
  every Chinese literal in them must be a dictionary key or the Chinese half of an
  English/Chinese pair. The browser spec `tests/browser/english-trial.spec.ts` runs
  with the US trial capability set (`PLAYWRIGHT_US_TRIAL=true`) on the walkthrough
  data and on an empty workspace, and checks Today, purchasing (workbench, requests,
  orders, receiving, bills, three-way match), inventory stock, transfers, counts and
  adjustments (lists and new forms), sales risks, evidence and invoices, finance
  overview, payables, receivables and aging, the reports overview and the open
  assistant. On the walkthrough data the harness adds two trial sales orders (three
  lines; on hold with no customer name), and the spec checks their translated labels
  on the risk and evidence pages in English and their Chinese labels in zh-CN. The
  sales order drawer on these pages and its review panel were removed (2026-10-08): no
  link opened them, and a sales order focus goes to `/app/sales/orders/:id`. Second part (2026-10-09): the sales order and shipment workbench
  (`OutboundWorkbench.tsx`), the inventory pages and their filter chips
  (`src/modules/inventory/Page.tsx`), the shell and global search panel
  (`src/app/FlowChainApp.tsx`) and the purchasing workbench (`ProcurementWorkbench.tsx`)
  are on the coverage list; the finance status filters and credit note statuses show
  labels. The global search status and a subtitle that only repeats it are translated
  where shown; other search subtitles and evidence values the server builds (for
  example "可用 …" and "安全库存 …" on stock results) are still Chinese. Deferred: an order's evidence graph, whose
  risk summaries the server writes in Chinese. Removed because no route rendered
  them: `overviewEvidence.ts` and the procurement panels (#147); the old receiving
  page, `DeliveryPage.tsx` and `ReceiptPage.tsx` (2026-10-09); the Today cockpit
  panel, the inventory movement ledger, exception, warning and adjustment page files
  and the unmounted V2 panels under `src/components` (2026-10-09).
- The sales order reserve, release and delivery draft dialogs and the shipment post,
  reverse and cancel dialogs have English and Chinese titles and confirm buttons that
  name the action. Their previews say what will happen in one or two sentences built
  from the server's preview (`src/modules/sales/outboundPreviewText.ts`), with the
  impact counts under "Technical details"; warehouses show by name and location, and
  reservation and movement ids in short form. The order and shipment timelines show
  the reservation and movement titles the workbench API builds at read time in the
  interface language (`src/modules/sales/outboundCopy.ts`); audit summaries stay as
  recorded. SKUs, item and warehouse names, units and shipment numbers stay as stored.
- Today (`/app/overview/risks`) has English and Chinese copy
  (`src/modules/overview/todayCopy.ts`): the work rows and their date labels, the
  status tiles, the first-day checklist and recent documents. The server sends codes,
  dates and numbers (`GET /api/home/overview`); document numbers, SKUs, units and
  supplier and customer names stay as stored, and calendar days and change times
  follow the workspace locale and timezone in both languages. Checked in both
  languages by `home-overview-language.spec.ts`, `today-work.spec.ts` and
  `today-first-run.spec.ts`.
- The purchase order document (`/app/procurement/orders/:id/document`) prints its
  labels in the document language: the workspace default from Settings › Company &
  workspace › Documents, or the language picked on the page for one print, which is
  not saved. Numbers, dates, currency codes, PO numbers, SKUs and units stay as
  recorded and are formatted in the workspace locale and timezone whatever the
  document language. The page's toolbar and the Documents settings form have English
  and Chinese copy; a custom document title is the workspace's own text and is printed
  as entered.
- The customer invoice document (`/app/sales/invoices/:id/document`) follows the same
  rules: labels in the document language, the invoice number, SKUs, units, amounts,
  currency codes and the invoice and due dates as recorded and formatted in the
  workspace locale (calendar days read in UTC, so the day entered is the day printed).
  Customer contact details, payment terms and payment instructions are printed as
  the workspace recorded them, in whatever language they were entered.
- The print-layout editor (receive sheet, delivery note, sign receipt) has English and
  Chinese copy for its toolbar, save, delete and import messages, the read-only and
  unreadable-template notes, the close prompt and the per-print panel. Elements added
  from the toolbar and the per-print fields start with text in the interface language.
  The built-in templates (`printLayoutPresets.ts`) are built in the interface
  language: their names, element titles, column titles, signature line and footer.
  Not yet translated: the element inspector and the canvas placeholders (page number,
  barcode, QR code). Template names and element text are template content: a template
  saved to the workspace keeps the text it was saved with in either language. The
  receive sheet opens from a receipt's detail page (`/app/procurement/receiving/:id`,
  **Print receive sheet**); the delivery note and sign receipt pages have no route yet.

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
purchasing detail views, receiving, returns/quarantine server text, and some AI
response surfaces are the largest remaining areas. Translate them at their presentation boundary with both
English and Chinese acceptance scenarios. A regression test requires every Chinese
route, module, breadcrumb, and primary-navigation label to have an English mapping.

- The returns and quarantine screens (`/app/inventory/returns/**`,
  `/app/inventory/quarantine`, `/app/sales/returns` and its form) have English and
  Chinese copy in `src/modules/inventory/returnsCopyData.ts`, including statuses,
  disposition routes, reconciliation rules, audit action names and the error codes
  the returns API and its role and sign-in checks send. Error and blocking messages
  show the raw code on a line below the text; status, type and route chips show only
  the label. A node test (`server/domain/returns-copy.test.mjs`) requires both
  languages for every string and code. For the few codes the server sends for
  several causes, English shows the server's message and Chinese a label that fits
  every cause. Still English in the Chinese UI: the server's audit summaries in the
  evidence log. The browser spec still runs in Chinese only; an English browser
  check is pending. The module stays off for the trial.

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

Checked in both languages: the workspace skill answers (every skill, both
languages, the same ids, counts and amounts) and the business query labels the
assistant evaluation reaches. Knowledge answers depend on the configured provider
and are not covered by the offline evaluation.
