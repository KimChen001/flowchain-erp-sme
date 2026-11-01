# Order changes, history import and reverse flows: design and decisions

Status: approved by the owner on 2026-11-01: every decision in §6 as recommended.
Nothing is built by this document. The build follows the order and timing in §5.

On 2026-10-30 the owner asked what is wrong with FlowChain's features themselves.
The answer, from a code check of `main` (70891206), ranked three gaps first. A real
company meets them in its first weeks:
- orders cannot be changed after approval;
- past orders cannot be imported, so analytics stay empty for months;
- returns and invoice corrections cannot be done.

On 2026-11-01 the owner asked for this design.

## 中文摘要

- **A. 订单变更**
  - **现状：**
    - 采购单批准后，数量、价格、行都改不了，草稿也改不了；
    - 已下达的采购单可以改交期（要填原因，留修订记录），也可以把剩余数量整单"短关"；
    - 销售单确认后不能改，发了一部分以后剩下的也关不掉；
    - 另外还有一个报表缺陷：短关掉的剩余金额仍显示为"未收货"。
  - **建议：**
    - 采购单走"变更单"：每次改动生成一个修订版本（Rev 2、Rev 3），记录改前改后和原因；
    - 金额增加时要重新审批，审批前原版本继续有效，仓库照常收货；减少金额、改交期、关闭某一行不需要审批；
    - 已开票的数量不能改价，价格错了走红字单；
    - 销售单确认后可以改，剩余数量可以关闭，新增"已关闭"状态。
- **B. 历史单据导入**
  - **现状：**
    - 只能导入五类主数据，导入后没法撤回；
    - 采购单没有"下单日期"和"单号"字段，报表按创建时间算日期；
    - 报表每类单据最多只读最近 500 条；
    - 收货过账会产生库存流水，会和期初库存重复。
  - **建议：**
    - 新增"历史采购单"（连同收货）、"历史销售单"（连同发货）、"在途采购单"三种导入；
    - 历史单据只做记录，不动库存、不产生应付应收、不进入待办；
    - 采购单和销售单补上下单日期和来源两个字段；
    - 一整批导入在 30 天内可以撤回；
    - 上线前先把报表的"最近 500 条"改成按日期范围读取。
- **C. 反向流程**
  - **现状：**
    - 退货模块（退给供应商、客户退货、隔离区）已经做好，也有测试，但试用环境关着；
    - 红字单只能基于已过账的退货开，界面上也没有入口；
    - 已批准的供应商发票不能撤回，已开出的客户发票不能作废，也没有不退货的价格更正。
  - **建议：**
    - 补上几处缺口后打开退货：两个占位页面、冲销退货前检查红字单、用户指南；
    - 红字单可以基于退货开，也可以不退货直接开（价格错误、多开、折扣）；
    - 客户发票开出后不作废，只用红字单冲销，全额冲销后这批发货可以重新开票；
    - 供应商发票批准后，在未付款、未标记导出之前可以撤回审批。
- **决定（2026-11-01 已按推荐批准）：** §6 共 22 项（订单变更 OC1–OC8，历史导入 HI1–HI8，反向流程 RV1–RV6）。
- **工作量和顺序：** 合计约 45–55 个工作日。建议分三批：
  - 12 月：在途采购单导入和两个缺陷修复；
  - 1 月：采购单变更单、历史采购单导入、打开退货；
  - 2027 年第一季度：其余各项。

## 1. Principles for all three

1. **A change is a new record.** Documents keep their number. A revision, a
   credit or an import batch is its own record, with the person, the time, the
   reason, and the values before and after. Nothing is edited in place after
   approval, and nothing is deleted after money or stock has moved.
2. **What has happened limits what can change.**
   - Quantity cannot go below what was received, shipped or invoiced.
   - A price cannot change on quantity already invoiced.
3. **The same command path as today:** idempotency key, row lock, version check,
   AuditLog and DomainChangeFeed (`runCommand`,
   `server/domain/procurement-db-command-service.mjs:151-199`).
4. **Money is corrected with credit documents.**
   - Cancelling is allowed only before anything financial is final: before
     approval for a bill, before issue for a customer invoice.
   - After that, a credit memo or credit note is the correction. This matches
     how the accounting system will read the records later.
5. **Imported history is never live work.**
   - It is marked as history. It creates no stock movements, payables or
     receivables, and never appears in Today, approvals or overdue lists.
   - It does count in analytics: spend, price history, on-time, sales by product.
