# FlowChain handbook (research edition)

FlowChain is a purchasing, inventory and sales workspace with an AI assistant.
Since 2026-11-06 it is used as a research platform for procurement and
inventory decisions. It runs on two workspaces built from public datasets, with
every assumption labelled, and holds no company's own records.

The rules have not changed:
- FlowChain prepares documents and figures, and a person approves, sends and pays.
- It never moves money. It sends nothing to a supplier or a customer, with one
  exception that is off by default: the follow-up email on an overdue purchase
  order, sent only after a person confirms its text and then its address
  (section 4).
- The assistant changes a record only when a person clicks a button for it.

This handbook follows the order in which you meet the product. It replaces the
trial user guide of 2026-10-10. It was checked against `main` df9f3260 on
2026-11-18.

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

| Workspace | Dataset | Currency, time zone, regional format |
| --- | --- | --- |
| Walmart store CA_1 (M5 public data) | M5 Forecasting: daily unit sales of one Walmart store | US dollar, America/Los_Angeles, en-US (Nov 18, 2026) |
| UK online gift retailer (UCI public data) | UCI Online Retail II: invoices of a UK online gift retailer, many of whose customers are wholesalers | Pound sterling, Europe/London, en-GB (18 Nov 2026) |

The two businesses share nothing, so each has its own workspace and currency.
Dates and numbers follow the workspace's regional format in both interface
languages. Sources, licences, selection rules and sizes are in
[Public data workspaces](public-data-workspaces.md).

**From the data:**
- items, with their selling prices;
- customers: in UCI, one in four customers, named by ID and country; in M5, one point-of-sale customer;
- sales orders, shipments and, in UCI, issued customer invoices.

**Dates** move by whole weeks, so weekdays match the data: a Saturday in the
data is a Saturday in the workspace, and the weekly reviews fall on the data's
Mondays. The last day of the data is the day before the workspace was seeded;
the data's newest days that would fall on or after that day (0 to 6 of them)
are left out. Holidays and seasons move with the dates.

**Assumed, because public sales data has no buying side** (each labelled in the
workspace):
- suppliers: one per M5 department, one per UCI StockCode family;
- a 14-day lead time and a review every Monday;
- minimum orders: a week of the first 90 days' average daily demand, rounded up to a multiple of 10 (at least 10);
- thresholds, set again at each Monday review from the 90 days before it only, so no threshold and no order uses later demand. The data's first 90 days are a calibration period:
  - reorder point: the reorder list's own suggestion (section 9), enough for 21 days in 5 of 6 past stretches;
  - order-up-to level: the app's default, the reorder point plus 7 days of average demand (section 9);
  - safety stock: 7 days of average demand;
- purchase prices: a share of the public selling price, because neither dataset has costs: 50 % in UCI (of the product's median price) and 75 % in M5 (of the store's price on the day of the order);
- the purchasing history, made by the reorder list's own rule at each Monday review. When a day's demand was more than the stock on hand, more was bought after the fact and marked, so every public order shipped in full. Do not use the seeded order history as a manual baseline in research;
- supplier tiers, set 40 days before the seed day from each supplier's share of purchase spend over the year before: the suppliers making up the first 70 % of spend are Tier 1, the next up to 90 % Tier 2, the rest Tier 3;
- purchase requests: two in each state (draft, submitted, approved, converted to a purchase order, rejected, cancelled), raised by the buyer in the last 14 days, and approved or rejected by a second person;
- in UCI, six of the newest sales orders are still being filled (section 5), and supplier invoices, three-way matches and payments follow stated rules (section 4);
- no VAT or other tax: every customer and supplier invoice has tax 0.

The UCI workspace also has one labelled scene with two fictional suppliers,
*Acme Home Goods* and *Globex Party Supplies*, and a buyer, Daniel. Acme is Tier
1, as the sole source of the scene's main item. In the scene a buyer meets:
- late orders from both suppliers;
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
- `--no-auto-sign-in` shows the sign-in page instead of signing in by itself (section 2).
- With the local forecast service running (`tools/forecast-service/README.md`),
  `FLOWCHAIN_FORECAST_URL` adds the TimesFM line to the reorder list (section 6).

## 2. Signing in and your profile

FlowChain has no passwords. You sign in with a link sent to your email. The
sign-in page leads with the assistant: "Ask about purchasing and stock, then act
on the answer."

**On the research workspaces (local development):**
1. The local walkthrough signs you in by itself as the local administrator ("Signing in as …").
2. The sign-in page shows a **Local development** box with the workspace's accounts, after you sign out or with `--no-auto-sign-in`:

   | Account | Role |
   | --- | --- |
   | admin@flowchain.local | Workspace administrator |
   | kim@example.com | Operations manager |
   | daniel@example.com (UCI only) | Operations manager: the scene's buyer |

3. **Use local administrator** (or **Use local manager**) signs in with one click.
4. With `--no-auto-sign-in`, the buttons fill in the email instead. Then choose **Email me a sign-in link**, **View the sign-in link** and **Open the sign-in link**, and on the next page **Sign in to** followed by the workspace name. No email leaves the computer: the link comes from the local outbox.

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

