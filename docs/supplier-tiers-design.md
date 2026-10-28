# Supplier tiers and the supplier list: design

Status: design, 2026-10-04. Written against main at `36025e4`. On 2026-10-04 the owner
approved all eight decisions in [§10](#10-decisions-for-the-owner) as recommended and asked
for T1.

Owner decisions so far, all made on 2026-10-04:
- Tiers mean importance to the business. People set them; the system suggests a
  tier and states its reasons.
- The search bug comes first. It is fixed in #132.
- Two points are read as follows; the owner was told and may correct them:
  - anyone with `master_data.supplier.manage` may set a tier, and every change is
    audited;
  - supplier work runs alongside the AI roadmap.

The decisions still open are in [§10](#10-decisions-for-the-owner).

## Summary

- **Three tiers by importance.** Each tier has a written meaning, and the UI shows it
  wherever a tier is chosen:
  - Tier 1 Strategic;
  - Tier 2 Core;
  - Tier 3 Transactional;
  - Not tiered, until someone decides. A supplier never gets a tier silently.
- **A person sets the tier with a reason.** Every change is an audit row, and the
  supplier page shows the history.
- **The system suggests a tier from facts it can show.** These are the supplier's
  share of spend, whether it is the only source of an item, and whether it was used
  at all in the last 12 months. There is no weighted score: the owner rejected
  hand-set scores for the assistant on 2026-10-03, and the same reasoning applies
  here. Delivery performance is shown next to the tier, never mixed into it.
- **The supplier list gets tabs and business columns.**
  - Tabs: All, Managed by me, one tab per tier, and Not tiered.
  - Columns: tier, business owner, 12-month spend, open and overdue orders, on-time
    rate, open issues.
  - FlowChain already computes every one of these numbers somewhere; none is shown
    on the list today.
- **Three PRs: T1, T2, T3** ([§8](#8-phases)). T1 needs a migration. Groups, tags,
  cost centers, documents and onboarding approval come later ([§9](#9-later-s2)).

## 1. What exists today

| Area | Today | Where |
| --- | --- | --- |
| Supplier record | `code`, `name`, `category` (the first category), `status` (active, inactive, draft); everything else in `metadata` JSON | `prisma/schema.prisma` `model Supplier` |
| `riskLevel`, `score` columns | Never written. A missing risk reads as "medium". | `supplier-master-command.mjs`, `db-master-data-repository.mjs` `mapSupplier` |
| Tier, owner, tag, cost center, group | None | — |
| List page | Code, name, contact, phone, categories, currency, payment terms, lead time, status, updated. Search and category filters work since #132. | `src/modules/srm/Page.tsx` |
| Detail page | Details and Performance tabs. "Purchase records" and "Risks and exceptions" are fixed empty placeholders. | `src/modules/srm/Page.tsx` |
| Committed spend per supplier, share of spend | Reports dashboard only. With several currencies it uses the share of orders instead. | `server/domain/report-dashboard-visuals.mjs` |
| On time, in full, OTIF, rejections, price variances | Supplier Performance tab and Reports. Against the original promise, 90 days, at least 5 lines, never adding currencies. | `server/domain/supplier-scorecard.mjs` |
| Open, overdue and unreceived orders; invoice and receiving issues | Assistant only | `supplier-action-summary-read-service.mjs`, `ai-skill-signals.mjs` |
| Item sources | Item-supplier links (active, approved, preferred) and `Item.preferredSupplierId` | `master-data-commands.mjs` |
| Who edits suppliers | `master_data.supplier.manage`: Workspace Administrator, Operations Manager, Operations Specialist, Procurement Specialist. The Operations Specialist cannot read purchase orders. | `server/auth/permission-catalog.mjs` |
| Listing users | `GET /api/workspace/users` needs `settings.users.read`, which buyers do not have | `server/routes/pilot-workspace.routes.mjs` |
| Unused tier vocabulary | `src/modules/suppliers/*` labels strategic / core / remediation on an empty static list. Nothing imports it. | `SupplierTable.tsx` |

## 2. Tiers

### 2.1 Meaning

| Tier | Meaning (shown in the UI) | Typical number |
| --- | --- | --- |
| Tier 1 Strategic | Losing this supplier would stop sales or operations soon. It needs a named owner and regular review. | A handful |
| Tier 2 Core | A regular, approved source, with alternatives or limited impact. | Most active suppliers |
| Tier 3 Transactional | Occasional or low-impact purchases. | The long tail |
| Not tiered | Nobody has decided yet. | Every supplier until reviewed |

The tier is about importance, not performance. A Tier 1 supplier that delivers
late is exactly the case the list should surface: the late deliveries show in its
own columns, and its tier stays Tier 1.

### 2.2 Data

New columns on `Supplier`. They are columns rather than `metadata`, because the tabs
filter and count in the database; #132 showed what happens when a filter cannot
reach the data.

| Column | Type | Rule |
| --- | --- | --- |
| `tier` | `Int?` | 1, 2 or 3 (check constraint); null means not tiered |
| `tierReason` | `String?` | Required whenever `tier` is set, 3 to 500 characters |
| `tierSetById` | `String?` | The user who set it |
| `tierSetAt` | `DateTime?` | When |
| `businessOwnerId` | `String?` | A user of the same workspace (foreign key to `User`) |

Indexes `(tenantId, tier)` and `(tenantId, businessOwnerId)`. Existing suppliers
start as not tiered, with no owner.

### 2.3 Setting a tier

- `PATCH /api/master-data/suppliers/:id/tier` takes `{ tier, reason, expectedVersion }`.
  `tier: null` clears it, with a reason.
  - It is separate from the profile save, so a tier change always carries a reason.
  - It writes its own audit row: action `tier_change`, with the old tier, the new
    tier, the reason and whether a suggestion was accepted.
  - It bumps the supplier version, as a profile save does.
- `PATCH /api/master-data/suppliers/:id/owner` takes `{ businessOwnerId, expectedVersion }`
  and writes audit action `owner_change`.
- Both need `master_data.supplier.manage` (the reading above). Every signed-in user
  who can read suppliers sees the tier, its reason and the owner.
- The owner must be an active user of the same workspace. `GET /api/master-data/supplier-owners`
  returns `{ id, name }` for active users, and only to `master_data.supplier.manage`.
  Picking an owner then needs no user-administration rights.
- Status and tier are independent. An inactive supplier keeps its tier, and the
  tier tabs show active suppliers by default.
- The detail page shows the tier history from the audit rows: date, from and to,
  who, and the reason.

## 3. Suggestions

The suggestion is computed when it is read: as of today, over the last 12 months,
and with the reader's own access. It is never stored. Rules are checked in order.
Every fact that holds is listed as a reason, so a reader can check each one.

| Suggests | When | Reason shown, for example |
| --- | --- | --- |
| Tier 1 | **Spend concentration.** Rank suppliers by committed PO amount over the last 12 months, largest first, and add them up until the total reaches 50%. Every supplier added, including the one that crosses 50%, is suggested for Tier 1. With more than one PO currency, order count is used instead, as the reports dashboard does, and the reason says so. | "18.2% of committed spend in the last 12 months, 2nd of 14 suppliers" |
| Tier 1 | **Only source.** The supplier is the only active, approved source of an active item. Only items with recorded sources count. An item with no supplier links, only a preferred supplier, says nothing about alternatives, so the reason lists it as "sources not recorded" instead. | "Only approved source of LDM-001 and LDM-002" |
| Tier 3 | No committed PO in the last 12 months and not a source of any active item | "No purchase orders in the last 12 months" |
| Tier 2 | Everything else | "9 purchase orders in the last 12 months; its items have other approved sources" |

- **Performance never changes the suggestion** (decision 3). Late deliveries and
  rejections show beside the tier, with the scorecard's own sample rules.
- **The reader's access applies.** Facts the reader cannot read are left out, and the
  suggestion says "Based on what you can see". An Operations Specialist, for
  example, gets suggestions from item sources only.
- **Where suggestions show:**
  - the tier card on the detail page, with an **Accept** button that prefills the
    reason with the suggestion's reasons;
  - a "Suggestion differs" mark on the list;
  - a **Review suggestions** page for suppliers that are not tiered. It lists each
    supplier with its suggestion and reasons. You can accept one row, or accept all
    shown after a confirmation (decision 4). Each accepted supplier gets its own
    audit row.
- **Thresholds** are fixed in code for now: 12 months, 50%, and the meaning of "only
  source" (decision 2). Making them workspace settings is S2.

## 4. Supplier list

**Tabs**, each with its count from the database: All, Managed by me, Tier 1, Tier
2, Tier 3, Not tiered.

**Columns:**

| Column | Content | Hidden when |
| --- | --- | --- |
| Supplier | Code and name, linking to the detail page | — |
| Category | All categories | — |
| Tier | A chip; a dot when the suggestion differs | — |
| Business owner | Name, or "—" | — |
| Spend, 12 months | Committed PO amount in the document currency. With several currencies, the largest one plus "+ n currencies". Never converted. | The reader cannot see PO amounts |
| Open POs / Overdue POs | Counts, using the open purchase orders report's rules | The reader cannot read purchase orders |
| On time, 90 days | Scorecard rate against the original promise; "—" under 5 lines | Same |
| Open issues | Count of open signals: overdue POs, rejected or unposted receipts, invoice variances. They are the assistant's signals, so the numbers agree. | Each kind follows its own read permission |
| Status | Active, inactive, draft | — |

- **Filters:** search (code or name), status, category, owner.
- **Sort:** name by default. A reader may sort by spend, overdue POs or open issues.
  The owner's date-order rule (2026-10-03) governs assistant lists. Here the reader
  chooses a column, and the order never comes from a hidden weight.
- **Moved off the list:** contact, phone, currency, payment terms, lead time and
  updated stay on the detail page (decision 6).
- **Cost:** one list read loads the tenant's suppliers, their purchase orders from
  the last 12 months and the open ones, receipts from the last 90 days, and invoice
  signals. That fits SME volumes (at most 500 suppliers, as the list limit already
  says) computed in the application, as the reports are. T2 measures it. If p95 goes
  over 1 s, the metrics are cached per workspace and day.

## 5. Supplier detail

- **Header:** the tier chip with its reason, the business owner, and **Change tier**
  and **Change owner** (a reason is required for the tier).
- **Suggestion card,** shown when the suggestion differs from the tier or the
  supplier is not tiered.
- **Tier history,** from the audit rows.
- **Purchase records** fills the current placeholder: the last 20 purchase orders
  (number, date, status, promised date, and amount where allowed), and invoices for
  readers who may see them.
- **Risks and exceptions** fills the other placeholder: this supplier's open signals,
  in the assistant's date order (#113). Each links to its record.

## 6. Assistant

In T3:
- The `supplier_attention` and `purchase_orders` answers state each supplier's tier.
- The tier becomes a filter: "Which Tier 1 suppliers have overdue orders?". Rules
  read the tier as an entity; with model tool planning (P2) it is a tool argument.
- **The tier never re-ranks a list** (decision 8). Date order stays, and the tier
  only filters and labels.

## 7. Data, seed and cleanup

- The migration adds nullable columns, so every existing supplier starts as not
  tiered.
- The walkthrough seed sets tiers and owners through the same command, with
  reasons and audit rows, so the tabs are not empty in the local walkthrough
  (decision 7). The seed follows the suggestions. Measured on today's walkthrough
  scenario:
  - spend: Northstar 24.6%, Acme Components 24.0%, Evergreen 16.6%, Summit
    15.2%, Precision 12.0%, Atlas 7.6%;
  - the 50% rule therefore suggests Tier 1 for Northstar, Acme and Evergreen;
  - the walkthrough records no item-supplier links, so the only-source rule
    suggests nothing there;
  - Horizon and suppliers 008 to 010 have no orders and become Tier 3.
  With only six active suppliers, half of them land in Tier 1; the rule becomes
  selective with more suppliers. Decision 2 can tighten it.
- `src/modules/suppliers/*` and the other unused SRM components are deleted in T1.
  This leaves one tier vocabulary. `docs/repository-governance-audit-2026-07.md`
  already marks `suppliers/Page.tsx` for deletion.

## 8. Phases

| PR | Ships | Size |
| --- | --- | --- |
| T1 | Migration and columns; tier and owner endpoints with audit rows; owner picker endpoint; tier chip, change dialogs and history on the detail page; list tabs, tier column, owner column and owner filter; seed | M |
| T1b | The unused SRM code removed. It moved out of T1 when T1 was built: three tests and `server/domain/supplier-risk-control-tower.mjs` still reference those files, so removing them is its own change. | S |
| T2 | Metric columns with masking; suggestions; the Review suggestions page; the "Suggestion differs" mark | M–L |
| T3 | Purchase records and Risks and exceptions on the detail page; tier in assistant answers and as a filter | M |

Each PR is separate and can be reverted on its own. T2 and T3 need T1.

Tests:
- **PostgreSQL:**
  - tier set and clear with a reason and a version;
  - audit rows;
  - viewer and finance denied;
  - the owner must be an active user of the same workspace;
  - tab counts;
  - suggestions on the walkthrough scenario, with the expected tier and reasons
    written in the test;
  - masking for each role.
- **Browser:** the tabs, the change dialog in English and Chinese, and Review
  suggestions.
- **The assistant evaluation** gains tier cases in T3.

## 9. Later (S2)

Not in T1–T3:
- supplier groups or parent companies, and several legal entities;
- tags and cost centers;
- documents and certificates with expiry reminders;
- onboarding status and approval of new suppliers;
- second-person approval of bank detail changes;
- workspace settings for the suggestion thresholds.

## 10. Decisions for the owner

| # | Decision | Recommendation | Owner, 2026-10-04 |
| --- | --- | --- | --- |
| 1 | Tier names and meanings: Tier 1 Strategic, Tier 2 Core, Tier 3 Transactional, plus Not tiered (§2.1) | As proposed | Approved |
| 2 | Suggestion rules: 12 months; Tier 1 for the suppliers that together make the first 50% of spend, or the only approved source of an active item; Tier 3 for no PO in 12 months and no items (§3). On the walkthrough this gives three Tier 1 suppliers out of six active ones (§7). | As proposed; revisit the 50% once a trial workspace has real spend | Approved |
| 3 | Delivery performance never changes the suggested tier; it is shown beside it | Yes | Approved |
| 4 | Review suggestions may accept all shown suppliers at once, after a confirmation, with one audit row per supplier | Yes | Approved |
| 5 | The owner picker lists every active workspace user. Owner names are visible to everyone who can read suppliers. | Yes | Approved |
| 6 | The list's default columns (§4), with contact, phone, currency, payment terms, lead time and updated moved to the detail page | As proposed | Approved |
| 7 | The walkthrough seed sets tiers and owners (§7) | Yes | Approved |
| 8 | In the assistant, the tier filters and labels and never re-ranks (§6, T3) | Yes | Approved |