6. **The interface is English first,** with Chinese through the existing copy
   maps (`AGENTS.md`). Business values are kept as entered.

## 2. A. Order changes

### 2.1 What exists on `main`

**Purchase orders.**
- **Statuses:** draft, pending_approval, approved, rejected, issued, partially_received, fully_received, closed, cancelled (`server/domain/procurement-status-authority.mjs:51-63`).
- **Commands** (`PURCHASE_ORDER_COMMANDS`, `procurement-db-command-service.mjs:40-50`):
  - submit, approve, reject (with a reason) and return_for_revision;
  - issue, which writes `issuedAt` once;
  - cancel from draft, pending or approved;
  - close (below).
- **Close is a short-close.** It is allowed from issued or partially_received,
  with a reason and the reject permission. Unposted receipts block it. It records
  each line's open quantity in metadata (`closedOpenQuantities`) and leaves the
  lines unchanged (:200-245).
- **Promised dates can change.** `POST /api/procurement/orders/:id/promised-dates`:
  - works on issued and later POs, with a reason;
  - writes an append-only `PurchaseOrderPromiseRevision` per line;
  - refuses fully received lines (`server/domain/purchase-order-promise-dates.mjs`).
- **Nothing can change quantity, unit price or lines, on any PO.** Not even on a
  draft: there is no draft edit command.
  - `return_for_revision` therefore leads to a draft nobody can edit. The API and
    the phone app offer it; the desktop does not.
  - The legacy PATCH handlers throw `FLOWCHAIN_LEGACY_MUTATION_REMOVED`
    (`server/routes/purchase-orders.routes.mjs`).
- **Fields that cannot change:** `originalPromisedDate` on a line and `issuedAt`
  are protected by database triggers. The supplier scorecard depends on them.
- **Approval is one step by role.**
  - `review.amountThreshold` is stored but read by no server code (`workspace-settings-contract.mjs:36`).
  - Nothing stops a person approving their own PO.
  - With `review.approvedRequestApprovesPurchaseOrder` (default on), a PO
    converted from an approved request starts approved.
- **What reads a PO line after approval:**
  - receiving (remaining quantity, the over-receipt block);
  - supplier invoice lines (capped at ordered less invoiced);
  - three-way match (the live unit price, snapshotted into `ThreeWayMatchLine`);
  - reorder list coverage;
  - the supplier scorecard (original promise; it already reads a line-level
    `metadata.closedAt` as "decision D5, not built yet");
  - price history;
  - the report value bridge;
  - the PO document (no revision number);
  - the assistant's read tools.
- **A reporting defect.** Closed POs still count as committed, so a short-closed
  remainder shows as "Not yet received" in the value bridge
  (`server/domain/report-dashboard-visuals.mjs:189-206`).

**Sales orders.**
- **Statuses:**
  - `workflowStatus` is draft, confirmed, on_hold or cancelled;
  - reservation and fulfillment run not, partially or fully.
- **Revising:** only a draft with no reservation or shipment
  (`server/domain/sales-order-workbench-service.mjs:128-147`).
- **Cancelling:** only with no posted shipment. After a partial shipment the only
  way out is to reverse the shipment.
- **Nothing closes the unshipped remainder.**
  - A fully shipped order stays `confirmed`, and no closed status exists.
  - Releasing a reservation frees the stock but leaves the line open, so its
    demand stays in shortage counts and Today.

### 2.2 Purchase order changes

**A revise command** for draft, approved, issued and partially_received POs. It
also fixes the draft dead end.

| Change | Allowed when | Needs approval |
| --- | --- | --- |
| Lower a line's quantity | Not below received, and not below quantity invoiced before receipt | No |
| Raise a line's quantity | Always | Yes: the PO amount rises |
| Change a unit price | Only on quantity with no invoice line yet; invoiced quantity keeps its price (a supplier price correction after invoicing is a credit memo, §4.4) | Only if the amount rises |
| Add a line | Always; its original promise is set when the change takes effect | Yes |
| Remove a line | Nothing received or invoiced on it | No |
| Close a line's remainder | Issued or partially received, with a reason | No |
| Header: expected date, notes, ship-to warehouse | The warehouse only while nothing is received | No |
| Promised dates | The existing promise-date command | No |