**Your profile.** **My profile** shows your name, job title, email, role and
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
- **Workspace name**, the company name, **Default interface language**, **Regional format** (en-US, en-GB or zh-CN), **Timezone** and **Base currency**. The base currency and the time zone are locked once posted transactions exist.
- **Documents:** the letterhead, the **Default document language**, and the purchase order and customer invoice templates used when a document is printed or saved as PDF.

The research workspaces are set as follows:

| Workspace | Currency, time zone, regional format | Warehouse |
| --- | --- | --- |
| M5 | USD, America/Los_Angeles, en-US | "Store CA_1 stockroom" |
| UCI | GBP, Europe/London, en-GB | "Main warehouse" |

In both, the warehouse code is MAIN, with the locations A-01 "Main stock" and
QC-01 "Quality check".

**Numbering rules** (in effect). Documents are numbered PREFIX-YYYYMM-NNNN:
- The server assigns the number when the document is saved; nobody types it.
- The sequence restarts each month in workspace time and grows past four digits when needed.
- The prefixes are PR, RFQ, PO, GRN, SO, DN, CI, CT, TR, CC and ADJ.
- Supplier invoices keep the supplier's own number. Returns and credit notes are not numbered yet: their rows (RR, RA, RP, CM) are marked not in effect.
- Only the prefix can be changed (1–8 letters or digits), by an administrator.
- The page lists **Document**, **Prefix**, **Format this month** and **Status**.

**Review policies.** Three settings are marked **In effect**:
- **Purchase order approval**: "A purchase order made from an approved purchase request is approved with it", on in a new workspace.
- **Supplier follow-up email**: "Let Today email a follow-up to the supplier of an overdue purchase order", off in a new workspace. While it is off, Today offers the text to copy and FlowChain sends no email.
- The **Invoice matching tolerances** used by the three-way match (section 4). A new workspace starts with a quantity tolerance of 0, a unit price tolerance of 2 % and a line amount tolerance of 1 currency unit. A workspace that saved its own values keeps them.

The settings under **Other review settings** are marked as not in effect.

**Users & roles**, **Warehouses & access** and **AI governance**: see sections 10 and 8.

### Warehouses

An administrator adds a warehouse in **System administration › Warehouses &
access**:
1. Choose **New warehouse**.
2. Enter a **Code**: up to 32 letters, digits, hyphens or underscores, saved in capitals. It cannot change later.
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
  manager or Operations specialist. Opening stock also needs **Operate** access to each warehouse in the file.

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
| Customers | Customer code, Customer name | Contact, Email, Payment terms, Currency, Country, Credit status |
| Item suppliers | SKU, Supplier code | Supplier SKU, Reference price, Currency, Minimum order quantity, Lead time (days), Preferred |
| Opening stock | SKU, Warehouse code, Location, Quantity | Unit |

The item import has no order-up-to level or lot size column; set those on the
item form (section 6).

A new workspace starts with the payment terms Due on receipt, Net 15, Net 30,
Net 45 and Net 60 (DUE, NET15, NET30, NET45, NET60). A workspace that already
had payment terms keeps its own.

**Opening stock** is not added to stock straight away:
1. The import creates draft adjustments (ADJ-YYYYMM-NNNN): one per warehouse for every 200 rows. The results link to them.
2. A person checks each in **Inventory › Inventory operations › Inventory adjustments**: **Mark ready**, then **Post adjustment**, which shows each line's stock before and after, then **Post**.

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
- a search card with **Reset**, **Refresh** and **Export results**, which exports every row the filters match;
- the list, with its count.

On a phone, rows become cards and the extra filters fold behind **Filters**.

### Today: the next step, prepared

**Today** lists what is **Waiting for your decision**, each with the next step
FlowChain prepared. Nothing is created or sent until you click:
- **An item to reorder:** a purchase request with its supplier and quantity (section 6). **Review and create the request** opens it filled in.
- **An overdue purchase order:** a follow-up to the supplier with the lines still to receive. **Copy and mark chased** copies the text. When the review policy allows supplier email, **Review and send** asks you to confirm the text, then the address, and sends it; a research workspace writes it to the local outbox only. An order approved but never issued is not chased: the card says to send the order first.
- **An approved purchase request:** the purchase orders it would become, one line per supplier and currency. Before the second click the card says what it will create, for example "Will create 1 approved purchase order", and lists the lines. **Create the purchase orders** makes them.
- **A supplier invoice held at the match:** each difference, its likely cause and a next step, with a message to the supplier to copy (**Copy and mark contacted**).

**Not now** and **Not needed** set a card aside with a reason. It comes back by
itself when its condition changes materially.

**1. Purchase request.**
- **Purchasing › Purchase requests › New purchase request**. For each line enter:
  - the item and quantity;
  - the supplier, one of the item's suppliers;
  - **Estimated unit price**;
  - **Destination warehouse or service location**;
  - **Need by**. It is not filled in for you, except from a supplier's recorded lead time.
- **Save draft** or **Save and submit**. The number (PR-…) is assigned on save.
- If the item has a preferred supplier and you choose another, pick a reason; the approver sees it.
- The list's cards are **Draft**, **Pending approval**, **Approved** and **Converted to PO**.

