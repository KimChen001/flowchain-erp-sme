# FlowChain handbook (research edition)

FlowChain is a purchasing, inventory and sales workspace with an AI assistant.
Since 2026-11-06 it is used as a research platform for procurement and
inventory decisions. It runs on two workspaces built from public datasets, with
every assumption labelled, and holds no company's own records.

The rules have not changed:
- FlowChain prepares documents and figures, and a person approves, sends and pays.
- It never sends anything to a supplier or a customer, and never moves money.
- The assistant changes a record only when a person clicks a button for it.

This handbook follows the order in which you meet the product. It replaces the
trial user guide of 2026-10-10. It was checked against `main` 9b74d83d on
2026-11-08.

Labels in **bold** are the words on the screen in English. Menu paths are
written as **Purchasing › Purchase orders**. FlowChain is in English by
default; Chinese is available (section 2).

Contents

1. [The two research workspaces](#1-the-two-research-workspaces)
2. [Signing in and your profile](#2-signing-in-and-your-profile)
3. [Setting up a workspace](#3-setting-up-a-workspace)
4. [Buying: from request to payment](#4-buying-from-request-to-payment)
5. [Selling: from order to payment](#5-selling-from-order-to-payment)
6. [Inventory and the reorder list](#6-inventory-and-the-reorder-list)
7. [Reports and the supplier scorecard](#7-reports-and-the-supplier-scorecard)
8. [The assistant](#8-the-assistant)
9. [How the figures are worked out](#9-how-the-figures-are-worked-out)
10. [Roles, permissions and warehouse access](#10-roles-permissions-and-warehouse-access)
11. [Known limits](#11-known-limits)

## 1. The two research workspaces

| Workspace | Dataset | Currency, time zone |
| --- | --- | --- |
| Walmart store CA_1 (M5 public data) | M5 Forecasting: daily unit sales of one Walmart store | US dollar, America/Los_Angeles |
| UK online gift retailer (UCI public data) | UCI Online Retail II: invoices of a UK online gift retailer, many of whose customers are wholesalers | Pound sterling, Europe/London |

The two businesses share nothing, so each has its own workspace and currency.
Sources, licences, selection rules and sizes are in
[Public data workspaces](public-data-workspaces.md).

**From the data:**
- items, with their selling prices;
- customers: in UCI, one in four customers, named by ID and country; in M5, one point-of-sale customer;
- sales orders, shipments and, in UCI, issued customer invoices.

Dates are moved by whole days, so the last day of the data is the day before
the workspace was seeded.

**Assumed, because public sales data has no buying side:**
- suppliers;
- a 14-day lead time and a review every Monday;
- minimum orders;
- safety stock, and a reorder point of 21 days of average demand;
- purchase prices: equal to the selling prices, as a proxy;
- the purchasing history, made by a weekly-review base-stock policy.

The UCI workspace also has one labelled scene with two fictional suppliers,
*Acme Home Goods* and *Globex Party Supplies*. In it a buyer meets:
- late orders;
- an item to reorder;
- an order waiting for approval.

**The note on every page.** Each page shows a **Public data workspace** note
saying what comes from the data and what is assumed:
- **What is assumed** opens the list, and **Hide details** closes it.
- The × hides the note. The **Public data** pill in the header brings it back.
- The note shows only on local development servers.

**Starting them.** The extract is never stored in the repository; build it
first, as [Public data workspaces](public-data-workspaces.md) describes. Then
run:

```bash
npm ci
npx prisma generate
npm run walkthrough:local -- --extract=~/flowchain-data/public-data-extract.json --ai-env=<your model settings file>
```

- The M5 workspace opens on the app port, and UCI on the next port.
  `FLOWCHAIN_WALKTHROUGH_PRIMARY=uci` swaps them.
- Without `--ai-env`, every page works except the assistant, which says it is
  not set up (section 8).
- `--reset --as-of=<day>` seeds again as of another day.

## 2. Signing in and your profile

FlowChain has no passwords. You sign in with a link sent to your email. The
sign-in page leads with the assistant: "Ask about purchasing and stock, then act
on the answer."

**On the research workspaces (local development):**
1. The sign-in page shows a **Local development** box with the workspace's accounts:

   | Account | Role |
   | --- | --- |
   | admin@flowchain.local | Workspace administrator |
   | kim@example.com | Operations manager |
   | daniel@example.com (UCI only) | Operations manager: the scene's buyer |

2. Choose **Use local administrator** (or **Use local manager**), then **Email me a sign-in link**.
3. Choose **View the sign-in link**, then **Open the sign-in link**. No email leaves the computer: the link comes from the local outbox.
4. On the next page choose **Sign in to** followed by the workspace name.

**On a deployed server:**
1. Enter your **Work email** and choose **Email me a sign-in link**.
2. Open the email "Your FlowChain sign-in link" on the same device. The link works once and expires after 15 minutes. **Resend the link** is offered after 60 seconds.
3. On **Finish signing in**, choose **Sign in to** followed by the workspace name.

Only people added to the workspace can sign in. When a stored session is no
longer accepted, the page says "Your session ended. Sign in again to continue."

**Joining from an invitation.** Open the invitation link, enter **Your name** and
choose **Accept and email me a sign-in link**. An invitation works once and
expires after 3 days.

**Language.**
- Before signing in, use the language selector on the sign-in page (**English** or **中文**).
- After signing in, open **System administration › My profile** (also in the user menu) and change **Interface language**. **Follow workspace default** uses the workspace's language.

Changing the language changes only the words on the screen. Currencies, number
and date formats, the time zone, and recorded names and numbers stay as they are.

**Your profile.** **My profile** shows your name, job title, email, roles and
default warehouse.

**Approval emails.** FlowChain emails the people who may approve something when:
- a purchase request or purchase order is submitted;
- a supplier invoice becomes ready to approve;
- an inventory adjustment is created.

The email gives only the document type and number, with a link, and it cannot
approve anything. You never get one about your own action. Switch it off with
**Email me when something is waiting for my approval** in **My profile**. On
local servers the email goes to the local outbox.

## 3. Setting up a workspace

The research workspaces come set up. This section is for a new workspace, and
explains the settings you will see in the research ones.

### Workspace settings

**System administration › Company & workspace** has:
- **Workspace name**, the company name, **Default interface language**, **Regional format**, **Timezone** and **Base currency**. The base currency shows **Locked** once posted transactions exist.
- **Documents:** the letterhead, the **Default document language**, and the purchase order and invoice templates used when a document is printed or saved as PDF.

The research workspaces are set as follows:

| Workspace | Currency, time zone | Warehouse |
| --- | --- | --- |
| M5 | USD, America/Los_Angeles | "Store CA_1 stockroom" |
| UCI | GBP, Europe/London | "Main warehouse" |

In both, the warehouse code is MAIN, with the locations A-01 "Main stock" and
QC-01 "Quality check".

**Numbering rules** (in effect). Documents are numbered PREFIX-YYYYMM-NNNN:
- The server assigns the number when the document is saved; nobody types it.
- The sequence restarts each month in workspace time and grows past four digits when needed.
- The prefixes are PR, RFQ, PO, GRN, SO, DN, CI, CT, TR, CC and ADJ.
- Supplier invoices keep the supplier's own number. Returns and credit notes are not numbered yet.
- Only the prefix can be changed (1–8 letters or digits), by an administrator.
- The page lists **Document**, **Prefix**, **Format this month** and **Status**.

**Review policies.** Two settings are in effect:
- the **Invoice matching tolerances** used by the three-way match (section 4);
- **Purchase order approval**: "A purchase order made from an approved purchase request is approved with it", on in a new workspace.

The settings under **Other review settings** are marked as not in effect.

**Users & roles**, **Warehouses & access** and **AI governance**: see sections 10 and 8.

### Warehouses

An administrator adds a warehouse in **System administration › Warehouses &
access**:
1. Choose **New warehouse**.
2. Enter a **Code**: up to 32 letters, digits, hyphens or underscores. It cannot change later.
3. Enter a **Name**, then choose **Add warehouse**. Whoever adds it gets **Operate** access.

**Set inactive** works once nothing is in the warehouse or waiting on it. The
page lists what is in the way: stock, reservations, receipts, counts, transfers,
adjustments, quarantine stock, return postings or open purchase orders. The last
active warehouse cannot be set inactive.

Locations (bins) need no setup: you name them when you import opening stock or
receive goods.

### Importing data

**Master data › Import data** creates records from a CSV or XLSX file. Existing
records are skipped, never changed.

**Who can import:**
- Items, item suppliers and suppliers need a role that manages them: Workspace
  administrator, Operations manager, Operations specialist or Procurement specialist.
- Customers and opening stock need a Workspace administrator, Operations
  manager or Operations specialist.

**Order and steps.** Import items, suppliers, customers, item suppliers, then
opening stock. For each type:
1. **Download template**. Headers in English or Chinese are both accepted.
2. Fill in your rows, keep the header row, and save as CSV (UTF-8) or XLSX.
3. **Choose file**, then **Check file**. Nothing is saved yet. Each row shows whether it will be created, skipped because it exists, or refused for an error.
4. **Import {n} rows**. Rows with errors are never imported.
5. **Download results** keeps a copy of what happened to each row.

**Limits:** 2 MB, 2,000 rows and 50 columns per file.

| File | Required columns | Useful optional columns |
| --- | --- | --- |
| Items | SKU, Item name, Unit | Category, Safety stock, Reorder point, Lead time (days), Status |
| Suppliers | Supplier code, Supplier name | Email, Default currency, Payment term code (for example NET30), Lead time (days) |
| Customers | Customer code, Customer name | Contact, Email, Payment terms, Currency |
| Item suppliers | SKU, Supplier code | Supplier SKU, Reference price, Currency, Minimum order quantity, Preferred |
| Opening stock | SKU, Warehouse code, Location, Quantity | Unit |

Every workspace has the payment terms Due on receipt, Net 15, Net 30, Net 45
and Net 60 (DUE, NET15, NET30, NET45, NET60).

**Opening stock** is not added to stock straight away:
1. The import creates one draft adjustment per warehouse (ADJ-YYYYMM-NNNN). The results link to it.
2. A person checks it in **Inventory › Inventory operations › Inventory adjustments**: **Mark ready**, **Preview posting**, then **Confirm**.

Only then does the quantity appear in the inventory balances. No cost is recorded.

### Setting up from the chat

**Today** shows a **Set up your workspace** checklist with five steps, from
importing items to inviting a teammate.

The assistant offers **Help me set up my workspace**:
- Paste suppliers or items into the chat and it shows a **New suppliers and items** card.
- Check each row, then choose **Create {count} records**. The card takes up to 25 rows.
- It needs a role that may add suppliers or items, and an AI model (section 8).

## 4. Buying: from request to payment

The usual path is: purchase request → approval → purchase order → issue →
receipt → supplier invoice → three-way match → approval → payment record.

Every list under **Purchasing** has the same layout:
- metric cards at the top: select one to filter the list;
- a search card with **Reset**, **Refresh** and **Export results**;
- the list, with its count.

On a phone, rows become cards and the extra filters fold behind **Filters**.

**1. Purchase request.**
- **Purchasing › Purchase requests › New purchase request**. For each line enter:
  - the item and quantity;
  - the supplier, which must be one of the item's suppliers;
  - **Estimated unit price**;
  - **Destination warehouse or service location**;
  - **Required date**.
- **Save draft** or **Save and submit**. The number (PR-…) is assigned on save.
- If the item has a preferred supplier and you choose another, pick a reason; the approver sees it.
- The list's cards are **Drafts**, **Awaiting approval**, **Ready for a purchase order** and **Converted to purchase orders**.

**2. Approval.**
- On the list, a submitted request has **Approve**, **Reject** (asks "Why is it rejected?") and **Withdraw**. Withdraw asks you to confirm and returns the request to draft.
- A draft's page has **Edit** and **Submit for approval**.

**3. Purchase order.**
- On an approved request choose **Create purchase order**. FlowChain makes one purchase order per supplier, currency and warehouse.
- With the default review policy the order is approved with the request. Otherwise it starts as a draft: **Submit for approval**, then **Approve**.
- Other order actions are **Reject**, **Cancel PO** and **Close PO**. Close PO ends an issued order whose remaining quantity will not come, with a reason.

**4. Issue.**
1. On the approved order choose **Open PO document**, then **Print or save as PDF**. **Document language** changes the language of one print.
2. Send the document to the supplier yourself.
3. Choose **Mark as issued to supplier**. This records that you sent it; FlowChain does not send it.

**5. Receiving.**
1. On the order choose **Receive**.
2. Enter the **Receiving warehouse** and the **Arrival time**. For each line enter the **Accepted** quantity, any **Rejected** quantity with a **Rejection reason**, and the **Location**.
3. Choose **Save and submit for posting**. A draft receipt offers **Edit draft**, **Submit for posting** and **Cancel receipt**.
4. On the receipt choose **Post receipt**, then **Confirm posting**. Only accepted quantities become stock, and a partial delivery leaves the rest open.

After posting:
- **Reverse receipt** then **Confirm reversal** undoes a posted receipt, unless a supplier invoice already claims it.
- Receipts are listed under **Purchasing › Receipts**, with the cards **Receipts**, **Posted**, **Not posted** and **With rejections**.
- **Print receive sheet** prints a receipt.

**6. Supplier invoice.**
- Supplier invoices are under **Purchasing › Supplier invoices**. Choose **Record supplier invoice** on a posted receipt, or **New supplier invoice**.
- Enter the supplier's own invoice number, the dates and the invoiced lines, then **Preview** and **Create draft**.
- An invoice can be recorded before the goods arrive. It then waits for **Link receipt**.
- FlowChain flags an invoice that looks like a duplicate.
- The list's cards are **Awaiting match**, **Match exceptions**, **Matched, to approve** and **Approved**.
- The research workspaces have no supplier invoices: their purchasing side is assumed and stops at receipts.

**7. Three-way match.**
1. On the invoice choose **Submit**, then **Match**.
2. **Match by line** compares each invoice line with the purchase order and the receipt, net of tax. Its columns are PO line, Ordered, Received, Invoiced, PO price, Expected, Invoiced (net) and Variance, and a summary ends the table.
3. Differences within the **Invoice matching tolerances** pass. Anything else is a **Match exception**: the invoice page says why first, with **Open the three-way match**.
4. Choose **Approve**. The invoice moves to **Payables & receivables › Supplier invoices to pay**.

**8. Payment record.**
1. Pay the supplier the way you always do.
2. On the invoice choose **Record payment** and enter the date, amount, method and reference. Partial payments are allowed.
3. A wrong entry is voided with a reason, never deleted.

FlowChain records payments; it never moves money.

## 5. Selling: from order to payment

**1. Sales order.**
1. **Sales › Sales orders › New sales order**. Choose the **Customer**. Their payment terms show under the choice, and their currency replaces the workspace currency.
2. Enter the lines with item, quantity and **Unit price** (**Add line** adds another), and **Promised date (optional)**. The order number (SO-…) is assigned on save.
3. **Save draft**. It stays disabled until every line has a price.
4. A draft can be changed with **Edit draft**. **Confirm order** confirms it.

The order shows its customer and **Order total**, and offers **Put on hold**,
**Resume** and **Cancel order**.

**2. Reserve.** On the confirmed order choose **Reserve inventory**, pick the
warehouse and location, check the preview and confirm. **Release reservation**
gives the stock back.

**3. Ship.**
- **Create shipment draft** for the reserved quantity, then **Post shipment**. Posting takes the quantity out of stock.
- **Reverse shipment** undoes it with a reason, unless a customer invoice holds it.

**4. Customer invoice.**
1. Customer invoices are under **Sales › Customer invoices**: **Create customer invoice** from a shipment, or **New customer invoice**. The price comes from the sales order and the number (CI-…) is assigned on save.
2. **Preview** and **Create draft**, then **Submit**, **Approve** and **Issue invoice**. Issuing creates the receivable under **Payables & receivables › Receivables**.
3. To send it: **Open invoice document**, then **Print or save as PDF**, and send it yourself. An approved invoice that is not yet issued prints marked "Not issued — do not send."

**5. Payment received.** On the issued invoice choose **Record payment
received**.

**In the research workspaces:**
- UCI has one shipped sales order per public invoice, each with an issued
  customer invoice paid on its due date.
- M5 has one order per day for the store's point of sale, with no invoices.

## 6. Inventory and the reorder list

- **Inventory balances** shows, per item, warehouse and location: **On hand**, **Reserved**, **Available**, **Safety stock** and the reorder point. Available = on hand − reserved.
- **Inventory movements** lists every posted change with its **Source document**.
- **Inventory operations** holds three kinds of draft document, each checked with a preview and posted by a person:
  - **Inventory transfers** move stock between locations or warehouses. A posted transfer can be reversed.
  - **Cycle counts** record counted quantities (optionally as a **Blind count**) and post the variance. A posted count cannot be reversed.
  - **Inventory adjustments** change a quantity with a reason. A posted adjustment can be reversed.

**Reorder list** (**Inventory › Reorder list**):
- **Stock position.** For each item, on hand − reserved + incoming. Incoming counts every open purchase order line: approved, issued or partly received, whatever its due date. A late line still counts and is flagged "late, counted; confirm with the supplier".
- **Ranking.** Items are ranked by the day the stock position is expected to reach the item's recorded reorder point. Items without a reorder point are not checked.
- **Suggested reorder point.**
  - It shows under the recorded value as **Suggested {value}**, with **Below suggestion** when the recorded value is lower. Section 9 says how it is worked out.
  - **Set reorder point…** opens a dialog prefilled with the suggestion. **Set reorder point** saves it as an audited item update. Until then the list keeps using the recorded value.
- **Ordering.** Nothing is ordered automatically: **Create purchase request** opens a prefilled request to check and submit.

You see and change stock only in warehouses you have access to (section 10).

## 7. Reports and the supplier scorecard

**Reports** has **Business overview**, **Procurement analytics**, **Sales
analytics**, **Inventory analytics**, **Invoice analytics**, **Supplier
analytics** and the **Report library**.

**On every dashboard:**
- **Dates.** The presets are This month, Last 3 months, Year to date, Last 12 months and All dates. The supplier page ends with Last 90 days instead of All dates.
- **Filters.** **More filters** offers Supplier, Customer and Currency, and **Clear filters** clears them.
- **Page controls.** **Customize view**, **Metric definitions**, **Export** (a workbook of five sheets) and **Save view**.
- **Compare with.**
  - **Previous period** compares the range with the period of the same length before it. It is offered when the range has a start and an end date.
  - Six figures are compared: committed purchase order amount, sales order amount and count, invoice amount, on-time deliveries, and suppliers with committed orders.
  - The change shows as a neutral blue badge. With no earlier figure the card says "No figure for the previous period".
- **Key findings.** The band above the charts states up to four findings from the page's own figures, largest change first, each with **Open the records →**. On the Business overview, the items needing attention sit with them, above the charts.
- **Charts.**
  - Colors follow the brand palette, and status colors keep their meaning: teal done, blue in progress, orange waiting, red a problem, grey draft, cancelled or closed.
  - Statuses are shown as segmented bars, stages as stage bars, and ordered → received → invoiced as a horizontal bridge.
  - Selecting a part of a chart filters the page.
  - Each chart offers **Download image**, **Download CSV** and **Focus mode**.

**Open purchase orders** (the first view of Procurement analytics):
- The views are **Open orders**, **Overdue**, **Missing data** and **All orders**, with the panel **Suppliers with overdue orders**.
- Amounts are full order amounts, not what is left to pay.
- Days overdue count by the workspace's calendar day.

**How to read the figures:**
- Only recorded values are used. A missing value shows as **Unavailable** or —, never as a guess.
- Amounts are never added across currencies. Each currency has its own total, and nothing is converted.
- Quantities are never added across items or units. Such a total shows "Multiple SKUs", "Mixed units" or "Units differ, so there is no total".
- A figure your role may not see says "Your role cannot view this figure". Inventory figures cover only the warehouses your role can see.
- In the research workspaces, purchase amounts use selling prices as a proxy. Read them as volumes in money, not as costs.

**Supplier performance** (in **Supplier analytics** and on a supplier's
**Performance** tab):
- **What is measured.** Deliveries against the date first promised when the order was approved, over the last 90 days by default. A delivery is the lines of one purchase order that share a promised date.
- **Which orders count.** Only orders issued to the supplier, or with a posted receipt. Approved orders not yet sent are listed as **Not sent to supplier: {n}**.
- **Small samples.** A supplier with fewer than five deliveries shows "Fewer than 5 deliveries" instead of a rate.
- **In the research workspaces,** assumed suppliers deliver on time, except in the UCI scene.

**Report library:**
- The tabs are **Standard reports**, **My reports**, **Team reports** and **Recently opened**.
- **Create report** saves a private report.
- Owners can share or delete their reports.

## 8. The assistant

### Opening it

- Open it with **AI assistant** in the sidebar or the button at the bottom right.
- On a wide screen it docks on the right and the page narrows. On a narrow screen it opens over the page, and on a phone it fills the screen.
- **Expand AI workspace** and **Minimize** change its size.
- A chip shows what it is looking at: "Whole workspace", or the record of the page you are on. **Stop using this record** returns it to the whole workspace.
- It answers in the language of your question, English or Chinese. Dates keep the form "Nov 4, 2026" in both languages.

### What it needs

The assistant answers only through an AI model. Since 2026-11-07 there is no
rules engine behind it. It answers when three things hold:
- **The server has a model service.** The trial servers use Claude Sonnet through MIT Parley; a local server uses the settings file given to it.
- **AI is switched on for the workspace.** An administrator does this in **System administration › AI governance** with "Use an AI model in this workspace". On local development servers every workspace may use the model, and no switch is needed.
- **The workspace is under its monthly cap.** The cap is $25 on the trial servers.

Otherwise it shows a notice and no answer:

| Notice | When |
| --- | --- |
| AI is off for this workspace | The switch is off |
| The assistant is not set up on this server yet | No model service |
| This month's assistant allowance is used | Over the monthly cap |
| The assistant is not available right now. Nothing was changed. | The model service failed |

Other limits:
- a question is at most 8,000 characters;
- 30 questions per person per 10 minutes;
- an answer may cost at most $0.20 of model use;
- a conversation is kept for 2 hours or 20 turns.

### What it can answer

It reads your records with tools, under your own permissions:
- **Work queues.** What needs attention today, records missing data, open purchase requests.
- **Documents.** Purchase orders (one in detail), sales orders, receipts, supplier invoices, requests for quotes and their quotes, contracts.
- **Stock.** Stock position, a week-by-week projection, and which sales orders a late purchase order puts at risk.
- **Suppliers.** An item's approved suppliers and terms, price history, supplier performance and supplier risks.
- **Money and sales.** Spend, sales from customer invoices, and receivables.
- **Search.** Across records and the workspace's documents.
- **Arithmetic.** Done on the server, never in the model's head.

**For deciding what and how much to order:**
- **The reorder list,** with the suggested reorder point and its basis.
- **Order size and holding cost.** Orders a year, holding cost, break-even cost per order, and the economic order quantity. Holding cost is assumed at 25 % of value a year, and the answer says so.
- **The order plan.** It is solved exactly for several items at once, within a budget and minimum orders. The plan is costed against ordering nothing, the reorder list, and your own plan. Its quantities reach the request form marked **Best order plan**. See section 9.

### What it prepares, and the clicks it needs

The model has no tool that writes. Every change is a button you press in your
own session.

**Purchase request form.**
- Each value carries its source, for example "Reorder gap", "Gap raised to minimum", "Preferred supplier" or "Best order plan".
- Suggested rows start unticked; **Add all suggested** and **Order anyway** add them.
- **Create draft request (N lines)** creates the draft. Then **Submit for approval**, **Cancel draft**, **Withdraw** and **Open full form** are offered.
- A supplier not yet approved for the item shows as "(not yet approved)". Creating the request also adds that supplier link, so it needs a role that manages item suppliers.

**Record cards.**
- A purchase request card offers **Submit for approval**, **Approve**, **Reject**, **Create purchase order** and **Request quotes (RFQ)**.
- A purchase order card offers **Approve** and **Mark as issued**.
- Every step except submitting needs a second **Confirm** click, and Reject needs a reason.
- Mark as issued sends nothing to the supplier. Request quotes creates the RFQ and sends nothing until it is opened.

**Setup cards.** See section 3.

**Messages to suppliers.** These appear as quoted text with **Copy**. You send
them yourself.

**It never:**
- pays, sends or emails anything;
- cancels, withdraws or deletes; it tells you where to do that in the app;
- says something was done unless the server has checked your click;
- shows what your role may not see; it says "Your role can't see …".

### Checks you may see in an answer

- A dotted underline marks a number, date, name or record number not matched to your records ("Not matched to your records").
- A note says a sentence was left out when it read as if something had been done for you.
- "[not shown]" replaces a value your role may not see. When that happens mid-answer, the answer stops and says why.
- Record numbers in the text are chips that open the record.

### What is sent to the model

Each model call sends:
- the conversation on your thread: your questions, the earlier answers, the tool calls and the tool results;
- the records the assistant reads to answer. These are only records your role may see, with hidden amounts left out and no contact emails or phone numbers;
- a context line: the answer language, the workspace's day, currency and time zone, and the page's record;
- for questions about documents, the matching passages.

FlowChain's own log keeps codes and counts per answer, never the words. Details
are in [AI workspace access](ai-workspace-access.md).

## 9. How the figures are worked out

These are the rules behind the decision figures, for anyone using FlowChain in
research. Each points to the code or document that defines it.

**Stock position and order-by date** (reorder list, `server/domain/reorder-list.mjs`):
- **Stock position** = on hand − reserved + every open purchase order line still to receive.
- **Order-by date:** the day the position is expected to reach the recorded reorder point at the item's recent daily demand. Demand is the quantity shipped over the last 90 workspace days.

**Suggested reorder point** (`server/domain/reorder-point-suggestion.mjs`):
1. Take H = lead time of the preferred supplier + 7 review days.
2. Form the 90 sums of H consecutive days of the last 90 days of shipments, wrapping round.
3. The suggestion is the 75th smallest sum, rounded up: enough for the next H days in 5 of 6 past stretches.
4. 5/6 is the newsvendor critical ratio when a unit short costs five times what holding one costs.

There is no suggestion when the item shipped on fewer than 8 of the 90 days,
the stock unit is not recorded, or the supplier link has no lead time.

**On-time deliveries** (`server/domain/supplier-scorecard.mjs`):
- A delivery is the lines of one purchase order that share an originally promised date.
- It is on time when every line's first posted receipt arrived by that date plus the grace days.
- A rate needs at least five deliveries.

**Order plan** (`optimize_order_plan`; [Replenishment solver](replenishment-solver.md)):
- **Method.** An exact sample-average mixed-integer plan, solved with HiGHS, over 200 demand scenarios drawn from the last 90 days of shipments. It stays within the budget and minimum orders.
- **Costs.** Holding cost is h = 25 %/year × price × (lead time + 7)/365, and shortage cost is 5h, the same ratio as above. These are defaults: the user can give another holding rate, review period or service level s, and shortage cost then becomes s/(100 − s) × h.
- **In the research workspaces,** prices are selling prices used as a proxy for cost (section 1).

**The assistant's evaluation.** Assistant v2 is evaluated on the public data
with the cases in `tests/ai-eval/v2-public/`: demand, stock days, reorder,
order size and budgeted order plans, in English and Chinese.

## 10. Roles, permissions and warehouse access

An administrator manages people in **System administration › Users & roles**:
- **Create invitation** for a teammate's email with a role, then **Copy link** and send it yourself. It works once and expires in 3 days; FlowChain does not email it.
- Changing a role asks to confirm and signs the person out, so the new role applies.
- Disabling a person signs them out and keeps their history.
- Custom roles can be made with **Create role** or **Copy role**.

The standard roles:

| Role | Typical work |
| --- | --- |
| Workspace administrator | Everything, including settings, users, roles and numbering |
| Operations manager | Approvals, purchasing, receiving, sales, inventory, finance and contracts |
| Operations specialist | Receiving, sales orders and shipments, supplier invoice entry and matching, and inventory drafts (a manager posts counts and adjustments) |
| Procurement specialist | Purchase requests and orders, items, suppliers and contracts |
| Finance specialist | Supplier and customer invoices, matching and payment records |
| Read-only viewer | Looks at records; cannot change them or see amounts |

For example, a Procurement specialist can submit a purchase request but not
approve it. If a button you expect is missing, your role probably does not
include it.

**Warehouse access.** In **System administration › Warehouses & access**, an
administrator gives each person **Read** or **Operate** access per warehouse, or
**No access**:
- You receive, ship, count and adjust only where you have **Operate**.
- Reports show stock only from warehouses you can see.
- A new administrator has Operate everywhere; other new members have no access until it is granted.

## 11. Known limits

**What FlowChain does not do:**
- It does not send anything to suppliers or customers. Documents are printed or saved as PDF in your browser, and you send them. The **Print templates** list under Master data previews layouts; it does not save them.
- It sends two kinds of email only: the sign-in link and approval emails.
- It is not an accounting system: no general ledger, tax filing, bank connection or payment execution.

**Not built yet:**
- **Changing an order.** A purchase order's quantities, prices and lines cannot change once it exists. A sales order cannot close its unshipped remainder.
- **Correcting an approved bill or an issued customer invoice.**
- **Returns, quarantine and credit notes.** These are built and tested but switched off.
- **Importing past or open orders.**

The design for all four is in
[Order changes, history import and reverse flows](order-changes-history-reverse-design.md).

**Also:**
- **The assistant needs a model.** Without one it gives no answers (section 8).
- **The same person can create and approve a document.** There is no separation-of-duties check on purchase requests, purchase orders, supplier invoices or adjustments.
- **The research workspaces are subsets with stated assumptions:**
  - one in four UCI customers and 200 of its products;
  - 196 of CA_1's items;
  - assumed suppliers that deliver on time;
  - purchase prices equal to selling prices;
  - UCI cancellations not posted as returns.

  See [Public data workspaces](public-data-workspaces.md).
- **Translations.** A few screens and messages may not be fully translated in both languages.

The technical list of limits is in
[Current development limitations](current-development-limitations-v1.md).

For questions about the research setup, contact the project owner.