**How a change takes effect** (decision OC1).
- **Without approval needed:** the change applies at once as revision n+1.
- **With approval needed:**
  - the change waits as a pending revision;
  - the version in force stays valid, so the warehouse can still receive against
    it, but a quantity above it cannot be received yet;
  - approval applies the change, and rejection drops it;
  - one pending revision per PO at a time.
- **Self-approval** (decision OC3): the person who asked for an increase cannot
  approve it, unless they are the workspace's only approver. The same gap exists
  for first approval today; this design closes it for changes only and leaves
  first approval to its own decision.

**What a revision records.** A new append-only table, `PurchaseOrderRevision`,
modelled on `PurchaseOrderPromiseRevision`:
- the number;
- the person who asked and the reason;
- the approver;
- per line, the before and after of quantity, price and status;
- the PO amount before and after;
- when it took effect.

**Downstream effects.**
- **Original promise.** Lines keep their original promise, so the scorecard is
  unaffected. A new line gets its own original promise when the change takes
  effect.
- **Three-way match** uses the price in force when the receipt was posted. The
  match line already snapshots the PO price.
- **Reports and the assistant** read the version in force. The timeline shows
  every revision.
- **A closed line remainder** writes `metadata.closedAt` and its open quantity on
  the line, which the scorecard already reads. The value bridge shows a closed
  remainder as closed, not as "not yet received" (the defect fix in §5).
- **Open receipt drafts** on a line block changes to that line, as they block
  close today.

**Telling the supplier** (decision OC5).
- The PO document prints "Rev n", with the changed lines marked and a change summary.
- Sending the revision is a step the buyer marks, as issue is today. Nothing is emailed.

### 2.3 Sales order changes

- **Revise a confirmed order** (decision OC7):
  - quantity, unit price on what is not yet invoiced, added lines and promised dates;
  - quantity cannot go below shipped;
  - lowering quantity below reserved releases the extra reservation in the same command;
  - no approval, since sales orders have none today.
- **Close the remainder:**
  - with a reason code: customer cancelled the rest, cannot supply, substituted, other;
  - it releases open reservations and records each line's closed quantity;
  - it sets a new `closed` workflow status;
  - closed lines leave open demand, shortage counts and Today.
- **Closed when done** (decision OC6): a fully shipped order also becomes
  `closed`, so "confirmed" means work is left.

## 3. B. History import

### 3.1 What exists on `main`

**The import** (`server/domain/data-import-service.mjs`, `shared/data-import-columns.mjs`).
- **Types:** items, suppliers, customers, item suppliers and opening stock.
- **Flow:**
  - preview writes nothing and marks each row create, skip-existing or error;
  - commit runs in chunks of 200 rows through the same save commands people use;
  - each chunk is one `BusinessCommandExecution` with an idempotency key and one AuditLog row.
- **Limits:** create only, never update. 2 MB, 2,000 rows and 50 columns per file.
- **Headers** are read in English or Chinese.
- **Behind the `data-import` flag,** which is in the trial set.
- **No batch record and no undo.** Opening stock lands as draft adjustments that
  a person posts.
- **Nothing imports purchase orders, receipts, sales orders or invoices.**
  Universal Intake handles only master data and cannot commit, and the legacy
  imports routes return 501.

**What history needs, and what stands in its way.**
- **No order date and no number on PurchaseOrder.**
  - The number is `metadata.orderNumber`.
  - Reports and spend analysis date a PO by `orderDate || createdAt`, and nothing sets `orderDate`.
  - Sales orders also date by `createdAt`.
- **No source field.** PurchaseOrder and SalesOrder have none; PurchaseRequest has `source`.
- **Reports read at most 500 records per subject, newest update first**
  (`server/repositories/db-procurement-runtime-repository.mjs:76-85`). A year of
  history would push out live records.
- **Price history** counts issued, partially received, fully received and closed
  POs. It needs item, unit price, unit and currency.
- **The supplier scorecard** needs:
  - an issued PO with a supplier id;
  - lines with an original promise;
  - posted receipts linked by PO line, dated by `arrivedAt`;
  - at least 5 deliveries.
- **Posting a receipt** writes inventory movements and balances at the present
  time. Historical receipts posted that way would add stock on top of opening
  stock, and their movements would block the opening balance
  (`ADJUSTMENT_OPENING_BALANCE_EXISTS`).
