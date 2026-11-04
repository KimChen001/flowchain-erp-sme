# Supply chain intelligence: shortages, replenishment, supplier choice and supplier risk

Status: proposal for owner review, 2026-11-02. Nothing is built by this document. The build follows §7, and the decisions SC-1 to SC-20 are in §8.

Code references point to `main` at ed8858b1 (worktree `wt/sci-doc`) and are relative to the repository root. That commit already holds the assistant v2 data tools (#242). The assistant v2 loop and UI tools are on `feat/assistant-v2-loop` (b348d642, PR #244, waiting on CI); those references say "v2-loop". "Unverified" marks anything not checked in code, not measured, or read only from a third party. No database was queried and no outside service was called while writing this, so data completeness in real workspaces is unknown.

Naming: the UI and public copy say "assistant". The terminology test (`server/domain/product-terminology-governance.test.mjs:11`) scans `docs/`, so this document says "showcase" and "walkthrough data".

## 中文摘要

- **方向（2026-11-02，你提出）：** FlowChain 要自动发现哪些货快缺了、哪些该补、哪些供应商能供、这些供应商有什么风险；风险可能要接外部 API。我同意，而且这是 FlowChain 的优势：前置采购工具只看到下单之前，FlowChain 还能看到下单之后的收货、拒收、库存和需求。
- **"自动"的意思：** 系统主动发现、主动起草，人确认，系统才执行；永远不自动下单。对应已批准的阶梯：L0 证据、L1 草稿、L2 带来源标注的预填。
- **主分支已有的：** 补货清单已经按"建议下单日"排序（按 90 天出货速度推算到达再订货点的日子，但没算交期）；最近采购单价格和最近 3 次加权平均（是下单价，不是付款价）；非首选供应商要填原因；供应商内部信号（逾期、拒收、发票差异、准时率）；对话里的请购单卡片。采购单草稿卡片正在做。
- **发现的问题：** 现在有三套"该不该补货"的规则，结果互相不一致；助手的建议数量很可能把已预留的需求算了两次；交期存在三个地方，但只读其中一个；导入只能新建、不能补填再订货点和交期；供应商没有结构化的国家和地址。
- **要做的六块：**
  - A 每个品项按天推算库存，算出断货日；
  - B 建议下单日（断货日或跌破安全库存日减去交期）和建议数量；实测交期只并排显示，由人采纳；安全库存按管理员设的服务水平起草，由人接受；
  - C 单个品项的供应商并排比较：没有总分，只标出"被别家在每一项上都比下去"的选项；
  - D 供应商风险：内部信号加外部证据。先做制裁和出口管制筛查（美国合并筛查名单，下载到本地比对，不把供应商名字发出去），再做按国家匹配的自然灾害提醒（GDACS）。外部数据只当证据，带来源和日期；名字匹配会误报，所以由人确认；永不自动改分级、永不拦截；
  - E 每天一条主动提醒："这 3 个品项在下次到货前会断货，周四前要下单"；
  - F 回复"好的"后出现带供应商比较的草稿卡片，由人确认。
- **最大的风险是数据质量：** 再订货点、交期、地址常常缺。所以缺数据提示和"只更新计划字段"的导入要先做。
- **时间：** 11 月只出这份文档和决定（课程报告、IPSERA、博士申请优先）。12 月只做统一的推算引擎和缺数据提示；1 月做实测交期、供应商比较、供应商国家字段和打开时计算的每日提醒；2 月做按需的制裁筛查和计划字段导入；2027 年第一季度在定时任务（#229）上线后做定时提醒、邮件和灾害提醒，并做服务水平安全库存草稿；第二季度做课程里的交换曲线。
- **需要你决定：** §8 的 SC-1 到 SC-20。最关键的四项：统一引擎是否也改补货清单页面（SC-2）；回复"好的"时是否算作点名了提醒里的品项（SC-11）；外部数据是否只在本地比对、不外发供应商名字（SC-14）；时间安排（SC-20）。

## 1. Purpose and owner direction

On 2026-11-02 the owner said, in Chinese (paraphrased): everyone talks about AI in supply chains. FlowChain should automatically spot which goods are running short, which need replenishing, which suppliers can supply them, and what risks those suppliers carry. Risk may need outside APIs. This is the direction.

The answer agreed in that conversation, which this document turns into a design:
- **It is FlowChain's edge.** Procurement tools that sit in front of an ERP see the request and the order. FlowChain also sees what happens after the purchase order: receipts, rejections, stock and demand. The 10/05 Zip plan named this as the moat.
- **A closed loop that spots, drafts and lets a person confirm.** Nothing executes unattended.
- **Data quality is the biggest risk.** Reorder points, lead times and supplier addresses are often missing, so the missing-data prompts and imports matter as much as the calculations.
- **It feeds the owner's course report and PhD work on cost saving:** the service level versus inventory trade-off, and realised savings.

This document also meets the promise of 2026-10-09 that supplier risk would get a design document before it is built (owner decisions of 2026-10-09, item 4).

### 1.1 What "automatic" means here

"Automatic" means proactive, not autonomous. The system finds the problem, works out the figures and drafts the document. A person reads it and clicks. Two ladders already have approved names; this table maps them so neither is broken.

| What the user sees | Zip-plan ladder (approved 10/05) | Assistant ladder (#225 §13, #229) | In this design |
| --- | --- | --- | --- |
| A dated finding with its figures and sources | L0 evidence | L1 grounded answer | The daily note, Today rows, item and supplier pages |
| A filled-in request or order the person edits and creates | L1 draft, L2 labelled prefill | L2 confirmed proposal | The PR card and the PO draft card |
| Drafts left by a scheduled rule for review | L1 draft | L3 standing instruction | Later, on the #229 runner (A1, A2) |
| Orders placed without a click | not offered ("never execute") | L4, needs its own owner decision and #229 A8 | Not offered |

Example of the note the owner described. The figures are illustrative, not seeded data:

> 3 items run out before their next delivery.
> - SKU-1007 Corrugated box 40x30: runs out Thu 12 Nov. Next receipt PO-0412 on 20 Nov. Order by today (lead time 14 days, recorded on the supplier link).
> - SKU-2210 Packing tape: below safety stock on Mon 16 Nov. Order by Thu 5 Nov.
> - SKU-3301 Pallet wrap: runs out Wed 18 Nov unless PO-0398 (5 days overdue) arrives. Chase PO-0398.
>
> [Fill in a request] [Open the reorder list]

"Fill in a request" (or typing "go ahead") opens the PR card with these lines, quantities, suppliers and a supplier comparison per line. The person edits and clicks Create. Submit is a second click (V2-3).

### 1.2 Corrections to the brief

The brief for this design listed some items as missing that are partly on `main`:

| Brief said | What `main` has | What is really missing |
| --- | --- | --- |
| No order-by date (Zip O1) | The Reorder list ranks by an order-by day: today + (position − reorder point) / daily demand, demand from 90 days of shipments (`server/domain/reorder-list.mjs:4-31, 118-123`) | Lead time is not in that date; open sales orders and open PRs are not subtracted; no run-out date |
| No last price paid (Zip S1) | Last PO prices and a weighted average of the last 3 lines, labelled "a purchase order price, not a paid price" (`shared/price-history.mjs:1-26`) | An invoiced or paid price; a price per supplier in one comparison |
| — | F4 override reasons (`shared/supplier-override-reasons.mjs:1-12`); C1 duplicate invoice flags; signal weights removed (`server/domain/ai-skill-signals.mjs`) | — |

## 2. What exists today, and the gaps

### 2.1 Shortage and replenishment

| Piece | Where | What it does | Gap |
| --- | --- | --- | --- |
| Reorder list | `server/domain/reorder-list.mjs`; `GET /api/inventory/reorder-list` (`server/routes/inventory.routes.mjs:330-364`); `src/modules/inventory/ReorderListPage.tsx` | Position = on hand − reserved + incoming; order-by day at the 90-day shipment rate (at least 8 shipment days); shortfall raised to the link MOQ; hands off to the PR form | No lead time in the date (`:118-123`); open sales orders and open PRs ignored; PO lines with no due day are counted as incoming (`:187`); whole-item reorder point, no warehouses; transfers ignored (`reorder-list-read-service.mjs:67`) |
| Stock status | `server/domain/runtime-inventory-allocation-read-model.mjs:66-84` | `below_reorder_point` compares ATP with the reorder point; `below_safety_stock` compares available with safety stock | Reorder point falls back to the SUM of balance rows (`:66-71`); a different rule from the Reorder list |
| Today | `server/domain/today-work.mjs:53, 176-182` | `reorder_now` rows dated by `dateKind: 'order_by'` from the Reorder list | Only the Reorder list's rule |
| Assistant stock signals | `server/domain/ai-skill-signals.mjs:106-112, 123` | `stock_shortage`, `stock_below_safety`, `stock_below_reorder` | No date, so they rank after all dated work (known gap in the 10/03 ranking rule) |
| Weekly projection | `aiStockProjection`, `server/domain/ai-read-tools.mjs:374-421`; tool `stock_projection` | From available, adds PO lines in their promised week, subtracts open sales order demand by the order's promised week; past-due or undated PO lines listed apart | Ignores the shipment rate, so an item sold without orders on hand never runs short in it |
| Purchase suggestion | `shared/purchase-suggestion.mjs:1-95`; tool `suggest_purchase_lines` (`server/domain/ai-assistant-v2-data-tools.mjs:233-319`) | Target = max(reorder point, safety stock, open sales demand); gap = target − available − incoming − open PRs; raised to MOQ; need-by = today + lead time, with a warning when the projection runs short sooner (V2-5, V2-6) | No order-by or run-out date; probably double counts reserved demand (§2.6) |
| Forecast and MRP | `src/domain/forecast/planning.ts:43-150` (client side, fed by an empty list); `GET /api/mrp-plan` capability-disabled (`server/domain/runtime-route-authority.mjs:12-20`) | Methods exist (SES, Holt, Holt-Winters, MAPE, tracking signal) | Off. `docs/planning-mrp-readiness-notes.md` still calls `/api/mrp-plan` available and is stale |

The four rules side by side:

| | Reorder list | Stock status | `stock_projection` | `suggest_purchase_lines` |
| --- | --- | --- | --- | --- |
| Starts from | on hand − reserved | available, ATP | available | available |
| Demand | 90-day shipment rate | unreserved open SO | unreserved open SO by week | open SO, reserved included |
| PO lines past due or undated | counted | counted | listed apart | counted |
| Open PRs | ignored | ignored | ignored | subtracted |
| Lead time | shown only | — | — | need-by date only |
| Reorder point | Item column only | Item, else sum of balances | shown | as stock status |
| Date out | order-by day | none | first short week | need-by date |

### 2.2 Supplier choice

| Piece | Where | What it gives | Gap |
| --- | --- | --- | --- |
| Item-supplier links | RuntimeRecord `master-data.item-suppliers` (`server/domain/master-data-commands.mjs:219-241`) | Approved, preferred, active; supplier SKU; reference price and currency; MOQ; lead time; blanks stay null | No price date or validity, no price breaks, no pack size; the audit row keeps only the version, so old prices are lost |
| Approved sources | `approvedSuppliersForItem` (`server/repositories/db-master-data-repository.mjs:450-488`); v2 `approvedSourcesOf` (`ai-assistant-v2-data-tools.mjs:166-190`) | Preferred first, prices masked without `procurement.prices.read` | `suggest_purchase_lines` returns alternatives as id and name only (`:299`) |
| Price history | `shared/price-history.mjs`; `server/domain/price-history-read-service.mjs` | Last PO prices per item, unit and currency; optional supplier key; weighted average of the last 3; `compareQuote` | Ordered price only; no invoiced price read over `SupplierInvoiceLine.unitPrice` |
| Contracts | K1 (`prisma/schema.prisma:2163`), behind `FLOWCHAIN_ENABLE_CONTRACTS` | Dates, terms, total value | No price lines until K2 (approved 10/09, not built) |
| RFQ comparison | `docs/rfq-supplier-comparison-read-v1.md`; `server/domain/rfq-supplier-comparison-service.mjs` | Latest quote revision side by side; ranking, recommendation and award marked unavailable; currencies unconverted | Per RFQ, not per item from records |
| Scorecard v3 | `server/domain/supplier-scorecard.mjs:74` (rules), `:476-487` (receipt join) | On-time, in-full, OTIF, rejection, average delay against the original promise; 90 days; at least 5 deliveries | Per supplier, not per item; rejection is null when a supplier's deliveries span several SKUs or units; no lead-time measure |
| Old weighted scorer | `compareSupplierResponses`, `buildAwardRecommendationDraft` (`server/domain/procurement-transaction-core.mjs:217-260`) | Price + lead + coverage − risk penalty, then rank | Imported by no module. Delete it under the approved "remove the remaining weights" item |

### 2.3 Supplier risk

| Piece | Where | What it gives | Gap |
| --- | --- | --- | --- |
| Internal issues | `server/domain/supplier-insights.mjs:26`; `GET /api/master-data/supplier-risks`; `src/modules/srm/SupplierRisksPage.tsx:11-15` | Overdue POs, rejected receipts, received-not-posted, invoice variances; earliest date first, no score | Nothing from outside FlowChain |
| Tiers | `server/domain/supplier-tier-command.mjs`; Supplier evaluation page | Set by a person with a reason, audited; "FlowChain never suggests a tier" (`supplier-insights.mjs:23`) | — (by design) |
| Unused risk columns | `Supplier.riskLevel`, `Supplier.score` (`prisma/schema.prisma:653-690`) | Never written | The read invents `'medium'` (`db-master-data-repository.mjs:121`) |
| Supplier location | `Supplier.metadata.address` and `postalCode`, one free-text line (`server/domain/supplier-master-command.mjs:3`) | — | No country, city, region or coordinates; the supplier CSV import has no country column; the intake schema defaults `supplier.countryCode` to `"US"` (`server/domain/canonical-master-data-schemas.mjs:35`) |
| Sanctions, hazards, geocoding | — | — | No code on `main` |

### 2.4 Data the design depends on

- **Lead time is stored in three places** and only the link value is read: the link's `leadTimeDays`, `Supplier.metadata.deliveryCycleDays` and `Item.metadata.purchaseLeadTimeDays`. The supplier form sends 0 for a blank field (`src/modules/srm/Page.tsx:346`, `supplier-master-command.mjs:28`), and the read maps a missing value to 0 (`db-master-data-repository.mjs:134`), so 0 cannot be told from "not recorded". The read also turns a missing item MOQ into 1 (`:84-85`).
- **The CSV import is create-only** (`server/domain/data-import-service.mjs:28-44`). It cannot backfill reorder points or lead times on items that already exist. The items import writes lead time to item metadata, which replenishment never reads.
- **Measured lead time is computable but not computed.** `PurchaseOrder.issuedAt` (`prisma/schema.prisma:1284`, written once on issue), the approve instants in `metadata.approvalTimeline` (`server/domain/procurement-db-command-service.mjs:231`), `ReceivingLine.purchaseOrderLineId` and `ReceivingDocument.arrivedAt` exist. The scorecard already joins receipts to PO lines (`supplier-scorecard.mjs:476-487`). Limits: `issuedAt` is null on POs received without being issued; `arrivedAt` defaults to the moment the receipt draft is created (`server/domain/receiving-draft-command-service.mjs:192`); a PO line's promise is the buyer's need-by date, not a date the supplier confirmed (scorecard `promiseBasis 'po_date'`).
- **Demand dates.** `SalesOrder.promisedDate` is optional and header-level; sales order lines carry no date (`prisma/schema.prisma:3340`). Shipment history is `ShipmentLine.postedQuantity` with `postedAt`; there is no history before go-live until the PO history import (#236 step 6, January) and the SO history import (step 12, Q1 2027).
- **No unit conversion and no pack size.** When the purchase unit differs from the stock unit, the Reorder list suggests no quantity (`reorder-list.mjs:208`). No pack size or order multiple exists outside the disabled MRP route.
- **No scheduler.** `main` has no timer, cron or queue. The owner approved an in-process runner (#229 A5: `AutomationRun` table, Postgres advisory lock, minute timer, catch-up on start); it is not built. Render runs one web instance per environment (`render.yaml:50, 169`).
- **Outbound calls.** Each adapter calls `fetch` with its own timeout; there is no shared outbound client, host allowlist or response cache. The browser CSP is `connect-src 'self'` (`server/bootstrap/security-headers.mjs:37`), so outside APIs are called from the server.
- **Admin settings have a home.** `Tenant.operationalSettings` is JSON (`prisma/schema.prisma:18`) with sections validated in `server/domain/workspace-settings-contract.mjs:159-160`. A new section needs no migration.

### 2.5 The assistant v2 branch

- On `main`: the data tools `attention_list`, `records_missing_data`, `suggest_purchase_lines` and `list_purchase_requests` (`ai-assistant-v2-data-tools.mjs:321`).
- On v2-loop: the UI tools `show_table`, `show_records`, `show_chart`, `show_kpis`, `offer_choices`, `suggest_purchase_request` and `suggest_followups` (`server/domain/ai-assistant-v2-ui-tools.mjs:307-718`). The record cards already accept an `orderByDate` (`:362`), but no tool returns one.
- The PO draft card is being built (workflow wf_15dbc9dd-4b2, branch `feat/assistant-v2-po-draft`). That branch is not in any local worktree, so its fields are unverified. The owner's rule for any drafted document applies: built from the module form rules, a source per value, edit in place, Create writes through the module route, then a receipt with Submit, Open and Cancel.

### 2.6 Defects found while reading

| Defect | Evidence | Confidence |
| --- | --- | --- |
| `suggest_purchase_lines` counts reserved demand twice. The target uses open sales demand, which includes reserved quantity, while `available` already has it removed. On hand 100, all reserved for one open order of 100, no reorder point: gap 100, although nothing more is needed. | `ai-assistant-v2-data-tools.mjs:33-35`; `runtime-inventory-allocation-read-model.mjs:164-165`; no test covers reserved demand | Likely (code reading only); write the test first |
| The Reorder list counts overdue and undated PO lines as incoming; `stock_projection` does not. The same item can be "fine" on one and "short" on the other. | `reorder-list.mjs:187`; `ai-read-tools.mjs:385-387` | Verified |
| Three reorder-point definitions: the Item column only (Reorder list), the sum of balance rows (stock status), and a fallback to safety stock (inventory repository and page). | `reorder-list.mjs:52-55`; `runtime-inventory-allocation-read-model.mjs:66-71`; `server/repositories/db-inventory-read-repository.mjs:77`; `src/modules/inventory/Page.tsx:129` | Verified |
| The read layer invents values: risk `'medium'`, supplier lead time 0, item lead time 0, item MOQ 1. | `db-master-data-repository.mjs:82-85, 121, 134` | Verified |
| `records_missing_data` does not check suppliers, link lead times or sales orders without a promised date. | `server/domain/ai-skill-readers.mjs:142-182` | Verified |

## 3. Principles

1. **Spot, draft, a person confirms, the system executes.** The model proposes; the system supplies the figures and runs the command after a click; nothing runs unattended (AI direction of 2026-10-05; Zip ladder of 10/05; V2-3, V2-8).
2. **One definition per figure.** One projection engine gives the run-out date, the order-by date and the quantity to every surface: Reorder list, Today, the assistant, the daily note and the weekly brief (#234 principle 1 and R1; V2-5).
3. **Rank by date, never by a score.** Lists order by the order-by date, then by record id (owner rule of 2026-10-03, #113).
4. **Pareto, not weights. No total score.** The supplier comparison marks options beaten on every measure and says by whom; it never adds measures up (Zip decision of 10/05). AI risk scores are on the "not to copy" list (10/05 review).
5. **People set tiers, and outside evidence never acts.** A screening match or a hazard alert never changes a tier, a status or a price, and never blocks a request or order. It warns and asks a person (tiers 10/04 and 10/09; contracts D9 "warn, never block"; C1 duplicate-invoice flags).
6. **Not recorded is not zero.** A missing lead time, reorder point or country is shown as "Not recorded" and listed under data to fix; no default is invented (#181 on supplier terms; report rules).
7. **Every outside fact carries its source, its date and how it matched.**
8. **Deterministic when nothing is asked.** Scheduled work and the daily note make no model call (#229 A4; #234 R9). The model answers only when a person asks, in a workspace with AI on.
9. **Measured values are shown, not applied.** A measured lead time or a drafted safety stock sits beside the recorded value until a person adopts it, with an audit row (Zip O2; #229 O6 "fixes are links first").
10. **Settings that judge are set by an administrator, with none by default:** the service level, the coverage days, the note horizon (#234 R8; Zip decision on service levels).
11. **Workspace data stays in the workspace.** Outside lists are downloaded and matched inside FlowChain; no supplier name is sent out by default; no pooled benchmarks before 2028 (Zip decision of 10/05; #229 A7).
12. **Never pick an item the user did not name** (#231; V2-4). SC-11 asks how a reply to the daily note counts.
13. **Calendar days in the workspace timezone.** There is no business-day calendar (AI plan D7).
14. **A lower price is not a saving.** Only C3 realised savings count (Zip C3; #234 §12).
15. **English UI first, Chinese through the i18n context** (AGENTS.md).

## 4. Capabilities

### A. Projected stock timeline and run-out date

**Data needed.** Per item, in its stock unit: on hand and reserved over the warehouses the reader can see; open committed PO line remainders with their due day (line `promisedDate`, else PO `expectedDate`); open sales order quantities (ordered − fulfilled, reserved included) with the order's promised date; posted shipments of the last 90 workspace days; safety stock and reorder point from the Item columns only.

**Calculation.** One pure module, `shared/stock-projection.mjs`, with daily buckets and a weekly view for display. No schema change.
- Start: on hand. Starting from on hand and subtracting all open sales demand (reserved included) removes the double count in §2.6.
- Receipts R(d): each counted PO line remainder on its due day.
- Demand D(d), cumulative: the greater of firm demand F(d) (open sales order quantity due by day d; past due on day 0) and the shipment rate r × d, where r is the existing rule (shipped in 90 days / 90, at least 8 shipment days; `reorder-list.mjs:20-24`). Taking the greater avoids counting orders twice (orders on hand are part of what the rate will ship) while still catching both a large confirmed order and steady counter sales (SC-3).
- Projected on hand P(d) = on hand + R(d) − D(d).
- Horizon: lead time + 28 days, at most 182 days. Without a lead time, 56 days.

**Outputs per item, each with a rule code:**
- `runOutDate`: the first day P(d) < 0;
- `belowSafetyDate`: the first day P(d) < safety stock (when one is recorded);
- `nextReceiptDate` and the PO it comes from;
- `chase`: PO lines past due or with no date, which are not counted (SC-4). The note then says "runs out on 18 Nov unless PO-0398 (5 days overdue) arrives", instead of suggesting a duplicate order;
- `daysOfCover`: run-out date − today;
- the daily series and its weekly view.

**Where it shows.**
- Item page: a stock timeline chart (ECharts, the report palette), with receipts and firm orders as markers and the safety stock as a line.
- Reorder list: a run-out column next to the order-by column.
- Assistant: `stock_projection` returns the engine's series and dates; the chart renders through `show_chart`.
- Today and the daily note: through capability B.

**Edge cases.**
- A reader limited to some warehouses gets the item as "not checked", as the Reorder list does today (the reorder point is whole-item).
- PO lines and shipments in another unit are listed apart, never added.
- An order with no promised date counts on day 0 and is flagged `demand_without_date`; it also goes on the missing-data list.
- Fewer than 8 shipment days: firm demand only, labelled `no_demand_rate`.
- Shipments during a stock-out understate demand (no lost-sales code exists, Zip F2). The rate is labelled "shipped, not demanded".
- Transfers in transit are ignored, as today; the row says so.

**When data is missing.** No stock unit, no on hand or no stock row: not checked, with the reason. No safety stock: `belowSafetyDate` is absent and the order-by date uses the run-out date, labelled. No firm demand and no rate: "no demand recorded", no date.

### B. Order-by date and how much

**Order-by date.**
- Trigger day = `belowSafetyDate`, else `runOutDate` (labelled `no_safety_stock`).
- `orderByDate` = trigger day − resolved lead time. Before today: `orderNow` with `daysLate` and the expected shortfall (the lowest P(d) before an order placed today could arrive).
- No lead time resolved: today's Reorder list rule (the day the position reaches the reorder point at the shipment rate), labelled `reorder_point_crossing`.
- No reorder point and no lead time: no order-by date; the item may still show a run-out date.
- When a reorder point and a lead time are both recorded, the time-phased date drives and the reorder-point day is shown second (SC-5).

**Lead time resolution** (SC-6), each value labelled with its source:
1. the item-supplier link's `leadTimeDays`;
2. the supplier's `deliveryCycleDays`, only when above 0;
3. the item's `purchaseLeadTimeDays`, only when above 0;
4. none.

The MOQ resolves the same way: link, then item metadata above 1.

**Measured lead time (Zip O2).** A read, `server/domain/measured-lead-time.mjs`, reusing the scorecard's receipt join:
- per delivery obligation (PO lines sharing one original promised date), from the issue day (`issuedAt`; else the approve instant in `approvalTimeline`, labelled) to the first receipt arrival day (`arrivedAt || postedAt`, not reversed), in workspace days;
- per supplier and item, else per supplier, over 12 months;
- median and 80th percentile with n; at least 5 deliveries, as the scorecard;
- the promised lead time (original promised date − issue day) beside it, so a supplier who is always late against a short promise is visible;
- negative values are dropped as data errors; receipts whose arrival equals the draft's creation moment are flagged `arrival_not_entered`;
- after the PO history import (#236 step 6), imported orders count, dated order date → received date and labelled `imported`.

It shows beside the recorded lead time on the item page, the link list, the supplier page and the comparison card. "Use measured" saves the link through `saveItemSupplier` with an audit row (SC-7). It never changes on its own.

**How much.** Two rules, each labelled:
- **Gap rule (today's V2-5 rule, fixed).** Target = max(reorder point, safety stock, unreserved open demand); gap = target − available − counted incoming − open PRs (draft, submitted, approved). This fixes the double count.
- **Coverage rule (when an admin sets coverage days and a lead time is known).** Arrival day a = the day an order placed on the order-by date (or today, if that date has passed) would arrive. Quantity = the largest shortfall of P(d) below safety stock over [a, a + coverage days], minus open PR quantities. This is a time-phased net requirement.

Both are then raised to the MOQ and rounded up to a pack size when one is recorded (new link field, SC-19). A quantity the user typed always wins. When the purchase unit differs from the stock unit, no quantity is suggested (`purchase_unit_differs`), as today.

**Service-level safety stock (Zip O2; course).** Drafts, never saved by FlowChain.
- An administrator sets one cycle service level per workspace in Settings › Planning. None by default (SC-8). Per item class later.
- SS = z · √(L·σd² + d²·σL²). d and σd come from weekly shipment buckets (13 weeks, or 26 after the SO history import), converted to days. L and σL come from the measured lead time; with fewer than 5 deliveries, the recorded L and σL = 0, labelled. z comes from the service level (95% gives 1.645). The formula follows Silver and Peterson as used by Chopra, Reinhardt and Dada (§5.3).
- Reorder point draft = d·L + SS.
- Intermittent demand (fewer than 8 of 13 weeks with shipments): no draft, labelled `intermittent_demand`; the normal approximation is poor there.
- The drafts are listed per item with current versus proposed values. A person accepts each, or all on a page, through `saveItemMaster` with an audit row.
- The settings page explains that a high fill rate can need only a modest cycle service level (in Chopra et al., 97–99% fill rate matched 50–70% cycle service level), and that in that range shortening lead time can help more than reducing its spread.
- The exchange curve (total safety stock value per currency against expected stock-out occasions per year, for a range of z) is the Q2 2027 course item. The administrator picks a point on it (MIT ESD.260 lecture 17: "Safety factor, k, is set by management").

**Where it shows.** Reorder list columns (order-by with its rule chip, run-out, quantity with its rule chip, lead time with its source); Today `reorder_now` rows dated by the new order-by date; the PR and PO cards; the daily note; item page.

**When data is missing.** No lead time: the reorder-point rule and a "Lead time not recorded" chip linking to the supplier link. No MOQ: none applied. No reference price: the PR card cannot create (`LINE_VALUE_REQUIRED`) and offers "Open full form", as V2 §4.1 says.

### C. Supplier comparison for one item

**Data needed and columns.** One read, `GET /api/procurement/items/:id/supplier-comparison`, and one data tool, `compare_item_suppliers`. Per approved source of the item (active, approved link; supplier active):

| Column | Source | Notes |
| --- | --- | --- |
| Supplier, tier, owner | Supplier | Tier as people set it |
| Preferred, approved | Link | — |
| Reference price | Link | Currency kept; "date not recorded" (links carry no price date) |
| Contract price | K2 price lines | "Not available" until K2 is built |
| Last PO price, date, PO; average of last 3 | `price_history` with the supplier key (`shared/price-history.mjs:28-30`, 50 keys per call) | Labelled "ordered price" |
| Last invoiced price | New read over `SupplierInvoiceLine.unitPrice` on approved invoices, joined by `purchaseOrderLineId` | Labelled "invoiced price"; never mixed with the ordered price (SC-9) |
| MOQ, pack size | Link | — |
| Lead time: recorded and measured (median, P80, n) | Link; capability B | — |
| On-time, in-full, rejection (n, period) | Scorecard, 90 days, at least 5 deliveries | Per supplier; rejection may be null (§2.2) |
| Open issues | `supplier_risks` | Count and earliest date |
| Outside evidence | Capability D | "Possible match to review", "Hazard alert in the supplier's country" with dates |
| Last order date | `item-supplier-orders` read | Rows sort by this, newest first |

**Pareto marking.** Three measures: price, lead time and on-time rate (SC-10).
- Option A is beaten by option B when B is at least as good on all three and better on one, and every value is present on both.
- Price compares only within one currency and one unit: the last invoiced price, else the last PO price, else the reference price, the same kind on both rows.
- Lead time uses the measured median when n ≥ 5, else the recorded value; both rows must use the same kind.
- On-time compares only when both suppliers have at least 5 deliveries.
- A beaten row says "Beaten by Acme on price, lead time and on-time". An unbeaten row says nothing more. The card never says "best" and never adds anything up.
- A missing value means no claim, shown as "Not compared: lead time not recorded".

**Hard checks are visible filters, not weights.** An inactive supplier, a supplier not approved for the item, or one with an unreviewed possible sanctions match is shown with a chip and left out of the marking. Picking it is still allowed, with a warning (never block).

**Where it shows.** A comparison panel in each line of the PR card and the PO draft card (UI tool `show_supplier_comparison`); a "Compare suppliers" drawer on the classic PR and PO forms and the item page. Picking a non-preferred supplier asks for the F4 reason, as the PR form already does.

**Edge cases.** One approved source: the card shows it and says "No other approved supplier"; it offers an RFQ draft later (F). Masked prices: price columns show "Not available for your role" and price is left out of the marking. Mixed currencies: side by side, never converted (as the RFQ comparison).

### D. Supplier risk

Risk is evidence about a supplier, with a date and a source, that a person reviews. It is never a score.

**D0. Internal signals (exist).** Overdue POs, rejected receipts, received-not-posted and invoice variances on the Supplier risks tab. Added here:
- measured lead time drift: the last 90 days' median above the recorded lead time; shown as a fact on the supplier page; an alert only when an administrator sets a threshold (#234 R8);
- dependency facts per supplier: items for which it is the only approved source, and open PO value per currency.

**D1. Sanctions and export screening (first outside source).**
- **Source.** The US Consolidated Screening List (CSL): 11 lists from Commerce, State and Treasury, OFAC's SDN list included, refreshed daily at 5:00 AM ET, with JSON, CSV and TSV files that carry a `source` column (§5.3).
- **How.** The server downloads the file once a day (before the runner exists: on demand, when the cached copy is older than 24 hours) and stores it as a global snapshot with its date and hash. Matching runs inside FlowChain, so no supplier name leaves the workspace.
- **Matching.** Normalise names (case, punctuation, legal-form words such as LLC, Ltd, Inc, Co, GmbH, 有限公司); compare the supplier name and an optional "Legal name (Latin script)" against each entry's names and alternate names with Jaro-Winkler, the method OFAC's own search describes (OFAC FAQ 249). A score at or above the threshold (SC-15) is a possible match. The country supports the match; it never removes one.
- **Not screened.** A supplier whose names are only in non-Latin script is listed as "Not screened: no Latin-script name", not as clear. Transliteration is out of scope for v1.
- **When.** On create and on a name change (the save path; supplier saves write an audit row, not a change-feed row), when a new list version arrives, and on "Check now".
- **Shown as** "Possible match: <list name>, entry <id>, listed <date>; a person confirms", with a link to the official list and the ITA non-endorsement notice.
- **Disclaimer.** "Screening finds possible matches. It is not legal advice. Check the official list before acting." OFAC states that many potential matches are false positives and that the organisation decides; reporting duties stay with the company.

**D2. Natural hazard alerts by supplier location.**
- **Source.** GDACS (UN OCHA, UNOSAT, the EU's JRC and ECHO): earthquakes, tropical cyclones, floods and volcanoes with green, orange or red alert levels; free with attribution; a GeoJSON API (§5.3).
- **v1, country level.** Fetch the global list of orange and red events (no workspace data in the request) and match locally to supplier country codes. Each match is labelled "In the supplier's country; not confirmed at the supplier's site". The GDACS caveat is shown: alerts are automatic and need confirmation before decisions.
- **The FlowChain edge.** Each alert lists the open POs with suppliers in that country, the items on them, and what the projection says if those POs arrive 14 days late (reusing `late_order_impact`). "Red cyclone alert in the Philippines (3 Nov): 2 open POs; SKU-1007 runs out on 12 Nov if PO-0412 slips two weeks."
- **v2, site level (later).** Needs structured addresses, then geocoding (US Census geocoder for US sites; OpenCage elsewhere, whose terms allow storing results), then matching to GDACS event polygons or the area search (up to 30 days back). NWS point alerts for US sites are optional.
- **Needs:** a structured supplier country first (SC-16). Without it the supplier is "Not matched: country not recorded".

**D3. Later sources** (pull-based: only when a design partner asks, as with landed cost on 10/28):

| Source | Now / later / no | Why |
| --- | --- | --- |
| DHS UFLPA Entity List | Later, for workspaces buying from China | Not in the CSL; about 210 listings; HTML only |
| UK Sanctions List | Later, for UK exposure | Open Government Licence; CSV and XML |
| OpenSanctions hosted API | Later, opt-in paid add-on | Wide coverage; commercial use needs a licence; per-query price |
| EU financial sanctions files | Later | Download needs a login token; licence unverified |
| Credit (D&B, Creditsafe) | No integration now | Per-report prices for the buyer's own use; small suppliers often missing. A person may attach a report they bought as dated evidence |
| News (GDELT) | No for now | Free for commercial use with citation, but noisy; company names collide |
| Shipping and ports (AIS, IMF PortWatch) | No | Commercial AIS is enterprise-priced; PortWatch terms not read |
| Company identity (GLEIF) | Later | CC0, but few small suppliers have an LEI |
| Enterprise risk platforms (Everstream, Resilinc, Interos, Prewave) | No | Priced and built for large firms; several sell scores whose workings are not shown |

**Review workflow.** One evidence row per supplier, provider and source entry or event.

| Status | Set by | Meaning |
| --- | --- | --- |
| `new` | the system | A possible match or alert nobody has looked at |
| `confirmed` | a person, with a note | The person judges the match real. FlowChain still blocks nothing; the warning stays on forms |
| `not_a_match` | a person, with a reason code (`different_entity`, `different_country`, `different_address`, `other` + note) | Suppressed for this list entry until the entry's content hash changes |
| `dismissed` | a person, with a reason code (`not_relevant`, `handled_elsewhere`, `other` + note) | For hazard alerts: seen, no action |
| `expired` | the system | The list entry was removed or the event closed; kept for history |

Each change writes an audit row with codes only. A `new` screening match creates a Today row `screening_match_review` for supplier owners and administrators, and a warning chip on PR and PO lines for that supplier. A hazard alert creates a Today row only when the supplier has open POs.

**Time to survive versus time to recover.** From the MIT work with Ford and Schneider Electric (§5.3): time to recover (TTR) is how long a supplier or site needs to return to full function; time to survive (TTS) is how long supply can still meet demand without it.
- A person marks an item as critical and may record a TTR estimate on its supplier link, with a date. No system rule marks either.
- FlowChain computes TTS per critical item and supplier: the run-out date from the engine with that supplier's open PO lines removed, minus today.
- Flag where TTR > TTS: "SKU-1007 lasts 12 days without Acme; recovery estimated at 45 days; 1 other approved supplier." The count of other approved sources is shown, because a second source shortens recovery.
- Shown on the item and supplier pages and in answers to "what if Acme stops delivering?" Never a score.

### E. The proactive daily note

**Content.** From the engine and the evidence table, in a fixed order with at most three findings per section (#234 R7):
1. Items whose order-by date is within the next 3 days (or already passed), or whose run-out date comes before their next receipt. Sorted by order-by date.
2. PO lines to chase: past due or undated lines that a run-out depends on.
3. New outside evidence: possible matches to review and hazard alerts touching open POs, as counts with a link.

Each line comes from a fixed en/zh template with its figures and a record link. "Show all N" opens the Reorder list. A day with nothing says so in one line.

**Where and when.**
- **v1, computed on open.** A "This morning" card at the top of Today and as the assistant's welcome card. No model and no scheduler, so it can ship beside #234 step 3.
- **v2, scheduled.** On the #229 runner at 07:00 workspace time: a Today row, plus an email under A7 (counts, record numbers and a link; no amounts, no supplier names). No model at run time (A4).
- Per-person scope: each person's note uses their own permissions.
- Snooze per item for 7 days with a reason code (`seasonal`, `discontinued`, `covered_elsewhere`, `other`). Codes are recorded for measurement.

**"Go ahead".** The card's "Fill in a request" button, or a typed reply in the assistant, opens the PR card (or the PO draft card, F) with the note's items. How those rows arrive ticked or unticked is SC-11. Items already covered by open requests or orders stay unticked and say "Already requested: PR-…" (decision 10 of 10/04: say the open orders first).

**Relation to the weekly brief (#234 §8).** The note is daily, narrow (stock and supply) and actionable. The brief is weekly and covers spend, deliveries, stock, invoices and data to fix. Both read the same engine. The brief's stock section uses the same count as the Reorder list, Today and the note, so no two numbers disagree. On Mondays the brief's stock section links the note instead of repeating it (SC-12).

### F. Drafting

- **Purchase request card (exists on v2-loop).** Lines from `suggest_purchase_lines`, which gains `orderByDate`, `runOutDate`, rule codes and the comparison per line. Create and Submit stay two clicks (V2-3).
- **Purchase order draft card (in progress).** The same lines when the person asks for an order, or when the workspace buys without a request step. The supplier pick from the comparison fills it. FlowChain never issues or sends a PO.
- **RFQ draft (later, v2 P2 optional).** From the comparison when an item has no approved source or only stale prices, via `createRfqFromPurchaseRequest`, with invitees limited to approved sources (`server/services/procurement-request-command-service.mjs:382-422`).
- **Never:** approve, issue, send, pay or delete (V2-8).

## 5. Data model, outside integration, tools and UI

### 5.1 Data model changes

| Change | Where | Migration | Step |
| --- | --- | --- | --- |
| None for the engine, order-by date and gap fix | `shared/stock-projection.mjs` | No | 1 |
| `planning` section: `cycleServiceLevel` (null), `coverageDays` (null), `noteHorizonDays` (3) | `Tenant.operationalSettings`; validation in `workspace-settings-contract.mjs` | No | 2, 8, 12 |
| `outsideData` section: `screening` and `hazards` switches (off) | `Tenant.operationalSettings` | No | 7 |
| Link fields: `packSize`, `timeToRecoverDays`, `timeToRecoverRecordedAt`; adoption is an audit row | Item-supplier link payload (RuntimeRecord JSON) | No | 3, 10 |
| Item field: `critical` (boolean, set by a person) | `Item.metadata` | No | 10 |
| Supplier `countryCode` (ISO 3166-1 alpha-2, nullable) and index `(tenantId, countryCode)`; `city`, `region`, `legalNameLatin` in metadata | `Supplier`; supplier form; CSV import column; intake default `"US"` removed | Yes | 6 |
| `SupplierRiskEvidence`: id, tenantId, supplierId, kind (`screening`, `hazard`, `attached_report`), provider, sourceEntryId or eventId and episodeId, listVersion, listDate, matchedName, matchBasis, score, alertLevel, countryCode, sourceUrl, contentHash, fetchedAt, status, reasonCode, note, reviewedById, reviewedAt | New table, unique on (tenantId, supplierId, provider, sourceEntryId) | Yes | 7 |
| `ExternalListSnapshot` and `ExternalListEntry`: provider, version, fetchedAt, sha256, row count; entry names, alternate names, countries, programs, source list | New global tables, no tenant column, read-only to workspaces | Yes | 7 |
| `AutomationRun` | From #229 step 2 | Yes (#229) | 11 |
| `SupplierSite` with coordinates and geocode source | New table | Yes | Later |

The read layer stops inventing values in step 2: no `'medium'` risk, no lead time 0, no MOQ 1. `Supplier.riskLevel` and `score` stay unwritten; dropping them is a separate cleanup after a check that nothing reads them.

### 5.2 Outside integration architecture

- **Adapters.** One module per provider under `server/integrations/`, written like the mailers: injectable `fetch`, `AbortSignal.timeout`, an identifying User-Agent, a response size cap, and errors redacted by the existing `server/observability/redact.mjs`.
- **A shared outbound client** (`server/integrations/outbound.mjs`) with a host allowlist (starting with `data.trade.gov` and `www.gdacs.org`), retry with back-off, and a per-provider circuit breaker. None exists today.
- **Never from the assistant loop.** The v2 eval rule H9 says only the model provider's host is reached during an answer. Tools read stored evidence; "Check now" is a user click on a route outside the AI dispatch files.
- **Scheduling.** Before the #229 runner: on demand (a page opens or "Check now" is clicked, with the cache rules below). After it, jobs on the same runner, each with an `AutomationRun` row and the advisory lock:
  - `outside.csl.refresh` once a day after the list's 5:00 AM ET refresh;
  - `outside.screen` per opted-in workspace after a new list version;
  - `outside.gdacs.poll` hourly (its feeds update every 6 minutes);
  - `note.daily` at 07:00 workspace time.
- **Caching.** List snapshots by version and hash; GDACS events by event id and episode; geocodes stored only where the licence allows. A snapshot older than 48 hours shows "List last updated <date>" on every match.
- **Secrets.** Neither v1 source needs a key for the download path we plan to use (unverified for the CSL file until the first build). If the CSL API is used, its key is an environment variable, `sync: false` on Render, checked by the production config guard and never logged.
- **Switches.** Per workspace: Settings › Outside data, administrator only, off by default, with a sentence stating exactly what is sent (for v1: nothing about the workspace). Environment kill switch `FLOWCHAIN_OUTSIDE_DATA=off`.
- **What leaves the workspace in v1.** Nothing. The CSL is downloaded whole; GDACS is queried for the global event list. Sending supplier names out (OpenSanctions API, geocoding addresses) is SC-14.

### 5.3 Outside sources: terms, licences and cost

All checked 2026-11-02 from the pages named; nothing was called live.

| Source | Cost | Licence and terms | URL | Confidence |
| --- | --- | --- | --- | --- |
| US Consolidated Screening List | Free files; API key free from the developer portal (no fee stated) | ITA terms: non-endorsement notice; access may be limited or ended; rate limits not published | https://www.trade.gov/consolidated-screening-list ; https://developer.trade.gov/terms-of-service | Lists, refresh and files verified; "free" likely; rate limits unverified |
| OFAC guidance | — | Many potential matches are false positives; the organisation decides and keeps records | https://ofac.treasury.gov/faqs/topic/1591 ; https://ofac.treasury.gov/faqs/249 | Verified |
| DHS UFLPA Entity List | Free | HTML page only; last updated 10/28/2026 | https://www.dhs.gov/uflpa-entity-list | Verified |
| UK Sanctions List | Free | Open Government Licence v3.0; the only UK list since 28 Jan 2026 | https://www.gov.uk/government/publications/the-uk-sanctions-list | Verified |
| OpenSanctions | API €0.10 to €0.03 per query (500 credits €50; 5,000 €400; 500,000 €15,000); 2,000 free credits | Data CC BY-NC 4.0; any for-profit use needs a licence; a product may screen for its customers through the API; loading bulk data into our own matcher needs a reseller licence | https://www.opensanctions.org/api/ ; https://www.opensanctions.org/licensing/ ; https://www.opensanctions.org/docs/commercial/faq/ | Verified |
| GDACS | Free | Attribution "Global Disaster Alert and Coordination System, GDACS"; alerts automatic, "as is", not for decisions without confirmation; 100 records per call | https://www.gdacs.org/documents/2025/GDACS_Terms_of_use_Mar_25.pdf ; https://data.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf | Verified; explicit commercial reuse wording not found |
| US Census geocoder | Free | US only; batches up to 10,000 | https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html | Verified |
| OpenCage | From $50/month (10,000 requests a day) | Results may be stored permanently | https://opencagedata.com/pricing | Verified |
| Nominatim (public) | Free | 1 request per second; bulk use discouraged | https://operations.osmfoundation.org/policies/nominatim/ | Verified; not for production bulk |
| D&B small business | From $61.99 per Credit Evaluator Plus report; $189.99 per Business Information Report | End-user packs; resale inside a SaaS not covered | https://www.dnb.com/en-us/utilities/small-business-pricing.html | Prices verified; rights likely |
| GDELT | Free | Commercial use allowed with citation | https://www.gdeltproject.org/about.html | Verified |

Rough running cost of v1 (CSL and GDACS): no fees; storage of one list snapshot (size unmeasured) and a few hundred evidence rows per workspace. An OpenSanctions add-on for 200 suppliers checked monthly is about 2,400 queries a year, inside the €400 bundle of 5,000 credits.

Methods cited:
- Chopra, Reinhardt and Dada, "The Effect of Lead Time Uncertainty on Safety Stocks" (Kellogg working paper, 2003): https://www.kellogg.northwestern.edu/faculty/chopra/htm/research/lead-timejuly31-2003.pdf
- Caplice, MIT ESD.260J Logistics Systems, Fall 2006, lecture 17 (exchange curves).
- MIT News, 2022-06-15, time to survive and time to recover: https://news.mit.edu/2022/companies-use-mit-research-identify-respond-supply-chain-risks-0615 ; Simchi-Levi et al., Interfaces 45(5), 2015, DOI 10.1287/inte.2015.0804 (full text not read).
- de Boer et al., EJPSM 4 (1998) and de Boer, Labro and Morlacchi, EJPSM 7(2) (2001), on weighted supplier scoring (read from abstracts only).

### 5.4 Assistant tools

| Tool | Kind | Change |
| --- | --- | --- |
| `stock_projection` | data | Reads the engine: daily series, weekly view, run-out, below-safety and order-by dates, chase lines, rule codes |
| `suggest_purchase_lines` | data | Rows gain `orderByDate`, `runOutDate` and rule codes; quantity from the gap or coverage rule; reserved double count fixed; alternatives carry the comparison row |
| `reorder_list` | data | Same engine; open PRs subtracted (V2-5 (c)) |
| `attention_list` | data | Stock rows dated by the order-by date (`when.kind 'order_by'`), so they rank among dated work |
| `records_missing_data` | data | New checks: no lead time on the preferred source, no country on a supplier with open POs, sales orders without a promised date, receipts with the default arrival time; a `suppliers` source |
| `compare_item_suppliers` | data, new | Capability C rows, the Pareto marks and the reasons; prices masked per role |
| `supplier_lead_times` | data, new | Measured lead time per supplier and item, with n and the recorded value |
| `supplier_risks` | data | Adds outside evidence rows: provider, list date, status, match basis |
| `daily_note` | data, new | The note's sections, so "what should I do this morning?" returns the same lines as the card |
| `show_supplier_comparison` | ui, new | Renders the comparison from a `compare_item_suppliers` result by reference |
| `suggest_purchase_request`, PO draft card | ui | Lines from the engine; the comparison panel per line |

No tool calls an outside service, and the model gets no write tool.

### 5.5 Pages and UI parts

- **Today:** the "This morning" card; `reorder_now` rows dated by the new order-by date; `po_chase` rows; `screening_match_review` rows.
- **Reorder list:** run-out, order-by with rule chip, quantity with rule chip, lead time with source, chase column.
- **Item page:** the stock timeline chart; lead time recorded versus measured with "Use measured"; safety stock and reorder point drafts when a service level is set; TTS and TTR for critical items.
- **Supplier page and Supplier evaluation:** measured lead time column; country; outside evidence section.
- **Supplier risks tab:** outside evidence rows with Review, Not a match and Dismiss, earliest first.
- **Settings › Planning** (service level, coverage days, note horizon) and **Settings › Outside data** (switches, what is sent, sources and licences).
- **PR and PO forms:** "Compare suppliers" drawer; a warning chip on a supplier with an unreviewed possible match.

All copy goes through the i18n context in en-US and zh-CN.

## 6. Measurement

Nothing here is measured today; FlowChain has no trial data yet. Each measure is read from records, in codes, per workspace. Using trial users' data for research needs COUHES review first (#234 R11).

| Question | Measure | Source |
| --- | --- | --- |
| Are stock-outs avoided? | Stock-out days: days an item's available stock was 0 while open demand waited; per item, before and after the note is on | Inventory balance history and open sales orders; no lost-sales code yet, so this undercounts |
| Is the run-out date right? | For items not reordered in time: predicted run-out date minus the first actual zero day, mean absolute error in days | Engine snapshots kept per day (codes and dates only) |
| Are order-by dates met? | Share of order-by dates with a PR or PO for the item created on or before the date; days late otherwise | PR and PO creation dates |
| Do people use the drafts? | Note shown, opened, "Fill in a request" clicked; drafts created unchanged, edited or cancelled; F4 reasons on non-preferred picks | Audit codes; `AiActionProposal` outcomes after v2 P2 |
| Are recorded lead times wrong? | Share of links where the measured median differs from the recorded value by more than 3 days; adoptions of "Use measured" | Measured lead time read |
| Does the service level hold? | Achieved cycle service level (replenishment cycles without a stock-out) and fill rate (demand shipped from stock) against the administrator's target, per item class | Shipments, receipts, engine |
| What does it save? | C3 realised savings per currency against the lower-of baseline (last invoiced price versus the average of the last 3), increases counted negative; never a quoted or ordered price alone | Invoices, price history |
| Is screening usable? | Possible matches raised; share confirmed versus not a match (false positive rate); median days to review; suppliers not screened (no Latin-script name, no country) | Evidence table |
| Are hazard alerts useful? | Alerts raised; share touching open POs; share dismissed as not relevant | Evidence table |
| Is the data getting better? | Share of items with reorder point or safety stock; of preferred links with a lead time; of suppliers with a country; of POs with `issuedAt`; of receipts with an entered arrival time | `records_missing_data` |

Engine correctness is tested in code: unit tests with fixed inputs for each rule code, the reserved-demand case, past-due and undated lines, mixed units, and a check that the Reorder list, Today, the assistant and the note give the same date for the same item. The course data (UCI Online Retail II) could backtest the run-out and order-by rules offline; that is an option for the report, not a plan.

## 7. Phases and sequencing

Sizes are rough, in working days, for one developer. The real limit is the owner's review and merge time (roadmap decision R6: about 6 hours a week in November, about 20 in early December).

| Step | What | Size | Needs |
| --- | --- | --- | --- |
| 1 | Projection engine and order-by date, lead time resolution, rule codes; unit tests | 3–4 | — (a new pure module) |
| 2 | Engine everywhere: Reorder list, `suggest_purchase_lines`, `stock_projection`, `attention_list`, Today; reserved double count fix (test first); open PRs on the Reorder list; one reorder-point definition; read layer stops inventing values | 2–3 | 1; SC-2 to SC-6; the PO draft card merged, since both touch the suggestion tool |
| 3 | Missing-data prompts (new checks and a `suppliers` source); pack size on the link | 1–1.5 | — |
| 4 | Measured lead time read, shown on item, link and supplier pages; "Use measured" | 2–3 | 1 |
| 5 | Supplier comparison read, tool and card; last invoiced price read; delete the old weighted scorer | 4–5 | 4; PR card and PO draft card |
| 6 | Supplier country and address parts: column, form, import column, intake default removed | 2 | — |
| 7 | Screening: list snapshot, local matcher, evidence table, review workflow, Supplier risks rows, Today row, form chips; on demand | 6–8 | 6; SC-13 to SC-15 |
| 8 | Daily note computed on open: Today card and assistant welcome card; `daily_note` tool | 2–3 | 2 |
| 9 | Planning update import (update mode for planning fields, before → after preview) | 3–4 | — |
| 10 | Critical items and TTS versus TTR | 2 | 2, 4 |
| 11 | Scheduled note and email; scheduled list refresh and re-screening; GDACS country-level polling | 3–4 | #229 runner (step 2 there) |
| 12 | Service-level safety stock and reorder point drafts | 4–5 | 4; demand history (#236 step 12) or 13 weeks of shipments |
| 13 | Exchange curve | 3–4 | 12 |
| 14 | Site-level hazards: `SupplierSite`, geocoding, polygons | 5–7 | 6, 11; SC-17 |

About 45–55 working days in all.

**Calendar, set against the plans already approved:**
- **November:** this document and the owner's decisions only. The course report (draft 11/15, submit by 11/27), IPSERA (11/30) and the Cambridge Judge deadline (11/17) come first. Assistant v2 P1 and the PO draft card are in flight; v2 P2 may slip to December.
- **December:** steps 1–3 only (about 6–9 days; no model, no scheduler, no migration). December already holds #236 steps 1–4, #234 steps 0–1, v2 P2 or P3, the T1 review (12/14–12/18) and the PhD deadlines (Sloan 12/1, Oxford 12/2, Cambridge funding 12/8, CEE and IDSS 12/15). Three small steps is realistic; more is not.
- **January:** steps 4, 5, 6 and 8 (the note on open, beside #234 step 3). The PO history import (#236 step 6) starts feeding the measured lead time.
- **February:** step 7 (screening on demand) and step 9 (planning update import).
- **Rest of Q1 2027:** step 11 once the #229 runner exists, step 10, and step 12 after the SO history import (#236 step 12) and the forecasting slice of phase 2.
- **Q2 2027:** step 13 for the course, step 14 if a design partner needs it. D3 sources only on request.

**What waits for what:**
- **The #229 runner:** the scheduled note and its email, the daily list refresh, re-screening on a new list version, hazard polling.
- **The first deploy:** any outside call from a hosted server, the per-workspace switch in a real workspace, and every measure in §6.
- **Demand history:** service-level drafts with meaningful σd.
- **Owner capacity:** "pull earlier when there is room" (10/05) applies to steps 1–3, which need no model, no scheduler and no migration.

## 8. Owner decisions

- **SC-1 Direction and order.** (a) As proposed: replenishment loop, then supplier comparison, then the daily note, then outside risk (sanctions, then hazards); (b) outside risk first. **Recommend (a).** The loop's value depends on its dates being right, and outside risk needs location data that does not exist yet.
- **SC-2 One engine, including the Reorder list page.** (a) The engine replaces all four rules, and the Reorder list's dates change; (b) the assistant only; (c) keep the four. **Recommend (a).** It changes figures people already see, like V2-5.
- **SC-3 Demand in the projection.** (a) Open sales orders only; (b) the 90-day shipment rate only; (c) the greater of the two, cumulative per day, over lead time + 4 weeks. **Recommend (c).**
- **SC-4 PO lines past due or undated.** (a) Counted as arriving today (the Reorder list now); (b) not counted, with a "chase PO-x" line. **Recommend (b).**
- **SC-5 Order-by date when both a reorder point and a lead time are recorded.** (a) The reorder-point crossing; (b) the time-phased date (trigger day − lead time), with the reorder-point day shown second. **Recommend (b).**
- **SC-6 Lead time precedence.** (a) Link only (now); (b) link, then supplier above 0, then item above 0, each labelled. **Recommend (b),** and stop reading 0 as recorded.
- **SC-7 Measured lead time.** (a) Shown only; (b) shown, adopted by a person with "Use measured" and an audit row; (c) applied automatically. **Recommend (b).** Measure: issue day to first arrival, median and P80, 12 months, at least 5 deliveries.
- **SC-8 Service level.** (a) None; people keep entering safety stock; (b) an administrator sets one cycle service level per workspace, none by default, and FlowChain drafts safety stock and reorder points for a person to accept; (c) (b) plus per item class. **Recommend (b) in Q1, then (c).**
- **SC-9 "Last price paid".** (a) The PO price only (now); (b) add the invoiced price on approved supplier invoices as a separate, labelled read; C3 uses it. **Recommend (b).** Never mix ordered and invoiced prices.
- **SC-10 Pareto measures.** (a) Price, lead time and on-time rate; (b) add rejection rate and open issues. **Recommend (a).** Rejection is often null per supplier, and open issues are shown but not compared.
- **SC-11 "Go ahead" and V2-4.** (a) Items listed in the note arrive ticked when the reply answers that note (the thread refs prove it); covered items stay unticked; Create is still the confirmation; (b) the rows arrive unticked with "Add all from this morning's note". **Recommend (a).** It narrows V2-4 only for the note's own items, which the user has just seen and accepted.
- **SC-12 Note cadence.** (a) Daily note only; (b) fold it into the weekly brief; (c) a daily note for stock and supply, and the weekly brief for everything, both from the same engine. **Recommend (c),** in-app first, email when the runner exists.
- **SC-13 Outside data switch.** (a) On for every workspace; (b) per-workspace administrator opt-in, off by default, with an environment kill switch. **Recommend (b).**
- **SC-14 Sending supplier data out.** (a) Never; local matching against downloaded lists only; (b) allowed per workspace for a paid add-on (OpenSanctions API, geocoding addresses), with the administrator told exactly what is sent. **Recommend (a) for v1 and (b) only when a design partner asks.**
- **SC-15 Screening sources and threshold.** (a) The CSL only; (b) the CSL, then UFLPA for workspaces buying from China; (c) OpenSanctions as well. **Recommend (b).** Start with a Jaro-Winkler threshold of 0.90 on normalised names, tuned on the false positive rate (§6).
- **SC-16 Supplier location.** (a) Keep free text; (b) an ISO country column plus city and region in metadata, with an import column, and the intake's `"US"` default removed; (c) a sites table with coordinates now. **Recommend (b),** then (c) with SC-17.
- **SC-17 Hazard alert level.** (a) Country level, orange and red only, labelled as not confirmed at the site; (b) wait for site-level matching. **Recommend (a).**
- **SC-18 Effect of a confirmed match or alert.** (a) Evidence on the Supplier risks tab only; (b) plus Today rows and a warning chip on PR and PO lines; (c) block orders. **Recommend (b).** Never block.
- **SC-19 Data fixes.** (a) An update mode for the import that changes only planning fields (reorder point, safety stock, lead time, MOQ, pack size) with a before → after preview; (b) a pack size field on the link. **Recommend both.** Data quality is the biggest risk.
- **SC-20 Timing.** (a) As in §7: nothing built in November; steps 1–3 in December; steps 4–6 and 8 in January; steps 7 and 9 in February; the scheduled parts in Q1 2027; (b) pull steps 1–3 into late November. **Recommend (a),** with (b) only if the course report is submitted early.

Questions with no recommendation yet:
- Which design partners import from China or the UK (decides UFLPA and the UK list).
- Whether TTR estimates are worth asking people for before a trial customer asks.
- Whether the course report should cite the engine as its method.

## 9. Risks and open questions

| Risk | Answer in this design |
| --- | --- |
| Data quality: missing reorder points, lead times and countries make dates wrong or absent | "Not recorded" never becomes a default; missing-data prompts (step 3); planning update import (step 9); the #229 health check; every row says which rule made its date |
| The Reorder list's dates change when the engine lands, and people notice | SC-2 is the owner's call; the release note and the rule chip on each date explain it |
| Demand is censored by stock-outs (no lost-sales code) | The rate is labelled "shipped, not demanded"; firm orders still count; F2 lost-sales capture stays planned |
| Lumpy or thin demand makes the safety stock formula wrong | No draft for intermittent demand; drafts are proposals; minimum history |
| Measured lead time is biased by receipts left at the default arrival time and POs never issued | Such receipts are flagged; POs without an issue instant are left out; n is always shown |
| Name matching gives false positives, and misses non-Latin names | A person confirms every match; "not a match" with a reason; "Not screened" is shown, never "clear"; an optional Latin-script legal name |
| A screening result is read as legal advice | The disclaimer and the link to the official list on every match |
| An outside service changes terms, rate limits or goes down | Snapshots are cached with their date; stale lists say so; adapters behind a kill switch; terms re-checked before each new source |
| Licence breach (OpenSanctions bulk data in our matcher) | Only the CSL, UFLPA and the UK list in the local matcher; OpenSanctions only through its API with a licence |
| Alert fatigue from hazards and notes | Orange and red only; alerts on Today only when open POs are touched; at most three per section; snooze with reasons; thresholds set by an administrator |
| People click "go ahead" without reading | Source chips on every value; covered rows unticked; Create and Submit stay separate clicks; outcomes measured |
| Scope creep into an enterprise risk platform | D3 is pull-based; no scores, no tiering, no blocking; credit reports only as attached evidence |
| November and December capacity | Nothing built in November; only steps 1–3 in December, which need no model, scheduler or migration |
| Single-instance runner | As #229 A5; a Render cron job if the service scales out |

Open questions:
- The PO draft card's fields: its branch was not readable here (§2.5).
- How complete reorder points, lead times, addresses and `issuedAt` are in a real workspace. No database was queried.
- Whether the CSL file download needs a key, and the API's rate limits. Not published; verify on the first build.
- Whether GDACS allows commercial reuse beyond attribution. The terms do not say explicitly.
- Whether reorder points should become per warehouse, and transfers in transit counted. Both are out of scope here and listed as limitations.
- Whether the #151 confirmed-action decisions are fully replaced by v2 P2 (V2-3, V2-10).
- Whether `docs/planning-mrp-readiness-notes.md` should be corrected now: it still describes `/api/mrp-plan` as available.
