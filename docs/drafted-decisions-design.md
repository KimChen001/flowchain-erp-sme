# Drafted decisions: the system prepares the next step, a person decides

Status: proposal of 2026-11-11. Nothing is built by this document. Decisions DD-1 to DD-8 (§9) are open.

**Where it comes from.** On 2026-11-11 the owner asked what a WeChat article suggests for FlowChain.
- The article: 卡兹克 on a year of building an agent automation system for his own work ([source](https://mp.weixin.qq.com/s/2R9xtPdgYr3kF6L-LGr8aA)).
- Its main point: a person's attention is the scarce resource, so the agent should prepare each decision and the person should only decide.
- The author's analogy is the Ming court. The cabinet drafted a recommendation on each memorial (票拟); the emperor only marked it in red (批红).

The owner chose to have that idea written up for FlowChain. This is that design.

## 中文摘要

- **要解决的事：**
  - 今天页现在列出要处理的事，最多 100 行、18 类。每行只是一个链接，用户打开单据后还要自己想下一步做什么。
  - 助手要等用户来问才回答。
  - 用户的注意力都花在"找事、想办法"上，而不是"做决定"上。
- **做法：** 把"要处理的事"变成"已经起草好的决定"。
  - 系统发现一件事时，先把下一步起草好。比如某商品要补货、某采购单逾期、某申请已批准待转单。
  - 起草的内容可以是：预填好的采购申请、给供应商的催货文字、新的承诺日期、待审核的采购订单草稿。
  - 每张卡片写明依据和日期。用户点一下确认，或选"以后再说""不需要"并给出理由。
- **不变的规则：**
  - 系统只起草；确认后写入的也只是草稿或记录。
  - 提交、审批、下发给供应商、发邮件、付款、删除，系统都不做。
  - 排序仍按日期，不打分。
- **新东西只有三样：**
  1. 一张"决定事项"表，记录每件事从出现、决定到解决的全过程；
  2. 记住用户的决定：同一件事除非情况明显变化，不会再问；
  3. 今天页把"等你决定"和"其他待办"分开，让真正要拍板的事尽量少。
- **和已有设计的关系：** L3 定时指令（#229）、报表提醒（#234）、供应链智能草稿里的每日提示，都把结果写进同一张决定事项表，不另开渠道。
- **第一批只做三类：**
  - 补货：预填采购申请；
  - 采购单逾期：催货文字，加记录新的承诺日期；
  - 已批准的申请：生成采购订单草稿。
- **不调用模型也能运行：** 起草全部来自现有规则和表单。模型只在用户问"为什么"、或在对话里修改草稿时使用。
- **决定：** §9 共 8 项。最关键的是：
  - DD-1：是否采用这个方向；
  - DD-3：一键能做什么；
  - DD-4："不需要"对谁生效。
- **时间：** 等助手的 5 个 PR 合并后开始。12 月做第 1–2 步，1 月做第 3–4 步。

## 1. The problem in FlowChain terms

- **Today lists; it does not prepare.**
  - Today (`buildTodayWork`, `server/domain/today-work.mjs`) lists up to 100 rows of 18 kinds, earliest date first. Each row opens its record.
  - The user then works out the next step: which supplier, how many, what to write, which date to record.
- **The assistant waits to be asked.**
  - Assistant v2 answers "What should I handle first?" from `attention_list`.
  - It can fill a purchase request card (`suggest_purchase_request`).
  - Nothing is prepared before the question.
- **Nothing is remembered.**
  - Rows and signals are worked out again on every read (`buildAiSkillSignals`).
  - Say a buyer decided last week not to reorder a seasonal item. They see it again every day.
  - Assistant threads live 2 hours, in memory (`ai-assistant-v2-threads.mjs`).
- **Everything looks equally urgent.**
  - The "Needs action" tile counts every row in Today's work.
  - An overdue order that needs a call to the supplier sits in the same list as an approved request that needs one click.
- **In purchasing, the acts that matter all need a person.**
  - The article lists what its agent must always hand to a person: spending money, messages to outsiders, deletes, permissions.
  - That list covers placing orders, chasing suppliers and changing dates.
  - So the value is not in acting alone; it is in having the decision ready.
  - This is the rule of 2026-10-05: the model understands and proposes, the system supplies the facts and executes, a person confirms.

## 2. What exists on `main` (a7065fbe)

| Piece | Where | What it gives | Gap for this design |
| --- | --- | --- | --- |
| Today's work | `buildTodayWork`, `TODAY_WORK_KINDS` (18 kinds) | Rows of codes, ids, dates and numbers, ordered by date | Rows link to records; no prepared step; worked out on every read |
| Attention signals | `buildAiSkillSignals` (11 types), `ai-skill-signals.mjs` | One reason per record, with its date; `attention_list` merges them per record (`also`) | Not stored |
| Reorder prefill | `reorder-list.mjs` (`requestMinimumOf`), `ReorderListPage.tsx` | A prefilled purchase request per item: supplier, and shortfall raised to the minimum order | Opened one item at a time |
| Purchase request card | `suggest_purchase_request`, `ai-assistant-v2-ui-tools.mjs` | An in-chat form; Create writes a draft through `POST /api/procurement/requests` | Only when asked in chat |
| Orders from a request | `POST /api/procurement/requests/:id/generate-purchase-orders` (`createPurchaseOrdersFromPurchaseRequest`) | Draft purchase orders from an approved request, one per supplier, currency and delivery warehouse | Refuses the request when a line lacks any of the three (422) |
| Promised date revision | `POST /api/procurement/orders/:id/promised-dates` (`revisePromisedDates`), `PurchaseOrderPromiseDates.tsx` | A new promised date per line with its reason; the original promise is kept | Only from the order page |
| Supplier follow-up text | `buildSupplierFollowupDraftPreview`, `rfq-and-supplier-followup-draft-preview.mjs` | An editable follow-up message for a supplier and a document. Preview only; never sent | Not offered on Today |
| Match exception review | `/api/finance/match-exceptions/:id/review-preview` and `/review` | A preview, then the review command | — |
| Stored drafts | `ActionDraft` with its validation and audit tables (`prisma/schema.prisma:928`) | A draft with status, payload, origin and audit trail | Holds a draft, not a finding with its decision and outcome |
| Audit | `AuditLog` | One row per command | — |
| Scheduler | — | — | None. #229 designs one (approved, not built) |

## 3. Where this sits among the approved designs

| Design | What it decides | How it uses this one |
| --- | --- | --- |
| #229 L3 standing instructions (approved 2026-10-29) | Rules a person sets ("each Monday, draft the reorder requests"); scheduled runs leave drafts | Its runs write decision items. Its review codes (§3, step 7 there) are the outcome codes here. Its hourly Today triggers (§4.5 there) raise items before anyone opens Today |
| #234 reports, weekly brief and alerts (approved 2026-10-30) | Thresholds an administrator sets; alerts as Today rows; auto-quiet | Alerts become decision items with "Not now" and "Not needed"; auto-quiet reads the same decline record |
| Supply chain intelligence draft (branch `docs/supply-chain-intelligence`, no PR yet) | Run-out and order-by dates, supplier comparison, the daily note, snooze codes | The note's lines are decision items, its snooze codes are the reasons here, and its PR card is the reorder draft |
| Assistant v2 (#239, approved 2026-11-02) | One loop, UI tools, confirmed actions; Create, then Submit as a second click (V2-3) | "What should I handle first?" reads the same items, and "go ahead" is the primary click |

The point is one place that holds three things: what the system found, what it drafted, and what the person decided. Today, the assistant, the rules and the alerts all read and write it. No new channel is added.

## 4. The design

### 4.1 A decision item

One record per finding that needs a person.

| Part | Content |
| --- | --- |
| Finding | The Today kind and the record, with its codes, numbers and date, as `buildTodayWork` gives them |
| Draft | The prepared next step, with each value's source. For example, "quantity 240: shortfall 180, raised to the minimum order of 240" |
| Basis | The facts behind it, each dated and linked: stock position, open orders, the last receipt |
| Options | One primary action, at most two others, then "Not now" and "Not needed" |
| State | open, decided, resolved, expired |
| Decision | Who, when, which option, a reason code, and the record it created |

- **Key:** the kind, the record id and the condition's own date. That date is the due date for an overdue order and the order-by date for a reorder.
- **One item per key.** A second finding on the same record joins it, as `attention_list` merges signals with `also`.

### 4.2 Lifecycle

```
open ──► decided ──► resolved
  │
  └────► expired
```

- **Open:** raised when a Today row appears and no item has its key.
- **Decided:** the person chose an option. Accepting creates the drafted document and links it.
- **Resolved:** the condition is gone: the order arrived, stock is back above the reorder point, or the request was converted. Recorded with its date.
- **Expired:** the condition went away before anyone decided. Recorded too, so the measures can count findings nobody needed.

### 4.3 The first three kinds and their drafts

| Today kind | The draft | Primary click | Other options | Writes through |
| --- | --- | --- | --- | --- |
| `reorder_now` | A purchase request: the supplier and quantity the reorder list prefills (shortfall raised to the minimum order). Items due the same day for the same supplier are offered together | Create the request. It is a draft; Submit stays a second click (V2-3) | Edit in the form | `POST /api/procurement/requests` |
| `purchase_order_overdue` | A follow-up message from `buildSupplierFollowupDraftPreview`: the order, the lines still to receive and the promised date | Chase: copy the message and record "chased" | Record a new promised date with the supplier's reason | `POST /api/procurement/orders/:id/promised-dates`; "chased" is a decision only |
| `purchase_request_to_convert` | The draft purchase orders the request would make, one per supplier, currency and delivery warehouse. A line missing any of the three is named, and there is no button until it is filled in | Create the draft orders | Open the request | `POST /api/procurement/requests/:id/generate-purchase-orders` |

- **Why these three:**
  - each has a command already on `main`;
  - its draft is fully set by rules already on `main`;
  - none of them sends, approves or pays.
- **Chasing a supplier:** FlowChain sends nothing. Supplier email is its own step, with its own permission and mail channel (decision 4 of 2026-10-05). The person copies the text into their own mail.
- **Every other Today kind** keeps its row as now and gains only "Not now" and "Not needed". Kinds join one at a time later (§8, step 6).

### 4.4 What the system may do, and what it may not

| Kind of act | The system alone | Prepared, then done on one click | Never by the system |
| --- | --- | --- | --- |
| Read and work out | Read records; work out dates and quantities; order by date | — | — |
| Draft | Prefill requests and orders; write follow-up text | — | — |
| Create | — | A draft purchase request; draft purchase orders from an approved request | Submit, approve, or issue a purchase order to a supplier |
| Record | — | A new promised date with its reason; a decision with its reason | Change master data, settings or permissions |
| Outside the workspace | — | — | Email or message suppliers or customers; pay; post; delete |

- **Permissions:** each click runs as the person, through the existing route and its permission check. Someone without the permission sees the item but not the button.
- **Amounts:** no amount threshold exists on `main` (#229, O4). Approval stays by role, after Submit, as today.
- **Model:** no click calls a model.

### 4.5 Remembering decisions

- **"Not now"** brings the item back on a day the person picks: tomorrow, next Monday, or a date. The default is the next workday.
- **"Not needed"** asks for a reason code:
  - `seasonal`;
  - `discontinued`;
  - `covered_elsewhere`;
  - `supplier_confirmed`;
  - `other`, with a short note.

  The first three are the supply chain intelligence draft's snooze codes.
- **A set-aside item comes back only when its condition changes materially (DD-5):**

| Kind | Comes back when |
| --- | --- |
| `reorder_now` | Stock falls below safety stock, the shortfall at least doubles, or 30 days pass |
| `purchase_order_overdue` after "chased" | 3 workdays pass with no receipt and no new promised date |
| `purchase_order_overdue` after "Not needed" | A recorded new promised date passes, or 7 more days pass with no receipt |
| `purchase_request_to_convert` | 14 days pass |
| Every other kind | The condition's date changes, or 30 days pass |

- **Everyone who sees the record sees the decision (DD-4).**
  - For example: "Set aside by Sam on 11 Nov: seasonal."
  - Anyone with the permission can reopen it.
- **The assistant reads the decisions.**
  - `attention_list` marks set-aside items with their reasons.
  - "What should I handle first?" leaves them out and says how many were set aside.
  - The assistant never raises a set-aside item as new.

### 4.6 Today: what needs you, first

Today gets three parts:
1. **Waiting for your decision.** Open items the person may act on, earliest date first. Each is a card: the finding, the draft, the basis and the buttons. At most 10 are shown, then "Show all N".
2. **Today's work.** Every other row, as now.
3. **Set aside.** Collapsed. Each item shows who set it aside, when and why, with "Reopen".

- **The "Needs action" tile** counts part 1 only. A second figure gives part 2.
- **The order stays by date** (owner decision 2026-10-03). There is no score.
- **The phone** approval inbox (#209) can show part 1 with the same buttons, later.

### 4.7 How items are raised

- **v1, on read:**
  - When Today, the assistant's welcome card or `attention_list` is read, the server builds Today's work as now.
  - It then inserts items for keys it has not seen, and resolves or expires items whose row has gone.
  - No model, no scheduler, no new service.
  - Two readers at once write the same keys. A unique index on workspace and key makes that safe.
  - A failed write never breaks Today: the rows are the same with or without their items.
- **v2, hourly:**
  - Runs on the #229 runner (§4.5 there), so items exist before anyone opens Today.
  - The digest can then say "4 decisions waiting". Under #229 A7 it carries counts, numbers and links, but no amounts or names.
- **Scope:** items belong to the workspace. Each reader sees only the items their permissions allow, with the hiding rules Today uses now.

### 4.8 In the assistant

- **The welcome card** gives the count of waiting decisions and the first three, with their buttons.
- **"What should I handle first?"** answers from the same items, and its buttons are the items' options.
- **"Go ahead" or "do the first one"** after such an answer:
  - is the primary click of the item the answer showed (the thread's refs prove which);
  - still shows the confirm card, as SC-11 proposes for the daily note.
- **"Why this quantity?"**
  - is explained from the draft's sources;
  - the model may word the answer, and the answer check applies.
- **A read tool, `decision_history`,** gives a record's items and decisions. With it the assistant can say "You set this aside on 11 Nov as seasonal."

### 4.9 Checks before a card is shown and when it is clicked

The article's agent reviews each code change before it is merged. Here the check is deterministic.

- **When a card is shown:**
  - **Coverage:** if an open request or order already covers the item, there is no draft. The card says "Already requested: PR-…".
  - **Permission.**
  - **The record's version.**
- **When it is clicked:**
  - The draft is rebuilt from current data. If a figure changed, the card shows the new figure and asks again.
  - Writes carry the record's `expectedVersion` and an idempotency key made from the item key. A double click or a retry therefore creates one document.
- **Model text** on a card or in an answer goes through the existing answer check (`checkAiModelFirstGrounding`).

### 4.10 What is recorded

- **For each item:**
  - raised;
  - decided: the option, the reason code, who, when, and the document created;
  - resolved or expired;

  each with its date.
- **For accepted drafts:** whether the document was later submitted unchanged, submitted after an edit (which fields), or cancelled. This is read from the document, as in #229 step 7.

Three measures per kind follow:
- the share of drafts accepted unchanged;
- the time from raised to decided;
- the share of set-aside items that came back and were then acted on, which tests the come-back rules.

Only codes, ids and dates are recorded. Using people's decisions as research data needs COUHES review first (#225 §13). The public-data workspaces need none.

## 5. Data model sketch

- **`DecisionItem`** holds:
  - tenant;
  - `key`, unique per tenant;
  - kind, entity type, record id, condition date;
  - state: open, decided, resolved or expired;
  - raised, decided and resolved times;
  - the decision: option code, reason code, a note of up to 200 characters, and who decided;
  - the document created (type and id);
  - `returnOn` for "Not now", and the come-back rule code.
- **Drafts are not stored.** They are rebuilt from current data each time a card is shown (§4.9).
- **The created document** carries `source: "decision_item"` and the item id in `originEvidence`, as #229 marks `source: "automation"`.
- **`ActionDraft` stays as it is.** A decision item is not a draft; it is a finding with its decision.
- **Each decision** writes an `AuditLog` row.

## 6. Model use and cost

| Moment | Model call | With AI off |
| --- | --- | --- |
| Raising items and building drafts | None | Same |
| "Why?" on a card | One answer, when asked | The card's sources only |
| Editing a draft by chat | The v2 loop, when asked | The form |

The inbox works with AI off. The model adds explanations and editing by chat, at the existing cost per answer.

## 7. What this does not do

- It does not act alone. L4 stays as #229 A8 left it.
- It does not send anything to suppliers or customers.
- It adds no channel (chat apps, push). Email waits for the #229 digest (A7).
- It does not score or rank by importance. The order is by date.
- It does not replace the record pages. Each card opens its record.

## 8. Build order and rough size

Sizes are rough, in working days.

| Step | What | Size | Needs |
| --- | --- | --- | --- |
| 0 | Merge the five open assistant PRs first (#301 → #300 → #305 → #297 → #290). Step 3 changes `attention_list` | — | The owner's merges |
| 1 | `DecisionItem` table and migration; raising on read; Today's three parts with "Not now", "Not needed" and "Reopen"; the come-back rules; tests | 4–6 | — |
| 2 | The drafts and one-click actions for the three kinds; the checks of §4.9 | 4–5 | 1 |
| 3 | The assistant: welcome card, `attention_list` reading items, "go ahead", `decision_history` | 3–4 | 2; step 0 |
| 4 | Outcome codes and a measures table on an admin page or export | 2 | 2 |
| 5 | Hourly raising and the digest | 2 | The #229 runner |
| 6 | More kinds, one per PR: supplier invoice exceptions, contract notice, #234 alerts, the daily note's lines | 1–2 each | 2 |

- **Checking each step** uses the UCI walkthrough and the M5 workspace, as the public-data direction asks.
- **Timing:**
  - November holds the course report, IPSERA and the PhD applications.
  - Steps 1–2 fit December, next to supply chain intelligence steps 1–3, which change the same Today rows.
  - Steps 3–4 follow in January (DD-8).

## 9. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| DD-1 | Direction: (a) decision items as one shared layer under Today, the assistant, #229 rules and #234 alerts; (b) cards in the assistant only; (c) not now | (a). One record of what was found and decided, used everywhere, instead of three lists |
| DD-2 | The first kinds | `reorder_now`, `purchase_order_overdue` and `purchase_request_to_convert`. Each has a command on `main` and a draft set by existing rules |
| DD-3 | What one click may do | Create draft documents, record a promised date, and record a decision. Never submit, approve, issue, send, pay, post, delete, or change master data |
| DD-4 | Who a "Not needed" applies to: (a) the whole workspace, showing who, when and why, with Reopen for anyone with the permission; (b) only the person | (a). Purchasing is shared work; otherwise each teammate makes the same decision again |
| DD-5 | When a set-aside item comes back | The table in §4.5 |
| DD-6 | How items are raised | On read in v1; hourly on the #229 runner in v2 |
| DD-7 | What is recorded | Codes, ids and dates, plus an optional short note. Research use only on the public-data workspaces unless COUHES approves |
| DD-8 | Timing | After the five assistant PRs merge. Steps 1–2 in December, steps 3–4 in January |

## 10. Risks

| Risk | Answer in this design |
| --- | --- |
| Wrong master data (missing reorder points, lead times, minimum orders) makes wrong drafts | Each value shows its source. The #229 health check and the supply chain intelligence missing-data prompts come first. "Not needed: other" notes point at data to fix |
| People click through without reading | A click creates drafts only; Submit and approval stay separate steps. "Accepted unchanged" is read together with later edits and cancels |
| A set-aside item hides a real problem | Come-back rules; the set-aside list is visible to everyone; 30 days at most |
| Reading Today now writes | Insert-if-absent by unique key; a failed write never blocks Today |
| Two people decide the same item | The item's state is checked in the same transaction; the second person sees who decided |
| Overlap with three approved designs | §3: they all write into this layer, so no list is duplicated |
