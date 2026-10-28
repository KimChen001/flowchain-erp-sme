# Assistant prefill and autocomplete: design

Status: design, 2026-10-03. The owner approved decisions 1-8 in [§9](#9-decisions-for-the-owner)
as recommended the same day. Decision 9 (P3) is open. Written against main at `a783fd4`
(PR #113 merged); line numbers refer to that commit.

P1 is built, in four PRs (2026-10-04, open):
- #119: the purchase request form opened from the assistant, source labels, the
  suggestion trail;
- #120: supplier message drafts reviewed as a message, with "Open in email";
- #122: a next step and a draft on every answer line, drafts as letters. It needs #118;
- #124: new receipts and first supplier quotes prefilled from their records.

Merge order: #118, #119, #120, #122; #124 after #119.

Decision 10 (the assistant opens the purchase request form by itself when asked for an
order) was approved on 2026-10-04 and is built in #125, stacked on #119. See
[J3](#j3-raise-a-purchase-request-for-a-short-sku).

Related: the agent mode design (`docs/ai-agent-mode-design.md`, PR #108). This design
gives a model no new decision until its optional phase 3, and phase 3 reuses the agent
mode verifier instead of adding a second one ([§7](#7-fit-with-agent-mode)).

## 中文摘要

- **目标**：每条助手回答都是一个入口。它说明下一步该做什么，一键打开预填好的草稿或表单，并在表单里像代码补全那样用用户自己的历史补全。目的是少打描述性文字，少做重复录入。
- **现状**：助手已经能为三种情况准备草稿：逾期采购单跟进、发票差异询问、短缺 SKU 的采购申请。但这些草稿走到一半就断了：
  - 只有问题里出现"草稿/消息/新建"等字样时才显示草稿按钮；
  - 文本草稿只能复制或"保留待复核"，没有收件人，消息只有一行，确认按钮是禁用的；
  - 采购申请交给表单时只带过去 SKU 和数量，原因和需求日期丢了，行备注被写死成一句中文；
  - 询价草稿跳转的目标页面根本没有挂载，所以询价预填现在不起作用；
  - 任何表单字段都没有自动补全，没有 Tab 接受，也不记住用户填过的值；
  - 系统不发送、也不记录发给供应商的消息，所以"上次发给这家供应商的消息"现在无从取得。
- **顺带发现的缺陷**：多行采购单的跟进消息把整张单的剩余数量写在第一行的 SKU 名下，数量和 SKU 对不上。
- **建议**：分四期。前两期不用模型，事实全部来自确定性读取，用户复核每一份草稿，系统不自动提交。
  - **P1：先把草稿接通，不用模型，约 8–10 人日。**
    - 回答里每条可处理的记录都写明下一步，并给一个草稿按钮。
    - 草稿和表单的预填值来自记录字段和主数据默认值，每个字段标明来源。
    - 修好采购申请和询价的交接。
    - 提交时记录哪些字段采纳了建议，只记来源代码和计数，不记文本。
    - 评测加 `prefill` 类别。
  - **P2：表单内历史补全，不用模型，约 10–13 人日。**
    - 用你本人的历史值和字段模板，以灰色提示显示，Tab 接受，Esc 忽略。
    - 新增"记录已发送"，保存发给供应商的跟进消息，以后可以复用。
  - **P3（可选）：描述性文字的模型补全。** 只用本地 Parley，默认关闭。数字、编号、日期由服务器填槽并校验。和 agent mode 决定 4 一起决定。
  - **P4（可选）：** 同事的结构化历史值，以及移动端优化。
- **决定（[§9](#9-decisions-for-the-owner)）**：2026-10-03 已按推荐批准 1–8，P1 开始实施；决定 9（P3）待定。
- **决定 10（2026-10-04 批准，#125）**：用户让助手"生成订单/下单"且目标明确时，助手直接打开预填好的采购申请，不保存也不提交。已有在途订单或待审批申请覆盖缺口时不自动打开，回答第一句先说明已有哪些在途订单，再给"跟进 PO"和"仍然新建"两个按钮，避免用户困惑和重复采购。

## Summary

- **Problem.** The assistant already makes review-only drafts for three cases, but each
  stops halfway. The draft buttons are hidden unless the question asks for a draft. Text
  drafts can only be copied. The purchase request handoff drops most fields, and the RFQ
  handoff lands on a page that is never mounted. No form has autocomplete, and nothing
  records what was sent to a supplier.
- **Recommendation.** Four phases. The first two use no model.
  - **P1, land the drafts.** Each answer line states its next step and offers a draft.
    Prefills come from the record and from master data, and each field is labelled with
    its source. Accepted suggestions are audited as codes. This is the smallest useful
    phase.
  - **P2, history autocomplete.** Ghost text from the user's own history and field
    templates: Tab accepts, Esc dismisses. A "Log as sent" follow-up log makes the last
    message to a supplier reusable.
  - **P3, optional model completion** for descriptive text only. Local, off by default,
    and every fact goes through a verified slot.
  - **P4, optional.** Workspace-wide structured history, and mobile polish.
- **Invariants in every phase.** Facts come from deterministic reads. The user reviews
  every draft. Nothing is submitted or sent automatically. Every suggestion names its
  source.

## 1. What exists today

| Piece | Where | Today | Gap |
| --- | --- | --- | --- |
| Draft cards | `prepare_action_draft`: types `server/domain/ai-skill-prepare-action-draft.mjs:14`, candidates `:19-37`, cards `:59-81` | Up to 3 review-only cards: `po_followup_draft`, `supplier_followup_draft` (invoice variance) and `purchase_request_draft`. The quantity is the target minus available, incoming and pending (`:29-30`). | Only this skill makes cards. `purchase_orders`, `today_priorities`, `supplier_attention` and the others only link. |
| Card wording | `server/domain/ai-skill-copy.mjs:167-174` | English and Chinese templates filled from facts. The invoice amount is left out without permission (`:172`). | One sentence, no recipient, no subject |
| Facts behind a PO card | `readAiSkillFacts`, `server/domain/ai-skill-readers.mjs:168-233` | Masked per actor | **Defect:** `remaining` is summed over every line (`server/domain/open-purchase-orders-report.mjs:44`), but `sku` is the first line's (`ai-skill-readers.mjs:221,233`). A two-line PO's message names one SKU with both lines' quantity (`ai-skill-prepare-action-draft.mjs:65-66`). |
| Card to button | `src/domain/ai/focused-response.ts:69-83` | Draft buttons show only when the question matches 草稿, draft, 消息, 新建 and similar words (`:81-82`) | Answers are not entry points by default |
| Text drafts | `src/components/ai/AiResponseV2Renderer.tsx:77-80`, then `src/app/FlowChainApp.tsx:952-991`, then `POST /api/action-drafts/preview`, then `src/modules/action-drafts/ActionDraftReviewShell.tsx:173-391` | Single-line inputs only (`:333`). Actions are Copy and "Keep draft for review" (`FlowChainApp.tsx:993-1010`). Confirm is disabled (`docs/draft-first-action-boundary-v1.md`). | No To or Subject, no multi-line message, no record that it was sent |
| Structured drafts | `AiResponseV2Renderer.tsx:95-116`, `FlowChainApp.tsx:953-969` | Navigate with the query `mode, itemId, sku, quantity, reason, suppliers, due` | The PR form reads only `itemId`/`sku` and `quantity` (`src/modules/purchase-requests/CanonicalProcurementPanel.tsx:196,206`) and writes a fixed Chinese line note (`:234-235`). The RFQ target `CanonicalDownstreamPanel` is mounted only by `src/modules/rfq/Page.tsx:45`, which nothing imports. The live view is `RfqListPage` (`src/modules/procurement/Page.tsx:53`). |
| Other prefill entry points | Receipt `?po=` (`src/modules/procurement/Page.tsx:41-46`); exception case source fields (`src/modules/exception-cases/Page.tsx:166-184`) | The receipt form already sets accepted to the remaining quantity (`src/modules/procurement/ReceivingForm.tsx:110`) | No free-text prefill anywhere |
| Preview builders | `server/domain/purchase-request-draft-preview.mjs:37-66,116` | Preferred supplier, gap quantity, the item's default warehouse | A good base for the D tier ([§3](#3-prefill-sources)) |
| Universal Intake | `server/domain/business-action-intake.mjs:25-49`, `server/domain/entity-slot-resolver.mjs:34-78` | Free text to slots, with `missingSlots` | No route calls it (tests only). It never reads history. |
| Confirmed actions | `server/domain/user-confirmed-business-action.mjs:1-26`, `server/routes/user-confirmed-actions.routes.mjs:47-68` | `save_supplier_followup_note` stores an internal note. `send_email` and `send_rfq` are forbidden (`:16-17`). | No screen calls these routes |
| Autocomplete | none | No datalist and no typeahead. The `cmdk` wrapper is unused (`src/app/components/ui/command.tsx:4`). Nothing handles Tab, and no form value is remembered. | All of [§4](#4-autocomplete-in-forms-and-free-text) is new |
| Usage data | The per-answer audit row (`server/domain/ai-skill-audit.mjs:16-56`) and the request log (`server/bootstrap/request-logging.mjs:47-53`) | No usage events | [§6](#6-measurement) |

## 2. User journeys

Each answer line gets a stated next step and, where one fits, a draft. The mapping
already exists in the draft candidates (`ai-skill-prepare-action-draft.mjs:19-37`). P1
shows it on every answer that lists the record, not only on "prepare a draft".

| Signal (`server/domain/ai-skill-signals.mjs:77-105`) | Next step (en / zh) | Entry point |
| --- | --- | --- |
| `po_overdue`, `po_due_7d`, `po_partially_received` | "Ask {supplier} to confirm a delivery date" / 请 {supplier} 确认交货日期 | PO follow-up draft |
| Shortage covered by an open PO | "Chase {po}, which brings this SKU" / 跟进带来该 SKU 的 {po} | PO follow-up draft |
| Shortage nothing covers | "Raise a purchase request for {qty} {unit}" / 申请采购 {qty} {unit} | PR form, prefilled |
| `invoice_variance` | "Ask {supplier} about the variance" / 就差异询问 {supplier} | Variance query draft |
| `grn_rejected_qty` | "Tell {supplier} about the rejected quantity" / 告知 {supplier} 拒收数量 | Receipt exception draft (P2) |
| `grn_received_unposted`, `pr_awaiting_approval`, `rfq_ready_to_award` | "Post the receipt" / "Review the request" / "Compare quotes" | Link only, as today |

Typing counts below are estimates from today's forms. P1 replaces them with measured
values ([§6](#6-measurement)).

| # | Journey | User | Today: steps / typed characters (est.) | Proposed: steps / typed | Lands on |
| --- | --- | --- | --- | --- | --- |
| J1 | Chase a late PO | Buyer | 6-8 / 200-350 | 3 / 0-60 | Draft, then email, then "Log as sent"; later the promise-date form |
| J2 | Query an invoice variance | Finance | 6 / 200-350 | 3 / 0-60 | Draft; later the match exception resolution |
| J3 | Raise a PR for a short SKU | Buyer | about 10 inputs / 50-110 | 2 clicks and a review / 0-30 | PR create form |
| J4 | Record a receipt exception | Warehouse | 3 inputs per line plus a note / 40-120 | a review / 0-20 | Receiving form, then a supplier notice |
| J5 | Record an RFQ reply (a supplier's quote) | Buyer | 4 header and 3 per-line inputs / 40-100, plus prices | a review / prices only | RFQ supplier response dialog |

Source tags in the tables: **R** record, **D** master data or default, **T** template,
**H** your history, **M** model. [§3](#3-prefill-sources) defines them.

### J1 Chase a late PO

- **Today.**
  1. Find the PO.
  2. Ask again with the word "draft".
  3. Open a one-line message.
  4. Look up the supplier's email in master data.
  5. Copy the text into email and type the lines, dates and sign-off.
  6. When the supplier replies, type the new date and a reason in the promise-date form
     (`src/modules/purchasing/components/PurchaseOrderPromiseDates.tsx:80-81`).
- **Proposed.**
  1. The answer line reads "PO-013 · Atlas · due Sep 28, 5 days overdue · 2 open lines",
     followed by "Draft follow-up".
  2. Review the prefilled draft.
  3. Choose Copy or "Open in email" (mailto). FlowChain sends nothing. In P2, "Log as
     sent" records the message.
  4. When the supplier confirms, "Record promised date" opens the promise form with its
     reason prefilled.

| Field | Value | Source | Phase |
| --- | --- | --- | --- |
| To | The supplier's contact name and email (`Supplier.metadata`, `server/domain/supplier-master-command.mjs:3`) | D | P1 |
| Subject | "PO-013: delivery date for 2 open lines" | T + R | P1 |
| Message | One line per open PO line: SKU, item, remaining quantity and unit, promised date, and the original date if it moved (`PurchaseOrderLine.originalPromisedDate`, `prisma/schema.prisma:1282`). This fixes the defect in §1. | T + R | P1 |
| Greeting, sign-off, message language | From your last logged message to this supplier | H | P2 |
| Promise-date reason | "Confirmed by {supplier} by email on {date}" | T + H | P2 |

### J2 Query an invoice variance

- **Today.** Finance opens the bill and the PO and compares prices and quantities line by
  line. They write to the supplier, then type a resolution on the match exception
  (`src/modules/finance/SupplierInvoiceScreens.tsx:242`, used at `:325-326`).
- **Proposed.** The answer line reads "INV-001 · Atlas · variance 120.00 USD, open since
  Sep 25", followed by "Draft query". The draft lists each line with a variance: the PO
  price against the billed price, times the quantity (`ThreeWayMatchLine`,
  `prisma/schema.prisma:1474`), and the total.
  - Amounts appear only with `finance.amounts.read`; otherwise the hidden-amount wording is
    used (`ai-skill-copy.mjs:172`).
  - In P2 the resolution field suggests template phrases ("Credit note requested on
    {date}") and your own earlier resolutions (`FinanceMatchException.resolvedById`,
    `prisma/schema.prisma:1508`).

### J3 Raise a purchase request for a short SKU

- **Today, from the form.** Department, currency, need-by date, SKU, supplier, quantity,
  unit price, warehouse, line date and note (`CanonicalProcurementPanel.tsx:516-763`).
- **Today, from the assistant.** SKU, quantity, preferred supplier, reference price and
  the item's warehouse are prefilled (`:194-240`). The reason and the due date are
  dropped, and the note is a fixed Chinese sentence.

| Field | Value | Source | Phase |
| --- | --- | --- | --- |
| SKU, item | From the signal | R | P1 |
| Quantity | The gap (`ai-skill-prepare-action-draft.mjs:29-30`), rounded up to the item-supplier minimum order quantity (`server/domain/master-data-commands.mjs:238,245`) | R + D | P1 |
| Supplier, price, currency | The preferred item-supplier and its reference price. The price is filled only for readers with `procurement.prices.read`; masking already nulls it otherwise (`server/domain/master-data-read-access.mjs:17-55`). | D | P1 |
| Warehouse | The item's default warehouse, else the user's (`User.defaultWarehouseId`, `prisma/schema.prisma:543`) | D | P1 |
| Need-by date | Today plus the item-supplier lead time (`leadTimeDays`, `master-data-commands.mjs:237,244`) | D | P1 |
| Line note | "12 available against a reorder point of 50; nothing incoming covers it." in the UI language | T + R | P1 |
| Department | Your last request's department (`metadata.departmentId`, `server/services/procurement-request-command-service.mjs:224`) | H | P2 |
| "Your last quantity for this SKU: 200 (PR-0042, Sep 12)" | A hint chip only. It never replaces the computed gap. | H | P2 |

**When the user asks for an order (decision 10, #125).** "Can you help me generate the
order?", "create a PO for LDM-001", 帮我下单 and 补货 are a request for this form. The
assistant works out what to buy (rules only: `server/domain/ai-skill-start-order.mjs`)
and opens the form by itself, filled in as above, when the choice is clear:

| Situation | The answer | Opens the form |
| --- | --- | --- |
| A SKU is named, or the page's SKU | The gap; ordered on top of open orders, the target less what is available | Yes |
| No SKU named; exactly one SKU still short after open POs and pending requests | That SKU's gap | Yes |
| Several SKUs still short | A button per SKU, named | No: the user picks |
| Open POs or pending requests already cover the shortage | The first sentence names what is already on order. Then a follow-up on the latest PO, and "open a request anyway" | No ("anyway" or 仍然 opens it) |
| Nothing short | A blank purchase request | No |
| The question asks whether or what to order | The same buttons | No |

The form opens unsaved, and only its own Save button saves. The assistant stays open, so the user
reads why the page changed, and a new answer is shown from its first line. "Issue",
"submit" and 下达 are still refused.

### J4 Record a receipt exception

- **Today.** The receiving form takes a warehouse and an arrival time. Each line takes
  accepted and rejected quantities, a rejection reason (required when rejected is above
  0, `ReceivingForm.tsx:135,238`), a location and a note (`:249`). The reason is stored in
  the line's metadata (`server/domain/receiving-draft-command-service.mjs:91`). Telling the
  supplier happens outside FlowChain.
- **Proposed.**
  - **Warehouse:** the PO line's target, else your default (D, P1).
  - **Arrival time:** now (D, P1).
  - **Accepted quantity:** the remaining quantity, as today.
  - **Location:** the last location used for this SKU in this warehouse (H, P2).
  - **Rejection reason:** chips with your recent reasons, newest first, plus Tab
    completion (H + T, P2).
  - **After posting a rejection:** the receipt page and the `receiving_issues` answer
    offer "Draft supplier notice", a new type `receipt_exception_followup_draft` built
    from record facts only: receipt, PO, SKU, rejected quantity and reason (P2).

### J5 Record an RFQ reply

FlowChain has no supplier portal, so the buyer enters the supplier's quote. Sending RFQs
stays forbidden (`user-confirmed-business-action.mjs:16`).

- **Today.** The dialog (opened from `src/modules/procurement/CanonicalRfqDetailPage.tsx:300`)
  takes currency, free-text payment terms, valid-until and delivery date
  (`src/modules/procurement/RfqSupplierResponseDialog.tsx:220-223`). Each line takes a
  quantity, a unit price and a delivery date (`:231`).
- **Proposed.**
  - **Currency:** the supplier's default currency (D, P1).
  - **Payment terms:** the supplier's payment term (D, P1). Failing that, the payment terms
    on the supplier's last quotation revision (`SupplierQuotationRevision.paymentTerms`,
    `prisma/schema.prisma:1162`) (H, P2).
  - **Per line:** the RFQ's requested quantity and required date (R, P1).
  - **Unit price:** never prefilled. The last quoted price is shown as a hint (H, P2).
  - **Assistant handoff:** P1 also fixes the RFQ handoff, or removes the button until the
    live RFQ create path reads the query.

## 3. Prefill sources

| Tier | Source | Examples | Read through | Deterministic rule | Label (en / zh) |
| --- | --- | --- | --- | --- | --- |
| R | The record the answer or form is about | Supplier, PO lines, remaining quantity, dates, variance, rejected quantity | The skill facts or the form's own record API, with the actor's masking | A copy of a stored or computed field | "From PO-013" / 来自 PO-013 |
| D | Master data and defaults | Supplier email and contact, currency, payment term, lead time, minimum order quantity, preferred supplier, reference price, item and user default warehouse, tenant currency and time zone | The master data read access, which masks bank and tax fields and the price | Fixed precedence: record, item-supplier, supplier, item, user, workspace | "Supplier default" / 供应商默认值 |
| T | Field templates | Follow-up message, PR line note, promise reason, resolution phrases | `[en, zh]` entries like `ai-skill-copy.mjs:543-555`, with slots filled from R | Template id and version | "Template" / 模板 |
| H | The actor's own history | Last department, location per SKU, last quantity per SKU, own reasons and resolutions, last follow-up to this supplier | Queries scoped to the session's tenant and actor ([§3.1](#31-where-history-lives-today)) | Newest first by date, as the owner ruled in #113; ties by record id. Show the date and a count, never a score. | "Your last value · Sep 29" / 你上次填写 · 9月29日 |
| W | Workspace history (decision 5) | Short structured values: reasons, locations, departments | The same queries for any actor, limited to fields and records the actor can read | The same | "Used in this workspace · 4 times" / 本工作区用过 4 次 |
| M | Model (P3, behind a flag) | Descriptive text only | [§4.3](#43-optional-model-completion-p3) | Not deterministic; facts only through slots | "AI wording · facts from PO-013" / AI 措辞 · 事实来自 PO-013 |

Every suggestion carries a reference that recomputes it:

```json
{ "field": "message", "source": "template",
  "ref": { "template": "draft.po_followup.message", "version": 2, "record": "purchase_order:LOCAL-DEMO-PO-013" },
  "asOf": "2026-10-03" }
```

The value travels only to the form. Audit and usage data carry `source` and `ref`, never
the value ([§5](#5-safety)).

What the user typed always wins over any suggestion. If Universal Intake is later wired
to a route (it is not part of this design), its slots count as typed values
(`entity-slot-resolver.mjs:34-78`), and these sources fill only its `missingSlots`.

### 3.1 Where history lives today

| History | Stored in | Actor | Usable for H |
| --- | --- | --- | --- |
| PR department, quantity, reason | `PurchaseRequest` and its lines (`prisma/schema.prisma:989,1016`) | No creator column. The user id is in the `requester` string and `metadata.requesterId` (`procurement-request-command-service.mjs:221,224`). | Yes, through `metadata.requesterId`. P2 adds an indexed column. |
| Receipt reason, location, damaged quantity | `ReceivingLine.metadata` (`receiving-draft-command-service.mjs:91`) | `ReceivingDocument.postedById` (`prisma/schema.prisma:1311`) | Yes, for posted receipts |
| Promise-date reasons | `PurchaseOrderPromiseRevision`, append-only (`prisma/schema.prisma:1292`) | `actorId` | Yes |
| Quote payment terms | `SupplierQuotationRevision.paymentTerms` (`:1162`) | `createdByActorId` (`:1163`) | Yes |
| Match resolutions | `FinanceMatchException` (`:1508`) | `resolvedById` | Yes |
| Saved drafts | `ActionDraft` (`:902`) | `createdById`, not indexed | Yes, but drafts are rarely saved |
| Who created a PO | `PurchaseOrder.metadata.createdBy` (`procurement-request-command-service.mjs:434`) | JSON only | Weak |
| Any change | `AuditLog` (`prisma/schema.prisma:954`) | `actorId`, not indexed (`:970-971`) | No. Summaries are redacted and capped at 240 characters (`server/domain/audit-policy.mjs:3-16,50`). |

### 3.2 What is missing

| Missing | Why it matters | Proposal | Phase |
| --- | --- | --- | --- |
| A log of follow-ups sent to suppliers | "Your last message to this supplier" has no source. FlowChain sends nothing: `send_email` is forbidden, and mail is used only for sign-in (`server/auth/email-link-sign-in.mjs:174`). | "Log as sent": the user records the date, the channel and the final text on the PO or bill. Store it in `ProcurementFollowup` (`prisma/schema.prisma:2572`), which already has `message`, `supplierId` and `documentType/Id` and has no writer today, adding `createdById`, `sentAt` and `channel`. The confirmed-action note (`server/repositories/user-confirmed-action-repository.mjs:49`) is a JSON record, which is harder to query by supplier. | P2 |
| A reorder quantity | The owner asked for "the reorder quantity last used". `Item` has only `safetyStock` and `reorderPoint` (`prisma/schema.prisma:675-676`). | Use your last PR quantity for the SKU (H) as a hint. A master data reorder-quantity field is a separate question and not needed here. | P2 |
| Supplier contacts as data | Email and contact name are free fields in `Supplier.metadata`, one per supplier | Use them as they are. Several contacts per supplier is out of scope. | none |
| An index for "mine" | `requester`, `createdById` and `actorId` are not indexed | `(tenantId, actor, createdAt)` indexes on the tables H reads | P2 |
| Suggestion outcomes | Nothing records which values came from a suggestion | `suggestionTrail` on submit ([§5](#5-safety)) | P1 |

## 4. Autocomplete in forms and free text

### 4.1 Interaction

| Field | Behaviour | Accept | Reject |
| --- | --- | --- | --- |
| Structured (select, number, date) with a prefill | Filled when the form opens, with a source chip. A dotted underline stays until the user focuses or changes the field. | Leave it | Change it, or "Clear" on the chip |
| Structured, no prefill | On focus, up to 3 chips with your recent values and their dates | Click, or Enter on a chip | Ignore them |
| Short text (reason, location, payment terms) | Ghost text after the caret: the newest of your values that starts with what you typed. Empty focus shows template and recent-value chips. | **Tab**, or → at the end of the text | Keep typing, or **Esc** |
| Long text (message, note) | Prefilled from a template. Ghost completion of the current sentence comes from templates (P2) or the model (P3). | Tab for the whole ghost text; Ctrl/Cmd+→ for one word | Esc |
| Touch screens | No Tab: a "Use" chip sits beside the ghost text | Tap | Ignore it |

- **Tab rule.** Tab accepts only while ghost text is visible and the caret is at the end.
  Otherwise Tab moves focus as usual, so keyboard navigation is unchanged.
- **Accessibility.** Ghost text is not part of the value until it is accepted. A polite
  live region announces "Suggestion available, Tab to accept" once per field.
- **Copy.** All chips, banners and announcements are written in English with a Chinese
  translation through `useI18n` (`src/i18n/I18n.tsx:649-671`).

### 4.2 Rules and history first (P1-P2, no model)

- **Order.** Newest use first, then record id. Each candidate shows its date and a count
  ("Sep 29 · 4×"). There are no weights.
- **Matching.** Case-insensitive prefix, then word prefix. For Chinese, character prefix.
- **Window.** The last 50 distinct values per actor, form and field, optionally keyed by
  SKU or supplier, from the last 180 days.
- **Templates.** One set per field in English and Chinese, chosen by the UI language.
  Record slots are filled on the server.
- **One request per form open.** `GET /api/suggestions?form=purchase_request&context=item:<id>`
  returns the prefills and up to 50 candidates per field. Filtering on each keystroke
  happens in the browser.
  - Latency target: server p95 at most 150 ms, and no network call per keystroke.
- **Rules live on the server.** Each form gets one module (`server/domain/suggestions/*.mjs`),
  so unit tests and the eval can pin them. The client only renders.

### 4.3 Optional model completion (P3)

- **Fields.** Descriptive text only: the follow-up message body, notes, resolutions and
  the PR line note. Never quantities, prices, dates, ids, recipients or selects.
- **Switches.** The flag `FLOWCHAIN_AI_TEXT_COMPLETION=off|local` defaults to off.
  - A `text_completion` entry in `AI_MODEL_POLICY_DEFINITIONS`, like `intent_routing`
    (`server/domain/ai-model-router.mjs:73-79`), with `enabledByDefault: false`.
  - The per-workspace opt-in the owner approved for agent mode (decision 6 there).
- **Input to the model.**
  - The field id and the UI language.
  - The text typed so far: at most 300 characters, the actor's own.
  - The record's masked view, the same compact view agent mode P3 builds: ids, codes,
    numbers and short names, with no notes and no history text.
- **Output.** At most 200 characters. Facts appear only as slots (`{rec:}`, `{fig:}`,
  `{date:}`) that the server fills. The agent mode verifier checks it
  (`docs/ai-agent-mode-design.md` §4). On any failure no suggestion is shown, and the user
  never sees an error.
- **Timing.** The call starts after 600 ms idle at the end of the text. One call at a time;
  the next keystroke aborts it. Timeout 1.5 s, p50 target 1.0 s. Pick-one routing
  measured 0.75 s for a similar size.
- **Cost.** About 600 input and 60 output tokens, about $0.001 per completion on Haiku
  4.5 at the prices in agent mode §7. There is a per-user daily cap.

### 4.4 Privacy

| Data | Who may receive it as a suggestion |
| --- | --- |
| The record's fields | Anyone who can open the record, with the same masking as its screen (amounts, partner names) |
| Your own history | You only, from records you can still read today. Access is checked when the suggestion is read, not when the value was written. |
| Other users' values (W) | Only if decision 5 says yes: short structured values from fields you can read, never free text verbatim |
| Prices from history | A hint only, for readers with `procurement.prices.read`. Never prefilled (decision 6). |
| Sent to the model (P3) | The masked record view and your own typed text. Never history, notes, other users' text, or names that match injection patterns. |

## 5. Safety

| Concern | Rule | Builds on |
| --- | --- | --- |
| Permissions and masking | Suggestions read through the same access layers as the screens: `aiSkillVisibility` (`server/domain/ai-skill-registry.mjs:111-121`), `scopeBusinessContext` (`server/domain/report-read-access.mjs:109`), `maskProcurementRecord` (`server/domain/procurement-read-access.mjs:135`) and master data masking (`master-data-read-access.mjs:17-55`). Drafts still need `procurement.purchase_order.revise` (`ai-skill-registry.mjs:32`). A field the actor cannot see stays empty and says why. | Existing layers |
| Tenant isolation | The tenant and the actor come from the session. The suggestion API takes no tenant or user parameter. | `server/repositories/repository-read-scope.mjs:6-13`; eval workspace B |
| No auto-submit | Suggestions change only what the browser shows. A prefilled form opens unsaved, and only the screen's own button saves, through its normal API and validation. The draft shell's Confirm stays disabled. "Open in email" hands the text to the user's own mail app; FlowChain sends nothing. The server never writes because of a suggestion. | Draft boundary; `FORBIDDEN_CONFIRMED_ACTION_TYPES` (`user-confirmed-business-action.mjs:12-26`) |
| Source labels | Every prefilled field and every suggestion shows its source chip ([§3](#3-prefill-sources)). A form opened from the assistant shows a banner: "Prefilled from the assistant at {time}. Check each field before saving." / 已根据助手回答预填（{time}），保存前请逐项核对。 | `useI18n` |
| Stale values | Prefills are computed when the form opens, and each chip shows its date. The create API still validates, for example over-receipt (`receiving-draft-command-service.mjs:86`). | Existing validation |
| Audit of accepted suggestions | The create request carries `suggestionTrail: [{ field, source, ref, outcome: accepted / edited / cleared }]`: codes and ids, no values. The server adds it to that create event's audit row and links the answer's audit id when the form came from the assistant. This follows agent mode decision 9: reason codes only. | `recordDatabaseAuditBestEffort` (`audit-policy.mjs:40-56`) |
| Prompt injection from stored text | **Rules phases:** stored text is only shown, never interpreted, and React escapes it. Autocomplete drops candidates that match `PROMPT_INJECTION` (`server/domain/ai-semantic-query-planner.mjs:16`), contain a URL or an email address, or are over 200 characters. The To address comes only from supplier master data. **P3:** no stored free text reaches the model. Names that match injection patterns become ids, as in `server/domain/ai-skill-entities.mjs:108`. The output is verified. | Eval `EVAL-INJ-*` seeds (`tests/ai-eval/run-eval.mjs:387-390`) |
| Anchoring on old values | Prices are never prefilled from history. Quantities come from rules, not history. History chips show their date, so an old value looks old. | none |
| Language | Templates follow the question or UI language. Names, ids and currencies are shown as stored; dates and numbers use the tenant locale (AGENTS.md). | `ai-skill-copy.mjs:543-555` |
| Draft types | A new draft type must be added to `AI_SKILL_DRAFT_TYPES`, which the validator enforces (`server/domain/ai-skill-validator.mjs:69-73`) | Existing gate |

## 6. Measurement

| Metric | Definition | Collected |
| --- | --- | --- |
| Prefill keep rate | Prefilled fields submitted unchanged, divided by prefilled fields, by source and field | Counted in the browser at submit, sent in `suggestionTrail` |
| Edits after acceptance | Normalised edit distance between the accepted and the submitted text, in buckets (0, up to 10%, up to 50%, more) | In the browser, bucket only |
| Autocomplete acceptance | Accepted divided by shown (visible at least 500 ms), and the dismiss rate, by field and source | Per-form counters |
| Characters saved | Characters a prefill or an acceptance inserted that survive to submit, and characters typed, per field | Counters only, no text |
| Time to submit | From form open to submit: opened from the assistant against opened directly | Browser timestamps |
| Draft funnel | Answer with a draft action, then draft opened, then copied, emailed or logged, then the normal form submitted | Audit ids linked by `answerAuditId` |

- **Where it is recorded.** There is no usage telemetry today ([§1](#1-what-exists-today)).
  Recommendation: build no new pipeline.
  - The counters ride on the submit request and land in that create event's audit row.
  - Copy and "Open in email" in the draft shell write one `ai_draft_used` audit row each.
  - A script, `npm run report:prefill`, aggregates by week. Add a separate usage table
    only if the volume calls for one.
- **Baseline.** For two weeks before P1 is switched on, count typing and time to submit on
  J1-J5's forms. Or compare forms opened from the assistant with forms opened directly.
- **Eval** (`npm run test:ai:eval`):
  - **Category.** A new `prefill` category in `tests/ai-eval/questions.json`, with a new
    `expect.draftPayload` field. Add it to `EXPECT_FIELDS` (`run-eval.mjs:89`) and score it
    in `scoreCase` (`:568-741`).
  - **Payload checks.** The card's payload must equal the truth values: supplier, PO
    number, every open line with its remaining quantity, the promised dates, and the
    variance.
  - **Permission cases.** A viewer gets no draft. A buyer without
    `procurement.prices.read` gets no price. Finance without `finance.amounts.read` gets
    the hidden-amount wording.
  - **Injection.** The `EVAL-INJ-*` supplier never supplies a To address. Its stored name
    is shown only as data.
  - **Tenant.** No workspace B value appears.
  - **Gate.** `prefill` cases are must-pass. The safety categories (`run-eval.mjs:55`)
    stay at zero failures.
  - **Unit tests.** The suggestion service gets unit tests for order by date, masking,
    distinct values and the 180-day window.
  - **P3.** Add a scripted provider plus agent mode's `grounding` cases for completions.
- **Targets to review after 4 weeks of use** (proposed):
  - prefill keep rate at least 70% for R and D fields;
  - autocomplete acceptance at least 25%;
  - median edit after acceptance at most 10%;
  - characters typed in J1-J3 down at least 50% against the baseline.

## 7. Fit with agent mode

- **The server builds cards and prefills.** Skills build them, so agent mode, which calls
  skills as tools, carries the same cards. The model never chooses or writes a prefill
  value.
- **Next steps sit in the presenter.** P1 adds the next step and the draft action in
  `presentAiSkillAnswer` (`server/domain/ai-skill-presenter.mjs:208`), so rules answers,
  compound answers (`server/domain/ai-skill-compound.mjs`) and agent sections all get
  them.
- **Ordering.** Cards attached to answer lines follow the answer's date order. The
  standalone "prepare drafts" answer keeps its severity order, as agreed in #113.
- **One verifier.** P3 completion reuses agent mode's slots, masked view and verifier, and
  rides on the same decision: agent mode decision 4, masked record data sent to the
  provider.
- **Separate audit blocks.** Audit gains a separate `suggestions` block; agent mode's
  `agent` block is untouched.

## 8. Phased plan

Effort is in developer days for one engineer, with tests and English and Chinese copy.

| Phase | Ships | The model decides | Effort |
| --- | --- | --- | --- |
| **P1, land the drafts** (no model; works on Render) | (1) Next step plus draft action on answers that list a draftable record, at most one per line and three per answer, with the `focused-response.ts:81-82` gate removed. (2) PO follow-up: every open line (fixes the §1 defect), To and Subject from master data. (3) Draft shell: multi-line message, source chips, "Open in email", Copy. (4) PR handoff: reason to line note, due to need-by date, minimum order rounding, an English and Chinese template instead of the fixed Chinese note. (5) RFQ handoff fixed, or the button removed. (6) R and D prefills on the receiving form and the quote dialog. (7) `suggestionTrail` and its audit. (8) Eval `prefill` cases and unit tests. | Nothing | 8-10 |
| **P2, history autocomplete** (no model) | Suggestion service and `GET /api/suggestions`. Ghost text with Tab and Esc. H suggestions for the PR department and last quantity, receipt reasons and locations, promise reasons, quote payment terms and resolutions. "Log as sent" with a migration (`ProcurementFollowup` actor and sent columns, actor indexes). Greeting and sign-off reuse. The `receipt_exception_followup_draft` type and promise-date prefill. Counters and `report:prefill`. | Nothing | 10-13 |
| **P3, model text completion** (optional) | The `text_completion` policy and flag, local Parley only, the per-workspace opt-in, slots and agent mode's verifier, scripted-provider eval | The wording of descriptive text; facts only through slots | 4-6 once agent mode P3's verifier exists, 10-14 without it |
| **P4, workspace history and polish** (optional) | W suggestions (decision 5), mobile chips, more forms | Nothing | 3-5 |

- **Why P1 is the smallest useful phase.** It turns three dead-end drafts into working
  entry points and fixes two broken handoffs. It needs no model and no migration, and it
  produces the measurements that P2 and P3 should be judged by.
- **Gates.** Each phase ships after the previous one's targets are reviewed. P3 also needs
  agent mode decision 4.
- **Language coverage.** This design does not claim full bilingual coverage
  (`docs/interface-language-policy.md`). Each phase checks its own screens in both
  languages.

## 9. Decisions for the owner

| # | Decision | Recommendation | Owner, 2026-10-03 |
| --- | --- | --- | --- |
| 1 | Build P1 (no model): drafts land on the normal screens with record and master data prefills, and every field shows its source | Yes | Approved |
| 2 | Show the next step and a draft action on every answer line with a draftable record (at most one per line, three per answer), not only when the question asks for a draft | Yes | Approved |
| 3 | "Open in email" hands the draft to the user's own mail app (mailto). FlowChain still sends nothing. | Yes | Approved |
| 4 | P2 "Log as sent": store the final message text, the date and the channel on the PO or bill, readable by whoever can read that record. Only the author's own messages are reused as suggestions. | Yes, store the text | Approved |
| 5 | Suggest other users' values (W): short structured values only, never their free text | Defer to P4; then structured values only | Approved |
| 6 | Prices and amounts from history are hints, never prefilled. Quantities come from rules (gap, minimum order quantity), with your last quantity as a hint. | Yes | Approved |
| 7 | Measure through audit rows with counts and source codes only (no text), plus a weekly report; no new telemetry service | Yes | Approved |
| 8 | Tab accepts a visible suggestion; Esc dismisses; with no suggestion, Tab moves focus | Yes | Approved |
| 9 | P3 model completion for descriptive text: local Parley only, off by default, behind the per-workspace opt-in | Decide together with agent mode decision 4, after the P2 results | Open |
| 10 | When the user asks for an order and the choice is clear, the assistant opens the purchase request form filled in, without a click; it never saves or submits. When open orders already cover the shortage it does not open the form, and its first sentence says what is already on order ([J3](#j3-raise-a-purchase-request-for-a-short-sku)) | Yes | Approved 2026-10-04 (#125) |
