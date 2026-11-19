# Supplier replies: reading the new delivery date, a person records it

Status: proposal of 2026-11-17. SR-1, 2, 3, 4, 6 and 8 decided 2026-11-19 as recommended (§10); steps 1 and 1e are being built. SR-5 waits for a deployment.

**Where it comes from.** On 2026-11-17 the owner compared FlowChain's assistant with the agents in large ERP products. They asked how FlowChain could do what the Dynamics 365 Supplier Communications Agent does: follow the supplier emails about a purchase order, read the new delivery date from the reply, and propose the change for a person to confirm. They chose to have the design written first ("先写设计文档").

It extends the drafted decisions design (`docs/drafted-decisions-design.md`, #310). That design sends the follow-up to the supplier (§4.11) and left one line open: "Replies: not read by FlowChain in v1. The person records the new promised date from the reply, on the same card." This document closes that line.

## 中文摘要

- **要解决的事：**
  - 逾期采购单的催货邮件现在已经可以从今天页发出（#311、#312）。
  - 但供应商的回信只到采购员自己的邮箱，FlowChain 看不到。
  - 采购员要自己读信、找到新交期、打开采购单、逐行改日期、写原因。回信里的日期常常没录进系统，库存推演和逾期提醒就一直用旧日期。
- **做法：** 先粘贴，后收信。
  1. **粘贴（第 1 步）：** 在逾期卡片和已下发的采购单页面上加一个"粘贴供应商回信"的框。
  2. **读信：** 一次单独的模型调用，只做抽取：哪一行、新日期、原句。不加进聊天助手的工具里（聊天的固定提示在冷缓存下只剩约 108 个 token 的余量，2026-11-19 实测）。
  3. **代码核对：** 每个值都必须能在回信原文里找到原句；明确写出的日期要能从原句解析成同一天；行必须是这张单上还没收完的行。核对不过、日期含糊（"尽快""12 月初"）、数字日期有歧义（03/12）时，不出提议，改为"需要你看"，并给出手动填日期的表单。
  4. **提议卡片：** 逐行显示"现在的日期 → 回信说的 → 建议的日期"，附原句，并显示新日期对库存的影响。用户点"记录新日期"才写入。
  5. **写入：** 走现有的改交期命令（`POST /api/procurement/orders/:id/promised-dates`），原因写供应商的原句。最初承诺日期不变，供应商评分照旧按它算。
- **只记日期：** 回信里改数量、改价格、取消、换货，只标出来，不改单。等 #236 的改单命令做好后再预填。FlowChain 不会自己回复供应商。
- **收信（第 3 步，部署以后）：** 催货邮件的 Reply-To 同时写采购员和一个每封信专用的 FlowChain 地址，通过 Postmark Inbound 收回信，匹配到采购单，在今天页出提议。不连接用户的 Gmail/Outlook 邮箱。研究和课程只需要第 1–2 步。
- **评测：** 写一套约 40 封的供应商回信（中英文），用在 UCI 演练数据的逾期采购单上。明确日期读错、或按回信里的"指令"做了写入，都算硬失败。0 个硬失败、有日期的回信 90% 以上读对，才上演练环境。
- **决定：** §10 共 8 项（SR-1 到 SR-8）。2026-11-19 已定（"方案C开始吧"）：SR-1、2、3、4、6、8 按建议，第 1 步和 1e 开工；SR-5 等部署。

## 1. The problem in FlowChain terms

- **The chase goes out; the answer does not come back.**
  - Today raises `purchase_order_overdue` items, and the card sends the follow-up after two confirmations (`server/services/supplier-follow-up-email-service.mjs`).
  - Reply-To is the person's own address (DD-9), so the supplier's answer lands in their mailbox, not in FlowChain.
- **Recording the answer is manual work.** To act on "we can ship the balance on 28 November", the buyer opens the order, finds the lines, types the date per line and writes a reason.
- **When it is skipped, the system works on the old date.**
  - The order stays "overdue" in Today, and the chased item comes back after 3 workdays (`DECISION_RETURN.chasedWorkdays`).
  - Stock projection and reorder suggestions count the open quantity at a date that has already passed.
  - The supplier evaluation page has no record that the supplier moved the date.
- **This is the part of purchasing that lives in email.** Small suppliers have no portal or API. Email is the interface, so reading it is where FlowChain can save the buyer real time.

## 2. What exists on `main` (b2079abc)

| Piece | Where | What it gives | Gap for this design |
| --- | --- | --- | --- |
| Follow-up email | `supplier-follow-up-email-service.mjs`, `supplier-follow-up-email.mjs` | Sends the chase after two confirmations; checks every figure against the order (`checkFollowUpContent`); records an `AuditLog` row `supplier_follow_up_sent` with the provider message id; the item becomes `chased` | Nothing reads the reply |
| Mail adapters | `server/mail/` (Postmark, Resend, outbox) | `send()` with `replyTo`; public-data workspaces always use the local outbox | Send only; no inbound route |
| Promised dates | `POST /api/procurement/orders/:id/promised-dates` → `revisePromisedDates` → `applyPromisedDateChanges` (`purchase-order-promise-dates.mjs`) | Per-line change with a required reason after issue; one `PurchaseOrderPromiseRevision` and one audit row per change; the original promise is locked by a database trigger | The revision's `source` is always `procurement_db_command_service`, so it cannot say the date came from a supplier reply |
| Decision items | `server/domain/decision-items.mjs` | `purchase_order_overdue` with options `chased`, `not_now`, `not_needed` (reason `supplier_confirmed` exists); permission `procurement.purchase_order.revise` | No "reply received" state |
| Supplier scorecard | `server/domain/supplier-scorecard.mjs` | On-time delivery measured against the original promise | No measure of how often a supplier moves its date |
| Universal intake | `InboundArtifact`, `IntakeSourceType` (`manual_upload`, `manual_paste`, `email_attachment`, `api`, `system_export`) | One governed boundary for outside content; never writes operational tables | Preview only; `email_attachment` has no provider |
| Injection pre-check | `server/domain/ai-injection-guard.mjs` | A first filter on text that tries to steer the model; structural defences do the rest | Built for questions, not for an outsider's email |
| Assistant v2 | `server/domain/ai-assistant-v2.mjs` | A user can paste up to 8,000 characters; `suggest_setup_records` already turns pasted text into a card the user checks | The fixed prompt is about 28.9k tokens with about 108 tokens of cold-cache room for earlier turns (measured 2026-11-19), so a new chat tool must be offset |
| Order changes | `docs/order-changes-history-reverse-design.md` §2.2 (#236) | The revise command for quantities, prices, lines | Designed, not built |

## 3. What Dynamics 365 does, and what we take

Microsoft Learn describes the Supplier Communications Agent as follows ([overview](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/supplier-com-agent-overview), [applying email changes](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/supplier-com-agent-apply-email-changes), [follow-ups](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/supplier-com-agent-follow-up), [FAQ](https://learn.microsoft.com/en-us/dynamics365/supply-chain/faq-supplier-communications-agent)):
- it works from a mailbox synced to Dataverse;
- it drafts follow-up emails for unconfirmed orders. Sending them automatically is a separate feature an administrator turns on;
- it sorts each incoming vendor email into one of four categories, one of them purchase order confirmation;
- when a supplier confirms or revises a date, it extracts the change from the email or an attachment and links it to the order. A person reviews and applies the changes;
- it is a preview feature, needs version 10.0.44 or later, and is charged as Copilot Studio messages.

| | Take | Leave | Add |
| --- | --- | --- | --- |
| Matching | Link each reply to its order | Mailbox sync: SMEs use Gmail or Outlook.com, and reading a whole mailbox is a large privacy surface | A per-message reply address, later (§4.11) |
| The change | Propose, a person applies | Automatic sending (DD-9 keeps two confirmations) | Each value quoted from the reply and checked in code (§4.5) |
| Scope | Dates first | Attachments in v1 | "Needs you" when unsure, instead of a guess (§4.5) |
| | | | The effect on stock on the card (§4.6); a public evaluation set (§7) |

## 4. The design

### 4.1 The flow

```
reply text ──► clean ──► read (one model call) ──► check in code ──┬─► proposal card ──► person confirms ──► promised-dates command
 (paste, or                                                        ├─► needs you: reply shown, manual date form
  inbound mail)                                                    └─► nothing to record (auto-reply, no date): reply kept on the order
```

### 4.2 Where a reply comes in

- **Step 1: paste.**
  - On the `purchase_order_overdue` card once it is `chased`: "Got a reply? Paste it here".
  - On an issued or partially received order's page: "Record supplier reply". This also covers order confirmations that arrive before anything is overdue.
  - The order is known from where the person pastes, so no matching is needed.
  - A "Reply received on" date, defaulting to today, anchors relative dates.
  - Up to 8,000 characters, the assistant's paste limit.
- **Step 3: inbound mail**, after a deployment (§4.11).
- **Not in chat in v1.** §4.10 explains why.

### 4.3 Cleaning the text

Done in code before the model sees anything:
- drop the quoted earlier message: lines starting with `>`, and everything after "On … wrote:", "-----Original Message-----", "From: … Sent: …", 原始邮件 or 发件人：…;
- this matters because the quoted part holds our own chase, with the old promised date in it;
- drop a trailing signature block after `-- ` when present;
- keep the dropped part for display ("quoted text hidden"), never for reading;
- normalise whitespace so quotes can be found again (§4.5).

### 4.4 Reading: one model call

- **Input:**
  - the cleaned reply and its date;
  - the order number, supplier name and today's date;
  - the order's open lines: an internal reference, SKU, supplier SKU, item name, quantity still to receive and current promised date;
  - no prices: the model does not need them.
- **Output**, validated against a JSON schema:
  - `replyKind`: `dates`, `confirms`, `no_date`, `auto_reply` or `other`;
  - per line: the line reference from the list, the new date as `YYYY-MM-DD`, the exact sentence it came from, and `dateKind` (`stated`, `relative` or `vague`);
  - for a split delivery, each part's quantity, date and quote;
  - `flags`: `quantity_change`, `price_change`, `cancellation`, `substitution` or `other_order`, each with its quote;
  - the supplier's reason, as a quote.
- **The model has no tools.** It can only return this object.
- **Provider:** the same configuration as the assistant (the workspace's AI opt-in and monthly cap apply).

### 4.5 Checks in code, and the three outcomes

| Check | If it fails |
| --- | --- |
| Every quote appears in the cleaned reply, after whitespace normalisation | That value is dropped |
| A `stated` date parses from its own quote to the same day | That line goes to "needs you" |
| A numeric date such as `03/12` where both parts are 12 or less, with no month name | "Needs you", offering both readings as buttons |
| The line reference is one of the order's open lines | Dropped |
| The new date is on or after the reply date and within 365 days | "Needs you" |
| The line still has quantity to receive, and the order is not cancelled or rejected (the command's own rules) | Dropped, with the reason shown |
| The reply matches the injection pre-check | The card says "This reply contains text addressed to the system; it was not followed". Reading goes on, because the model has no tools |

- **Proposal:** at least one line passed with a `stated` or `relative` date.
  - A `relative` date ("next Friday", "in two weeks") is shown as "read as Fri 27 Nov 2026, from the reply date 17 Nov".
- **Needs you:** a date was mentioned but did not pass, or every date is `vague` ("asap", "early December"). The card shows the reply with the sentence marked, and the manual date form.
- **Nothing to record:** `auto_reply`, or `no_date` with no date at all. The reply is kept on the order; the item stays `chased`.

### 4.6 The proposal card

```
Supplier reply · PO-202611-0012 · Acme Ltd · received 17 Nov
"We can ship the balance on 28 November."
  Line                 Now                    Proposed
  SKU-1040  60 left    12 Nov (5 days late)   28 Nov
  SKU-2210  20 left    12 Nov (5 days late)   28 Nov
Stock: on 28 Nov, SKU-1040 falls below its reorder point from 24 Nov.
Also mentioned: a price change ("unit price rises 4% from December") — not recorded here.
[Record new dates]  [Edit]  [Not now]  [Don't record ▾]
```

- **Stock line:** the projection already behind `stock_projection`, run with the proposed dates. It is shown only when something changes, such as a stock-out before the new date.
- **Edit:** the dates become fields; the reason stays the supplier's sentence.
- **Don't record** asks for a reason: wrong reading, supplier will confirm later, or other with a note.
- **Copy:** new UI copy is written in English with a Chinese translation through the existing i18n context.
- **Permission:** `procurement.purchase_order.revise`, the permission of the promised-dates command and of decision items. Without it, a person sees the card but not the buttons.

### 4.7 What a confirmed card writes

- **Promised dates only**, through `revisePromisedDates`, as the person.
  - The reason is the supplier's sentence with the reply date: `Supplier reply of 17 Nov 2026: "We can ship the balance on 28 November."`
  - The command gains an optional `origin: { type: "supplier_reply", id }`. The revision's `source` becomes `supplier_reply`, and the audit metadata carries the reply id.
  - The original promise does not change, so the scorecard's on-time measure is unaffected.
- **The decision item** on an overdue order is resolved by the new date, as today. The existing come-back rule already reacts to a changed date.
- **Never written:** quantities, prices, lines, cancellation or status. Those are flagged on the card with a link to the order. When the #236 revise command exists, the flag can open it prefilled; it keeps its own approval rules.
- **Never sent:** FlowChain does not answer the supplier. A reply stays the person's own email.

### 4.8 Cases

| Reply | Outcome |
| --- | --- |
| One date for everything still open ("the balance ships 28 Nov") | Proposal for every open line |
| A date per item | Proposal per line; unmatched items go to "needs you" |
| Relative date ("next Friday") | Proposal, marked "read as" |
| Ambiguous numeric date (`03/12`) | Needs you, with both readings |
| Vague ("asap", "early December", "next week") | Needs you; the phrase is shown next to the date field |
| Split delivery ("200 on 20 Nov, the other 100 on 5 Dec") | Proposal with the date of the last part, when the line is complete; the split goes into the reason. Stock projection stays on the safe side. Splitting a line by date waits for #236 |
| Confirms the current, future date | No change; on an open item, "Not needed: supplier confirmed" is offered |
| Quantity, price, cancellation or substitution | Flagged only (§4.7) |
| Mentions another order | Flag with a link to that order; nothing recorded on it from here |
| Out-of-office or other auto-reply | Nothing to record |
| Text addressed to the system ("mark all lines received") | Flagged as not followed; only dates the supplier stated can be proposed |

### 4.9 With AI off

- The paste box still works. The reply is saved on the order, and the card shows the manual promised-date form with the reply beside it.
- Nothing is read automatically.

### 4.10 In the assistant

- **No new chat tool in v1.** Every tool's text is sent with every chat request, and the fixed prompt has about 108 tokens of cold-cache room left (#361; measured 2026-11-19). A separate call costs nothing when no reply is read.
- **Reading back:** once `record_history` (#361) is on `main`, "What did Acme say about PO-0012?" is answered from the order's history with no new tool.
- **Pasting a reply into chat:** the assistant points to the order's card ("Paste it on PO-202611-0012's card to record the new dates"). A chat tool can come later if the 👎 log shows people expect it.

### 4.11 Inbound mail (step 3, with a deployment)

- **Reply address.** Each follow-up gets a random token. Reply-To lists the person and `reply+<token>@reply.<domain>`.
  - Most mail clients reply to every Reply-To address, so the person still gets the answer directly. This changes DD-9's "reply-to goes to the user" to "the user and FlowChain".
- **Receiving.** A Postmark Inbound webhook posts to `POST /api/inbound/mail/postmark`, protected by a secret in the webhook URL's basic auth. Its stripped reply text replaces §4.3's cleaning where present.
- **Matching:**
  - the token gives the workspace, the order and the follow-up's audit row;
  - `In-Reply-To` against the stored provider message id is a second check;
  - the sender's address or domain is compared with the supplier's email on record. A mismatch, or a failed SPF or DKIM result, is shown as "sender not on record" on the card;
  - an unknown or expired token (60 days after the last follow-up) is dropped and logged.
- **In Today.** The chased item comes back to "waiting for your decision" with the proposal: a new come-back condition, "a supplier reply arrived".
- **Guards:**
  - off until the workspace turns supplier email on (the DD-9 switch);
  - at most 50 inbound replies per workspace per day;
  - attachments are listed by name and not read in v1;
  - duplicates are dropped by `Message-ID`.
- **Never on public-data or local workspaces.** The evaluation set (§7) stands in.
- **Why not connect Gmail or Outlook.** It reads the whole mailbox. Google's restricted Gmail scopes need a security assessment. And it is far more data than the replies to our own follow-ups.

### 4.12 What is recorded and measured

- **On the order:** the reply (source, received date, cleaned text up to 8,000 characters, and for mail the sender and message id), next to the follow-up it answers. The follow-up body is already kept this way.
- **Outcome codes per reply:** recorded unchanged, recorded edited, not recorded with its reason, needs you, nothing to record.
- **Measures**, on an admin export and the supplier evaluation page:
  - how often proposals are recorded unchanged, edited or rejected;
  - the time from reply to recorded date;
  - per supplier: date revisions per order, average days moved, and the share of replies with a stated date.
- **The scorecard stays on the original promise.** Revisions are a separate reliability measure, not a change to on-time delivery.
- **Research use** follows DD-7: codes, ids and dates; reply text only on public-data workspaces, where the replies are written by us.

## 5. Data model sketch

- **`SupplierReply`:**
  - tenant, purchase order, supplier;
  - source (`paste` or `email`), received date;
  - for mail: sender, `messageId` (unique per tenant when present), `inReplyTo`, the follow-up's audit row id;
  - the cleaned text, and whether quoted text was dropped;
  - the reading: provider, model, prompt version, the model's output and each check's result;
  - state: `needs_you`, `proposed`, `recorded`, `not_recorded`, `nothing_to_record`;
  - the decision: option, reason code, note of up to 200 characters, who and when, how many lines were edited;
  - the promise revision ids it created.
- **`revisePromisedDates`** gains the optional `origin` (§4.7).
- **Step 3 only:** `SupplierReplyAddress` with the token's hash, workspace, order, follow-up row and expiry.
- **Universal intake is not used in v1.** Attachments (a PDF order confirmation) can enter later as `email_attachment` artifacts.

## 6. Model use and cost

| Moment | Model call | With AI off |
| --- | --- | --- |
| A reply is pasted | One extraction call | Saved; manual date form |
| A reply arrives by mail (step 3) | One extraction call | Saved; the card asks for the date |
| Recording, editing, rejecting | None | Same |
| Chat | No change to the prompt | Same |

- **Size of a call:** the reply (up to 8,000 characters), the open lines and short instructions, typically a few thousand input tokens and a few hundred output tokens.
- **Limits:** it counts against the workspace's monthly cap like an assistant answer.

## 7. Evaluation: the supplier reply set

- **About 40 replies**, about 25 in English and 15 in Chinese, written against real overdue orders in the UCI walkthrough, with a few on M5. They are labelled as written by us, as the public-data direction requires.
- **Every case in §4.8**, plus:
  - a reply that quotes our chase with the old date;
  - a reply in a long thread;
  - a date in words ("the twenty-eighth");
  - a wrong order number;
  - two injection cases.
- **Each case states** the reply, its date, the order, and the expected outcome: the proposal per line, "needs you" or nothing, and the flags.
- **Scoring:**
  - a wrong `stated` date proposed is a hard fail;
  - any proposal of a value the supplier did not state, or anything taken from injected text, is a hard fail;
  - "needs you" where a clear date existed is a miss, not a hard fail.
- **Gate before step 1 goes on the walkthrough:** no hard fails, and at least 90% of the dated replies proposed correctly, on the walkthrough's model and on Sonnet.
- **Afterwards:** a "Don't record: wrong reading" becomes a draft case, as 👎 answers do (`scripts/assistant-feedback-cases.mjs`).

## 8. What this does not do

- It does not answer suppliers, or send anything new.
- It does not change quantities, prices, lines or status, or cancel an order.
- It does not read attachments in v1.
- It does not connect to anyone's mailbox.
- It adds no tool to the chat prompt.
- It does not change the scorecard's on-time basis.
- On public-data and local workspaces, nothing comes in from outside.

## 9. Build order and rough size

Sizes are rough, in working days.

| Step | What | Size | Needs |
| --- | --- | --- | --- |
| 0 | Nothing blocks it: the decision items and the follow-up email are on `main` (#311, #312) | — | — |
| 1 | `SupplierReply` and migration; cleaning; the extraction call and its checks; the paste box and card on the overdue item and the order page, in English and Chinese; `origin` on the promised-dates command; tests | 5–6 | — |
| 1e | The supplier reply set, its scorer, runs on the walkthrough's model and on Sonnet | 2 | 1 |
| 2 | Outcome export; the reliability measure on the supplier evaluation page; reading replies back through `record_history` | 2–3 | 1; #361 |
| 3 | Inbound mail (§4.11) | 4–5 | A deployment with a verified sending domain and an MX record for the reply subdomain |

- **Checking** uses the UCI walkthrough and the M5 workspace.
- **For the research and the course report**, steps 1 to 2 are enough. Step 3 is only for real users.

## 10. Decisions for the owner

**Decided 2026-11-19.** The owner said "方案C开始吧" ("start option C") on the
Pallet study, whose option C is this flow built on its own first
(`docs/workflow-automation-design.md`, WA-1). SR-1, 2, 3, 4, 6 and 8 are taken
as recommended below, and steps 1 and 1e start. SR-5 waits for a deployment.
For SR-7, step 1 stores the reply and its outcome codes; the reliability measure
comes with step 2.

Build notes from the workflow review (#392 §3), which tighten §4.5:
- a relative date is proposed only when code computes it from the quoted phrase
  and the reply date, never from the model's date alone;
- the regex injection pre-check is not a defence and is not relied on; the
  defences are structural (no tools, line references from a given list, quotes
  checked, invisible characters stripped);
- each reading is estimated and reserved in the assistant's cost ledger before
  the call, with at most two calls per reply.

| # | Decision | Recommendation |
| --- | --- | --- |
| SR-1 | Direction: (a) read supplier replies, pasted first on the card and the order page, inbound mail later; (b) inbound mail first; (c) not now | (a). It works locally today, needs no deployment, and gives the evaluation data before any mail setup |
| SR-2 | How a reply is read | One separate model call with no tools; every value quoted from the reply and checked in code; no new chat tool. With AI off, the manual form |
| SR-3 | What a confirmed card may write | Promised dates only, through the existing command, with the supplier's sentence as the reason. Quantity, price, cancellation and substitution are flagged only. FlowChain never answers the supplier |
| SR-4 | When FlowChain does not propose | Vague dates, ambiguous numeric dates, a quote not found, or a line not matched: "needs you", with the reply and the manual form. Relative dates are proposed and marked "read as" |
| SR-5 | Inbound mail | A per-message reply address next to the person's in Reply-To, received through Postmark Inbound, only with a deployment and a verified domain. No mailbox connection. This changes DD-9's reply-to line |
| SR-6 | The quality gate | The supplier reply set: no hard fails and at least 90% of dated replies correct before it goes on the walkthrough |
| SR-7 | What is recorded | The reply on the order like the follow-up; outcome codes; a reliability measure per supplier, separate from the on-time scorecard; research use as DD-7 |
| SR-8 | Timing | Start steps 1 and 1e on approval, as agent work that does not need the owner's November time. The owner looks at the card on the walkthrough before merging. Step 2 next; step 3 only with a deployment |

## 11. Risks

| Risk | Answer in this design |
| --- | --- |
| A date is read wrongly | The quote and parse checks; "read as" for relative dates; "needs you" when unsure; a person confirms each change; the original promise stays locked |
| Our own quoted chase is read as the supplier's answer | Quoted text is removed before reading, and a quote must be found in the new part |
| The email tries to steer the model | The model has no tools and returns line references from a list and dates; the code checks each value; the card says when text addressed to the system was ignored |
| People click through without reading | The supplier's sentence is on the card; edits and rejections are measured |
| Reply text holds personal data | Kept on the order like the follow-up; sent only to the configured provider under the workspace's AI opt-in; written replies on public-data workspaces |
| Few people paste replies | The chased card asks for the reply; step 3 removes the step once deployed |
| A mail client replies only to the first Reply-To address | Pasting stays available; the share of replies arriving by mail is measured |
| A spoofed supplier email (step 3) | The token, `In-Reply-To`, the sender against the record, and SPF and DKIM results; a person still confirms |
| Cost | One short call per reply, inside the workspace cap; nothing added to the chat prompt |
