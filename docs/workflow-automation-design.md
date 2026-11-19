# Workflow automation: triggers, fixed steps, confirmed outcomes

Status: proposal of 2026-11-19, for the owner's decisions WA-1 to WA-12 (§7.2).
Nothing is built by this document. Code references are to `main` at 8b89b1f1.

On 2026-11-19 the owner asked how Pallet, a logistics AI company, builds its
agent platform. The study's recommendation C, workflow automation, is designed
here. It is the "L3 standing instructions" of `docs/ai-model-first-design.md`
§13 (#225) and `docs/ai-onboarding-and-automation-design.md` (#229, A1–A8
approved 2026-10-29), widened in two ways: a workflow may also start from an
event or an incoming message, and one step may be a tool-less model call that
reads outside text. Where this changes a #229 decision, §7.2 says so.

## 中文摘要

- **做法：** 触发 → 固定步骤（读取 → 判断 → 起草）→ 今天页上的待确认卡片，或由人发出的消息。没有人确认，不写任何业务记录。
- **触发：** 新邮件（需要部署，见 #363 SR-5）、到期日、库存低于再订货点、每周一、手动。推荐在应用进程里跑：一张运行表，用 `FOR UPDATE SKIP LOCKED` 保证每次只跑一遍；不引入 pg-boss、graphile-worker 或 Trigger.dev。
- **步骤：** 复用现有只读工具（`runAiReadTool`）；读外来文字时只用一次不带工具的模型调用做抽取，每个值由代码核对。步骤的输入输出用 Zod 定义。
- **记录：** 每次运行一条记录；"原样确认率"和"更正率"按 §4.2 的公式算。更正变成评测用例草稿，不做会自动改变行为的"记忆"。
- **第一个流程：** 供应商回信 → 新交期（#363）。动手前要定 SR-1、2、3、4、6、8；SR-5、SR-7 可以等。
- **决定：** §7.2 共 12 项（WA-1 到 WA-12）。

## 1. Goal and scope

A workflow is a trigger, a fixed list of steps in code, and an ending.
- **Steps** read through the existing read tools, decide by rules, and draft. The model never picks a step or a tool, unlike the loop in `answerAssistantV2` (`ai-assistant-v2.mjs`).
- **The ending** is a pending card on Today that a person confirms, edits or dismisses; a message a person sends under the existing rules (`sendSupplierFollowUp`); or nothing to do.
- **Nothing is written without a person's confirmation.** A run writes only its run record and its card. The change itself goes through the existing command as the person who confirmed, as decisions already do (`server/routes/decision-items.routes.mjs`: "A decision records only").