**2. Approval.**
- A submitted request offers **Approve** and **Reject** (asks "Why is it rejected?") only to someone who may approve it (section 10). It also offers **Withdraw**, which asks you to confirm and returns the request to draft.
- **Cancel request** asks "Why is it cancelled?". A request can be cancelled until it becomes a purchase order, and a cancelled one cannot be reopened.
- A rejected request offers **Return to draft**, to revise it and submit it again.
- A draft's page has **Edit**, **Submit for approval** and **Cancel request**.

**3. Purchase order.**
- On an approved request choose **Create purchase order**. A dialog first lists the orders it will make, one per supplier, currency and warehouse, with their lines and amounts, and says whether they start approved or as drafts.
- It refuses, and creates nothing, when a line has no price above 0 or its supplier is not active.
- With the default review policy the order is approved with the request. Otherwise it starts as a draft: **Submit for approval**, then **Approve**.
- Other order actions are **Reject**, **Cancel PO** and **Close PO**, each asking why. Close PO ends an order whose remaining quantity will not come.
- When every order made from a request is cancelled or rejected, the request is approved again, so it can be ordered again.
- An order with a supplier invoice that is not cancelled cannot be cancelled. An order cannot be closed while one of its invoices has a match difference still to review.

**Requests for quotes.** **Purchasing › RFQs & quotations** records and compares
supplier quotes. An RFQ cannot be turned into a purchase order yet, and the
assistant no longer offers one:
- A draft RFQ offers **Open RFQ**, which marks its suppliers invited and sends them nothing.
- A draft or open one offers **Cancel RFQ**. Its quotes stay on record, and its purchase request can then be turned into a purchase order.

**4. Issue.**
1. On the approved order choose **Open PO document**, then **Print or save as PDF**. **Document language** changes the language of one print.
2. Send the document to the supplier yourself.
3. Choose **Mark as issued**. This records that you sent it; FlowChain does not send it.

**5. Receiving.**
1. On the order choose **Receive**.
2. Enter the **Receiving warehouse** and the **Arrival time**. For each line enter the **Accepted** quantity, any **Rejected** quantity with a **Rejection reason**, and the **Location**.
3. Choose **Save and submit**. A draft receipt offers **Edit draft**, **Submit for posting** and **Cancel receipt**.
4. On the receipt choose **Post receipt**, then **Confirm posting**. Only accepted quantities become stock, and a partial delivery leaves the rest open.

After posting:
- **Reverse receipt** then **Confirm reversal** undoes a posted receipt, unless a supplier invoice already claims it.
- Receipts are listed under **Purchasing › Receipts**, with the cards **Receipts**, **Posted**, **Not posted** and **With rejections**.
- **Print receive sheet** prints a receipt, page by page with "Page n of m".

**6. Supplier invoice.**
- Supplier invoices are under **Purchasing › Supplier invoices**. Choose **Record supplier invoice** on a posted receipt, or **New supplier invoice**.
- Enter the supplier's own invoice number, the dates and the invoiced lines, then **Preview** and **Create draft**.
- An invoice can be recorded before the goods arrive. It then waits for **Link receipt**.
- FlowChain flags an invoice that looks like a duplicate.
- The list's cards are **Awaiting match**, **Match exceptions**, **Matched, to approve**, **To pay**, **Partly paid** and **Paid**.

**7. Three-way match.**
1. On the invoice choose **Submit**, then **Match**.
2. **Match by line** compares each invoice line with the purchase order and the receipts, net of tax. Its columns are PO line / item, Ordered, Received, Invoiced, PO price, Invoice price, Expected, Invoiced (net) and Variance, and a summary ends the table.
3. Each line is checked on its own, and differences never offset each other:
   - **Quantity:** what the invoice bills on a purchase order line against what every posted receipt of that line brought in, less what other invoices claim on it. The default tolerance is 0.
   - **Price:** the line's price difference passes within the larger of the unit price tolerances over the quantity and the line amount tolerance: by default the larger of 2 % of the line and 1 currency unit. A difference beyond it is one price exception, never also an amount exception.
4. Anything else is a **Match exception**: the invoice page says why first, with **Open the three-way match**.
5. Review each difference with a written resolution:
   - A price difference: **Approve difference** or **Reject difference**.
   - A quantity difference cannot be approved for payment. Reject it; or wait for the goods and choose **Match again**; or choose **Accept at received quantity**, and the amount to pay then leaves out what was not received.
6. Choose **Approve**. Someone other than the person who submitted the invoice approves it (section 10). The invoice moves to **Payables & receivables › Supplier invoices to pay**.

**Purchasing › Three-way match** lists every match under **Matched**,
**Pending** and **Variances**, by its match status. A match within the
tolerance counts as matched and keeps its small variance on record.

**8. Payment record.**
1. Pay the supplier the way you always do.
2. On the invoice choose **Record payment** and enter the date, amount, method and reference. Partial payments are allowed.
3. A wrong entry is voided with a reason, never deleted.

FlowChain records payments; it never moves money.

