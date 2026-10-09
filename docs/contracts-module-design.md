# Contracts module: design

Status: design, 2026-10-09. Written against main at `41788ace`. Nothing is built yet.
The decisions for the owner are in [§11](#11-decisions-for-the-owner).

Owner decisions so far (2026-10-09):
- Contracts get **their own top-level module**. A supplier's contracts can also be seen
  and started from the supplier's page. The owner's reason: the product should be
  complete here, even if a workspace never uses it.
- Build it in steps, design first.

## Summary

- **What a contract is in FlowChain:** a record of an agreement the business has already
  signed outside FlowChain. It holds the key terms, the dates, the signed file and, for
  purchase agreements, the agreed item prices. FlowChain does not draft, negotiate or
  sign contracts.
- **Why it matters for this product:** the dates stop renewals and price changes from
  slipping by unnoticed, and the agreed prices give buyers and approvers something to
  check a purchase price against. Later, the savings ledger can use them as a baseline.
- **Three steps:**
  - **K1, contract records** (about 3–4 days): the module, the list, the detail page, the
    signed file, reminders on Today, and a Contracts tab on the supplier page.
  - **K2, agreed prices** (about 2–3 days): price lines on a purchase agreement, which a
    new purchase request takes first, and a warning when a price is above the contract.
  - **K3, later:** the assistant, emailed reminders, customer contracts and approvals.
- **Off in the 10/25 trial** behind its own switch, and on in the local walkthrough,
  until its tests and a walkthrough pass.

## 1. What exists today

| Area | Today | Where |
| --- | --- | --- |
| Contract data | None. No model, table or column mentions a contract, agreement or blanket order. | `prisma/schema.prisma` |
| Contract page | A hidden, frozen placeholder route "框架合同" / "Framework agreements" that says contracts are not available. A typed URL shows the capability-blocked page. | `routeRegistry.tsx` `procurement:contracts`; `route-manifest.ts` FROZEN; `procurement/Page.tsx` |
| Leftovers | `SupplierRecommendationResult.contractId/contractLabel/contractDiscount/contractTierMinQty` (no reader); `CONTRACTS = []` (no importer); the assistant's supplier query reads `db.contracts`, which nothing fills. | `src/types/scm.ts`, `src/data/empty-business-state.ts`, `server/domain/ai-supplier-operational-query.mjs` |
| Agreed prices today | Item–supplier links hold a `referencePrice`, currency, MOQ and lead time, with no validity dates. A new purchase request takes the preferred supplier's `referencePrice`. A PO line copies its price from the request line; there is no PO price edit. | `master-data-commands.mjs` `saveItemSupplier`; `shared/purchase-request-prefill.mjs`; `procurement-request-command-service.mjs` |
| Price history | Last prices paid per item and supplier, and a quote-vs-history comparison | `shared/price-history.mjs`, `PriceHistoryFacts` |
| File storage | Uploads exist only for receiving and the frozen settlement flow. They are local disk (`FLOWCHAIN_UPLOAD_STORAGE_DIR`, a 1 GB disk on staging), PDF and images, 20 MB each, and staging needs `mobile.sync.use`. The routes answer 409 unless mobile operations or the settlement workflow is on. | `server/routes/attachments.routes.mjs`, `attachment-service.mjs`, `render.yaml` |
| Scheduled jobs | None. Nothing runs daily, so nothing can send a reminder email on a date. | — |
| Today | Work items are computed on each read from the records. A new kind is a reader plus an entry in `TODAY_WORK_KINDS`. | `today-work-read-service.mjs`, `today-work.mjs` |
| Permissions | Codes live in a catalogue, and a database check lists every allowed code, so new codes need a migration. | `server/auth/permission-catalog.mjs`, migration `20261002030000_master_data_permissions` |
| Numbering | Workspace numbering settings exist but are not in effect. Documents use a prefix plus 8 characters of a uuid (`PO-1a2b3c4d`). | `workspace-settings-contract.mjs`, `procurement-request-command-service.mjs` |

## 2. What a contract records

One record per signed agreement:

| Field | Notes |
| --- | --- |
| Number | System number `CT-xxxxxxxx`, shown everywhere. |
| Their reference | Optional. The number on the signed document, which is often the supplier's. Searchable. |
| Title | Required, for example "2026 packaging supply agreement". |
| Type | Purchase agreement, Service agreement, NDA, Quality agreement, Other ([D2](#11-decisions-for-the-owner)). |
| Supplier | Required in K1. The model keeps a counterparty type so customer contracts can come later without a new table. |
| Owner | A workspace user who answers for it and gets its reminders. Defaults to the supplier's business owner. |
| Start date, end date | Calendar days, as entered, like due dates since #170. An empty end date means open-ended. |
| Signed on | Required to activate. |
| Renewal | None, Renews automatically, or Renew by agreement. |
| Notice period | Days. For a contract that renews automatically, the reminder is about the last day to give notice, not the end date. |
| Remind me | Days before the key date, 60 by default ([D6](#11-decisions-for-the-owner)). |
| Payment terms | From the payment terms list. Informational in K1. |
| Currency, total value | Optional. Hidden from readers without `procurement.prices.read`, like other prices. |
| Signed file | One or more PDFs or images ([D5](#11-decisions-for-the-owner)). |
| Notes | Free text. |
| Renews | A link to the contract this one replaces, if any. |

**Status.** People set only three states; the rest is read from the dates on each read,
in the workspace's calendar day:

| Shown as | Meaning |
| --- | --- |
| Draft | Being recorded. No reminders, never used for prices. |
| Active | Signed and in force. |
| Active · Notice due by *date* | Renews automatically and the notice deadline is inside the reminder window. |
| Active · Ends in *n* days | The end date is inside the reminder window. |
| Ended | The end date has passed, it does not renew automatically, and no renewal was recorded. |
| Renewed | A newer contract that renews it was activated. |
| Terminated | Ended early by a person, with a date and a reason. |

A contract that renews automatically and passes its end date stays Active. Today then asks
someone to record the new end date ([§5](#5-reminders)). FlowChain never moves a date by
itself.

**Changes.** Every change keeps a version number, so two people cannot overwrite each other,
and writes an audit row (`contract_created`, `contract_activated`, `contract_updated`,
`contract_terminated`, `contract_file_added`, `contract_file_removed`). The detail page shows
the history.

**Renewal** creates a new contract, prefilled from the old one, with "Renews CT-…". When
the new one is activated, the old one shows Renewed. Nothing is edited in place, so the
history of terms stays readable.

## 3. Navigation and pages

- **Sidebar:** "Contracts" / "合同", right after Suppliers ([D8](#11-decisions-for-the-owner)).
- **Second-level tabs:** Contracts | Ending soon | Contract prices (K2).
- **Contracts list.** It follows the purchase-order list layout ([list page layout](../src/modules/purchasing/Page.tsx)):
  - cards: Active, Ending in 60 days, Notice due, Drafts;
  - a search card: number, reference, title, supplier, type, status, owner;
  - a table: number, title, supplier, type, start, end, key date, owner and a status chip.
- **Ending soon.** The same table filtered to contracts whose key date is inside their
  reminder window, earliest first. It follows the owner's 2026-10-03 rule: order by date,
  not by score.
- **Detail page.**
  - Header: number, status chip and actions (Activate, Edit, Renew, Terminate, Add file).
  - Terms card, Files card, Price lines card (K2), Purchase orders card (K2: orders that
    used its prices), History.
- **New contract form.** It can be opened from the list, or from a supplier with the
  supplier filled in.
- **Supplier page.** A third tab "Contracts" beside Details and Performance. It lists
  that supplier's contracts and has a New contract button.
- **The old placeholder** `procurement:contracts` is removed. Its URL redirects to the new
  module, and the dead leftovers in §1 are deleted.

## 4. Who can do what

New permission codes ([D7](#11-decisions-for-the-owner)):
- `contracts.contract.read`: see contracts and download their files;
- `contracts.contract.manage`: create, edit, activate, renew, terminate, add and remove files.

Default roles:

| Role | Read | Manage |
| --- | --- | --- |
| Workspace Administrator | yes | yes |
| Operations Manager | yes | yes |
| Procurement Specialist | yes | yes |
| Finance Specialist | yes | — |
| Operations Specialist | yes | — |
| Read-only Viewer | yes (no amounts or prices) | — |

Amounts and price lines follow `procurement.prices.read`, as on purchase orders. Files are
served only through an authorized download; there are no public links.

## 5. Reminders

- **Today.** Three new work kinds, computed on read like the others:
  - `contract_notice_due`: renews automatically, and the notice deadline is inside the
    window;
  - `contract_ending`: the end date is inside the window;
  - `contract_past_end`: still Active past its end date (renews automatically, or nobody
    recorded what happened).

  Each row names the contract, supplier and date and opens the contract. The owner of the
  contract sees it; administrators see all.
- **Email** needs something that runs every day, and FlowChain has nothing like it yet.
  K1 leaves email out; K3 adds the first daily job ([D6](#11-decisions-for-the-owner)).

## 6. Signed files

- **Storage.** The existing upload service, with a new contract binding beside receiving
  and settlement: PDF and images, 20 MB each, kept on the workspace's disk.
- **Upload switch.** Uploads stop depending on mobile operations: the attachment routes
  also open when contracts are on, and staging a contract file needs
  `contracts.contract.manage` instead of `mobile.sync.use`. This matters because the trial
  scope lock (#143) turns mobile operations off.
- **Request size.** The shared JSON body reader (`server/utils/http.mjs` `readBody`) has no
  size limit, so an upload request is read into memory whole before the 20 MB check.
  Contract uploads use the bounded reader custom fields already use (`readBoundedJson`).
  The other routes, sign-in included, have the same gap; it is tracked separately.
- **Disk.** Staging has a 1 GB disk. Contracts are small, but the pilot plan should say
  when to grow it or move to object storage.

## 7. Agreed prices (K2)

- **Price lines.** A purchase agreement can have price lines: item, unit price, currency,
  unit, minimum order quantity and an optional validity within the contract's dates.
- **New purchase requests.** When the chosen supplier has an Active contract with a valid
  line for the item, the request takes that price and labels it "Contract CT-… price". It
  falls back to the reference price as today. It never switches supplier on its own; if
  another approved supplier has a contract price, it says so.
- **Above the contract price.** A request or order line whose price is above the
  contract price shows the difference ("$0.40 (8%) above CT-…") on the line and on the
  approval view. It is a warning, not a block ([D9](#11-decisions-for-the-owner)).
- **Contract prices tab.** All valid price lines by item and supplier, so a buyer can
  see what was agreed without opening each contract.
- **Price history.** Shows the contract price as a reference line next to the prices paid.

## 8. What the module does not do

- Drafting, redlining, clause libraries, e-signature or legal approval. Those tools serve
  legal teams; FlowChain's users are the people who buy, receive and pay.
- Tracking obligations beyond dates and prices: volume commitments, rebates, penalties.
- Checking supplier bills against contract prices. The three-way match already checks
  bills against the purchase order, and the order is checked against the contract (K2).

## 9. Later (K3)

- **Assistant:** answer "which contracts end this quarter" and "do we have a contract
  with X" from real records, replacing the empty `db.contracts` read; name the contract
  price when it prepares a request.
- **Read a signed file:** the assistant proposes the key terms from an uploaded PDF and a
  person confirms them. This follows the propose → confirm → execute rule.
- **Emailed reminders:** the first daily job, with its own runbook.
- **Customer contracts** for sales, using the same model.
- **Approval** before activation, reusing approval emails, if design partners ask for it.

## 10. Build plan

**K1, contract records**
- Data:
  - migration for `Contract` and `ContractAttachment`;
  - a permission migration (catalogue check and default roles).
- Switch: capability `contracts` with `FLOWCHAIN_ENABLE_CONTRACTS`, explicit enable. It is
  on in the walkthrough and off in `render.yaml` and the trial capability test until
  verified.
- Routes:
  - module, list, ending soon, new and detail;
  - the old placeholder is removed and redirected;
  - the route authority matrix is regenerated.
- Server:
  - commands: create, update, activate, renew, terminate, add and remove a file, each
    with a version check, an idempotency key and audit;
  - the list read with filters and visibility;
  - three Today kinds.
- Pages:
  - list, detail, form and the supplier tab, in English and Chinese, with the language
    coverage test.
- Tests:
  - node: dates and status in the workspace day, permissions, masking;
  - Postgres: commands, concurrency, tenant isolation, files;
  - browser: create, activate, upload, ending soon, Today and the supplier tab, in both
    languages.

**K2, agreed prices**
- price lines;
- the request prefill change;
- the above-contract warning on request, order and approval;
- the Contract prices tab;
- the price history line;
- an assistant eval check that its answers did not change.

## 11. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Which counterparties in K1 | Suppliers only. Customer contracts in K3, with no new table. |
| D2 | Contract types | Five fixed types: Purchase agreement, Service agreement, NDA, Quality agreement, Other. Workspace-defined types later if partners ask. |
| D3 | Approval before a contract is active | None in K1: FlowChain records what was already signed, so Activate needs a signed date and the manage permission. |
| D4 | Contract number | The system number `CT-xxxxxxxx` plus an optional "their reference". |
| D5 | Signed files | Upload PDFs and images (20 MB each) on the existing upload service, and decouple uploads from mobile operations. |
| D6 | Reminders | Per-contract "remind me", 60 days by default, shown on Today and the Ending soon tab. Email in K3, with the first daily job. |
| D7 | Permissions and default roles | Two codes (read and manage) and the role table in §4. |
| D8 | Sidebar position | After Suppliers, with tabs Contracts, Ending soon and Contract prices (K2). |
| D9 | A price above the contract | Warn on the line and the approval view; never block. |
| D10 | Trial | Off in the 10/25 trial, on in the walkthrough. Build K1 after the supplier sub-tab change; K2 after the trial. |
