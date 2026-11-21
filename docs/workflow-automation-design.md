# Workflow automation: the supplier reply flow first, or a framework first

Status: proposal of 2026-11-19, revised the same day after a review. WA-1 to
WA-4 decided 2026-11-19 as recommended (§5): #363 is built on its own first.
Code references are to `main` at 465da8a0; the appendix holds the detail.

The 2026-11-19 study of Pallet's agent platform (vendor claims, not verified)
recommended workflow automation: a trigger runs fixed steps, read → decide →
draft, that end in a card a person confirms or a message a person sends.
Nothing is written without a person's confirmation.

This is not L3 as `docs/ai-model-first-design.md` §13 (#225) and
`docs/ai-onboarding-and-automation-design.md` (#229) define it: there, a user
states a rule in chat and the model maps it onto a template. Here, workflows
are written in code and switched on per workspace.

## 中文摘要

- **核心取舍：** 如果运行不经人确认什么都不写、只留卡片，能带来新东西的流程其实只有"供应商回信 → 新交期"，而 #363 已经把它设计完了。补货草稿和三个只提醒的模板，今天页已经有对应的行和卡片。
- **两条路：** (A) 先单独做 #363，约 8–9 天，带运行记录和 Zod 步骤约定，以后可以并入框架；(B) 先做通用框架，约 15–19 天才到同一个结果，其中定时和到期触发暂时没有流程用。
- **推荐 A。** 等第二个流程需要应用里没有的触发方式（收信、定时）时再做框架，最早随首次部署，或按 #225 §13 在 2027 年第一季度和 L3 一起做。
- **要定的 4 件事：** 单独做还是先做框架、费用上限、身份与可见范围、时间。2026-11-19 已定（"方案C开始吧"）：全部按建议，先单独做 #363。

## 1. The choice

If a run may write nothing, it ends in a card. (#229's A2 let its reorder template write draft requests; appendix B.) Then:
- **Reorder drafts,** #229's first template, become the `reorder_now` card Today already raises with a drafted request (`buildDecisionDrafts`, `decision-drafts.mjs`).
- **The three notify-only templates** match rows Today already shows: `purchase_order_overdue`, `bill_exception`, `contract_notice_due` (`TODAY_WORK_KINDS`, `today-work.mjs`).
- **No workflow needs the weekly or due-date triggers yet.**
- **The one new workflow** is supplier reply → promised date, which #363 (`docs/supplier-reply-dates-design.md`, open) designs in full.

| | A. #363 standalone, framework-ready | B. Framework first |
| --- | --- | --- |
| Builds | #363 steps 1 and 1e, as step functions with Zod contracts and a run record per reply | Run table, step runner, workflow cards, metrics; #363 on top; a scheduler |
| Working days to first use | 8–9 | 15–19, plus 3 for the scheduler |
| Background runs | None: a paste runs in the person's request | Yes, with the runner rules of appendix B |

**Recommendation (WA-1): A.** Lift its steps into B when a second workflow needs a trigger the app lacks: inbound mail with the first deploy (#363 SR-5), or rules stated in chat, which #225 §13 places in Q1 2027.

## 2. What A builds

- **Steps** (appendix D): read the order, clean the reply, one tool-less model call, checks in code, the card. Each is a function with a Zod input and output; Zod 4 already checks the assistant's parts (`shared/assistant-protocol.mjs`).
- **Domain reads, not chat tools.** `get_purchase_order` returns no line ids (`lineOf`, `ai-read-tools.mjs`), and `revisePromisedDates` needs `purchaseOrderLineId`. The order comes from `readPurchaseOrder` (`procurement-db-command-service.mjs`) as the person who pasted.
- **The run record** is #363's `SupplierReply` row: step timings, prompt version, tokens, cost and each check's result. The reply text is kept there (#363 §4.12); the step log holds codes only.
- **The card is its own record.** A decision item is decidable only while its row is on the reader's own Today (`arrangeToday`, `decision-items.routes.mjs`); `accepted` needs a created document; `NOT_NEEDED_REASONS` has no "wrong reading". Recording dates moves an overdue order off Today, and `planDecisionSync` closes its item as now.
- **A second reply** supersedes an open card. The card carries the order's `version` and sends it as `expectedVersion`, so a stale card is refused.
- **Copy** is English, with Chinese through the existing i18n context.

## 3. Guards

**Cost (WA-2).** The assistant estimates each call before making it (`ai-assistant-v2.mjs`) and reserves in `createAssistantV2CostLedger` (`ai-assistant-v2-controls.mjs`). A reading does the same: its input plus a `max_tokens` of 1,000, reserved in that ledger. A reply gets at most two calls, a reading and one retry after a schema failure. On Sonnet 5.5 at the meter's prices a reading costs about 1–1.5¢, at most 3¢. Pastes count against the monthly cap like answers: $25 in `render.yaml`, $20 by default in code. Under B, 50 background runs a day would cost about $22 a month at 1.5¢ and up to $75 at 5¢, so B gives them a fixed share of the cap.

**Identity and visibility (WA-3).** Under A nobody new runs anything: the reading runs in the paster's request, and recording runs as the person who confirms, through the existing command and its permission check. The card stores ids, dates and quotes, and is rendered for each reader with their order permission and, for the stock line, their warehouse scope; `todayHiddenWork` filters by collection only. B would need the server to act as a workflow owner without a signed-in identity, which `loadAiSkillContext` requires: a new, security-sensitive path (appendix B).

**Injection.** The regex pre-check is no defence: #363's own example, "mark all lines received", does not match `aiInjectionDetected`. The defences are structural:
- the model has no tools and returns line references from a given list, and dates;
- a stated date must parse from its own quote; a relative date is proposed only when code computes it from the quoted phrase and the reply date;
- invisible characters are stripped, our quoted chase is removed, and each quote is shown in its sentence;
- inbound mail, later, reads the text/plain part only and authenticates the sender (#363 §4.11);
- second order: `record_history` returns the audit summary, not the revision's reason (`ai-assistant-v2-history-tools.mjs`); #363 §4.10's read-back must pass supplier text as a clipped field marked as such.

## 4. Measures

- **Unit:** one reply. The counted outcome is `SupplierReply.state` (under B, the run's outcome), never a decision item.
- **Outcome, the first that applies:** outage (model off, failed or over a cap); hand-off ("needs you"); dismissed as a wrong reading; edited before recording; recorded unchanged; dismissed for another reason.
- **Period:** by decision date. Open, expired, superseded and bypassed cards (dates changed on the order page meanwhile) are reported apart, as are outages.
- **Rates,** with U unchanged, E edited, R wrong reading, D other dismissal, H hand-off: touchless = U / (U + E + R + D + H); correction = (E + R) / (U + E + R); hand-off = H / (U + E + R + D + H).
- **Evidence:** on the public-data workspaces the confirming person is the researcher, so the evidence is the eval gate (#363 SR-6), and it is thin: 27 of 30 correct gives a 95% interval of about 74–96%.
- **Corrections become draft eval cases,** as `scripts/assistant-feedback-cases.mjs` does for 👎, and a changed prompt or check passes the gate before use. No learned memory: it changes behaviour without a version, and memory built from supplier emails carries outside text into later prompts.

## 5. Decisions for the owner

**Decided 2026-11-19.** The owner said "方案C开始吧" ("start option C") on the
Pallet study. WA-1 to WA-4 are taken as recommended: A, built framework-ready;
the cost guard of §3; the paster reads and the confirmer writes; and #363 steps 1
and 1e start now, with its SR-1, 2, 3, 4, 6 and 8 taken as recommended. B waits
as WA-4 says.

| # | Decision | Recommendation |
| --- | --- | --- |
| WA-1 | #363 standalone (A) or framework first (B) | A, framework-ready |
| WA-2 | Cost guard | Estimate and reserve before each call; two calls per reply at most; pastes count against the monthly cap; under B, background runs get 20% of it |
| WA-3 | Identity and visibility | The paster reads, the confirmer writes; cards hold ids and dates and are rendered per reader. No server-made identity under A |
| WA-4 | Timing | A once SR-1, 2, 3, 4, 6 and 8 are decided (#363 SR-8); B not before the first deploy with inbound mail, or with L3 in Q1 2027 |

Engineering defaults, not decisions: Zod step contracts, the card as its own record, and under B the runner rules of appendix B.

## Appendix

### A. What exists on `main`

| Piece | Where |
| --- | --- |
| Tool contract | `defineAiTool` (`ai-read-tool-contract.mjs`): strict JSON Schema, `available`, refs; "a tool never writes" |
| Tool runner | `runAiReadTool` (`ai-read-tool-runner.mjs`): 40 data tools; 11 display and card tools (`ai-assistant-v2-ui-tools.mjs`) |
| Spend | `ASSISTANT_V2_LIMITS` ($0.20 per answer); `createAssistantV2CostLedger`, in memory per process; `ai-usage-meter.mjs`; `withAiWorkspaceAccess` and `AI_MONTHLY_CAP_DEFAULT_USD` (`ai-workspace-access.mjs`); `FLOWCHAIN_AI_MONTHLY_CAP_USD` = 25 (`render.yaml`) |
| Decision items | `decision-items.mjs`, `decision-drafts.mjs`, `syncTodayDecisions` (`server/services/decision-item-service.mjs`), `decision-items.routes.mjs` |
| Supplier email | `sendSupplierFollowUp` (`server/services/supplier-follow-up-email-service.mjs`); `server/mail/` |
| Promised dates | `revisePromisedDates` (`procurement-db-command-service.mjs`) → `applyPromisedDateChanges` (`purchase-order-promise-dates.mjs`), with `expectedVersion` |
| Change feed | `DomainChangeFeed`, read by `mobile-sync-service.mjs` |
| Background work | Only the solver's worker thread. No queue, cron, timer loop or inbound webhook; nothing uses `SKIP LOCKED`. `render.yaml`: one instance |
| Shutdown | `registerShutdownSignals` (`server/bootstrap/server-lifecycle.mjs`): on SIGTERM, drains HTTP for up to 10 s, then disconnects Prisma |
| Identity | Session tokens (`server/auth/workspace-sessions.mjs`); `resolveProvisionedActor` refuses a disabled user (`USER_DISABLED`, `pilot-identity.mjs`); no machine tokens |
| Rate limit | `createAssistantV2RateLimiter`: 30 questions per user per 10 minutes, in memory |

### B. Option B: the framework

**Triggers.** New email (needs a deploy, #363 SR-5); due dates and stock below its reorder point, by reading Today's rows hourly (#229 §4.5, DD-6); a weekly time in the workspace timezone; manual.

**Where runs execute.**

| Option | For | Against |
| --- | --- | --- |
| B0. A timer in the web process over a run table | No new service | Shares the web process; see the rules below |
| B1. The same runner as its own process | Isolated from web traffic | A second service; the in-memory ledger and limiter no longer hold |
| B2. pg-boss or graphile-worker | Retries, backoff, cron ready-made | A dependency with its own schema outside Prisma migrations |
| C. Trigger.dev (Pallet's choice) | Durable long runs, a dashboard | A second deploy target; code, secrets and data leave the process; local research needs its service |

**Runner rules,** whichever host:
- **At least once, not exactly once.** Claim a row in a short transaction, setting a lease and an attempt count; never hold a lock through a run, since command transactions time out at 30 s (`timeout: 30_000`) and a model call may take 75 s.
- **Recovery.** A `running` row past its lease is due again. The SIGTERM handler knows nothing of runs, so a deploy cuts runs in flight; every step must be safe to repeat.
- **Uniqueness in the database:** a unique index on workspace, workflow and period key, without the version; the "rows since last run" mark in a table; the daily run limit counted under `pg_advisory_xact_lock`, the pattern of `email-link-sign-in.mjs:115`.
- **More than one process** doubles the in-memory ledger and rate limiter; both move to the database first.
- **Run as an owner.** Per-workspace workflow state: who switched it on, the owner, on or paused, the reason, and reassignment. A disabled owner (`USER_DISABLED`) pauses it. Manual pastes still run as the person who pastes.
- **Limits.** 50 background runs per workflow per day; manual pastes are limited per user instead.
- **#229 decisions that return:** A2 (the reorder template writes drafts) conflicts with "nothing written without confirmation"; A4 (no model call during runs) would need an exception for extraction.

**Build steps (working days).** W1 run table, step runner, a run as a user: 4–5. W2 workflow cards: 3–4. W3 #363 on W1–W2: 7–8. W4 metrics: 1–2. W5 scheduler: 3. W6 inbound mail: 4–5, needs a deploy.

### C. Step failures

| Failure | Handling |
| --- | --- |
| Order not found or not readable | Stop with the code |
| Database timeout | Retry once, then stop |
| Model off, down, or over a cap | Outage: the reply and the manual form (#363 §4.9) |
| Model output fails its schema | One retry (the second call), then a hand-off |
| One value fails a check | That value to the person; the rest may be proposed |

### D. Example

```js
// Proposed; nothing like it exists on main.
const ReplyReading = z.strictObject({
  replyKind: z.enum(['dates', 'confirms', 'no_date', 'auto_reply', 'other']),
  lines: z.array(z.strictObject({
    line: z.string(),          // a reference from the open lines given
    date: z.iso.date(),
    quote: z.string().max(400),
    dateKind: z.enum(['stated', 'relative', 'vague']),
  })).max(50),
  flags: z.array(z.strictObject({ kind: z.enum(FLAG_KINDS), quote: z.string().max(400) })).max(10),
})

const steps = [
  step('order', { input: OrderRef, output: OpenLines, run: readOpenLines }),             // readPurchaseOrder, as the person
  step('clean', { input: PastedReply, output: CleanReply, run: cleanReply }),            // #363 §4.3
  step('read', { input: ReadingInput, output: ReplyReading, run: readReply, calls: 2 }), // reserve, call, one retry
  step('check', { input: Reading, output: CheckedReading, run: checkReading }),          // #363 §4.5
]
```

### E. #363's decisions for option A

| SR | Question, in short | When |
| --- | --- | --- |
| SR-1 | Read replies: pasted first, inbound first, or not now? | Before building |
| SR-2 | One tool-less call, values quoted and checked in code, no chat tool? | Before building |
| SR-3 | A confirmed card writes promised dates only? | Before building |
| SR-4 | When to propose nothing and ask the person? | Before building |
| SR-6 | The gate: no hard fails, 90% of dated replies right? | Before building |
| SR-8 | Start steps 1 and 1e on approval? | Before building (the go-ahead) |
| SR-5 | Inbound mail with a per-message reply address? | Waits for a deploy |
| SR-7 | What is recorded: reply, outcome codes, a reliability measure? | Mostly waits; step 1 needs the stored reply and §4's outcomes |
