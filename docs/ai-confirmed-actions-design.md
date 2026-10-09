# Assistant actions: propose, confirm, execute (track C): design

Status: proposal, 2026-10-05, for the owner's review. This is track C of that day's AI
direction. The owner approved its decisions 3-6 the same day:
- v1 actions: create a purchase request, and create an RFQ from an approved one;
- supplier email is a later step;
- confirmation is a preview card in the chat, and the form stays the route to edit first;
- the old "AI creates no real records" promises are updated.

This design turns those into a build plan. It asks decisions A1-A8 in
[§12](#12-decisions-for-the-owner). Written against main at `3121b74` (#122 merged);
line numbers refer to that commit.

Related:
- the prefill design (`docs/ai-prefill-autocomplete-design.md`, PR #116), whose
  decision 10 opens a filled-in purchase request when asked for an order;
- the agent mode design (`docs/ai-agent-mode-design.md`, PR #108);
- AI per workspace (`docs/ai-workspace-access.md`, PR #150).

## 中文摘要

- **目标**：让助手能替你做事，但每一步都由人确认。分三步：
  - 助手提出（propose）一份完整的预览；
  - 你在聊天里点一次"确认"（confirm）；
  - 系统用你自己的权限执行（execute）已有的业务命令。
- **原则**：模型理解和提议；系统提供事实并执行；人确认。
  - 模型不提供数字或记录，不自己执行，也没有"确认"这个工具。
  - 确认只能来自你在页面上的一次点击。
- **现状：比预想的近。** 两个 v1 动作的业务命令都已存在，带幂等键、带审计：
  - 新建采购申请，新单是"草稿"状态；
  - 从已批准的申请创建询价，询价也是"草稿"，不会发给供应商。
  - 缺的只是助手和它们之间的连接。
- **现在断在哪里：**
  - **字段不全。** 助手的采购申请卡片只带 SKU、数量和原因。服务器要求每行都有供应商、单价和需求日期，所以不能直接提交给命令。表单的预填函数能补齐这些字段，服务器可以复用它。
  - **重复采购的风险（现有缺陷）。** 助手只把"已提交"的申请算作覆盖短缺，"草稿"和"已批准未下单"的申请都不算。助手能建草稿以后，再问一次就会再建一张。v1 一起修复。
  - **"提交"没有被拒绝（现有缺陷）。** 中文的"提交"不在拒绝动词表里，英文的 submit 在。
  - **旧接口要下线。** `/api/user-confirmed-actions` 没有权限检查，只写假记录，也没有页面调用它。建议删除。
- **设计要点：**
  - **预览存在服务器上**（复用现有的 ActionDraft 表）。确认时执行的正是你看到的那份，浏览器不能改。只能用一次，24 小时后过期。
  - **每个值都标明来源：** 你的问题、短缺计算、物料主数据。缺供应商或你看不到的单价时，卡片不给"确认"，只给"在表单中编辑"（已批准的方向决定 5）。
  - **一次确认只创建一张草稿申请。** 不提交、不审批、不下单。连点两次也只有一张。
  - **询价：** 只针对已批准、还没有询价或采购单的申请。邀请的供应商是该物料的已批准供应商，什么都不发出。
  - **重新检查：** 只有收到预览的人能确认，且在确认时再查一次权限和数据。
- **不做：** 提交、审批、下达采购单、发邮件、打开询价（邀请供应商）、付款、删除、批量创建。
- **工作量：**
  - C1，采购申请：约 3–4 人日；
  - C2，询价：约 2 人日；
  - C3，模型提议工具：约 1–2 人日，在 #144 合并后做。
- **需要你决定（[§12](#12-decisions-for-the-owner)）：** A1–A8，均附推荐。

## Summary

- **Problem.** The owner's words: "it cannot do things for me". Today the assistant
  prepares drafts and opens filled-in forms, but every record is still typed and saved
  by hand.
- **Finding.** Both v1 actions already exist as idempotent, audited commands, and both
  create a draft:
  - `createPurchaseRequest`, `server/services/procurement-request-command-service.mjs:202`;
  - `createRfqFromPurchaseRequest`, `server/services/procurement-request-command-service.mjs:326`.

  Nothing the assistant produces reaches them yet.
- **Recommendation.**
  - The server turns an answer's draft into a complete proposal and stores it.
  - The chat shows it as a card with every value and its source.
  - One click on Confirm runs the existing command with the user's own session and
    permission.
  - The result is a draft purchase request or a draft RFQ, never more.
- **Invariants:**
  - facts come from records;
  - the user sees every value before anything is written;
  - one click writes one draft;
  - nothing is submitted, approved, issued, sent or paid;
  - the model never confirms.

## 1. What exists today

### 1.1 The two commands

| | Create a purchase request | Create an RFQ from a purchase request |
| --- | --- | --- |
| Route | `POST /api/procurement/requests` (`server/routes/procurement-workflow.routes.mjs:74`) | `POST /api/procurement/requests/:id/rfqs` (`server/routes/procurement-workflow.routes.mjs:88`) |
| Permission | `procurement.purchase_order.revise` (`procurement-request-command-service.mjs:25-38`); the catalog has no purchase request code | The same |
| Preconditions | At least one line. Every line has an active supplier approved for the item, a quantity above 0, an explicit reference price and a need-by date (`server/domain/procurement-workflow.mjs:62-173`) | The request is `approved`, `expectedVersion` matches, and no active RFQ or purchase order exists for it (`procurement-request-command-service.mjs:311-320`) |
| Writes | A `PurchaseRequest` in `draft`, `source: "manual"` (:225-228) | An `Rfq` in `draft`, its lines, and a `planned` participation per invited supplier. The request stays `approved` and gets `linkedRfqId` (:349-361) |
| Idempotency | `BusinessCommandExecution`, unique on tenant, command type and key (`prisma/schema.prisma:3188-3205`). The same key and payload replay the first result; a different payload gets 409. Without a key, each call creates a new request (:220) | The key is derived from the request id, version and payload |
| Audit | `purchase_request_created`, with the prefill suggestion trail (:234) | `rfq_created_from_purchase_request` (:363) |
| Sends anything? | No | No. Even opening an RFQ only sets participations to `invited_internal` |

A draft request can be cancelled (`draft → cancelled`,
`server/domain/procurement-status-authority.mjs:137-144`), so a mistaken confirm has
a plain undo on the request's own page.

### 1.2 What the assistant does today

- **Draft cards.** Answers carry review-only draft cards (`server/domain/ai-skill-drafts.mjs:89-121`), each with `previewOnly`,
  `requiresHumanReview` and `prohibitedActions`. The purchase request card's payload is
  only `{ itemIdOrSku, quantity, reason, language }` (`server/domain/ai-skill-start-order.mjs:114`).
- **Opening the form.** "Order 200 of LDM-001" opens the purchase request form (decision 10, `ai-skill-start-order.mjs:212`;
  `src/modules/ai-assistant/Panel.tsx:758`). The form fills supplier, price, warehouse
  and date with `planPurchaseRequestPrefill` (`shared/purchase-request-prefill.mjs:25-86`):
  - each value carries its source;
  - the supplier list comes from `GET /api/master-data/items/:id/suppliers`, with
    prices masked for the reader (`server/routes/master-data.routes.mjs:384-397`).
- **Prefill audit.** On save, the form records which suggestions were kept, edited or
  cleared, in the `purchase_request_created` audit metadata.
- **Who can draft.** Draft cards appear only for users with `procurement.purchase_order.revise`
  (`AI_SKILL_DRAFT_PERMISSION`, `server/domain/ai-skill-registry.mjs:32`).
- **Refusals.** Approve, pay, send, issue, cancel and similar requests are refused
  (`server/domain/ai-skill-router.mjs:129-131, 263, 357`).

### 1.3 Pieces that look reusable

- **`ActionDraft`** (`prisma/schema.prisma:918-940`): `status` (default `preview`),
  `requiresConfirmation`, `previewOnly`, `payload`, `originEvidence`, `createdById`,
  plus validation and audit-trail child tables.
  - Only text drafts are saved there today.
  - `confirmDraft` is a placeholder that returns 501 (`server/repositories/db-action-draft-repository.mjs:159-164`).
  - `server/domain/action-draft-boundary.mjs:9,16` already names the future confirmations:
    `create_purchase_request` and `create_rfq`.
  - This design uses this table.
- **`/api/user-confirmed-actions`** (`server/routes/user-confirmed-actions.routes.mjs`,
  `server/domain/user-confirmed-business-action.mjs`). It looks like the same idea, but:
  - it writes `RuntimeRecord` rows with made-up `PR-DRAFT-…` ids, not real requests;
  - it checks sign-in but no permission;
  - nothing in the frontend calls it.

  This design does not use it, and A7 proposes removing it.

### 1.4 Gaps this design closes

1. **The proposal is incomplete.** The card lacks supplier, price and date. The command
   rejects such a request (`LINE_VALUE_REQUIRED`). The form's prefill planner already
   computes them, and it lives in `shared/`, so the server can call it.
2. **Double ordering (an existing defect).** The assistant counts a request as covering
   a shortage only while it is `submitted` (`server/domain/ai-skill-readers.mjs:315`;
   `server/domain/ai-skill-signals.mjs:73`). A `draft` request, or an `approved` one not
   yet turned into an order, is ignored, so the assistant can already propose a second
   request for the same item. Once it can create drafts itself, this would happen on
   the very next question.
3. **"提交" is not refused (an existing defect).** "submit" is in the English verb list,
   but 提交 is missing from the Chinese one (`ai-skill-router.mjs:131`).
4. **The assistant cannot see approved requests that still need sourcing.** It reads
   only submitted requests, so it has nothing to offer an RFQ for.

## 2. The rule

The balance the owner accepted on 2026-10-05: **the model understands and proposes; the
system supplies the facts and executes; a person confirms.**

| Step | Who | What it may do | What it may not do |
| --- | --- | --- | --- |
| Understand | Rules; the model only when AI is on for the workspace (#150) | Pick the action; read the item, quantity, supplier and date the user named | Invent a value the user did not say and no record holds |
| Propose | The server | Fill every field from records and master data; check it with the command's own validation; store the proposal | Write a business record |
| Confirm | The person | Click Confirm on the card, after seeing every value | Be done by the model, a link, a timer or another user |
| Execute | The server, as that person | Run the existing command with their session, permission and an idempotency key | Submit, approve, issue, send, or do anything the card did not show |

## 3. User journeys

### J1 "Order 200 of LDM-001" / "帮我建一个 LDM-001 的采购申请，200 个"

1. **The answer leads with the position.** Its first sentence states what is on hand and
   on order (decision 10 wording, unchanged).
2. **The card shows every value with its source.** Title: "Create a draft purchase
   request" / "创建采购申请草稿". Its values, each labelled with where it came from:

   | Field | Value | Source |
   | --- | --- | --- |
   | Item | LDM-001 | your question |
   | Quantity | 200 | your question |
   | Supplier | the preferred supplier | the item's approved suppliers |
   | Reference price | from the item's supplier terms | master data |
   | Warehouse | the item's default | master data |
   | Need by | today plus the supplier's lead time | master data |
   | Note | the reason | the shortage calculation |

3. **Two buttons.** **Create draft request** is primary; **Edit in form** opens today's
   prefilled form.
4. **Confirm.** The card becomes "Created PR-7F3A2C1D as a draft. It is not submitted.
   Open it to submit for approval." with a link. The request's page shows "Created
   from the assistant".
5. **Nothing more happens.** Nothing is submitted; approval still follows the normal
   flow.

### J2 "What should I order today?"

- **The answer lists the shortages.** Each line states its next step, as today
  (#122).
- **A complete line gets a confirmable card.** The card is the J1 card.
- **An incomplete line opens the form.** The card offers only Edit in form.
- **At most three cards per answer** (the existing limit).

### J3 Values missing or hidden

- **No approved supplier, or no reference price.** The card shows the gap and offers
  only **Edit in form** (approved direction decision 5). For example: "LDM-001 has no reference
  price for Acme. Add it in the form."
- **A price the user cannot see.** The supplier read masks prices the user may not see,
  so the card treats the price as missing and does not reveal it.

### J4 Already covered

- **An open order or request covers the shortage.** The answer says which, first, and
  proposes nothing (decision 10). With gap 2 fixed, draft and approved requests count
  as cover. For example: "PR-1A2B is a draft for 200; submit it."
- **"Order anyway" / "仍然新建".** This still gives a card.

### J5 "Create an RFQ for PR-1A2B" / "这个申请发起询价"

- **An approved request with nothing downstream.** The card lists:
  - the request's lines;
  - the invited suppliers (A5);
  - the due date (the request's need-by date).

  Confirm creates RFQ-… as a draft. The card says that nothing is sent to suppliers,
  and that the RFQ page opens it when the user is ready.
- **Not approved yet.** The answer says the RFQ comes after approval, with a link to the
  request. No card.

### J6 Refused

- **"Submit it", "approve PR-1A2B", "issue the PO", "提交这张申请".** These are
  refused as today. 提交 is now included.
- **A link instead.** The refusal links to the record, where the user does it
  themselves.

### J7 Retries and races

- **Double click, two tabs, or a network retry.** The same proposal has the same
  idempotency key, so the command replays and the card shows the same PR id.
- **Stale or used proposal.** It is expired, used, or the request changed since the
  preview (RFQ version check). The card says "This preview is out of date" and offers
  to prepare it again.

## 4. Propose

### 4.1 Where each value comes from

| Field | Source, in order | Never from |
| --- | --- | --- |
| Item | The item the question names, resolved to a real, active, purchasable item the user can see; or the answer line's item | The model's free text |
| Quantity | The number in the question; else the shortfall (`ai-skill-start-order.mjs` plan); raised to the supplier's minimum order quantity, labelled | A number neither the user nor a record gave |
| Supplier | A supplier the question names, if it is an approved source for the item; else the preferred approved supplier; else the first approved one (`planPurchaseRequestPrefill`) | A supplier not approved for the item |
| Reference price | The chosen supplier's reference price, as the user is allowed to see it | Price history (prefill decision 6) |
| Currency | The supplier's, else the workspace's | |
| Warehouse | The item's default warehouse | |
| Need-by date | A date the question names; else today plus the supplier's lead time | |
| Note | The answer's reason sentence, in the answer language | |

The server calls the same planner the form uses. The form and the card therefore never
disagree, and **Edit in form** opens the same values.

### 4.2 Complete or not

The server runs the command's own line validation, `canonicalPurchaseRequestLines`, as a
dry run. If it passes, the card can be confirmed. If not, the card lists the missing
fields and offers only Edit in form.

### 4.3 The proposal record

Each confirmable card is stored as an `ActionDraft` row:
- `type`: `purchase_request_draft` or `rfq_draft`;
- `status`: `proposed`, then `confirmed`, `failed` or `expired`;
- `source`: `ai_assistant`;
- `createdById`: the user who asked;
- `payload`: the exact command input;
- `originEvidence`: the answer line's records;
- an expiry 24 hours ahead (in `payload`, so no schema change).

The card carries only the proposal id and the values to display. If the row cannot be
written, for example in a JSON-mode workspace, the card degrades to Edit in form.

Proposal cards are never served from a reused or cached answer. A reused answer
prepares its proposals again.

### 4.4 Coverage first

Before proposing, the shortage check counts requests in `draft`, `submitted` and
`approved` (not yet converted) as pending quantity:
- the readers list them;
- the signals sum them;
- the answer names them.

A draft request yields the next step "submit PR-…". An approved one yields "turn PR-…
into an order or an RFQ".

## 5. Confirm and execute

### 5.1 Endpoint

`POST /api/action-drafts/:id/confirm`, the placeholder that returns 501 today. Its body
is empty. Everything to execute is already on the stored proposal, so the browser
cannot change what runs.

### 5.2 Checks, in order

1. The user is signed in. The tenant comes from the session, never from the body.
2. The proposal exists in that tenant and was proposed to this user (`createdById`).
   Otherwise the response is 404, without saying whether it exists.
3. The status is `proposed` and the proposal has not expired. Otherwise 409
   `PROPOSAL_NOT_OPEN`, and the card says it is out of date.
4. The server flag allows actions (A6). Otherwise 403 `AI_ACTIONS_OFF`.
5. The server runs the command as the user, through `ctx.repositories.procurementRequests`:
   - the command itself checks the permission;
   - it re-validates every line against current master data;
   - its idempotency key is `ai-proposal:<proposal id>`.
6. On success, the proposal becomes `confirmed`, with the record id. The audit gets
   `ai_action_confirmed` (proposal id, record id, action and reason codes only; no
   question or model text, agent mode decision 9). The command adds its own
   `purchase_request_created` or `rfq_created_from_purchase_request`.
7. On a command error (an inactive supplier, a version conflict, a lost permission), the
   proposal becomes `failed` with the error code. The card shows the error in the
   answer language and offers Edit in form.

### 5.3 Marking the record

The command accepts `source: "ai_assistant"` from an allow-list. Its default stays
`manual`. The request and RFQ pages show "Created from the assistant", and the
suggestion trail records every value as accepted from the proposal (A4).

### 5.4 Undo

The assistant never cancels. The success card links to the draft, which can be
cancelled there by anyone allowed to (`draft → cancelled`).

## 6. RFQ from an approved request (phase C2)

- **Facts.** The readers add `purchaseRequests.toSource`: approved requests with no
  `linkedRfqId` and no active order.
- **Signal.** It becomes the signal `pr_approved_unsourced`, whose next step is "source
  PR-…".
- **When a card appears.** An RFQ card appears when the user asks for an RFQ or 询价, or
  on that signal's line.
  - Choosing between an RFQ and a direct draft order stays with the person.
  - The draft order action stays on the request page; it is not part of v1.
- **Invited suppliers (A5).** The approved suppliers of the request's items, preferred
  first, at most five; the card lists them.
  - The RFQ page can change them before opening.
  - Participations stay `planned`, and nothing is sent.
- **Version.** `expectedVersion` is the request version the proposal saw. A change since
  then gets `VERSION_CONFLICT`, and the card is out of date (J7).

## 7. Where the model fits

- **Rules cover v1.** Phase C1 needs no model: the rules already recognise order
  requests (`aiSkillOrderRequest`) and draft requests.
- **The model proposes (phase C3).** After agent planning (#144) merges, with AI on for the
  workspace, the model gets two proposal tools:
  - `propose_purchase_request {item, quantity?, supplier?, needBy?}`;
  - `propose_rfq {purchaseRequest}`.
- **The server checks every argument.**
  - The item, supplier and request must resolve to real records the user can see.
  - A quantity or date must appear in the user's question, as for P2's tier argument.
  - The tool result is the same stored proposal and card.
- **There is no confirm tool.** A model output can never write. The only path to the
  confirm endpoint is the user's click, with their session.

## 8. Safety

| Risk | Control | Where |
| --- | --- | --- |
| The model writes something | No write tool and no confirm tool. Confirm is an HTTP call from a click | §5, §7 |
| The browser changes what is confirmed | The payload lives on the server; the confirm body is empty | §5.1 |
| Someone else confirms my proposal | `createdById` must match; 404 otherwise | §5.2 |
| A user does more than the form allows | The same command, permission and validation as the form | §5.2 step 5 |
| Double creation | One idempotency key per proposal; single-use status | §5.2, J7 |
| Ordering what is already on order | Coverage counts draft, submitted and approved requests and open orders | §4.4 |
| Stale data | Re-validated at confirm; the RFQ version is checked; 24-hour expiry | §5.2 |
| Revealing hidden prices | Prices come through the reader's masked supplier read; a hidden price counts as missing | J3 |
| Instructions hidden in documents | Values come from records and the question, never from retrieved passages; the person sees every value | §4.1 |
| A runaway | One click per record; at most three cards per answer; a server flag to switch actions off | §5, A6 |
| Accidental confirm | The button needs a click; Enter in the chat never confirms; the card says "draft, not submitted" | §9 |

## 9. Wording and promises

### 9.1 Still true, pinned by tests, unchanged

- **The refusal summary.** "I can't approve, pay, send, issue, cancel or delete
  anything" (`server/domain/ai-skill-copy.mjs:118`). Creating a draft is in none of
  those words.
- **The panel line.** "Nothing is submitted, sent, posted or paid" (`src/modules/ai-assistant/Panel.tsx:447`).
- **The order summary.** "nothing is saved or submitted until you do" (`ai-skill-copy.mjs:204`):
  the confirm click is "you do".
- **The final-closure boundaries.** 不自动审批 and 不自动下单
  (`server/domain/final-product-closure.test.mjs`). No order is placed automatically,
  and a draft request is created only on the user's click.
- **`writesBusinessData: false` on every skill** (`server/domain/ai-skill-registry.mjs:90,144`).
  The skills stay read-only. The two actions are a separate, tested list, and the
  registry test pins it to exactly these two commands.
- **The forbidden-terms check.** No doc may say, un-negated, that the AI "正式创建 PR" or
  "下发 PO". This design and its build use "创建采购申请草稿".

### 9.2 Changing with C1

These sentences say the assistant never creates a record. They become "creates a draft
only when you confirm its preview; never submits, approves, sends or pays".

- `README.md` lines 3, 31 and 124;
- `docs/ai-safety-and-draft-first-explainer-v1.md:55-59, 101`;
- `docs/draft-first-action-boundary-v1.md:5, 74`, and the disabled confirm button in its
  "Review UI Shell" section;
- `docs/purchase-request-draft-preview-v1.md`, `docs/rfq-and-supplier-followup-draft-preview-v1.md`,
  `docs/current-development-limitations-v1.md:24-25`, `docs/architecture-overview-v1.md:126`;
- UI copy: `src/app/FlowChainApp.tsx:132` ("No business document was created."), the
  action draft review shell, and the panel's empty-state line;
- the code comments that state the old boundary (`ai-skill-start-order.mjs`,
  `ai-skill-drafts.mjs`, `ai-skill-registry.mjs`, `structuredDraftHandoff.ts`).

### 9.3 When

- **This design PR does not rewrite those sentences.** Main does not create anything
  yet, so changing them now would be untrue. It adds a "Planned change" note, linking
  here, to the two boundary docs.
- **The C1 build PR rewrites them,** in the same change that makes them true.
- **The interface language rule applies.** New copy is English first, with Chinese
  through the existing i18n (`AGENTS.md`).

## 10. Tests and measurement

- **Unit tests:**
  - every field's source;
  - complete versus incomplete;
  - coverage counting draft and approved requests;
  - 提交 refused;
  - the action list pinned to two commands.
- **PostgreSQL tests** (`tests/postgres/ai-confirmed-actions.test.mjs`):
  - **Confirm once.** Confirm creates exactly one draft request; a second confirm
    replays it.
  - **Proposals do not leave their owner.** Another user gets 404, and another tenant
    gets 404.
  - **The record must still match.** An expired proposal gets 409. A supplier
    deactivated after the preview fails with the command's code. A request approved
    and changed after the preview gets `VERSION_CONFLICT`.
  - **The user must still be allowed.** A user who lost the permission gets 403.
  - **The server flag holds.** With the flag off, nothing is proposed or confirmed.
  - **The audit holds no text.** It holds no question or model text.
- **Eval cases** (`tests/ai-eval/questions.json`, category `action`), English and
  Chinese:
  - a complete proposal;
  - an incomplete one, form only;
  - covered by a draft request;
  - submit refused;
  - an RFQ for an approved request;
  - an RFQ asked for a submitted one;
  - a user without the permission.
- **Browser spec.** Confirm on the card, then the request page shows the draft and
  "Created from the assistant".
- **Measures, from the audit:**
  - proposals shown, confirmed, edited in the form, failed by code, expired;
  - confirmed drafts later submitted or cancelled.

  Cancelled drafts are the signal that proposals are wrong.

## 11. Phased plan

| Phase | Scope | Size | Depends on |
| --- | --- | --- | --- |
| C0 | This design | — | — |
| C1 | Purchase request: complete proposals, the stored proposal, confirm, the source mark, the coverage fix, 提交 refused, the wording, removing `/api/user-confirmed-actions` | 3-4 days | A1-A8 decided |
| C2 | RFQ from an approved request: the facts, the signal, the card, confirm | about 2 days | C1 |
| C3 | Model proposal tools in agent planning | 1-2 days | #144, and #150 for the trial site |
| Later | Supplier email (approved direction decision 4): its own permission, the platform mail channel and a rate limit | separate design | C1 |

C1 fits the integration week. It needs no model and no provider, so it can be part of
the trial on 10/25 for every workspace, AI switch on or off.

## 12. Decisions for the owner

A for actions; the build phases are C0-C3 ([§11](#11-phased-plan)).

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| A1 | Where a proposal lives until it is confirmed | On the server, in the existing `ActionDraft` table; single use; 24-hour expiry | Confirm runs exactly what was shown, with no signing keys to manage, and the proposal-to-record link feeds the measures. The alternative, a signed token in the card, writes nothing until confirm but cannot be revoked or measured |
| A2 | Who may confirm | Only the user it was proposed to, with their own permission (`procurement.purchase_order.revise`, as the form); no new permission code | The click equals pressing Save on the form, so the same permission. A new code needs a constraint migration (`procurement-request-command-service.mjs:20-24`) for no new protection |
| A3 | Auto-open (decision 10) when the proposal is complete | Show the card with Confirm and do not open the form; still open the form when a value is missing | One click finishes the job; opening the form as well would ask for the same decision twice. Edit in form stays one click away |
| A4 | Mark what the assistant created | `source: "ai_assistant"` and a "Created from the assistant" note on the request and the RFQ | People can see and filter what came from the assistant, and the measures can count cancellations |
| A5 | Suppliers invited to an RFQ | The approved suppliers of the request's items, preferred first, at most five; editable on the RFQ page; nothing sent | Uses only approved sources, and the RFQ stays a draft until a person opens it |
| A6 | How to switch actions off | A server flag, `FLOWCHAIN_AI_ACTIONS`, on by default; no workspace switch in v1 | Actions need no model and do nothing the user's permission does not already allow. The workspace AI switch (#150) governs the model, not the clicks |
| A7 | `/api/user-confirmed-actions` | Remove it in C1 | No permission check, made-up records, no caller; keeping it beside the real confirm path invites mistakes |
| A8 | When the "never creates records" wording changes | With the C1 build, not in this design PR; this PR only adds a "Planned change" note | Main should never claim what it does not do |
