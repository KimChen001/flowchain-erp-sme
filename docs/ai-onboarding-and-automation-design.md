# New-user onboarding and standing instructions (L3): design and decisions

Status: approved by the owner on 2026-10-29: O1–O6 and A1–A8 as recommended (§9).
Nothing is built by this document. The build follows the order and timing in §7.

This design continues the roadmap in `ai-model-first-design.md` §13 (PR #225),
which names two Q1 2027 items:
- **L3 standing instructions:** the user states a rule in chat and it runs on a schedule, leaving drafts.
- **Onboarding by chat:** a new company sets up its workspace by talking and uploading its files.

Both rest on L2 confirmed actions, the design in `ai-confirmed-actions-design.md` (PR #151, track C).

## 中文摘要

- **要解决的事：**
  - 新公司第一次用 FlowChain 时，能在对话里完成开户后的设置和数据导入，并在第一天就看到有用的结果。
  - 之后可以用一句话设定“每周一把要补的货起草成采购申请”这类常规指令。系统按时执行，只生成草稿，由人确认。
- **主分支（70891206）现状：**
  - 工作区只能由运维用 `tenant:provision` 创建，没有自助注册；
  - 邀请同事不会发邮件，管理员要自己复制链接；
  - 导入已支持 .xlsx 和中英文列名自动匹配；
  - 期初库存导入后是待过账的调整单草稿；
  - 补货清单生成的是预填的采购申请，不是采购订单；
  - 设置里有金额阈值字段，但没有任何地方执行它；
  - 没有任何定时任务机制，线上是单实例部署；
  - 新工作区默认不调用模型。
- **推荐的做法：**
  - 上手对话用固定问题加按钮，不依赖模型；
  - 每个会改设置的回答都先出一张确认卡；
  - 定时指令只用于固定模板，创建时可以用模型把一句话转成规则，按时执行时不调用模型；
  - 输出只有草稿，有数量和金额上限、试运行、一键停用；连续被全部拒绝时自动暂停，并问用户原因。
- **决定（2026-10-29 已按推荐批准）：** §9 共 14 项。最关键的三项是：
  - 试用期是否开放自助注册（推荐先不开放）；
  - 第一批模板（推荐每周补货草稿）；
  - 定时任务放在哪里（推荐先在应用进程里跑，用数据库锁保证只跑一次）。
- **时间：** 按 #225 §13，排在首次部署和 L1/L2 之后，即 2027 年第一季度。

## 1. Where this sits

- **The rule of 2026-10-05 holds:** the model proposes, the system supplies the facts and executes, and a person confirms.
  - A standing instruction is confirmed once, when it is switched on, after a dry run.
  - Each run then leaves drafts that a person submits, edits or cancels.
  - No run sends, approves, pays or deletes anything.
- **L3 needs L2 first.** A standing instruction writes through the same commands
  and the same proposal records as a confirmed card (#151 C1).
- **Data quality comes before automation** (#225 §13, condition 1). A rule over
  wrong reorder points makes wrong drafts every week. So onboarding ends with a
  health check, and the first rule is offered only after it.

## 2. What exists on `main` (70891206)

| Piece | Where | What it gives | Gap for this design |
| --- | --- | --- | --- |
| Creating a workspace | `npm run tenant:provision` (`scripts/tenant-provision.mjs`) | An operator creates the tenant and its first administrator | No self sign-up route. `/api/ready` stays 503 until the tenant exists (`render.yaml`) |
| Sign-in | `server/auth/email-link-sign-in.mjs` | Email links through the mailer | None |
| Mail | `server/mail/mailer.mjs` | `outbox` locally; `postmark` or `resend` in production | None |
| Invitations | `server/routes/pilot-workspace.routes.mjs:264-282` | An invitation and its accept link | Returns `emailDeliveryConnected: false`: no email is sent, and the admin copies the link |
| First-day checklist | `buildFirstRunChecklist`, `server/domain/today-work.mjs` | Today lists items, suppliers, customers, opening stock and teammates until each has a real count | It only links to pages; it never checks the data |
| Import | `shared/data-import-columns.mjs`, `server/domain/data-import-service.mjs` | Five types: items, suppliers, customers, item suppliers and opening stock. Takes `.csv` and `.xlsx`. Matches English or Chinese headers and their aliases. Previews with row issues | Headers outside the aliases need the admin to rename them |
| Opening stock | `data-import-service.mjs:38-40` | One draft `opening_balance` adjustment per warehouse; a person readies and posts it | Needs `FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS` |
| Reorder list | `src/modules/inventory/ReorderListPage.tsx` | Per item: a prefilled purchase request with supplier and quantity, raised to the supplier's minimum. Its own copy reads "Nothing is ordered automatically" | Opened one item at a time |
| Purchase request command | `POST /api/procurement/requests` | A `PurchaseRequest` in `draft`, idempotent by key, cancellable | Writes `source: "manual"` only |
| Proposal records | `ActionDraft` and its validation and audit tables (`prisma/schema.prisma:927`) | #151 §4.3 stores each confirmable card here | — |
| Today | `TODAY_WORK_KINDS`, 18 kinds | Includes `reorder_now`, `purchase_order_overdue`, `bill_exception`, `contract_notice_due`, `contract_ending` and `draft_purchase_order` | No kind for automation output |
| Approval email | `server/notifications/approval-notifier.mjs` | Emails an approver through the mailer | — |
| Approval settings | `workspace-settings-contract.mjs`, `review` | Reviewer roles per policy; `amountThreshold: 100000` is stored | Nothing on `main` reads `amountThreshold`. Approval is by role, not by amount |
| Scheduling | — | — | None: no cron, no worker, no job table |
| Hosting | `render.yaml` | One Docker web service per environment, single instance, with a disk. Each deploy stops the old instance first | Cannot scale out; a deploy interrupts anything running |
| Model access | `ai.modelAssistEnabled: false` (#150) | A workspace calls no model until an administrator switches AI on | A brand-new workspace has no model |
| Read tools | PR #227 | 22 typed reads over the user's facts and services, scoped by permission | Not on `main` yet |

Two consequences shape the design:
- The onboarding interview cannot depend on a model, because a new workspace has AI off.
- Approval thresholds cannot be offered as a setting, because nothing enforces them.

## 3. The new-user journey

Each step lists what the user sees and what runs. "New" marks what does not exist.

### Step 0. A workspace exists

- **Trial (recommended):** an operator provisions the workspace and its first
  administrator, as today. The administrator gets a sign-in email.
- **Later, self sign-up (new):** a sign-up page creates the tenant and its first
  administrator, then sends an email link. Before it is opened to the public it needs:
  - email verification before the workspace exists;
  - a rate limit per address and per network;
  - name and currency rules;
  - AI off by default, as today;
  - a way for the operator to see and close new workspaces.

  This is decision O1.

### Step 1. The setup conversation (about 5 minutes, new)

The chat opens on first sign-in with a short scripted interview. It is fixed
questions with buttons and short answers, not a model, so it works with AI off
and every value is exact.

| Question | Answer becomes | How it is written |
| --- | --- | --- |
| Company name, country | Workspace profile | Shown on a card; the admin confirms |
| Currency, timezone | Workspace profile | Set at creation; changing them later is a card with a warning, since amounts and workspace days depend on them |
| Warehouses: how many, names, codes | Warehouses and their default locations | Card per warehouse, confirmed together |
| Who buys, who receives, who approves, who handles invoices | Invitations with roles | Step 3 |
| Do you approve purchases above an amount? | Recorded as the answer only | Not a setting: nothing enforces amount thresholds today (§2). The chat says approval is by role, and the answer goes to the owner's backlog (decision O4) |

- **Card rule:** every answer that changes a setting goes through a card the
  administrator confirms, the same confirm path as L2 (decision O3).
- **With AI on:** the model may read a free-text answer ("two warehouses, Boston
  and Dallas") and fill the card. Without AI, the chat asks field by field (decision O2).

### Step 2. Files in the chat (new, on the existing import)

- **Upload.** The administrator drops an Excel or CSV file into the chat. The
  existing import reads it: same types, same header matching, same preview.
- **Preview in the chat:** the type it found, rows that will be created or
  updated, rows with issues and why, and a link to the full preview page.
- **Headers it does not know:**
  - without AI, they are listed and the admin picks the column from a list;
  - with AI, the model proposes the column for each unknown header. The mapping is shown as a card, and nothing imports until it is confirmed.

  The model never changes values, only which column a header means.
- **A workbook with several sheets:** one preview per sheet, in import order (items, suppliers, item suppliers, customers, opening stock).
- **Confirm** runs the existing import.
- **Opening stock** becomes draft adjustments, as today. The chat links to the workbench, where a person posts them.

### Step 3. Inviting the team

- "Add Sam as buyer, sam@company.com" gives an invitation card with the role and the email. When it is confirmed, the invitation is created.
- **New:** the invitation is emailed through the existing mailer, and `emailDeliveryConnected` becomes true when a provider is configured (decision O5). It is small and useful before any trial, with or without this design.

### Step 4. First-value health check (new)

Right after the import, a deterministic check over the imported records. It uses
the same reads as the reorder list and the assistant's "records needing data".

| Check | Why it matters | Fix offered |
| --- | --- | --- |
| Items with no reorder point or safety stock | The reorder list and any reorder rule ignore them | Link to the items list filtered to them; bulk edit there |
| Items with no approved supplier | No purchase request can be prefilled | Link to item suppliers import |
| Suppliers with no payment terms | Invoices and contracts lack terms | Link to the supplier list filtered |
| Items with no lead time | Coverage dates are unknown | Link, filtered |
| Items already below reorder point | The first useful result: what to buy now | Open the reorder list |

- **Fixes are links first** (decision O6). Fixing master data in bulk from the
  chat would be a write, so it would be an L2 card. That is a later step, once C1 exists.
- **The first-day checklist on Today** gains these checks under the five import
  steps, so they stay visible after the chat is closed.

### Step 5. The first standing instruction

- After the health check, the chat offers two or three templates that fit the
  data. For example, if items are below reorder point: "Every Monday, draft
  purchase requests for what needs reordering?"
- The user can also write their own sentence.
- Either way, the result is a rule card with a dry run (§4.2), and nothing runs until the card is confirmed.

### Step 6. Runs, review and the digest

- Each run leaves its drafts in Today under a new kind, `automation_drafts`, with
  the rule's name and the run's counts.
- An email digest goes to the rule's owner when a run produced drafts or failed (§4.7).
- Review happens where it does today, in tables: the user submits, edits or cancels each draft purchase request.

### Step 7. Learning from review

- Each draft's outcome is stored as a code:
  - submitted unchanged;
  - submitted after an edit;
  - cancelled;
  - left until the next run.

  This is agent mode decision 9, codes and counts only.
- These codes drive the auto-pause (§4.6) and, much later, the L4 offer (§5).
- Collecting them from trial users as research data needs COUHES review first (#225 §13).

## 4. Standing instructions (L3)

### 4.1 Templates, not free-form rules

A rule is one of a closed set of templates, each with typed parameters. The model
maps a sentence onto a template and its parameters; it never writes code or a
query. A sentence that fits no template gets "I can't run that on a schedule
yet", with the nearest template if there is one.

| Template | Trigger | Condition | Output | Exists to build on |
| --- | --- | --- | --- | --- |
| Reorder drafts | Weekly or daily, at a time | Reorder list rows with a shortfall, not covered by an open request (#151 §4.4) | Draft purchase requests, one per supplier, quantity as the reorder list prefills it (shortfall raised to the minimum order) | Reorder list, purchase request command, C1 |
| Overdue order list | Daily or weekly | Purchase orders past their promise by N days | A Today row per order with its supplier's contact, and a digest. Nothing is sent to the supplier | `purchase_order_overdue`, PO read tools |
| Invoice exceptions | Daily | Supplier invoices with a match variance | A digest | `bill_exception` |
| Contract notice | Daily | Contracts whose notice date is within N days | A digest | `contract_notice_due`, `contract_ending` |

Only the first template writes anything, and what it writes are draft documents.
The other three only notify, so they can ship before or alongside L2 (decision A1).

### 4.2 The rule card

"Every Monday, draft purchase requests for what needs reordering, for me to check" becomes:

| Field | Value |
| --- | --- |
| Template | Reorder drafts |
| Owner | Kim. The rule runs with Kim's permissions, checked at each run |
| When | Mondays 08:00, workspace time (America/New_York) |
| Which items | Every item on the reorder list with a shortfall and an approved supplier |
| Output | Draft purchase requests, one per supplier; never submitted |
| Limits | At most 10 requests and $5,000 per run. Beyond that, notify only, listing what was left out |
| Notify | A Today row; an email digest to Kim |
| Dry run | "Last Monday this would have made 3 requests: Acme (2 items, $1,240), Summit (1 item, $310)." |
| Source | The sentence as written, kept with the rule |

- **Confirming** saves the rule and switches it on.
- **Editing** by chat or on the rule's page makes a new version. Runs record the version they used.
- **Switching off** is one click on the card, the page or Today.

### 4.3 Runs are deterministic

- **No model call when a rule runs** (decision A4). The model is used when a
  rule is created or changed: it turns the sentence into a spec and explains the
  dry run. The runs themselves:
  - give the same output from the same data;
  - cost nothing in model calls;
  - keep running when the provider is down or the workspace's cap is spent (#150);
  - can be audited line by line.
- **Steps in one run:**
  1. **Load the owner as an actor.** If they lost the permission the rule needs, the rule pauses with the reason and the run stops.
  2. **Read the condition** through the same read services as the read tools of #227, with the owner's scope.
  3. **Apply coverage.** Skip items already covered by an open request, including a draft from an earlier run that is still waiting.
  4. **Apply the limits.**
  5. **Create the drafts** through the existing commands. The idempotency key is the rule, its version and the period, so a retried or repeated run never duplicates.
  6. **Write the run record,** then the Today row and the digest.
- **Source mark (new):** drafts carry `source: "automation"` and their rule and
  run in `originEvidence`, so tables can filter them and the review codes can be counted.

### 4.4 Where the schedule runs

`main` has no scheduler (§2). The production service is a single Render instance,
and each deploy stops it briefly. Three ways:

| Option | How | For | Against |
| --- | --- | --- | --- |
| A. In the web process (recommended) | A timer every minute finds due runs in an `AutomationRun` table and takes each under a Postgres advisory lock | No new service or cost; works locally the same way; runs missed during a deploy are found on start | Shares the web instance's CPU; must stay light (the runs are reads plus a few commands) |
| B. Render cron job | A separate service runs `node scripts/run-automations.mjs` every 5–15 minutes with the same database | Isolated from web traffic | A second paid service, with its own deploy and secrets; minute-level timing is lost |
| C. External caller | A pinger calls a protected endpoint | Nothing to host | A secret endpoint that runs jobs; one more outside dependency |

- **Catch-up.** With A, a due run that was missed is done at the next start, once, with its original period key.
- **Moving later.** Start with A while there is one instance. Move to B if the
  service ever scales out or runs get heavy. The run table and the lock make that a
  hosting change, not a redesign (decision A5).

### 4.5 Event triggers

"When something happens" rules reuse Today instead of hooks inside every command:
- the runner evaluates the Today kinds on a short schedule (hourly);
- it acts on rows that are new since the last run.

This catches events from imports, the mobile app and every command alike. It
costs at most an hour of delay, which is enough for purchasing work.

### 4.6 Guards

| Guard | Default (recommended) |
| --- | --- |
| Limits per run | 10 drafts and $5,000 in the workspace currency; an admin may raise them up to a workspace maximum (decision A3) |
| Dry run | Required before a rule is switched on, over the last period |
| Kill switch | Per rule, per workspace (admin), and an environment flag that stops every run |
| Auto-pause | After 3 runs in a row whose drafts were all cancelled, the rule pauses and the chat asks the owner why (decision A6) |
| Stale drafts | A rule never stacks drafts: coverage counts its own waiting drafts |
| Permissions | The owner's permissions at run time; a lost permission pauses the rule |
| Rules per workspace | At most 20 |
| Never | Sending to suppliers or customers, approving, posting, paying, deleting |
| Audit | One record per run: its inputs, counts, output ids, the limits it hit and any error code |

### 4.7 Notification

- **Today** shows one row per run that left drafts or failed.
- **The email digest** goes to the owner and carries counts, record numbers and
  links. Amounts and supplier names are left out, since mail leaves the workspace
  (decision A7). It is sent through the existing mailer, one email per run at most.
- **No digest** when a run found nothing to do; the run record still exists.

### 4.8 Data model sketch

- **`AutomationRule`:** tenant, owner, template, parameters, trigger, limits, state (on, paused, off), pause reason, version and the source sentence.
- **`AutomationRun`:** tenant, rule, rule version, period key, state (due, running, done, failed, skipped), counts, output ids, the limits hit and an error code. Unique on tenant, rule and period key.
- **Drafts:** existing documents with `source: "automation"` and the rule and run in `originEvidence`.
- **Review codes:** read from each draft's later status; no new table until the L4 measure needs one.

## 5. L4: when it may be offered

L4 is not designed here. This design only records when the question may come back
(decision A8):
- a rule has run at least 8 times;
- at least 90% of its drafts were submitted unchanged;
- the owner has revised the rule of 2026-10-05 for that action type and amount.

Then an administrator may opt one rule in, for one action type, under a cap.
Payments, approvals and deletes stay out, as in #225 §12.

## 6. Use of the model and cost

| Moment | Model call | AI off |
| --- | --- | --- |
| Setup interview | Only to read a free-text answer into a card | Asks field by field |
| Unknown import headers | Proposes a column per header | The admin picks from a list |
| Creating or changing a rule | Sentence to spec; explains the dry run | Templates are picked from a list and their fields filled in |
| Each run | None | Same |
| Optional weekly summary | One call per digest | Not sent |

- **Cost.** The model-first probe of 2026-10-28 measured about $0.0011 per answer on
  Haiku 5.5. Setting up a rule takes a few calls, so it costs well under one cent.
  Runs cost nothing.
- **Weekly summary.** A model-written summary of the week is its own later
  decision (A4): it would be the only model call that happens without a person asking.

## 7. Build order and rough size

Each step is its own PR with green CI. The sizes are rough, in working days.

| Order | Step | Rough size | Needs |
| --- | --- | --- | --- |
| 0 | Invitation email through the mailer | 1 | Nothing; useful before any trial |
| 1 | L2 confirm cards (#151 C1) | 3–4 | The owner's go on #151 |
| 2 | Rule and run tables, the in-process runner, the Reorder drafts template, Today row, email digest, guards | 5–8 | 1 |
| 3 | Rule creation by chat, dry-run preview, rule page | 5 | 2 |
| 4 | The three notify-only templates and hourly Today triggers | 5 | 2 (the notify-only ones need neither 1 nor 3) |
| 5 | Setup interview, files in the chat, health check | 7–10 | 0, and 1 for the cards |
| 6 | Self sign-up, if chosen | 5 | Deploy, abuse guards (§3, step 0) |

Timing per #225 §13: after the first deployment and L1/L2, in Q1 2027.
- **Before the trial:** step 0 alone is worth doing.
- **Earlier option:** step 4's notify-only templates could ship earlier, since they write nothing.

## 8. Risks

| Risk | Answer in this design |
| --- | --- |
| Wrong master data makes wrong drafts every week | Health check before the first rule; dry run; limits |
| Drafts pile up unread | Coverage counts waiting drafts; auto-pause after rejections; one Today row per run |
| A deploy interrupts a run | Idempotent commands keyed by rule, version and period; catch-up on start |
| Workspace day and daylight saving | Times are in the workspace timezone; the period key is the workspace day (`tenantCalendarDay`) |
| A rule outlives its owner's role | Permissions are checked at each run; the rule pauses with the reason |
| Mail leaks business detail | The digest holds counts, numbers and links only |
| Trial users' review data used for research | Codes only; COUHES review before collecting from trial users |

## 9. Decisions for the owner

**Decided 2026-10-29:** the owner approved every decision below as recommended
("按推荐"). Two of them change what happens before the trial:
- **O1:** trial workspaces stay operator-provisioned;
- **O5:** invitation emails are sent through the existing mailer now, as §7 step 0.

The rest wait for the §7 order, after L1/L2.

### Onboarding

| # | Decision | Recommendation |
| --- | --- | --- |
| O1 | Trial workspaces: self sign-up or operator-provisioned | Operator-provisioned with invitation emails for the trial. Self sign-up after the pilot, with the guards in §3 step 0 |
| O2 | Setup interview: scripted or model-led | Scripted questions with buttons; the model only reads free-text answers when AI is on |
| O3 | Which answers write settings directly | None directly. Every setting change is a card the admin confirms. Currency and timezone are set at creation |
| O4 | Approval by amount | Not offered in onboarding, since nothing enforces it today. Record the answer; building amount thresholds is a separate ERP decision |
| O5 | Invitation emails | Send them through the existing mailer now, before the trial |
| O6 | Health check fixes | Links to filtered lists first; bulk-fix cards later through L2 |

### Standing instructions

| # | Decision | Recommendation |
| --- | --- | --- |
| A1 | First templates | Reorder drafts first. The three notify-only templates next; they may ship earlier because they write nothing |
| A2 | What a run writes | Draft purchase requests directly, never submitted, marked `source: "automation"`. The confirmation happens once, when the rule is switched on after its dry run |
| A3 | Default limits | 10 drafts and $5,000 per run per rule; an admin may raise them up to a workspace maximum |
| A4 | Model calls during runs | None. A model-written weekly summary is a later, separate decision |
| A5 | Scheduler hosting | In the web process with a run table and a Postgres advisory lock; a Render cron job if the service scales out |
| A6 | Auto-pause | After 3 runs in a row whose drafts were all cancelled; the chat asks why |
| A7 | Digest content | Counts, record numbers and links; no amounts or supplier names in mail |
| A8 | When L4 may be raised | Not before 8 runs of a rule with at least 90% of its drafts submitted unchanged, and only after the owner revises the rule of 2026-10-05 for that action type |