**In the research workspaces:**
- Both have the twelve assumed purchase requests (section 1). M5's purchasing side stops at receipts: it has no supplier invoices or payments.
- UCI has one supplier invoice per posted receipt, dated up to 5 days after it and due 30 days after the invoice, made through the app's own commands, with three stated differences picked by a fixed hash:
  - about 5 % price one line 2–5 % above the order; only those over the tolerance are held;
  - about 3 % bill in full a line delivered 5 % short; the buyer closes the rest of that order;
  - about 2 % are dated 1–3 days before the goods arrived.
- A second person reviews a held invoice 3 to 14 days after the match (a price difference approved, a quantity difference accepted at the received quantity) and approves it, so invoices held in the last 14 days may still wait.
- Approved invoices due before the seed day are paid on the due date, except 10 % of those due in the last 60 days, which are overdue.

## 5. Selling: from order to payment

**1. Sales order.**
1. **Sales › Sales orders › New sales order**. Choose the **Customer**. Their payment terms show under the choice, and their currency replaces the workspace currency.
2. Enter the lines with item, quantity and **Unit price** (**Add line** adds another), and **Promised date (optional)**. Every line needs a unit price: enter 0 for free goods. The order number (SO-…) is assigned on save.
3. **Save draft**. The form names each missing field.
4. A draft can be changed with **Edit draft**. **Confirm order** confirms it. Confirming needs a price on every line and an active customer from Customers whose credit status is not restricted.

The order shows one status and its steps (ordered, reserved, shipped,
invoiced, paid), and offers **Put on hold**, **Resume** and **Cancel order**.

**2. Reserve.**
- **Reserve all lines** reserves every open line in one step.
- **Reserve inventory** reserves one line: pick the warehouse and location, check the preview and confirm.
- **Release reservation** gives the stock back.

**3. Ship.**
- **Ship all reserved** drafts one shipment, with one DN number, for everything reserved. **Create shipment draft** drafts one line.
- **Post shipment** takes the quantity out of stock.
- **Reverse shipment** undoes it with a reason, unless a customer invoice holds it.
- **Sales › Shipments** lists every shipment in the warehouses you can see, newest first, with search, a status filter, counts and **Export results**.

**4. Customer invoice.**
1. Customer invoices are under **Sales › Customer invoices**: **Create customer invoice** from a shipment, or **New customer invoice**. The price comes from the sales order and the number (CI-…) is assigned on save.
2. **Preview** and **Create draft**, then **Submit**, **Approve** and **Issue invoice**. Someone other than the person who submitted it approves it. Issuing creates the receivable under **Payables & receivables › Receivables**.
3. To send it: **Open invoice document**, then **Print or save as PDF**, and send it yourself. An approved invoice that is not yet issued prints marked "Not issued — do not send."

**5. Payment received.** On the issued invoice choose **Record payment
received**.

**In the research workspaces:**
- UCI has one shipped sales order per public invoice, each with an issued
  customer invoice due 30 days later. Those due before the seed day were paid on
  the due date; later ones stay open.
- The six newest UCI orders without a scene item are still being filled: two not
  reserved yet, two reserved in full, and two with the first half of their lines
  shipped and invoiced. They keep their order day as the promised date, so they
  show as late.
- M5 has one order per day for the store's point of sale, with no invoices.

## 6. Inventory and the reorder list

- **Inventory balances** shows, per item, warehouse and location: **On hand**, **Reserved**, **Available**, **Safety stock** and the reorder point. Available = on hand − reserved.
- **Inventory movements** lists every posted change with its **Source document**.
- **Inventory operations** holds three kinds of draft document, each checked with a preview and posted by a person:
  - **Inventory transfers** move stock between locations or warehouses. A posted transfer can be reversed.
  - **Cycle counts** record counted quantities (optionally as a **Blind count**) and post the variance. A posted count cannot be reversed.
  - **Inventory adjustments** change a quantity with a reason. A posted adjustment can be reversed.

**Reorder list** (**Inventory › Reorder list**):
- **Stock position.** For each item over every warehouse, in its stock unit. The columns are **On hand**, **Reserved**, **Incoming**, **Requested**, **Backorders** and **Position**:
  - Incoming counts every open line of an approved, issued or partly received purchase order, whatever its due date. A late line still counts and is flagged "late — counted; confirm with the supplier".
  - Requested counts draft and pending-approval purchase orders and open purchase requests (draft, submitted or approved), named under **Already requested**.
  - Backorders are open sales demand that no reservation covers yet. They are taken off the position.
- **Ranking.** Items are ranked by **Order by**: the day the stock position is expected to reach the item's recorded reorder point at its recent daily demand. **Order now** marks an item due today. Items without a reorder point are not checked; they are listed apart, each with a suggested value to set.
- **How much.** A request orders up to a level, so the item leaves **Order now** once it is ordered:
  - the item's own **Order-up-to level** when it records one above the reorder point ("Orders up to {level}, the item's order-up-to level");
  - otherwise the reorder point plus 7 days of average demand, shown as assumed ("Orders up to {level} (assumed: reorder point + 7 days of demand)"). This is an app default, changed on the item.
  - The quantity is rounded up to the item's **Lot size**, then raised to the supplier's minimum order. Both fields are on the item form.