- **Live work lists include any open record:**
  - open or overdue POs in Today and in the KPIs;
  - unfulfilled sales orders in Today and in shortage counts.

### 3.2 Three new import types

| Type | One row is | Becomes | Purpose |
| --- | --- | --- | --- |
| Purchase order history | One PO line: PO number, supplier code, order date, currency, SKU, quantity, unit, unit price, promised date, received quantity and received date (optional), warehouse (optional) | A PO, `fully_received` or, with a shortfall, `closed`; one historical receipt per received date | Price history, spend, on-time, reports, the assistant |
| Sales order history | One SO line: SO number, customer code, order date, currency, SKU, quantity, unit price, shipped quantity, shipped date | A `closed` sales order with shipped quantities recorded on its lines | Sales analytics, demand history |
| Open purchase orders | One line of a PO still out with the supplier, as above, with what is already received | An `issued` or `partially_received` PO whose remainder is received normally | Day-one receiving without retyping POs |

**Rows group into documents by number.** A number that already exists in the
workspace is skipped.

**Validation:**
- suppliers, customers and items must exist (import master data first), and an
  unknown code is a row error with a link to that import;
- quantities must be positive, and received or shipped cannot exceed ordered;
- dates cannot be in the future, and the received or shipped date cannot be
  before the order date;
- one currency per document.

### 3.3 How history is stored

- **New columns** on PurchaseOrder and SalesOrder (decision HI3):
  - `orderDate`: reports read it first, for every PO, and new POs get it at creation;
  - `source`: `app`, `history_import` or `open_po_import`;
  - `importBatchId`.
- **A new `ImportBatch` record:**
  - the type, the file name and its hash, the person, the time and the counts;
  - the ids it created;
  - its state, `active` or `removed`.

  The legacy `ImportBatch`/`ImportIssue` tables are not reused.
- **Historical receipts:**
  - a `ReceivingDocument` that is already posted, with `arrivedAt` = the received
    date, lines linked to the PO lines, and `metadata.historical = true`;
  - no `InventoryMovement` or balance is written (decision HI2): on-hand comes only
    from opening stock;
  - reversing one is refused with "This receipt is imported history; it moved no stock."
- **Historical sales** record shipped quantity and date on the order lines, with
  no shipment documents or movements. Demand reads that use history (decision
  HI4), such as the reorder list's demand and the assistant, read these lines by
  shipped date, labelled as imported.
- **No finance documents.** No bills, invoices, payables, receivables or payments
  are created. Finance history stays in the accounting system (decision HI1).
- **Open purchase orders:**
  - Their original promise is the promised date in the file.
  - Their received part is a historical receipt with no movement. Only the
    remainder is received normally, which writes movements.
  - The opening stock file must include what was already received. The preview
    reminds the user.

### 3.4 Keeping history out of live work

| Place | Rule |
| --- | --- |
| Today, approvals, overdue lists | Never list `history_import` records; their statuses are already final |
| Report KPIs for open work | Unchanged: history is fully received, closed or shipped |
| Reorder list coverage | Unchanged: only receivable POs count, so open-PO imports count and history does not |
| Analytics (spend, price history, on-time, sales) | Include history, with a "includes imported history" note on the dashboard |
| The assistant | Cites imported records as "imported history" |
| Report reads | Change from "newest 500 per subject" to date-bounded reads before history ships (decision HI7) |

### 3.5 Undo

- **A whole history batch can be removed within 30 days** (decision HI6), if no
  live document points at its records.
- **Removal deletes:** the batch's POs, lines, historical receipts and sales
  orders, and only those.
- **Removal is audited.**

## 4. C. Reverse flows

### 4.1 What exists on `main`

**Returns and quarantine are built but switched off.**
- **Requests, authorizations and postings:**
  - return to a supplier from available stock or from quarantine;
  - receive a customer return into quarantine;
  - release from quarantine to available;
  - each posting can be reversed.
  - Routes: `server/routes/returns.routes.mjs`.
- **The workbench** is `src/modules/inventory/ReturnQuarantineWorkbench.tsx`. Its
  copy is English first with Chinese.
- **Tests:** a Postgres suite, an API smoke test and two browser specs run in CI.
- **Switched off:** `FLOWCHAIN_ENABLE_DB_RETURNS_QUARANTINE` is absent from
  `render.yaml`, and `us-trial-capabilities.test.mjs` asserts it stays off.