Out of scope: browser automation of third-party sites; connectors to other ERPs; external MCP access to FlowChain (a separate design); a learned memory (§4.3); L4, acting without a person (#225 §13).

### 1.1 What we take from Pallet

Pallet's descriptions are vendor marketing and are not verified.

| Pallet, as described | Here |
| --- | --- |
| Agents on the customer's TMS/ERP, email and portals | Workflows on FlowChain's own records |
| A Zod contract per action | Zod per step (§3.1) |
| A judge model and field confidence; about 5% to a person | Code checks per value; a failed check goes to a person (§3.2) |
| Exception reasons become Memory; backtests before rollout | Reasons become eval cases; a version passes them before rollout. No Memory (§4.3) |
| Money, customer, compliance and irreversible actions need a person | Every write needs a person (§6.6) |
| Every run logged; Trigger.dev, Encore queues, GCP PostgreSQL | Every run logged (§4); a run table in our PostgreSQL (§2.2) |

### 1.2 What exists on `main`

| Piece | Where (server/domain unless named) | Gap |
| --- | --- | --- |
| Tools | `defineAiTool` (`ai-read-tool-contract.mjs`): strict JSON Schema, `available`, `run` with `{ type, id, label }` refs; "a tool never writes". `runAiReadTool` (`ai-read-tool-runner.mjs`) over 40 data tools; 11 display and card tools (`ai-assistant-v2-ui-tools.mjs`) | `facts` and `context` are built per request from a signed-in identity (`loadAiSkillContext`, `readAiSkillFacts`) |
| Spend | `ASSISTANT_V2_LIMITS`: $0.20 per answer. `runWithAiUsageScope`, `aiUsageRecorder` (`ai-usage-meter.mjs`); opt-in and monthly cap, `AI_MONTHLY_CAP_DEFAULT_USD` = 20 (`ai-workspace-access.mjs`) | A scope opens per assistant request only |
| Output checks | `checkAiModelFirstGrounding`; action claims (`ai-answer-claims.mjs`); `aiInjectionDetected` (`ai-injection-guard.mjs`) | Built for answers |
| Decision items | `decision-items.mjs`: open → decided (`not_now`, `not_needed`, `chased`, `accepted`, `covered`) → resolved or expired; `comesBack`. Rule drafts in `decision-drafts.mjs`; raised and closed on read by `syncTodayDecisions` (`server/services/decision-item-service.mjs`) | Four kinds; an item lives only while its Today row does (`planDecisionSync`) |
| Today | `buildTodayWork` (`today-work.mjs`), per reader, on read | Nothing reads it without a reader |
| Supplier email | `sendSupplierFollowUp`: workspace switch, daily caps, idempotent, an `AuditLog` row; `server/mail/` | No inbound route |
| Change feed | `DomainChangeFeed`, written by command services, read by `mobile-sync-service.mjs` | Not used for triggers |
| Background work | Only the solver's worker thread (`replenishment-solver.mjs`). No queue, cron, timer loop, outbox table or inbound webhook. `render.yaml`: one instance, stopped before each deploy | All of §2 |
| Identity | Session tokens (`server/auth/workspace-sessions.mjs`); no machine tokens | §6.4 |

## 2. Triggers

### 2.1 Trigger types

| Trigger | Condition on `main` | Locally | After a deploy |
| --- | --- | --- | --- |
| New email | None | Paste on the card or the order page: a manual run (#363 step 1) | A Postmark Inbound webhook inserts a due run (#363 SR-5) |
| A due date | `purchase_order_due`, `purchase_order_overdue`, `contract_notice_due` rows (`today-work.mjs`) | Read hourly by the runner | Same |
| Stock below reorder point | `reorder_now` rows with `stockSignal` (`reorderWork`) | Read hourly | Same |
| Every Monday | None | A due time in the workspace timezone (`tenantCalendarDay`) | Same |
| Manual | None | A button, or `node scripts/run-workflows.mjs --once` | The button |

- **Conditions are polled,** not hooked into every command, as #229 §4.5 and DD-6 decided: the runner reads Today's rows hourly as the owner and acts on rows new since its last run. This catches imports and every command alike.
- **Period keys** (workflow, version, workspace day or week) keep schedules idempotent (#229 §4.3).

### 2.2 Where runs execute

Runs take seconds: a few reads and at most one model call, tens per workspace per day. A long wait ("ask again in 3 workdays") is a decision item coming back (`comesBack`), not a sleeping job.

| Option | For | Against |
| --- | --- | --- |
| A. In-process: a timer each minute claims due `WorkflowRun` rows with `FOR UPDATE SKIP LOCKED` | No new service, bill or dependency; same locally and deployed; missed runs found on start | Shares the web process; a deploy cuts runs in flight, so steps must be safe to repeat; the row lock, not the timer, keeps one execution |
| B1. The same runner as its own process | Isolated from web traffic | A second service to deploy and pay for |
| B2. pg-boss or graphile-worker on our PostgreSQL | Retries, backoff and cron ready-made | A new dependency with its own schema outside Prisma migrations; its rows duplicate the run record |
| C. Trigger.dev (Pallet's choice) | Durable long runs, waits, a dashboard | A second deploy target and account; code, secrets and data leave the process; local research needs its tooling; a bill or a self-hosted stack |

- **Cost and dependencies:** A adds none; B1 a service; B2 a library to keep up; C an account and a bill.
- **Local-first research:** A and B run on the public-data workspaces' local PostgreSQL alone; C does not.
- **Recommendation (WA-4):** A, which is #229's A5 with row locks for the claim (`email-link-sign-in.mjs` already locks through Prisma raw SQL). Keep the runner a module B1 can start unchanged. Revisit B2 or C only if runs grow long or numerous.

## 3. Workflow definition

### 3.1 Typed steps

- **Zod for step contracts (WA-6).** Zod 4 is a dependency already and checks the assistant's part props (`safeParsePartProps`, `shared/assistant-protocol.mjs`). It checks what a hand-written schema cannot, such as a real date; `z.toJSONSchema` gives the schema for a model step.
- **Tools keep their JSON Schema.** A tool step calls `runAiReadTool`, which checks the arguments (`validateAiToolArgs`) and the reader's access.
- **Four step kinds:** `tool` (one read tool, as the run's identity; its refs go to the run record), `code` (a pure function: cleaning, rules, checks), `model` (one provider call with no tools, always followed by a `code` check) and the end, which builds the card, the message draft or "nothing to do". Each output is checked against its Zod schema.

| Failure | Handling |
| --- | --- |
| `not_found`, `not_allowed`, `invalid_arguments` from a tool | Stop; the run fails with the code |
| `tool_failed`, a database timeout | Retry once, then stop |
| Model off, down, or over a cap | To a person, with the input and the manual form (#363 §4.9) |
| Model output fails its schema | Retry once, then to a person |
| A check fails for one value | That value to a person; the rest may be proposed |
| The owner lost the permission | The workflow pauses with the reason (#229 §4.6) |

### 3.2 Model calls

- **At most one tool-less call per run,** for extraction from outside text (#363 §4.4). It returns one object and cannot read, call or write.
- **Every value is checked in code** against the source text and the records (#363 §4.5). Confidence is the result of those checks, not a score the model gives. No judge model in v1.
- **Workflows over FlowChain's own records make no model call;** #229's A4 stands for them (WA-3).

### 3.3 Ending on Today

- **The card is a decision item** of the workflow's own kind (`supplier_reply_dates`), on its subject record, with the run id. Options are reused: `accepted` (confirmed), `not_needed` with a reason (dismissed), `not_now`.
- **New close rule.** `planDecisionSync` closes an item when its Today row goes away; a workflow card has no row. `syncTodayDecisions` would show open workflow cards as rows of their own and close them when decided or when the subject no longer qualifies (order closed, cancelled or received).
- **One card per record.** A reply on a chased `purchase_order_overdue` item becomes that item's proposal (#363 §4.2).
- **Who sees and decides:** the kind's permission (`DECISION_PERMISSIONS`) and Today's area rules (`todayHiddenWork`).

### 3.4 Example

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

export const supplierReplyDates = defineWorkflow({
  id: 'supplier_reply_dates',
  version: 1,
  trigger: { type: 'manual', input: PastedReply },   // inbound mail later (#363 SR-5)
  subject: 'purchase_order',
  permission: 'procurement.purchase_order.revise',
  limits: { costMicros: 50_000, modelCalls: 1, runsPerDay: 50 },
  steps: [
    { id: 'order', tool: 'get_purchase_order', args: (run) => ({ order: run.subject.number }), onError: 'stop' },
    { id: 'clean', code: cleanReply, output: CleanReply, onError: 'stop' },
    { id: 'read', model: { prompt: 'supplier_reply_v1', tools: false }, input: readingInput, output: ReplyReading, retries: 1, onError: 'to_person' },
    { id: 'check', code: checkReading, output: CheckedReading, onError: 'to_person' },
  ],
  end: supplierReplyCard,      // proposal, needs you, or nothing to record
})
```

## 4. Run log and metrics

### 4.1 The run record

One `WorkflowRun` row per run, steps as a JSON list:
- **workflow** id and version; **trigger** type with its period key or source (the pasted reply, the Today row key);
- **started by**: a person, or `schedule`, `event`, `inbound_mail`; **ran as**: the user whose permissions the reads used (§6.4);
- **steps**: kind, status, timings; for a tool, its name, an argument hash and refs; for the model, provider, model, prompt version, tokens, cost and the parsed output; for a check, each result;
- **cost** in micro-dollars, also counted in `AiUsageMonthly`;
- **outcome**: `proposal` or `needs_you` (a card was raised), `nothing_to_do`, `failed` (code), `skipped` (switch, cap); once a person acts, `confirmed_unchanged`, `confirmed_edited` (which fields), `dismissed` (reason), or `expired`;
- **links** to the decision item and to what the confirmed command wrote.

Everything else is codes and ids. Free text (an email, a note, the quotes in a parsed output) stays with its record as #363 §4.12 and DD-7 set out.

### 4.2 Touchless and correction rates

Per workflow version and period, over runs whose card a person decided:
- U: proposals confirmed unchanged; E: confirmed after an edit;
- R: dismissed as wrong ("Don't record: wrong reading" in #363);
- D: dismissed for another reason ("supplier will confirm later");
- H: sent to a person with no proposal ("needs you").

| Rate | Formula |
| --- | --- |
| Touchless | U / (U + E + R + D + H) |
| Correction | (E + R) / (U + E + R) |
| Hand-off | H / (U + E + R + D + H), the counterpart of Pallet's "about 5%" |

- **Outside every denominator:** runs with nothing to do, failed and skipped runs (counted apart), open cards, and cards that expired undecided.
- **D is outside the correction rate:** it says nothing about whether the proposal was right.

### 4.3 Corrections, evaluation and memory

| Pallet's loop | FlowChain | In scope |
| --- | --- | --- |
| A person handles the exception and gives a reason | A reason code and an optional note (`DECISION_NOTE_MAX`, 200 characters) | Yes |
| Reasons become cases | A script like `scripts/assistant-feedback-cases.mjs` turns edited and wrong runs into draft cases, on local research instances only | Yes |
| Backtest before rollout | A new version (prompt, checks, rules) runs over the cases offline and must pass its gate (for the first workflow, #363 SR-6) | Yes |
| Reasons become Memory that changes later runs | None | No |

Why no learned memory:
- **No version.** Memory changes output without a new version or an eval run, so a regression cannot be traced.
- **Lasting injection.** Memory built from supplier emails carries an outsider's text into later prompts.
- **Little data.** A small workspace makes a few corrections a month.
- **Research.** A study needs the same treatment across runs.
- **Later, safer:** a hint per supplier ("dates are day-first") proposed from corrections, as a setting a person confirms.

## 5. First workflow: supplier reply → promised date

The design is `docs/supplier-reply-dates-design.md` (#363, open). On §3's steps:

| # | Step | Kind | Uses | On failure |
| --- | --- | --- | --- | --- |
| 0 | Trigger | manual | Paste on the overdue card or the order page; inbound mail later | — |
| 1 | Read the order | tool | `get_purchase_order`: open lines, promised dates; prices removed before step 4 | Stop |
| 2 | Clean | code | #363 §4.3: drop the quoted chase and signature | Stop |
| 3 | Pre-check | code | `aiInjectionDetected`; a hit is shown on the card | — |
| 4 | Read | model | One tool-less call returning `ReplyReading` | To a person |
| 5 | Check | code | #363 §4.5: quote in the reply, stated date parses from it, line open, date in range | Per value, to a person |
| 6 | Stock effect | code | `aiStockProjection` (`ai-read-tools.mjs`) with the proposed dates; the `stock_projection` tool takes no dates | Card without it |
| 7 | End | — | Proposal, needs you, or nothing to record | — |

Confirming calls `POST /api/procurement/orders/:id/promised-dates` (`revisePromisedDates` in `procurement-db-command-service.mjs`, then `applyPromisedDateChanges`) as the person, with the supplier's sentence as the reason. FlowChain never replies to the supplier.

| SR | Question, in short | When |
| --- | --- | --- |
| SR-1 | Read replies: pasted first, inbound first, or not now? | Before building |
| SR-2 | One tool-less call, values quoted and checked in code, no chat tool? | Before building |
| SR-3 | A confirmed card writes promised dates only? | Before building |
| SR-4 | When to propose nothing and ask the person? | Before building |
| SR-6 | The gate: no hard fails, 90% of dated replies right? | Before building (the §4.3 gate) |
| SR-8 | Start steps 1 and 1e on approval? | Before building (the go-ahead) |
| SR-5 | Inbound mail with a per-message reply address? | Waits for a deploy |
| SR-7 | What is recorded: reply, outcome codes, a reliability measure? | Mostly waits: step 1 needs only the stored reply and §4.1's outcomes |

## 6. Safety

### 6.1 Prompt injection

- **Email text is data.** It reaches only the tool-less step, which cannot read, call or write. Our own quoted chase is removed first (#363 §4.3).
- **Values come back, not instructions:** line references from a given list and dates, each checked in code. Text addressed to the system is flagged on the card, never followed.
- **The server writes the card** from checked values, so it cannot claim an action. Model text shown to a person passes `checkAiModelFirstGrounding` and the action-claim check first.

### 6.2 Cost

- **Per run:** $0.05 by default, a quarter of the assistant's per-answer ceiling. A reading on Sonnet 5.5 at the meter's prices ($2 and $10 per million tokens) costs one to two cents.
- **Per workspace:** each run opens `runWithAiUsageScope` with `aiUsageRecorder`, so it counts against the same monthly cap, and `readAiWorkspaceAccess` is checked before the model step.

### 6.3 Rate limits

- 50 runs per workflow per workspace per day (as #363 §4.11); beyond that, runs are `skipped` and Today shows one row.
- Manual runs: a per-user limiter like `createAssistantV2RateLimiter` (30 per 10 minutes).
- Messages keep `SUPPLIER_EMAIL_LIMITS`. One open card per workflow and record.

### 6.4 Whose identity

| Option | For | Against |
| --- | --- | --- |
| The workflow owner | As #229 §4.2; checked each run; audit names a person | Reads use the owner's scope |
| A service identity with a role | Survives staff changes | Does not exist; audit without a person; a role to keep narrow |
| The person who confirms | Writes carry their name | Nobody is there when a schedule fires |

**Recommendation (WA-7):** reads run as the owner, resolved again each run (`resolveAuthorizationContext`, `server/auth/authorization-service.mjs`); a lost permission pauses the workflow. Every write runs as the person who confirms, through the existing command and its permission check.

### 6.5 Audit and off switches

- **Audit:** the run record, plus the `AuditLog` rows the confirmed command and any sent message already write.
- **Switches:** per workflow; per workspace, beside `ai.modelAssistEnabled` and `review.supplierFollowUpEmail` (`workspace-settings-contract.mjs`); and a `FLOWCHAIN_WORKFLOWS` environment flag. With AI off, model steps go to a person.
- **Auto-pause** after 3 runs in a row whose cards were all dismissed as wrong (#229 A6).

### 6.6 What always needs a person

Pallet's list is covered because every write needs a person. A run never sends to a supplier or customer (a person sends, after DD-9's two confirmations); creates, submits or approves a document; changes dates, quantities, prices, master data or settings; or posts, pays or deletes.

## 7. Build steps and decisions

### 7.1 Build steps

One PR each, green CI. Sizes in working days.

| Step | Delivers | Size | Deploy |
| --- | --- | --- | --- |
| W1 | `WorkflowRun` table; `defineWorkflow`; tool, code and model steps; a run as a user via `loadAiSkillContext`; usage scope; `scripts/run-workflows.mjs --once` | M, 4–5 | No |
| W2 | Workflow cards as decision items: kinds, close rule, Today rows, reasons; outcomes on the run | M, 3–4 | No |
| W3 | The first workflow: #363 steps 1 and 1e on W1–W2, with the reply cases and gate | L, 7–8 | No |
| W4 | The §4.2 rates per version; corrections to draft cases | S, 1–2 | No |
| W5 | The in-process scheduler: claim, catch-up, period keys, switches, caps, auto-pause | M, 3 | No |
| W6 | Hourly Today-row triggers; #229's notify-only templates as workflows | M, 3–5 | No |
| W7 | Inbound mail as a trigger (#363 step 3) | M, 4–5 | Yes |

W1–W4 are useful on the public-data workspaces with no scheduler and no deploy.

### 7.2 Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| WA-1 | Direction: (a) fixed-step workflows ending in a card or a person-sent message; (b) the assistant loop unattended; (c) not now | (a) |
| WA-2 | #229 A2 lets the reorder template write draft requests | Amend: the run leaves a card; drafts are created when a person confirms |
| WA-3 | #229 A4: no model call in runs | Keep for workflows over our records; allow one tool-less extraction step where a workflow reads outside text |
| WA-4 | Where runs execute | The web process, claiming run rows with `FOR UPDATE SKIP LOCKED`; no pg-boss, graphile-worker or Trigger.dev now |
| WA-5 | Event triggers | Hourly reads of Today's rows, manual runs and pastes; inbound mail with SR-5 |
| WA-6 | Step contracts | Zod per step; tools keep JSON Schema |
| WA-7 | Identity | Reads as the owner, checked each run; writes as the confirming person; no service identity |
| WA-8 | Ending on Today | A decision item of the workflow's kind with its own close rule, joined to a live item on the same record |
| WA-9 | Metrics | The §4.2 rates; codes only; text for research on public-data workspaces only (DD-7) |
| WA-10 | Memory | Corrections become eval cases and gate each version; no learned memory |
| WA-11 | Guards | $0.05 per run, 50 runs per workflow per day, three switches, auto-pause after 3 rejected runs |
| WA-12 | First workflow and order | Supplier reply → promised date as W1–W4, locally; W5–W6 next; W7 with a deploy |