- **Suggested reorder point.**
  - It shows under the recorded value as **Suggested {value}**, in orange when the recorded value is more than 30 % below it. Section 9 says how it is worked out.
  - **Set reorder point…** opens a dialog prefilled with the suggestion. **Set reorder point** saves it as an audited item update. Until then the list keeps using the recorded value.
- **TimesFM.** When the workspace runs the local forecast service, a **TimesFM {value}** line under the suggestion gives the same quantity forecast by TimesFM 2.5, an open time-series model run on the same computer, from up to two years of shipments. The set dialog then offers **Use suggested** or **Use TimesFM**. Without the service there is no TimesFM line.
- **Several rows at once.** Tick rows (or the rows on a page):
  - **Create one purchase request ({n} lines)** opens one prefilled request with a line per row, up to 50 lines.
  - **Adopt suggested reorder points ({n})** lists each change, then sets each item's reorder point to its suggestion (never the TimesFM figure) as audited item updates.
- **Ordering.** Nothing is ordered automatically: **Create purchase request** opens a prefilled request to check and submit.

A reorder point covers the whole item. If you can see only some warehouses, the
list does not check items against it, and says so. You see and change stock
only in warehouses you have access to (section 10).

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
  - The change shows as a neutral blue badge. With no earlier figure the card says "No figure for the previous period". A figure that is a state, such as open orders, says "As of today".
- **Drilling down.** Each KPI opens the records it counts, so the rows match the figure.
- **Key findings.** The band above the charts states up to four findings from the page's own figures, largest change first, each with **Open the records →**. On the Business overview, the items needing attention sit with them, above the charts.
- **Charts.**
  - Colors follow the brand palette, and status colors keep their meaning: teal done, blue in progress, orange waiting, red a problem, grey draft, cancelled or closed.
  - Statuses are shown as segmented bars, stages as stage bars, and ordered → received → invoiced as a horizontal bridge.
  - Selecting a part of a chart filters the page.
  - Each chart offers **Download image**, **Download CSV** and **Focus mode**.

**Stock on the Business overview.** **Below safety stock (on hand)** counts the
items under their safety stock on hand, as the inventory warnings do, and says
how many are covered by open orders. **Items to reorder**, by stock position as
on the reorder list, is a card of its own.

**Open purchase orders** (the second view of Procurement analytics, after
**Dashboard**):
- The views are **Open orders**, **Overdue**, **Missing data** and **All orders**, with the panel **Suppliers with overdue orders**.
- Amounts are full order amounts, not what is left to pay.
- Days overdue count by the workspace's calendar day.

**How to read the figures:**
- Only recorded values are used. A missing value shows as **Unavailable** or —, never as a guess.
- Amounts are never added across currencies. Each currency has its own total, and nothing is converted.
- Quantities are never added across items or units. Such a total shows "Multiple SKUs", "Mixed units" or "Units differ, so there is no total".
- A figure your role may not see says "Your role cannot view this figure". Inventory figures cover only the warehouses your role can see.
- In the research workspaces, purchase amounts are at the assumed purchase prices (50 % of the selling price in UCI, 75 % in M5; section 1). Read them, and gross profit, as figures under that assumption, not as recorded costs.

**Supplier performance** (in **Supplier analytics** and on a supplier's
**Performance** tab):
- **What is measured.** Deliveries against the date on the purchase order when it was issued to the supplier or first received, over the last 90 days by default. A delivery is the lines of one purchase order that share that date. Later changes move only the current date, which is shown beside it ("vs current date").
- **The measures.** On time, in full, OTIF (on time and in full), early deliveries, and receipt lines with a rejection. **Grace days** sets the days of grace. Each figure opens the deliveries behind it.
- **Which orders count.** Only orders issued to the supplier, or with a posted receipt. Approved orders not yet sent are listed as **Not sent to supplier: {n}**.
- **Small samples.** A supplier with fewer than five deliveries shows "Fewer than 5 deliveries" instead of a rate.
- **In the research workspaces,** assumed suppliers deliver on time and in full, except in the UCI scene and UCI's short deliveries (section 4).

**Report library:**
- The tabs are **Standard reports**, **My reports**, **Team reports** and **Recently opened**.
- **Create report** saves a private report.
- Owners can share or delete their reports.

**Printing.** A printed purchase order, customer invoice or receive sheet runs
across as many A4 pages as it needs, each numbered "Page n of m" at its foot in
the language it prints in. Firefox and Safari print no page numbers.

## 8. The assistant

### Opening it

- Open it with the **AI assistant** button at the bottom right of every page. It is one assistant for the whole workspace, whichever page you are on.
- On a wide screen it docks on the right and the page narrows; **Expand assistant** and **Collapse assistant** change its width. On a narrow screen it opens over the page, and on a phone it fills the screen. The × minimizes it, and **New conversation** starts again.
- It knows the record of the page you are on, and uses it only when the question points to it ("this PO").
- It answers in the language of your question, English or Chinese. Dates and numbers keep the workspace's regional format in both languages, for example "18 Nov 2026" in UCI and "Nov 18, 2026" in M5.

### What it needs