- **Gaps before switching it on:**
  - the sales and procurement return pages are placeholders;
  - reversing a return posting does not check for credits against it;
  - there is no scrap disposition;
  - the trial guide does not mention returns.

**Credits exist but are unreachable.**
- `supplier-credit-memo` and `customer-credit-note` sit under the operational
  finance flag, which is on.
- **A credit can only come from a posted return:**
  - a supplier credit memo from a supplier return dispatch, line by line against
    the bill's receipt lines;
  - a customer credit note from a customer return receipt.
- **There is no screen to create or approve one;** the finance pages only list them.

**Bills.**
- **Cancel** is allowed from draft, submitted, matched or exception.
- **Approval** creates a payable.
- **After approval,** payables can be held, released, marked export-ready, paid
  and have a payment voided.
- **Nothing reverses an approved bill,** and there is no refund path.

**Customer invoices.**
- **Statuses:** draft, submitted, approved, issued. Issue creates a receivable.
- **No cancel or void exists** (`server/domain/outbound-transaction-policy.mjs`
  says so where it refuses a shipment reversal).
- **Receivables** can be disputed and resolved, and payments recorded and voided.

**Stock reversals exist and are guarded:** receipts, shipments, adjustments and
transfers. A shipment with a live customer invoice cannot be reversed, and the
message points to a return plus a credit note.

**No accounting export file exists yet.** Export-ready only changes a payable's status.

### 4.2 Switching returns on (decision RV1)

1. Point the sales and procurement return pages at the returns workbench, or remove them.
2. Refuse reversing a return posting that an approved credit is based on.
3. Add the returns section to `docs/trial-user-guide.md`.
4. Set the flag in `render.yaml` and the env examples, and update `us-trial-capabilities.test.mjs` and `deploy/README.md`.

Scrap from quarantine waits (decision RV6). Writing stock off needs a value, and
FlowChain has no cost layer.

### 4.3 Credits from returns

From a posted return, "Create credit" opens a form:
- the lines come from the return;
- the prices come from the bill or invoice lines;
- approval follows the existing approve permission.

The bill or invoice page lists its credits and its net outstanding.

### 4.4 Credits without a return (decision RV2)

| Credit | Reasons | Limit |
| --- | --- | --- |
| Supplier credit memo against a bill | Price error, billed but not received, duplicate, discount, other | Not more than the bill's total less earlier credits; each line not more than its billed amount |
| Customer credit note against an invoice | Price error, goodwill, wrong customer or quantity, cancel invoice, other | Not more than the invoice's total less earlier credits |

- **A full customer credit** with reason "cancel invoice" makes the shipment
  invoiceable again, so a correct invoice can be issued.
- **A credit larger than what is still owed** is refused for now, with "Record the
  refund in your accounting system" (decision RV5). Refunds come with the payments
  import, which is step 4 of the accounting handoff.

### 4.5 Undoing before money is final

- **Approved bill: reverse approval** (decision RV4).
  - Allowed while the payable has no payment, is not held, is not export-ready
    and has no approved credit memo. A reason is required.
  - The payable becomes void, and the bill returns to matched or exception for
    correction or cancel.
  - After that point, only a credit memo.
- **Customer invoice: cancel before issue.** An approved invoice that is not yet
  issued can be cancelled with a reason.
- **After issue,** the correction is always a credit note (decision RV3): the
  customer has the document.

## 5. Build order and rough size

Each step is its own PR with green CI. Sizes are rough, in working days.

| Order | Step | Size | Needs |
| --- | --- | --- | --- |
| 1 | Defect fixes: the value bridge shows a short-closed remainder as closed; drafts become editable (or return-for-revision is withdrawn) | 1.5–2 | — |
| 2 | `orderDate`, `source` and `importBatchId` on PO and SO; reports read `orderDate`; date-bounded report reads in place of "newest 500" | 4–5 | — |
| 3 | Open purchase order import, with historical receipts that move no stock | 4–5 | 2 |
| 4 | Line-level remainder close on POs | 1.5–2 | — |
| 5 | PO revisions: the revise command, pending revision and approval, the revision table, "Rev n" on the document, the timeline | 6–8 | 1 |
| 6 | Purchase order history import, the batch record and batch removal | 5–6 | 2, 3 |
| 7 | Returns switched on (§4.2) | 3–4 | — |
| 8 | Reverse an approved bill; cancel an approved customer invoice | 2–3 | — |
| 9 | Credit screens from returns (§4.3) | 3 | 7 |
| 10 | Credits without a return (§4.4) | 4–5 | 9 |
| 11 | Sales order revise, remainder close and the `closed` status | 4–5 | — |
| 12 | Sales order history import, and history in demand reads | 3–4 | 2, 6, 11 |
| 13 | Scrap from quarantine | 2 | A cost decision |

