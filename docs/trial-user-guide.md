# FlowChain trial user guide

This guide is for the people who run purchasing, the warehouse, sales and
payables in a company that is trying FlowChain. It follows the order in which
you meet the product: signing in, setting up, buying, selling, inventory,
reports, the assistant, and who may do what.

FlowChain keeps your purchase, stock and sales records in one place and checks
them for you. It prepares documents and figures; a person in your company
approves, sends and pays. FlowChain never sends an order to a supplier, never
moves money and never acts on its own.

Contents

1. [Signing in and your profile](#1-signing-in-and-your-profile)
2. [First day setup](#2-first-day-setup)
3. [Buying: from request to payment](#3-buying-from-request-to-payment)
4. [Selling: from order to payment](#4-selling-from-order-to-payment)
5. [Inventory](#5-inventory)
6. [Reports and the supplier scorecard](#6-reports-and-the-supplier-scorecard)
7. [The assistant](#7-the-assistant)
8. [Roles, permissions and warehouse access](#8-roles-permissions-and-warehouse-access)
9. [Getting help and known limits](#9-getting-help-and-known-limits)

Labels in **bold** are the words on the screen in English. Menu paths are
written as **Procurement › Purchase orders**.

## 1. Signing in and your profile

FlowChain has no passwords. You sign in with a link sent to your work email.

1. Open your company's FlowChain address.
2. Enter your **Work email** and choose **Email me a sign-in link**.
3. The page says **Check your email**. Open the email "Your FlowChain sign-in
   link" on the same device and click the link. The link works once and
   expires after 15 minutes. If it does not arrive, check your spam folder or
   choose **Resend the link**.
4. On the **Finish signing in** page, choose **Sign in to** followed by your
   workspace name.

Only people your administrator has added can sign in. If your email is not on
the list, the page looks the same but no email is sent; ask your administrator.

**Joining from an invitation.** If an administrator invited you, open the
invitation link they sent you, enter **Your name** and choose **Accept and
email me a sign-in link**, then continue from step 3. An invitation link works
once and expires after 3 days.

**Language.** FlowChain is in English by default. Chinese (简体中文) is
available:

- Before signing in, use the **Interface language** selector on the sign-in
  page.
- After signing in, open **System Administration › My Profile** and change
  **Interface language**. **Follow workspace default** uses the language your
  administrator set for the company.

Changing the language changes only the words on the screen. Currencies,
number and date formats, the time zone, and the names and numbers you have
recorded stay exactly as they are.

**Your profile.** **My Profile** also shows your name, job title, email, role
and default warehouse.

## 2. First day setup

### Workspace settings

Your workspace was created for you with US settings: country US, English, US
dollars and the America/New_York time zone. An administrator can review them
in **System Administration › Company & Workspace** (company name, **Default
interface language**, **Regional format**, **Timezone**, **Base currency**).
The base currency locks once posted transactions exist, so check it first.
The same page has **Documents**: the letterhead, the **Default document
language** and the purchase order and invoice templates (title, optional
columns, terms, footer, payment instructions) used when a document is printed
or saved as PDF. FlowChain adds no payment terms or bank details of its own.

Other useful settings pages:

- **Numbering Rules**: shown for reference; it does not change document
  numbers yet.
- **Review Policies**: the **Invoice matching tolerances** used by the
  three-way match (see section 3), and whether a purchase order made from an
  approved purchase request is approved with it (on in a new workspace; see
  section 3). The other review settings are not in effect yet.
- **Users & Roles** and **Warehouse Access**: see section 8.

### Warehouses

Your workspace starts with one warehouse, code **MAIN** ("Main Warehouse"),
created when the workspace was set up. You can see it under **Master Data ›
Warehouses**. An administrator adds more in **System Administration ›
Warehouse Access › Warehouses**: **New warehouse**, a **Code** (up to 32
letters, digits, hyphens or underscores; it cannot be changed later) and a
**Name**, then **Add warehouse**. Whoever adds a warehouse gets **Operate**
access to it; give others access in the table below it (see section 8). A
warehouse can be renamed, or **Set inactive** once nothing is still in it or
waiting on it (stock on hand, open reservations, receipts, counts, transfers,
adjustments, or purchase orders still to be received there); the page lists
what is in the way. The last active warehouse cannot be set inactive.

Locations (bins) inside a warehouse do not need to be set up in advance: you
name the location when you import opening stock or receive goods, for example
`A-01`. The same page can keep a list of bins per warehouse for reference;
an inactive bin does not block receiving or transfers that type its code.

### Importing your data

Open **Master Data › Import data**. It creates records from a CSV or XLSX
file. Existing records are skipped, never changed.

Who can import: items, item suppliers and suppliers need a role that manages
them (Administrator, Operations Manager, Operations Specialist or Procurement
Specialist); customers and opening stock need an Administrator, Operations
Manager or Operations Specialist. Posting the opening-stock adjustment needs
an Administrator or Operations Manager.

Import in this order: items, suppliers, customers, item suppliers, then
opening stock. For each type:

1. Choose the type and **Download template**. The template has the column
   headers and one example row. Headers in English or Chinese are both
   accepted.
2. Fill in your rows, keep the header row, and save as CSV (UTF-8 is
   recommended) or XLSX.
3. **Choose file**, then **Check file**. Nothing is saved yet. Each row shows
   whether it will be created, skipped because it already exists, or not
   imported because of an error.
4. Choose **Import {n} rows**. Rows with errors are never imported: fix them
   in the file and upload it again.
5. **Download results** keeps a copy of what happened to each row.

Required columns (the rest are optional):

| File | Required columns | Useful optional columns |
| --- | --- | --- |
| Items | SKU, Item name, Unit | Category, Safety stock, Reorder point, Lead time (days), Status |
| Suppliers | Supplier code, Supplier name | Email, Default currency, Payment term code (for example NET30), Lead time (days) |
| Customers | Customer code, Customer name | Contact, Email, Payment terms, Currency |
| Item suppliers | SKU, Supplier code | Supplier SKU, Reference price, Currency, Minimum order quantity, Preferred |
| Opening stock | SKU, Warehouse code, Location, Quantity | Unit |

Your workspace already has the standard payment terms Due on receipt, Net 15,
Net 30, Net 45 and Net 60 (codes DUE, NET15, NET30, NET45, NET60).

### Opening stock

Opening stock records what you already hold on the day you start. It is not
added to stock straight away:

1. The import creates a draft inventory adjustment per warehouse. The results
   page links to it (**Open** followed by the adjustment number).
2. A person checks the draft in **Inventory › Inventory operations ›
   Inventory adjustments**, marks it **Ready**, opens **Post Preview** to see
   the effect on stock, and chooses **Confirm**.

Only then does the quantity appear in **Inventory › Inventory balances**. The
quantity must be in the item's own unit, the item must be active, and a
location that already holds stock cannot take opening stock again. No cost is
recorded.

## 3. Buying: from request to payment

The usual path is: purchase request → approval → purchase order → approval →
issue → receipt → bill → three-way match → approval → payment record.

**1. Purchase request.** **Procurement › Purchase requests › New purchase
request**. For each line enter the item, quantity, supplier, **Estimated unit
price**, **Destination warehouse or service location** and need-by date, then
**Save draft** and **Submit**. The supplier must be one of the item's
suppliers (from the item suppliers file or the item record). If the item has a
preferred supplier and you choose another, pick a reason (for example price or
lead time); the approver sees it.

**2. Approval.** A manager opens the request and chooses **Approve** or
**Reject** (with a reason). The person who submitted can **Withdraw** it while
it waits.

**3. Purchase order.** On an approved request choose **Create purchase order**.
FlowChain creates one purchase order per supplier, currency and warehouse,
under **Procurement › Purchase orders**. In a new workspace the request's
approval approves the order too: it is created approved, and its approval
names the request and who approved it. If an administrator turns this off in
**Review Policies**, the order is created as a draft: check it, choose
**Submit for approval**, and a manager chooses **Approve**.

**4. Issue.** On the approved order choose **Open PO document**, then **Print
or save as PDF**, and send it to your supplier yourself, by email or your usual
channel. The document can be printed from approval until the order is closed,
and only by a role that can see prices; **Document language** on the page
changes the language of one print. Then choose **Mark as issued to supplier**. As the screen
says, issuing records that you sent the PO; FlowChain does not send it.

**5. Receiving.** When goods arrive, open the purchase order and choose
**Receive**. Pick the **Receiving warehouse**, the **Arrival time**, and for
each line the **Accepted** quantity, any **Rejected** quantity with a
**Rejection reason**, and the **Location**. Choose **Save and submit for
posting**, then on the receipt **Post Receipt** and **Confirm Post**. Only
accepted quantities become stock. A partial delivery leaves the rest open; you
can receive again later. Receipts are listed under **Procurement › Receipts**.

**6. Supplier bill.** Bills are under **Procurement › Bills**. From a posted
receipt choose **Record bill** (or **New bill**), enter the supplier's invoice
number, dates and the billed quantities and prices, **Preview**, then **Create
draft**. A bill can also be recorded before the goods arrive; it then waits for
the receipt (**Link receipt**) and cannot be paid until it is matched.
FlowChain flags a bill that looks like a duplicate of another.

**7. Three-way match.** On the bill choose **Submit**, then **Match**. The
match compares the bill with the purchase order and the receipt: quantity
billed against quantity received and not yet billed, and unit price and line
amount against the order. Differences within your **Invoice matching
tolerances** pass; anything else becomes a **Match exception** for a person to
review. A matched bill can be **Approve**d, which makes it a bill to pay
(**Payables & receivables › Bills to pay**).

**8. Payment record.** Pay the supplier the way you always do (check, ACH,
wire or card). Then, on the bill, choose **Record payment** and enter the date,
amount, method and reference. FlowChain never moves money; it records the
payment you made. Partial payments are allowed. A wrong entry is voided with a
reason, never deleted.

## 4. Selling: from order to payment

**1. Sales order.** **Sales › Sales orders › New sales order**. Choose the
**Customer** from your customer records (**Master Data › Customers**; add or
import customers first). Their recorded payment terms show under the choice,
and their recorded currency replaces the workspace currency. Enter the order
number, an optional **Promised date**, and for each line the item, quantity
and **Unit price**; **Add line** adds another. Then **Save draft**. The button
stays disabled until every line has a unit price. Open the order and choose
**Confirm order**. A draft can be edited as a whole: customer, promised date
and every line.

**2. Reserve.** On the confirmed order choose **Reserve inventory**, pick the
warehouse and location to take the stock from, check the preview and
**Confirm**. Reserved stock is no longer available to other orders.
**Release reservation** gives it back.

**3. Ship.** Choose **Create delivery draft** for the reserved quantity, then
open the shipment and choose **Post shipment**. Posting takes the quantity out
of stock. A posted shipment can be reversed with a reason.

**4. Invoice.** Customer invoices are under **Sales › Invoices**. From the
shipment choose **Create invoice** (or **New invoice**), choose the shipment,
enter the quantity and any tax, **Preview** and **Create draft**. The price
comes from the sales order. Then **Submit**, **Approve** and **Issue
invoice**. Issuing creates the amount the customer owes under **Payables &
receivables › Receivables**. FlowChain does not send the invoice: on the issued invoice choose **Open
invoice document**, then **Print or save as PDF**, and send it to your customer
yourself. An approved invoice that is not issued yet opens as a preview marked
"Not issued — do not send."

**5. Payment received.** When the customer pays, on the issued invoice choose
**Record payment received** and enter the date, amount, method and reference. As with bills,
this records a payment; no money moves through FlowChain.

## 5. Inventory

- **Inventory balances** shows on hand, reserved and available quantity per
  item, warehouse and location. Available = on hand − reserved.
- **Inventory movements** lists every posted change: opening stock, receipts,
  shipments, transfers, counts and adjustments, with the document that caused
  it.
- **Inventory operations** has three kinds of document. Each is saved as a
  draft, checked with a preview, and posted by a person:
  - **Inventory transfers** move stock between locations or warehouses.
  - **Cycle counts** take a count snapshot (optionally a **Blind count**),
    record the counted quantities, review the variance and post it. A posted
    count cannot be reversed; correct it with an adjustment.
  - **Inventory adjustments** change a quantity with a reason. Posted
    adjustments can be reversed.
- **Reorder list** (**Inventory › Reorder list**) ranks items by the day their
  stock position (on hand − reserved + incoming) is expected to reach the
  item's reorder point. Items without a reorder point are not checked. Nothing
  is ordered automatically: **Create purchase request** opens a prefilled
  request for you to check and submit.

You see and change stock only in the warehouses you have access to (see
section 8).

## 6. Reports and the supplier scorecard

**Reports** has **Business overview**, **Procurement analytics**, **Sales
analytics**, **Inventory analytics**, **Invoice analytics** and **Supplier
analytics**. **Procurement analytics** opens on the open purchase orders
report: committed orders that still have quantity to receive, how many days
any are overdue, and their amounts.

How to read the figures:

- They are built only from what has been recorded in your workspace. A
  missing date or quantity is shown as unknown, not guessed.
- Amounts are never added across currencies. Each currency has its own total;
  nothing is converted.
- Quantities are never added across different items or units. An order or a
  total that mixes them shows "Multiple SKUs" or "Mixed units" instead of a
  number. Each item is shown in its own unit.
- Amounts on the open purchase orders report are full order amounts, not what
  is left to pay.
- Overdue days count by your workspace's calendar day.

**Supplier performance** (in **Supplier analytics** and on each supplier's
page) measures deliveries
against the date first promised on the purchase order when it was approved,
over the last 90 days by default. A delivery is the lines of one purchase
order that share a promised date. Only purchase orders issued to the supplier
or with a posted receipt are measured. A supplier with fewer than five deliveries
in the period shows no on-time rate rather than a misleading one. If your role
cannot see amounts, money figures are hidden for you.

## 7. The assistant

Open **AI Assistant** from the main navigation and ask in plain English or
Chinese; it answers in the language of your question. It can answer questions
about your own records, for example:

- stock, availability and shortages for an item;
- open, late or partly received purchase orders, and what a supplier still
  owes you;
- supplier questions, such as a supplier's open orders and delivery record;
- questions about your own policy documents, when your workspace has them set
  up and AI is switched on.

Answers show the records they are based on, and the assistant reads only what
your role may see.

The assistant prepares; you decide:

- It can open a purchase request form already filled in. The form says
  **Prefilled from…** and labels where each value came from. Nothing is saved
  until you check and submit it.
- It can draft a message to a supplier about open order lines. You review the
  recipient, subject and text, then **Open in email** to send it from your own
  mailbox. FlowChain does not send it.
- It never approves, issues, posts, pays or sends anything on its own.

Answers that use an AI model are switched on per workspace by an administrator
(**System Administration › AI Governance**, "Use an AI model in this
workspace") and are off unless your company asked for them. As the settings
page says, when it is on, questions are sent to Anthropic (Claude) to plan
lookups, and for questions about your documents the matching passages are sent
too; business records are not sent. Use is capped each month; once the limit
is reached, the assistant answers from workspace rules until next month.
Without the model, the assistant still answers the supported questions about
your records.

## 8. Roles, permissions and warehouse access

An administrator manages people in **System Administration › Users & Roles**:

- **Create invitation** for a teammate's email with a role, then **Copy link**
  and send it yourself (it works once and expires in 3 days). FlowChain does
  not email the invitation.
- Disable a person who leaves; their history stays.

The standard roles:

| Role | Typical work |
| --- | --- |
| Workspace Administrator | Everything, including settings, users and roles |
| Operations Manager | Approvals, purchasing, receiving, sales, inventory and finance |
| Operations Specialist | Receiving, sales orders and shipments, bill entry and matching, and inventory drafts (a manager posts counts and adjustments) |
| Procurement Specialist | Purchase requests and orders, items and suppliers |
| Finance Specialist | Bills, invoices, matching and payment records |
| Read-only Viewer | Looks at records; cannot change them or see amounts |

For example, a Procurement Specialist can submit a purchase request but not
approve it, and a Finance Specialist records payments but cannot change a
supplier's details. If a button you expect is missing, your role probably does
not include it; ask your administrator.

**Warehouse access.** In **System Administration › Warehouse Access** an
administrator gives each person **Read** or **Operate** access per warehouse,
or **No access**. You can receive, ship, count and adjust only in warehouses
where you have **Operate**, and reports show stock only from warehouses you
can see. A new member other than an administrator has no warehouse access
until an administrator grants **Read** or **Operate** here.

## 9. Getting help and known limits

For questions or problems, contact the person at FlowChain who set up your
trial. Tell them the page, the document number and what you expected.

What FlowChain does not do today:

- It prints purchase orders and invoices through your browser (**Print or save
  as PDF**) but does not send them; you send them yourself. The **Print
  templates** list under Master Data is a preview; it does not produce or save
  documents.
- It sends no email other than the sign-in link. Approvals are not announced by
  email; check the lists in FlowChain.
- It does not send anything to suppliers or customers.
- It is not an accounting system: no general ledger, no tax filing, no bank
  connection, and no payment execution. Payment records note payments you made
  elsewhere.
- A few screens and messages are not yet fully translated in both languages.

The technical list of current limits is in
[Current development limitations](current-development-limitations-v1.md).

### Coming soon in the trial

These are planned. Dates and details may change.

- Print layouts saved for the whole workspace.
- Email notifications when something waits for your approval.
- Further security and alert improvements.