The assistant answers only through an AI model. There is no rules engine behind
it. It answers when three things hold:
- **The server has a model service.** A deployed server is set up for Claude Sonnet through MIT Parley; a local server uses the settings file given to it.
- **AI is switched on for the workspace.** An administrator does this in **System administration › AI governance** with "Use an AI model in this workspace". On local development servers every workspace may use the model, and no switch is needed.
- **The workspace is under its monthly cap.** The cap is set per server: $25 in the deployment settings, $20 when none is set.

Otherwise it shows a notice and no answer:

| Notice | When |
| --- | --- |
| AI is off for this workspace. A workspace administrator can switch it on in Settings > AI. | The switch is off |
| The assistant is not set up on this server yet. | No model service |
| This workspace has used this month's assistant allowance. An administrator can see the spend in Settings > AI. | Over the monthly cap |
| The assistant is not available right now. Try again in a few minutes. Nothing was changed. | The model service failed |

Other limits:
- a question is at most 8,000 characters;
- 30 questions per person per 10 minutes;
- an answer may cost at most $0.20 of model use;
- a conversation is kept for 2 hours or 20 turns. When the server no longer has it, the answer works from your last few questions and answers, and says so.

### What it can answer

It reads your records with tools, under your own permissions:
- **Work queues.** What needs attention today, the decisions waiting on Today and what was decided before, records missing data, open purchase requests.
- **Documents.** Purchase orders (one in detail), sales orders, shipments, receipts, supplier invoices, requests for quotes and their quotes, contracts.
- **History.** Who changed a purchase order, sales order, item or supplier, and when (with a role that may read the audit log), and one item's stock movements.
- **Stock.** Stock position, a week-by-week projection, and which sales orders a late purchase order puts at risk.
- **Suppliers.** An item's approved suppliers and terms, price history, supplier performance and supplier risks.
- **Money and sales.** Spend, sales from customer invoices, receivables, amounts owed to suppliers, cash in and out by month from recorded payments, and gross profit: an estimate at the preferred supplier's reference price.
- **Search.** Across records and the workspace's documents.
- **Arithmetic.** Done on the server, never in the model's head.

**For deciding what and how much to order:**
- **The reorder list,** with the order-up-to level, the suggested reorder point and its basis, and the TimesFM figure when asked and the service runs.
- **Order size and holding cost.** Orders a year, holding cost, break-even cost per order, and the economic order quantity. Holding cost is assumed at 25 % of value a year, and the answer says so.
- **The order plan.** It is solved exactly for several items at once, within a budget and minimum orders. The plan is costed against ordering nothing, the reorder list, and your own plan. Its quantities reach the request form marked **Best order plan**. See section 9.

### What it prepares, and the clicks it needs

The model has no tool that writes. Every change is a button you press in your
own session.

**Purchase request form.**
- Each value carries its source, for example "Reorder gap", "Gap raised to minimum", "Preferred supplier" or "Best order plan".
- Suggested rows start unticked; **Add all suggested** and **Order anyway** add them.
- **Open full form** opens the request page instead. **Create draft request ({count} lines)** creates the draft.
- A draft then offers **Submit for approval**, **Cancel draft** and **Open**. Once submitted: **Withdraw** and **Cancel request**, which asks why.
- A supplier not yet approved for the item shows as "(not yet approved)". Creating the request also adds that supplier link, so it needs a role that manages item suppliers.

**Record cards.**
- A purchase request card offers **Submit for approval** (to its requester), **Approve**, **Reject** and **Create purchase order**.
- A purchase order card offers **Approve** and **Mark as issued**.
- Approve and Reject are not offered on your own request or order while someone else may approve it.
- Every step except submitting needs a second **Confirm** click, and Reject needs a reason.
- Mark as issued sends nothing to the supplier.

**Decision cards.** The same cards as **Waiting for your decision** on Today
(section 4), with the same buttons. The assistant's first screen shows them.

**Setup cards.** See section 3.

**Messages to suppliers.** These appear as quoted text with **Copy**. You send
them yourself, or from a Today card when supplier email is on.

**It never:**
- pays or moves money, and never sends or emails anything itself;
- cancels, withdraws or deletes; it tells you where to do that in the app;
- says something was done unless the server has checked your click;
- shows what your role may not see; it says "Your role can't see …".

### Checks you may see in an answer

- A dotted underline marks a number, date, name or record number not matched to your records ("Not matched to your records"). A date written with slashes, such as 05/06, is read in the workspace's order: day first in UCI (en-GB), month first in M5 (en-US).
- A button the answer names that the app does not have is marked the same way.
- A note says a sentence was left out when it read as if something had been done for you.
- "[not shown]" replaces a value your role may not see. When that happens mid-answer, the answer stops and says why.
- Record numbers in the text are chips that open the record.
- A line under the answer names its sources and the day of the data, and how many of its facts were found in the records. **Helpful** and **Not helpful** rate it; Not helpful asks what was wrong.

### What is sent to the model

Each model call sends:
- the conversation on your thread: your questions, the earlier answers, the tool calls and the tool results;
- the records the assistant reads to answer. These are only records your role may see, with hidden amounts left out and no contact emails or phone numbers;
- a context line: the answer language, the workspace's day, currency and time zone, the page's record, what your role cannot see, and, when the server no longer had the conversation, up to three earlier questions and answers;
- for questions about documents, the matching passages.