- **About 45–55 working days in all.**
- **December:** steps 1–4, beside the report and assistant work already planned.
  Open POs on day one matter most to a trial customer.
- **January:** steps 5–8.
- **Q1 2027:** steps 9–13. This replaces the returns and import items of the
  phase-2 list of 2026-09-30 with a concrete order.

## 6. Decisions for the owner

**Decided 2026-11-01:** the owner approved every decision below as recommended
("按推荐"). The build starts with §5 steps 1–4 in December.

### Order changes

| # | Decision | Recommendation |
| --- | --- | --- |
| OC1 | How a change that needs approval takes effect | A pending revision; the version in force stays valid until approval; one pending revision per PO |
| OC2 | What needs approval | Any rise in the PO amount and any added line. Reductions, line removals, remainder closes and dates do not |
| OC3 | Self-approval of a change | Not allowed, unless the person is the workspace's only approver. First approval is a separate decision |
| OC4 | Price changes | Only on quantity not yet invoiced; invoiced quantity keeps its price, and corrections after invoicing are credit memos |
| OC5 | Telling the supplier | "Rev n" on the PO document with changes marked; the buyer marks it sent; no email |
| OC6 | Sales order `closed` status | Written on a remainder close and when an order is fully shipped |
| OC7 | Confirmed sales order changes | Allowed without approval; not below shipped; lowering below reserved releases the extra |
| OC8 | The uneditable draft PO | Drafts become editable with the revise command, and return-for-revision stays |

### History import

| # | Decision | Recommendation |
| --- | --- | --- |
| HI1 | What history covers | POs with receipts and SOs with shipments, up to 24 months; no bills, invoices or payments |
| HI2 | Stock | History moves no stock; on-hand comes only from opening stock |
| HI3 | Data model | `orderDate`, `source` and `importBatchId` columns on PO and SO; reports date every PO by `orderDate` |
| HI4 | History in demand | Historical shipped quantities count in demand reads, by shipped date, labelled as imported |
| HI5 | Open POs at go-live | Their own import type, built first; the received part is history, and the remainder is received normally |
| HI6 | Undo | Remove a whole batch within 30 days if no live document points at it |
| HI7 | Size and reads | 10,000 rows per history file; report reads become date-bounded before history ships |
| HI8 | Matching | Suppliers, customers and items by code, which must already exist; unknown codes are row errors |

### Reverse flows

| # | Decision | Recommendation |
| --- | --- | --- |
| RV1 | Returns in the trial | Switch on after the §4.2 fixes, in January |
| RV2 | Credits without a return | Yes, with reason codes and limits as in §4.4 |
| RV3 | Correcting an issued customer invoice | Never void after issue; credit note only. A full "cancel invoice" credit makes the shipment invoiceable again. Cancel is allowed before issue |
| RV4 | Correcting an approved bill | Reverse approval while unpaid, not held, not export-ready and not credited; afterwards credit memos only |
| RV5 | Refunds | Not built; a credit beyond what is owed is refused with a message; refunds come with the payments import |
| RV6 | Scrap from quarantine | Later, with the cost layer decision |

## 7. Risks

| Risk | Answer in this design |
| --- | --- |
| A revision breaks receiving or matching in flight | Version in force stays valid; open receipt drafts block line changes; match lines already snapshot the PO price |
| The scorecard is gamed by moving dates | Original promises stay locked by trigger; revisions and date changes are audited |
| Imported history double counts stock | History writes no movements; open-PO imports move only the remainder; the preview reminds that opening stock includes what was received |
| History floods live lists or pushes live records out of reports | Final statuses only; source filter; date-bounded report reads before history ships |
| A bad file pollutes the workspace | Preview with row errors; batch removal within 30 days |
| Credits drift from the accounting system | Credits are documents with numbers and reasons; the accounting export (handoff step 3) carries them |
| Returns switched on with gaps | The four fixes of §4.2 come first, and the existing returns tests keep running in CI |
