# Reports as a decision loop: human–AI collaboration design and decisions

Status: approved by the owner on 2026-10-30: R1–R12 as recommended (§11).
Nothing is built by this document. The build follows the order and timing in §9.

On 2026-10-30 the owner said the reports are "not very good" and asked for a
better approach to human–AI collaboration in reporting, and to deploying AI in a
company. This design answers that request. It builds on:
- **`report-dashboards.md`:** the six dashboards and the rules every visual follows;
- **`ai-model-first-design.md` (PR #225):** the tool loop, the grounding check, and the L1–L4 roadmap in §13;
- **`ai-onboarding-and-automation-design.md` (PR #229):** the scheduled runner, the digest rules and the data health check (decisions A1–A8, O1–O6, approved 2026-10-29);
- **`ai-confirmed-actions-design.md` (PR #151):** proposal cards that a person confirms (L2).

## 中文摘要

- **问题：** 现在的报表图表很全，口径也严，但它只回答"现在是多少"，不回答下面几件事：
  - 变了多少、为什么变、该做什么；
  - 看到异常时没法接着问；
  - 不会主动来找人；
  - 发现问题后还要自己去别的页面处理；
  - 数据不全时，大多只在图里写一句说明。
- **主分支（70891206）现状：**
  - 看板用的是 `runtime-report-read-model.mjs` 里的 18 个指标定义；
  - `report-semantic-layer.mjs` 里还有一套旧的 20 个指标，能算上期和同比，但没有线上路由在用，只剩保存视图的校验在读；
  - 看板上的上期比较明确写着"尚未启用"；
  - "关键洞察"只是把页面上的数字换成句子；
  - 助手面板能接收页面上下文（单据类型和编号），但报表页没有接；
  - 没有任何定时任务；邮件只用于登录和审批提醒。
- **推荐的做法：** 把报表做成五层，机器负责发现、计算和起草，人负责设阈值、判断和确认。
  1. **一套指标定义：** 看板、助手、Today 和每周简报都从这里取数；
  2. **变化解释：** 上期比较，加上价格、数量、新增和停买的分解；准时率按供应商拆开；
  3. **对话：** 每张图和每个 KPI 都能"问这个"，以后可以一句话生成视图；
  4. **行动：** 每条发现连到过滤好的清单，L2 上线后连到确认卡；
  5. **推送：** 每周简报和阈值提醒，运行时不调模型。
  - 贯穿五层：每个数字都标出覆盖了多少记录，以及缺什么数据。
- **决定（2026-10-30 已按推荐批准）：** §11 共 12 项。最关键的三项：
  - 指标定义合并成一套（推荐合并）；
  - 每周简报先做站内版、不调模型，邮件只带数量和链接（推荐）；
  - 阈值默认不设，由管理员自己设（推荐，这样"不按假设目标评判"的规则继续成立）。
- **时间：** 11 月不做（首次部署和课程报告优先）。12 月和 L1/L2 并行做第 0–1 步，1 月做第 2–4 步，2027 年第一季度和 L3 一起做第 5–8 步。

## 1. What is wrong today

The dashboards are wide and their rules are strict: recorded data only, no sums
across currencies or SKUs, no judging against assumed targets
(`report-dashboards.md`). The gaps are about use, not about chart types.

| Gap | What the user meets | Evidence on `main` |
| --- | --- | --- |
| Only "how much", never "what changed" | A KPI shows this period's value and a monthly sparkline, nothing about the previous period | `BiDashboard.tsx:167`: "category and period comparison are not applied yet, so they are not shown" |
| No "why" | Key insights restate figures already on the page | `reportInsights.ts` header: "Nothing is computed here that the page does not show" |
| Cannot ask a follow-up | A tall bar can be filtered or downloaded, but not asked about | The reports pages pass no context to the assistant panel (§2) |
| Nobody comes to the page | A small-company owner does not open dashboards every day | No report mail, no schedule, no brief |
| Findings do not lead to work | Seeing a late supplier means leaving for another page | Visuals offer View business details only |
| Thin data looks like no data | With few records, visuals are empty or show a few points; on-time needs 5 deliveries | Limitations are listed per KPI, but there is no list of what to fix |

## 2. What exists on `main` (70891206)

| Piece | Where | What it gives | Gap for this design |
| --- | --- | --- | --- |
| Dashboards | `GET /api/reports/{overview,procurement,sales,inventory,finance,suppliers}`, `buildRuntimeGovernedReport` in `server/domain/runtime-report-read-model.mjs` | KPIs, visuals and details for the reader's scope (`report-read-access.mjs`), workspace timezone, limitation codes per KPI | — |
| Live metric definitions | `metricDefinitions` in `runtime-report-read-model.mjs` (18 metrics, version `3.0.0-runtime`) | The figures every dashboard shows | Labels and descriptions mix Chinese and English inside the server file |
| Older metric catalog | `reportMetricCatalog` in `server/domain/report-semantic-layer.mjs` (20 metrics) | `buildGovernedReport` computes previous-period and year-over-year deltas | No live route calls it. Saved-view validation (`report-view-repository.mjs:48-55`) still accepts metrics from both catalogs. Its `supplier_otif` is marked legacy in the code, beside the scorecard's on-time figure |
| Comparison | `BiDashboard.tsx` | A comparison selector exists in copy | Not applied, so not shown |
| Key insights | `src/modules/reports/reportInsights.ts` | Sentences from the page's own figures, en/zh | No change, no driver, no action |
| Visual actions | `VisualCard.tsx` | Click to filter (kept in the link), Show data, focus, PNG, CSV, View business details | No "ask about this" |
| Saved views | `server/routes/report-views.routes.mjs`, `report-view-repository.mjs` | Private and team views with filters, columns and charts | — |
| Supplier scorecard | `GET /api/reports/supplier-scorecard`, `supplier-scorecard.mjs` | On-time deliveries against the original promise; 90 days by default; a rate needs 5 deliveries | — |
| Today | `TODAY_WORK_KINDS` in `server/domain/today-work.mjs` (18 kinds) | `purchase_order_overdue`, `reorder_now`, `bill_exception` and others | No summary of change over a week |
| Assistant on `main` | `server/domain/ai-skill-spend-analysis.mjs` | Spend answers read the procurement dashboard's own report, "so the answer shows what the dashboard shows" | The rules assistant; one skill follows this pattern |
| Read tools | PR #227, not on `main` | 22 tools, including `spend_analysis`, `price_history`, `supplier_performance`, `stock_projection` and `calculate` | No tool reads a KPI by id, compares periods or explains a change |
| Panel context | `ActiveContext` in `src/modules/ai-assistant/Panel.tsx` | Module, entity type (six record types), id, label, view, route | Inventory, master data, procurement, purchase requests, purchasing and SRM pages set it; reports pages do not |
| Mail | `server/mail/mailer.mjs`, `server/notifications/approval-notifier.mjs` | Sign-in links and approval emails | No report mail. `FORBIDDEN_REPORTS_ACTION_PATTERN` in `reports-analytics-v2.mjs` keeps that surface's text from offering report subscriptions or outside email |
| Scheduling | — | — | None. PR #229 §4.4 designs an in-process runner with a run table and an advisory lock (A5) |
| Data quality | Limitation codes per KPI; `GET /api/data-access-quality` | Codes such as `multi_currency_unconverted`, `amount_missing`, `insufficient_sample`, `receipts_truncated` | No page calls the data-quality route; no single list of what to fix |

Two consequences shape the design:
- **One source of figures is half there.** The live dashboards and the spend skill
  already share one computation. The older catalog is a second set of definitions
  that should go before anything new reads metrics.
- **Everything that runs on a schedule depends on PR #229's runner.** The parts
  computed when a page opens do not, so they can come first.

## 3. Principles: who does what

| The system | People |
| --- | --- |
| Computes every figure from records, under one definition | Agree the definitions and correct the records |
| Finds what changed and what it is made of | Judge whether the reason holds |
| Watches the thresholds people set | Set the thresholds, or none |
| Drafts the next step | Confirm, edit or reject it |
| Records what was shown and what was done | Decide what counts as useful |

1. **One definition per figure, many surfaces.** The dashboard, the assistant,
   Today and the brief read the same registry with the same reader scope. The
   assistant never computes a KPI its own way. `ai-skill-spend-analysis.mjs`
   already works like this, and the design makes it the rule.
2. **Deterministic first, the model on demand.** Comparisons, breakdowns,
   briefs and alerts are code. The model is called only when a person asks, in a
   workspace with AI on (#150), and its answer passes the grounding check of #225.
3. **Arithmetic is not cause.** A breakdown says what a change is made of: price,
   quantity, new items, a supplier. Text and answers say "accounted for by", never
   "caused by". The person judges the cause.
4. **Say what is missing.** Every figure carries its coverage: how many records it
   counts, and how many it leaves out and why. The design prefers a visible gap
   to a quiet one.
5. **Exceptions, not pages.** People should look at what moved past a line they
   drew, not at thirty charts. With no line drawn, nothing is judged: the rule
   "no visual judges a figure against an assumed target" stands. A threshold an
   administrator saved is a recorded setting, not an assumption.
6. **People can change what the system proposes.** Studies of algorithm aversion
   found that people stop using a forecasting algorithm once they see it err
   (Dietvorst, Simmons and Massey, 2015). They keep using an imperfect one if they
   may adjust its output, even slightly (the same authors, *Management Science*,
   2018). So every proposal keeps an "edit, then confirm" route, as #151 decided.
7. **The existing report rules hold everywhere,** including in model-written
   text: one currency per sum, one SKU per quantity, recorded values only, the
   workspace's timezone and the reader's permissions.

## 4. Layer 1: one metric registry

- **The live definitions become the registry.** Each metric keeps:
  - an id;
  - en and zh labels and descriptions in `analyticsCopy.ts` (per `AGENTS.md`), not in the server file;
  - a unit, a subject, a numerator and denominator where it is a rate;
  - the filters it accepts and its drill path;
  - a version, and a minimum sample where one applies.
- **One read for every surface:** `readMetric({ id, filters, period, groupBy })`
  over `buildRuntimeGovernedReport`, with the reader's scope from `reportReadAccess`.
  - The dashboards, the new assistant tools (§6), the brief (§8) and the alerts all call it.
  - Restricted figures stay restricted: no value, never 0, on every surface.
- **Coverage on every value:** `coverage: { counted, leftOut: [{ reason, count }] }`,
  built from the existing limitation codes. For instance, on-time deliveries:
  "12 of 15 deliveries measured; 3 have no promised date."
- **The older catalog goes.**
  - Saved views that name an older metric are mapped to the live id, or the view
    shows that the metric was retired.
  - Then `reportMetricCatalog` and `buildGovernedReport` are removed, along with
    the legacy `supplier_otif`.
- **A test keeps the surfaces agreeing:** for the same filters, `readMetric`,
  the dashboard KPI and the assistant tool return the same value.

## 5. Layer 2: what changed and what it is made of

### 5.1 Period comparison

- **Bases:**
  - the previous period of the same length;
  - the same period last year.
- **Days** are workspace days (`tenantCalendarDay`). The older `previousQuery`
  works in UTC days and is not reused as it is.
- **No comparison** is shown when the earlier period has no records for the
  metric, or a rate's earlier sample is under its minimum. The KPI says why.
- **Display:** a KPI shows the change in its own unit and, where it makes sense,
  in percent. Money compares within one currency only.

### 5.2 Breakdowns (v1: two)

**Committed spend: price, quantity, new and stopped items.** Computed per SKU and
per currency, between two periods, from purchase order lines (order date,
committed statuses, as the dashboard counts them).

| Part | Per SKU, in one currency |
| --- | --- |
| Price | (this period's average price − last period's average price) × this period's quantity |
| Quantity | (this period's quantity − last period's quantity) × last period's average price |
| New items | The whole amount of an SKU bought now and not in the earlier period |
| Stopped items | Minus the whole amount of an SKU bought before and not now |

- **The parts add up exactly** to the change in committed spend in that currency.
  Quantities are never added across SKUs; only money is added, within one currency.
- **Illustration:** one SKU went from 100 units at $10 to 120 units at $11. Spend
  rose $320: price +$120, quantity +$200.
- **The answer names the largest parts:** "Committed spend rose $4,800 (+18%):
  price +$2,900, mostly LDM-004 at Acme; quantity +$2,100; new items +$300;
  stopped items −$500."
- **A price effect is not a saving.** The savings ledger planned as C3 in the
  supplier cost-saving plan of 2026-10-05 keeps its own approved definition, and no
  report calls a price drop a saving.

**On-time deliveries by supplier.**
- **Late deliveries per supplier in both periods,** on the scorecard's own
  definition and grace days. A supplier gets a rate only with at least 5 deliveries.
- **The change is told in deliveries:** "9 deliveries were late this month,
  against 4 last month; 6 of the 9 were Acme's."

**Later breakdowns:** overdue open purchase orders (newly overdue against cleared),
match exceptions by supplier and type, and SKUs that became short or stopped
being short.

### 5.3 Where it shows

- **On the dashboards,** a "What changed" strip above the visuals: at most three
  lines per dashboard, each with its link.
- **The key insights card** gains the comparison and the breakdown lines. It still
  computes nothing the page cannot show, because the breakdown becomes part of the page.

## 6. Layer 3: asking and building views

### 6.1 "Ask about this"

- **Every KPI and visual gets an "Ask about this" button,** shown only when AI is on for the workspace.
- **The panel context gains a report kind:**
  `ActiveContext.report = { dashboard, visualId | metricId, filters, selected }`.
  The panel shows it as a chip, as it does for records today: "About: Committed
  spend by month, March 2026".
- **Three new read tools in the model-first loop** of #228, all through `readMetric`:

| Tool | Returns |
| --- | --- |
| `metric_value` | A metric's value, coverage and limitations for a filter set and period |
| `metric_breakdown` | The metric grouped by an allowed field (supplier, SKU, month, warehouse, status) |
| `explain_change` | The §5 comparison and breakdown between two periods |

- **The grounding check applies unchanged:** every figure in the answer comes from a tool result or `calculate`.
- **Typical questions:**
  - "Why is March so high?" calls `explain_change` for March against February;
  - "Which supplier is behind this?" calls `metric_breakdown` by supplier;
  - "Is this bad?" is answered against a saved threshold if there is one, and otherwise says that no target is set.
- **The answer ends with the same links** the finding would have (§7).

### 6.2 A view from a sentence (later)

- **What the user types:** "Show on-time deliveries by supplier for the last six months."
- **What the model returns:** a view spec only:
  - a dashboard;
  - metrics from the registry;
  - grouping fields from the field catalog;
  - a visual type from the existing list;
  - filters and a period.
- **The same validator checks it** as saved views use (`report-view-repository.mjs`).
  An invalid spec is not shown; the panel says which part is not available.
- **A preview card opens the view.** The user may save it, private by default.
- **The model never writes a query** and never defines a new metric.

## 7. Layer 4: from a finding to the work

| Finding | Now | After L2 (#151) |
| --- | --- | --- |
| SKUs short or below reorder point | The reorder list, filtered | A purchase request draft (C1) |
| An open purchase order overdue | The order, with the supplier's contact | A follow-up email draft, once supplier email has its own decision (2026-10-05, decision 4) |
| A price above the last price paid | `price_history` for the SKU | An RFQ from the request (C2) |
| A match exception | The invoice in three-way match | — (people resolve exceptions) |
| A gap in the data | The filtered list of records missing the field | A bulk-fix card, later (#229, O6) |

- **What is recorded:** each finding shown, opened, acted on or dismissed, as a
  code with no content. This feeds the auto-quiet guard (§8.3), the usefulness
  review (§10) and, after COUHES review, research data (#225 §13).

## 8. Layer 5: the weekly brief and alerts

### 8.1 The brief

- **What it is:** a short page of what moved, built by code for each person with
  their own permissions. It aims to replace "open the dashboards".
- **Sections, in a fixed order:**
  1. Spend: month to date against the same days of the last month, with the top breakdown parts;
  2. Deliveries: late deliveries in the last 7 days by supplier; open orders newly overdue and cleared;
  3. Stock: the reorder list's "order now" count (the same count as Today and the reorder list) and SKUs that became short;
  4. Invoices: new match exceptions and invoices waiting for a match;
  5. Data to fix: the largest coverage gaps (§8.4).
- **At most three findings per section.** Within a section they are ordered by the
  size of the change in their own unit, or by date. There is no blended score,
  following the owner's decision of 2026-10-03 (rank by date, not score) and the
  "Pareto, not weights" decision of 2026-10-05.
- **Every finding:** one sentence from a fixed en/zh template, its figures with
  coverage, a link, "Ask about this" (AI on), and an action when §7 has one.
- **An empty section is left out.** A week with nothing to say says so in one line.

### 8.2 Where and when it runs

- **In the app first:** a "This week" card on the Overview dashboard, computed when
  the page opens. It needs neither a model nor a scheduler, so it can ship early (§9, step 3).
- **On a schedule later,** on PR #229's runner:
  - Monday 07:00, workspace time;
  - a Today row per recipient;
  - an email that follows decision A7: counts, record numbers and a link, with no amounts or supplier names.
- **No model call when it runs** (A4). A model-written summary of the week is a
  separate later decision (R9).
- **No email open tracking.**
- **The report-surface guard changes on purpose.** `FORBIDDEN_REPORTS_ACTION_PATTERN`
  keeps report text from offering subscriptions or outside email. The brief PR
  changes that guard deliberately and keeps the rest of the list.

### 8.3 Thresholds and alerts

- **Thresholds are set by an administrator, per metric. None exist by default**
  (principle 5). Setup offers a short list to pick from:

| Threshold | Basis | Needs |
| --- | --- | --- |
| On-time deliveries below X% for a supplier | The scorecard, at least 5 deliveries | — |
| A purchase order line price above the last price paid by more than Y% | `price_history` | One earlier price in the same currency and unit |
| An open purchase order overdue by more than N days | `purchase_order_overdue` | — |
| A match exception open for more than N days | `bill_exception` | — |

- **Checked hourly** through #229 §4.5, which reads Today kinds and acts on new rows.
- **An alert is a Today row,** plus an email under A7 when the administrator turns email on.
- **Auto-quiet:** a threshold whose alerts were dismissed 5 times in a row
  without action stops alerting and asks the administrator whether to change it,
  as A6 does for rules.

### 8.4 Data to fix

- **One list** built from the coverage of every metric and from #229's health
  check (§3, step 4). For instance:
  - "3 purchase orders have no promised date: on-time leaves them out";
  - "2 SKUs have no reorder point: the reorder list ignores them".
- **It shows in three places:** at the top of each dashboard as one line with a
  count, in the brief's last section, and as answers to "what data should I fix?".
- **Fixes are links first** (O6). Bulk fixes come later as L2 cards.

## 9. Build order and rough size

Each step is its own PR with green CI. Sizes are rough, in working days.

| Order | Step | Rough size | Needs |
| --- | --- | --- | --- |
| 0 | One metric registry: live definitions as the registry; labels into copy; coverage on every value; saved views mapped; older catalog removed; agreement test | 3–4 | — |
| 1 | Period comparison on KPIs, in workspace days | 2–3 | 0 |
| 2 | Breakdowns: spend price/quantity/new/stopped, late deliveries by supplier; the "What changed" strip | 4–5 | 1 |
| 3 | "This week" card on the Overview, computed on open; the "Data to fix" line | 2–3 | 2 |
| 4 | "Ask about this": report context in the panel; `metric_value`, `metric_breakdown`, `explain_change`; eval cases in both languages | 3–4 | #227 and #228 merged; 0–2 |
| 5 | The scheduled brief: Today row and A7 email | 2–3 | #229 step 2 (runner) |
| 6 | Thresholds and alerts, with auto-quiet | 4–5 | #229 step 4 (hourly triggers); 5 |
| 7 | Actions from findings: links now; cards as C1 and C2 land | 1, then per card | #151 |
| 8 | A view from a sentence | 4–5 | 0, 4 |

- **November:** nothing. The first deployment and the course report come first.
- **December,** beside L1 for opted-in trial workspaces and L2 C1: steps 0–1.
- **January:** steps 2–4.
- **Q1 2027,** with L3: steps 5–8.
- **Earlier option:** steps 0–3 use no model and no scheduler, so they can move
  forward whenever there is room.

## 10. Deploying this in a company

The second half of the owner's question: how AI in reporting earns a place in a
company's routine.

**A ladder, one rung at a time.** Each rung starts only when the one before is used.

| Rung | What the company gets | AI |
| --- | --- | --- |
| Read | Dashboards with comparison and coverage | None |
| Explain | Breakdowns; "Ask about this" | On demand, in opted-in workspaces |
| Push | The brief and thresholds | None at run time |
| Act | Findings lead to confirmed drafts (L2), then standing instructions (L3) | Proposes; a person confirms |

**Trust comes from five things, all already patterns in FlowChain:**
- **The same permissions:** the brief and every answer are built with the reader's scope, so restricted figures stay restricted.
- **Traceable figures:** every figure links to its records and its definition.
- **An audit trail:** each brief run, alert and answer is recorded; #228 already audits each answer's tool calls.
- **A switch and a budget:** AI per workspace (#150) with a monthly cap; each brief and threshold can be turned off.
- **Both languages:** templates and copy in en/zh, with business values left as recorded.

**Habits:**
- **The brief is the agenda.** With a design partner, the Monday brief becomes the agenda of the weekly purchasing meeting, run by one named person.
- **Monthly usefulness review.** Look at which findings were opened, acted on or dismissed, and drop or change the ones nobody uses.
- **Questions nobody could answer** go into the pain log started for the trial. The fix is a tool or a definition, never a rule.

**Measures:**
- the share of findings acted on;
- dismissals by reason;
- "Ask about this" use;
- the questions that got no grounded answer.

These are codes and counts only. Collecting them from trial users as research data
needs COUHES review first.

## 11. Decisions for the owner

**Decided 2026-10-30:** the owner approved every decision below as recommended
("按推荐"). Nothing changes before the first deployment: under R12 the build
starts with steps 0–1 in December, and steps 0–3 may move earlier when there is room.

| # | Decision | Recommendation |
| --- | --- | --- |
| R1 | One metric registry | Yes. The live definitions become the registry; saved views are mapped; the older catalog and `supplier_otif` are removed |
| R2 | Comparison bases | The previous period of the same length and the same period last year, in workspace days; nothing shown without an earlier record or below a minimum sample |
| R3 | First breakdowns | Committed spend (price, quantity, new, stopped) and late deliveries by supplier; the others later |
| R4 | "Ask about this" | On every KPI and visual, only in workspaces with AI on; Show data stays for everyone |
| R5 | The brief's form | The in-app "This week" card first, computed on open. The scheduled brief on #229's runner later, Monday 07:00 workspace time, email under A7 (counts, numbers, a link) |
| R6 | Who gets the brief | Workspace administrators by default; others subscribe themselves; each person's brief uses their own permissions |
| R7 | Ordering findings | A fixed section order, then the size of the change in its own unit or the date; no blended score |
| R8 | Thresholds | Set by an administrator per metric; none by default; auto-quiet after 5 dismissals in a row |
| R9 | A model-written weekly summary (revisits A4) | Not now. Revisit after 8 weeks of briefs with usefulness data |
| R10 | A view from a sentence | Later (step 8), as a preview card validated against the registry, saved private by default |
| R11 | What is recorded about findings | Codes and counts: shown, opened, acted on, dismissed with a reason. No content and no email open tracking. COUHES review before research use |
| R12 | Timing | Nothing in November; steps 0–1 in December, 2–4 in January, 5–8 in Q1 2027; steps 0–3 may move earlier when there is room |

## 12. Risks

| Risk | Answer in this design |
| --- | --- |
| A breakdown on thin data misleads | Minimum samples; "not enough history" instead of a figure; coverage on every value |
| People read arithmetic as cause | "Accounted for by" wording in templates and in the model prompt; the person judges the cause |
| Figures disagree between surfaces | One registry and the agreement test (§4) |
| Too many alerts | No default thresholds; at most three findings per section; auto-quiet |
| Business detail leaves in mail | A7: counts, record numbers and links only |
| A price change is called a saving | Price effect and savings stay separate; C3 keeps its own definition |
| Truncated reads | When the business context is truncated (`truncatedSubjects`), the brief and the answer say so and do not compare |
| The model overstates in "Ask about this" | The grounding check, the existing safety checks and new eval cases for change questions in both languages |
| Report work crowds out the first deployment | Nothing in November; steps 0–3 need no model and no scheduler |