FlowChain's own log keeps codes and counts per answer, never the words. One
exception is local: the walkthrough also writes the question, the answer and
any note of a rated answer to a file in its data folder, so a marked answer can
become an evaluation case. Details are in
[AI workspace access](ai-workspace-access.md).

## 9. How the figures are worked out

These are the rules behind the decision figures, for anyone using FlowChain in
research. Each points to the code or document that defines it. The
order-up-to default and the cost ratios are app defaults, labelled as
assumptions where they are shown.

**Stock position** (`inventoryPosition` in `shared/purchase-suggestion.mjs`;
the reorder list, Today's reorder cards and the assistant's suggestions all use
it):
- **Position** = on hand − reserved + incoming + pending purchase orders + open purchase requests − backorders, over every warehouse, in the item's stock unit.
- **Incoming:** what is still to receive on every line of an approved, issued or partly received purchase order, whatever its due date.
- **Pending purchase orders:** draft or pending approval. **Open purchase requests:** draft, submitted or approved.
- **Backorders:** open sales demand that no reservation covers yet, so no sales order counts twice.
- Lines in another unit than the stock unit are never added. Transfers are not considered.

**Order-by date and order now** (`server/domain/reorder-list.mjs`):
- **Daily demand** = the quantity shipped over the last 90 workspace days ÷ 90, only when the item shipped on at least 8 of those days.
- **Order-by date** = today + ⌊(position − reorder point) ÷ daily demand⌋ days, never before today. At or below the reorder point it is today.
- **Order now:** due today with a quantity to order. Due today with nothing to order (a recorded order-up-to level already reached) moves to tomorrow.

**Order-up-to level and quantity** (`orderUpToLevel` and
`suggestPurchaseQuantity` in `shared/purchase-suggestion.mjs`; an (s, S) rule):
- **s** is the item's recorded reorder point.
- **S** is the item's recorded order-up-to level when it is above s. Otherwise it is assumed to be s + 7 × average daily demand. Without enough shipments to give a daily demand, S = s.
- **Quantity**, once due = S − position, rounded up to a whole unit, then up to a multiple of the item's lot size, then raised to the supplier's minimum order. Ordering it brings the position to S or above, so the item is no longer due.
- **Lead time and minimum order** are the preferred supplier link's, else the item's own. A minimum order counts only when the item is bought in its stock unit.

**Suggested reorder point** (`server/domain/reorder-point-suggestion.mjs`):
1. Take H = lead time + 7 review days, with the lead time as above.
2. Form the 90 sums of H consecutive days of the last 90 days of shipments, wrapping round.
3. The suggestion is the 75th smallest sum, rounded up: enough for the next H days in 5 of 6 past stretches.
4. 5/6 is the newsvendor critical ratio when a unit short costs five times what holding one costs.

There is no suggestion when the item shipped on fewer than 8 of the 90 days,
the stock unit is not recorded, or no lead time is recorded. The list marks a
recorded reorder point more than 30 % below the suggestion.

**TimesFM forecast** (`server/domain/reorder-point-forecast.mjs`; only when
`FLOWCHAIN_FORECAST_URL` points to the local service):
- The same quantity as the suggestion: demand over the next H days at the same 5-of-6 level.
- The model reads up to 728 days of shipments as non-overlapping H-day totals from the item's first shipment, and gives the 5/6 quantile of the next total, rounded up.
- There is no forecast with fewer than 8 such totals, when the suggestion itself has none, or when the service does not answer. Nothing is stored until a person sets a reorder point.

**On-time deliveries** (`server/domain/supplier-scorecard.mjs`):
- A delivery is the lines of one purchase order that share an original promised date: the date on the order when it was issued or first received.
- It is on time when every line's first posted receipt arrived by that date plus the grace days.
- A rate needs at least five deliveries.

**Three-way match** (`THREE_WAY_MATCH_RULE` in
`server/domain/operational-finance-policy.mjs`; section 4):
- A line's price difference = quantity × (invoice price − PO price). It passes within the larger of the unit price tolerances over the quantity and the line amount tolerance; by default the larger of 2 % of the line and 1 currency unit.
- Quantity has no tolerance by default, and a quantity difference is never approved for payment.
- A match keeps the rule and tolerances it was made under.

**Order plan** (`optimize_order_plan`; [Replenishment solver](replenishment-solver.md)):
- **Method.** An exact sample-average mixed-integer plan, solved with HiGHS, over 200 demand scenarios drawn from the last 90 days of shipments. It stays within the budget and minimum orders. Each item starts from the stock position above.
- **Costs.** Holding cost is h = 25 %/year × price × (lead time + 7)/365, and shortage cost is 5h, the same ratio as above. These are defaults: the user can give another holding rate, review period or service level s, and shortage cost then becomes s/(100 − s) × h.
- **Prices.** The preferred supplier's reference price. In the research workspaces that is the assumed purchase price (section 1). The separate research instances (`scripts/public-data-instance.mjs`) keep the selling price as their proxy.

**The assistant's evaluation.** Assistant v2 is evaluated on the public data
with the cases in `tests/ai-eval/v2-public/`: a question set on the UCI
workspace and a smaller set on an M5 research instance, in English and Chinese.
They cover demand, stock days, reorder, order size and budgeted order plans,
among others. Expected figures are worked out from the seed's own plan, not
from the assistant's tools.

## 10. Roles, permissions and warehouse access

An administrator manages people in **System administration › Users & roles**:
- **Create invitation** for a teammate's email with a role, then **Copy link** and send it yourself. It works once and expires in 3 days; FlowChain does not email it.
- Changing a role asks to confirm and signs the person out, so the new role applies.
- Disabling a person signs them out and keeps their history.
- Custom roles can be made with **Create role** or **Copy role**. You can grant only permissions you hold yourself, and cannot give yourself a role.

The standard roles:

| Role | Typical work |
| --- | --- |
| Workspace administrator | Everything, including settings, users, roles, numbering and suppliers' bank details |
| Operations manager | Approvals, purchasing, receiving, sales, inventory, finance and contracts |
| Operations specialist | Purchase requests, receiving, sales orders and shipments, supplier and customer invoice entry, matching, items, suppliers and customers, and inventory drafts (a manager posts counts and adjustments) |
| Procurement specialist | Purchase requests and orders, items, suppliers and contracts |
| Finance specialist | Supplier and customer invoices, matching and payment records |
| Read-only viewer | Looks at records; cannot change them or see amounts |

For example, a Procurement specialist can submit a purchase request but not
approve it. If a button you expect is missing, your role probably does not
include it. Suppliers' bank details have a permission of their own, which only
the administrator role holds in a new workspace.

**No self-approval.** Whoever raised or submitted a purchase request, purchase
order, supplier invoice, customer invoice or return cannot give it its first
approval while someone else may:
- The pages offer **Approve** and **Reject** on requests and orders only to someone who may approve them.
- An approval that would be your own is refused: "You raised or submitted this, so someone else who may approve it has to approve it."
- In a workspace where you are the only person who may approve, the approval goes through and the audit log marks it.
- Inventory adjustments are not covered by this rule.

**Warehouse access.** In **System administration › Warehouses & access**, an
administrator gives each person **Read** or **Operate** access per warehouse, or
**No access**:
- You receive, ship, count and adjust only where you have **Operate**.
- Reports show stock only from warehouses you can see.
- A new administrator has Operate everywhere; other new members have no access until it is granted.

## 11. Known limits

**What FlowChain does not do:**
- It does not send documents to suppliers or customers. Documents are printed or saved as PDF in your browser, and you send them. The **Print templates** list under Master data previews layouts; it does not save them.
- It sends three kinds of email only: the sign-in link, approval emails, and the overdue-order follow-up to a supplier, which is off by default and sent only after a person confirms it.
- It is not an accounting system: no general ledger, tax filing, bank connection or payment execution.

**Removed:**
- **Forecasting and MRP module.** Its pages never opened and were deleted on 2026-11-17. The TimesFM line on the reorder list is the only model forecast.
- **Menus & modules** under System administration changed nothing and was removed the same day.

**Hidden or preview only:**
- **Supplier credit notes.** They come only from supplier returns, which are switched off, so their card and tab under Payables & receivables are hidden.
- **Review queue** and **Data intake** are previews. They are not in the menu, and a direct link shows "Capability unavailable".
- **Lots, serial numbers and inventory exceptions.** Nothing records them yet, so their lists have no tab and the item form hides their switches.

**Not built yet.** These are designed and approved, and none is available:
- **Changing an order.** A purchase order's quantities, prices and lines cannot change once it exists, and only a whole order can be closed. A sales order cannot be revised after confirmation or close its unshipped remainder.
- **Importing past or open orders.**
- **Reverse flows.** Returns and quarantine are built and tested but switched off. An approved supplier invoice cannot be reversed, an issued customer invoice cannot be cancelled, and there are no screens for credit notes, with or without a return.
- **Report collaboration:** one set of metric definitions, change breakdowns, asking the assistant about a chart, a weekly brief and threshold alerts.

The designs are in
[Order changes, history import and reverse flows](order-changes-history-reverse-design.md)
and [Reports as a decision loop](report-collaboration-design.md). Their build
plans start in December 2026 and run into the first quarter of 2027. Until a
step is merged to `main`, it is not in FlowChain.

**Also:**
- **The assistant needs a model.** Without one it gives no answers (section 8).
- **The research workspaces are subsets with stated assumptions:**
  - one in four UCI customers and 200 of its products;
  - 196 of CA_1's items;
  - assumed suppliers that deliver on time and in full, except the UCI scene and short deliveries;
  - purchase prices at 50 % (UCI) or 75 % (M5) of the selling price, the same share for every item;
  - no tax on any invoice;
  - UCI cancellations not posted as returns.

  See [Public data workspaces](public-data-workspaces.md).
- **Translations.** A few screens and messages may not be fully translated in both languages.

The technical list of limits is in
[Current development limitations](current-development-limitations-v1.md).

For questions about the research setup, contact the project owner.
