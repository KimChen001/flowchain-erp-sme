# Bills, invoices and the accounting handoff

> **2026-10-10: English UI names changed.** The owner replaced the
> QuickBooks/Xero names below with procurement-system wording (SAP, Coupa): the
> English UI now says "Supplier invoice(s)" instead of "Bill(s)" and "Customer
> invoice(s)" instead of "Invoice(s)". The Chinese UI is unchanged (采购发票,
> 销售发票). Route paths, ids, permission codes and stored values (for example
> `/app/procurement/bills`, `procurement:bills`) are unchanged. The rest of this
> document is kept as agreed on 2026-10-03.

Status: design agreed with the owner on 2026-10-03. Steps 1a (names,
navigation, redirects), 1b (entry from source documents, invoice actions), 1c
(bills recorded before the receipt) and 2 (light payment records) are
implemented; the rest is planned.

## 1. Problem

FlowChain records two different documents that the interface called
"invoices":

- the invoice a **supplier sends us** for goods we bought, and
- the invoice **we send a customer** for goods we shipped.

Before this change the only "New supplier invoice" button lived in Finance,
while Purchase fulfillment showed the same invoices read-only. Customer
invoices also lived only in Finance, and no sales order or shipment page
offered to create one. A user who just received goods had to leave the
receiving module to record the supplier's invoice, and nothing on a shipped
order said it still had to be invoiced.

FlowChain is not an accounting system. It must work for small businesses that
keep their books in QuickBooks, Xero or a spreadsheet, and it must be enough on
its own for businesses that have no accounting software yet.

## 2. How other products separate them

Every system we checked splits the work by direction (money going out vs coming
in) and by role, and gives the two documents different names:

| Product | Receiving (warehouse) | Supplier invoice (AP) | Customer invoice (AR) |
| --- | --- | --- | --- |
| SAP S/4HANA | Warehouse clerk: Post Goods Receipt | AP accountant: Create Supplier Invoice, matched to PO and receipt | Billing clerk: Create Billing Documents from deliveries |
| NetSuite | Purchases > Receive Orders | Payables > Bill Purchase Orders ("Vendor Bill") | Invoice Sales Orders |
| Odoo | Inventory > Receipts | "Create Bill" on the PO; bill control can use received quantities | "Create Invoice" on the sales order |
| Business Central | Post the PO as Receive | Post the PO as Invoice | Post the sales order as Ship / Invoice |
| Zoho Inventory | Purchases > Purchase Receives | Purchases > Bills ("Convert to Bill" on a receive) | Sales > Invoices ("Convert to Invoice" on a sales order) |
| QuickBooks, Xero | (simplified) | Bills | Invoices |
| Kingdee, Yonyou | 采购入库单 | 采购发票 → 应付单 | 销售发票 → 应收单 |

Two patterns matter for FlowChain:

1. **Names.** US small-business software calls the supplier's document a
   **Bill** and ours an **Invoice**. Chinese ERPs say 采购发票 and 销售发票.
2. **Create buttons sit on the source document.** The bill starts from the PO
   or receipt, the invoice from the sales order or shipment, with quantities
   carried over. The full lists live in one fixed place.

## 3. Terms

| Concept | English UI | Chinese UI | Model |
| --- | --- | --- | --- |
| Supplier invoice | Bill | 采购发票 | `SupplierInvoice` |
| Customer invoice | Invoice | 销售发票 | `CustomerInvoice` |
| Approved bill waiting for payment | Bill to pay | 应付款 | `PayableObligation` |
| Issued invoice waiting for payment | Receivable | 应收款 | `ReceivableObligation` |
| Goods receipt | Receipt | 收货单 | `ReceivingDocument` |
| Shipment | Shipment | 发货单 | `Shipment` |

Stored identifiers, statuses and partner names are never translated in place
(`docs/interface-language-policy.md`).

## 4. The two chains

```
Buy:   Purchase order → Receipt (warehouse) ┐
                      → Bill (any order)    ┴→ Three-way match → Bill to pay → Paid
Sell:  Sales order    → Shipment (posted)   → Invoice → Issued        → Receivable  → Paid
```

Step 1a moved entry points and names, not rules. Step 1c changed one rule at
the owner's request (2026-10-03): a supplier's bill often arrives before the
goods, so it can be recorded first and the receipt added later. Payment still
always needs the three-way match.

Buy side (`docs/operational-finance-phase-5a.md`):

- Every bill line names one purchase-order line (`SUPPLIER_INVOICE_SOURCE_REQUIRED`).
  Either every line also names a posted, non-reversed receiving line of one
  receipt, or none does yet (`SUPPLIER_INVOICE_RECEIPT_PARTIAL`).
- A bill with a receipt cannot bill more than was received minus what other
  bills already hold on that receipt line.
- A bill **before its receipt** is recorded against an approved purchase order
  that can still be received (approved, issued, partially or fully received);
  it cannot bill more than was ordered minus what other submitted bills
  already claim on that order line (`SUPPLIER_INVOICE_QUANTITY_EXCEEDS_ORDERED`).
  It shows "Waiting for receipt" and cannot be matched, approved or paid
  (`SUPPLIER_INVOICE_RECEIPT_REQUIRED`). Once the warehouse posts the receipt,
  **Link receipt** on the bill names the receipt line of the same order line
  for every bill line; quantities and prices stay as billed. A receipt that
  covers less than the bill is allowed and the preview says so: the three-way
  match then raises a quantity exception, which must be reviewed before
  approval. A receipt of another order, an unposted or reversed receipt, or
  one without goods for a line is refused.
- Price, quantity and amount are checked per line against configured
  tolerances; line variances never offset each other.
- Bill lifecycle: `draft → submitted → matched | exception → approved | held`,
  plus cancel. Approval creates the bill to pay (`AP-…` number).
- Bill numbers are unique per supplier.

Sell side (`docs/operational-finance-phase-5b.md`):

- Every invoice line names a posted, non-reversed shipment line and its
  sales-order line. Price comes from the sales order.
- Submission checks cumulative shipped-not-invoiced quantity under a lock.
- Issuing an approved invoice creates one open receivable with a due date;
  aging uses calendar-day buckets in the workspace timezone.

Both sides keep the original ISO currency; nothing converts or adds amounts
across currencies.

## 5. Roles

| Role | Does | Permissions (existing) |
| --- | --- | --- |
| Warehouse | Receives goods, posts receipts and shipments | `receiving.*`, outbound posting |
| Purchasing | Requests, RFQs, purchase orders | `procurement.*` |
| Accounts payable | Records bills, reviews match exceptions, approves | `finance.supplier_invoice.*`, `finance.three_way_match.*` |
| Billing / AR | Creates and issues customer invoices, handles disputes | `finance.customer_invoice.*`, `finance.receivable.*` |

In a five-person company one person may hold all of them. Hiding a module from
the sidebar never replaces a permission check; the server checks every read and
command.

## 6. Navigation

```
Today
Purchasing     Workbench · Requests · RFQs · Purchase orders · Bills · Three-way match
Receiving      Receipts · Order lines
Inventory
Sales          Sales orders · Invoices · Delivery risks · Order evidence
Payables & receivables   Overview · Bills to pay · Receivables · Aging · Credits
Suppliers · Items · Reports
```

| Page | Path | Opens with | Writes need |
| --- | --- | --- | --- |
| Bills | `/app/procurement/bills` | `finance.supplier_invoice.read` | `supplier-invoice` capability |
| New bill | `/app/procurement/bills/new` | same, plus the capability | `supplier-invoice` capability |
| Bill detail | `/app/procurement/bills/:id` | `finance.supplier_invoice.read` | `supplier-invoice` capability |
| Three-way match | `/app/procurement/three-way-match` | `finance.three_way_match.read` | read-only |
| Invoices | `/app/sales/invoices` | `finance.customer_invoice.read` and the `sales` module | `customer-invoice` capability |
| New invoice | `/app/sales/invoices/new` | same, plus the capability | `customer-invoice` capability |
| Invoice detail | `/app/sales/invoices/:id` | `finance.customer_invoice.read` and the `sales` module | `customer-invoice` capability |

- **Bills** sits under Purchasing: list, "New bill", and on each bill its
  purchase order, receipt, three-way match result and bill to pay. Match
  exceptions are the `status=exception` filter of this list.
- **Invoices** sits under Sales: list and "New invoice".
- **Payables & receivables** replaces the "Finance" entry. It shows what is due
  to suppliers and owed by customers; documents are created elsewhere.
- Reading a bill or an invoice never needs the operational finance capability,
  only the read permission. This keeps the rule that capabilities gate
  transactions, not reads.
- Source documents carry the create buttons (step 1b):
  - "Record bill" on an approved purchase order (approved, issued, partially
    or fully received, or closed) and on a posted receipt. It opens
    `/app/procurement/bills/new?po=…` or `?receipt=…`: the supplier, order and
    receipt are chosen and each accepted quantity is offered. A purchase order
    without a posted receipt offers what was ordered and not yet billed; the
    bill then waits for its receipt (step 1c). The form can also be switched
    to "No receipt yet" by hand.
  - "Create invoice" on a sales order with a posted shipment and on a posted
    shipment. It opens `/app/sales/invoices/new?salesOrder=…` or `?shipment=…`
    with the shipment chosen and each shipped quantity offered.
  - The buttons show only with the create permission
    (`finance.supplier_invoice.create`, `finance.customer_invoice.create`) and
    the capability; the server checks quantities, prices and permissions again.
- The invoice page submits, approves and issues the invoice, each step
  previewed first; issuing shows the new receivable.
- Old URLs and route ids keep working (`legacyRouteRedirects` in
  `src/app/routes/route-manifest.ts`):

| Old | New |
| --- | --- |
| `/app/finance/invoices`, `/app/procurement/invoices` | `/app/procurement/bills` |
| `/app/finance/invoices/new` | `/app/procurement/bills/new` |
| `/app/finance/invoices/:id`, `/app/procurement/invoices/:id` | `/app/procurement/bills/:id` |
| `/app/finance/three-way-match` | `/app/procurement/bills?status=exception` |
| `/app/finance/customer-invoices` (`/new`, `/:id`) | `/app/sales/invoices` (`/new`, `/:id`) |

## 7. Where the books are kept

A workspace setting answers "Where do you keep your books?":
FlowChain, QuickBooks Online, QuickBooks Desktop, Xero, a spreadsheet, or other.
It changes only the last step of each chain:

| Step | Books in FlowChain | Books elsewhere |
| --- | --- | --- |
| Receipt, bill, match, approval | FlowChain | FlowChain |
| Shipment, invoice, issue | FlowChain | FlowChain |
| Payment made or received | Recorded in FlowChain | Recorded in the accounting system; FlowChain exports and later reads status back |
| Ledger, tax, bank | Not in FlowChain | Accounting system |

## 8. Recording payments (step 2)

The frozen internal settlement and cashbook module (`docs/internal-settlement-cashbook-phase-5-2.md`)
is too heavy for a small business and is not maintained. Step 2 adds a light
record instead (`PaymentRecord`, `server/domain/payment-record-command-service.mjs`):

- **Record payment** on the bill to pay (bill page) and **Record payment
  received** on the receivable (invoice page): date, amount, method (check,
  ACH, wire, card, cash, other), reference, note. The form offers what is
  still outstanding.
- Partial payments are allowed; one payment can never exceed what is
  outstanding; the currency is the document currency and nothing is
  converted. The date cannot be in the future.
- Status follows the records, using the statuses the obligations already had:
  approved or open → `partially_settled` ("Partly paid") → `settled`
  ("Paid"). The page shows what was paid and what is outstanding.
- A held bill to pay or a disputed receivable cannot take a payment until it
  is released or the dispute is resolved.
- A wrong record is voided with a reason, never edited or deleted. Voiding
  puts the amount back and the status follows.
- A bill to pay exists only after its bill passed the three-way match and was
  approved, so no payment can be recorded for goods that were not received or
  a bill that was not matched.
- Recording and voiding need `finance.payable.record_payment` or
  `finance.receivable.record_payment`, which the workspace administrator,
  operations manager and finance specialist roles get by default; seeing
  payments needs only the read permission, and amounts follow
  `finance.amounts.read`. Writes need the operational finance capability.
- Each step is previewed, then confirmed; commands are idempotent and audited.
- It records that money moved; FlowChain never moves money and writes no
  cashbook or ledger entry.

## 8a. Duplicate bill checks

A supplier sometimes sends the same invoice twice, or a bill is entered twice.
FlowChain flags such bills; it never blocks or holds one on its own (plan item
C1, decision 9). The rules are in `server/domain/supplier-invoice-duplicates.mjs`.

- The exact invoice number stays unique per supplier in the database
  (`SupplierInvoice_tenant_supplier_number_key`, cancelled bills excepted), so
  a bill with the same number is refused when it is entered.
- **Likely duplicate:** another bill of the same supplier whose number is the
  same once case, spaces, dashes, dots, slashes and leading zeros are set
  aside. Leading zeros are dropped from each run of digits both before and
  after the separators are removed, and either reading counts, so
  "INV-2024-001", "inv 2024/1" and "INV2024001" are all the same number.
  Because inner separators are removed, "INV-1-23" and "INV-12-3" are flagged
  too; both numbers are printed for the approver to judge.
- **Possible duplicate:** another bill of the same supplier in the same
  currency with the same total, dated at most 7 calendar days apart. The page
  prints how far apart ("same amount, 3 days apart"). Amounts are compared
  only within one currency. Bill dates are calendar dates as entered.
- Cancelled bills are left out. A bill with no supplier, number or date says
  which check was not done; it is never passed silently.
- The bill page shows each flag with the other bill's number (a link), date,
  amount and status, and so does the approval step. Both bills show the
  flag. Flags are listed likely first, then by the other bill's date, oldest
  first.
- An approver (`finance.supplier_invoice.approve`) either dismisses a flag
  with a reason, which is audited and shown afterwards with who and when, or
  cancels the bill through the usual cancel step. Approving a bill with an
  open flag asks for that first. Approved bills cannot be cancelled, so when
  the earlier bill is already approved, the later one is the one cancelled.
- Each approver dismisses the flag on their own bill. A dismissal given on
  the other bill is shown beside the flag but does not clear it. Once a bill
  is past approval (approved, held while its payable is on hold, or
  cancelled), its undismissed flags are shown for information only ("no
  action") and can no longer be dismissed on it.
- A dismissal names the other bill's version as the approver saw it; if the
  other bill changed since, the dismissal is refused and the page asks for a
  reload.
- A dismissal holds only while both bills keep the number, currency, total
  and date it was given for. Editing a draft reopens the flag, and the old
  dismissal is shown as no longer applying.
- A same-amount flag reveals that two totals are equal, so a role without
  `finance.amounts.read` does not see those flags and is told so. If such an
  approver approves a bill with an open same-amount flag, approval waits for
  someone who can see amounts; they are not told which bill.
- Payments are not held by these flags; whether to hold a bill to pay is a
  separate owner decision.

## 9. Accounting handoff

See section 10 for formats. Three layers, built in order:

1. **Files (step 3).** CSV exports of bills, invoices, payments, suppliers,
   customers and items, with presets for QuickBooks Online, Xero and a full
   Excel layout. Each export is an export batch: who, when, which documents,
   file hash. A document already exported is skipped unless the user exports it
   again on purpose. Approved bills already move to `export_ready`.
2. **Status back (step 4).** Import a payments file from the accounting system
   to mark bills and invoices paid, matched by document number.
3. **Direct sync (later).** QuickBooks Online and Xero connectors over OAuth:
   push bills and invoices, read payments back.

Every exported record keeps a stable FlowChain reference so the two systems can
always be matched, and partners and items get an optional "name in accounting
system" so names that differ still match.

## 10. Data formats

Researched on 2026-10-03 from Intuit, Xero and Microsoft documentation. Several
details could not be verified without a QuickBooks Online Advanced trial or a
Xero trial organisation; they are marked, and the real templates must be saved as
test fixtures before step 3 ships.

### What the research changes

1. **QuickBooks Online bill import is limited.** In the US only Advanced and
   higher can import bills from a file, and only expense-account lines; item
   details are not imported, so imported bills never move inventory.
2. **QuickBooks Online invoice import stops when sales tax is set up.** Most
   US product sellers have sales tax on, so a file import of invoices fails for
   them. For QuickBooks Online customers the API connector is the real path;
   files are a stopgap.
3. **Unknown products become "Sales" in QuickBooks Online.** Item names in the
   file must match exactly, so FlowChain must export items first or keep a
   per-item "name in accounting system".
4. **Xero merges bills that share a number**, even across suppliers. Exported
   bill numbers must be unique across suppliers (`{supplier code}-{bill no.}`).
5. **Neither system is idempotent on document numbers.** FlowChain tracks what
   it exported (an export batch per document) and never relies on the target
   to reject duplicates.

### Exports (step 3)

One row per line, header fields repeated on every row, UTF-8 with BOM, dates as
text, plain decimals with a separate ISO currency column, and never
tax-inclusive and tax-exclusive amounts in one file. Text cells that start with
`=`, `+`, `-`, `@`, tab, CR or LF are neutralised in the Excel layout only;
accounting presets keep the raw value because the prefix would be stored in the
ledger.

| Preset | Invoices | Bills | Contacts and items | Dates |
| --- | --- | --- | --- | --- |
| Excel (full) | Every field, one row per line | Every field, one row per line | Suppliers, customers, items with codes | `YYYY-MM-DD` |
| QuickBooks Online | `InvoiceNo, Customer, InvoiceDate, DueDate, Terms, Location, Memo, Item(Product/Service), ItemDescription, ItemQuantity, ItemRate, ItemAmount, Service Date`; at most 1,000 rows and 100 invoices per file | Bill no., Vendor, Bill date, Due date, Account, Line amount (Advanced only; US labels unverified) | Names up to 100 characters, no `:` or `"`; products need exact names | `MM/DD/YYYY` |
| Xero | `ContactName, InvoiceNumber, Reference, InvoiceDate, DueDate, InventoryItemCode, Description, Quantity, UnitAmount, Discount, AccountCode, TaxType, Currency` (copy the live template header) | Same family; bill numbers unique across suppliers | Contacts: ContactName; items: ItemCode up to 30 characters | `MM/DD/YYYY` for invoices; the bills article says `DD/MM/YYYY` (test it) |
| QuickBooks Desktop | IIF only (`!TRNS`, `!SPL`, `!ENDTRNS`); Intuit discourages it. Low priority | | | |

Matching keys FlowChain must keep per record and per connected company:

| Record | QuickBooks Online | Xero | FlowChain key today |
| --- | --- | --- | --- |
| Supplier / customer | Display name (file), `Id` (API) | ContactName (file), `ContactID` (API) | `Supplier.code`, customer `code` |
| Item | Exact name with category path (file), `ItemRef` (API) | `ItemCode` | `Item.sku` |
| Bill | Bill no. and vendor | InvoiceNumber (ACCPAY, not unique) | invoice number unique per supplier |
| Invoice | `DocNumber`, up to 21 characters | InvoiceNumber (ACCREC, unique) | invoice number unique per workspace |

### Direct sync (step 5)

- **QuickBooks Online first.** Bills (`VendorRef`, item-based lines with
  `LinkedTxn` to the purchase order), invoices (`CustomerRef`,
  `SalesItemLineDetail`), and paid status read back through webhooks
  (CloudEvents format since 2026) plus Change Data Capture (30-day look-back).
  Every write sends a `requestid` and checks `DocNumber` before retrying.
- **Xero second.** `Invoices` with `Type` ACCPAY or ACCREC, `Payments`, and
  webhooks for invoice updates. Its `Idempotency-Key` lasts six minutes, so it
  only covers transient retries.
- New fields for both: an external id per supplier, customer, item, bill and
  invoice per connected company, and the last sync status and error.

Sources: Intuit help articles "Import multiple invoices" (updated 2026-10-01),
"Common questions about importing data" (2026-08-03), "Contact fields imported
from Excel" (2026-08-02), "Import products and services" (2026-05-26), the IIF
overview (2026-08-04) and the QuickBooks Online API reference; Xero Central
"Import customer invoices (US)", "Import bills and credit notes (US)", "Import
contacts", "Import inventory items" and the Xero API reference; Microsoft
"Opening CSV UTF-8 files correctly in Excel"; OWASP "CSV Injection".

## 11. Delivery plan

| Step | Change | Schema change |
| --- | --- | --- |
| 1a | Names, navigation, redirects; the bill detail links its PO, receipt and match | No |
| 1b | Create buttons on source documents with prefill; submit, approve and issue on the invoice page | No |
| 1c | Bills recorded before the receipt; Link receipt on the bill | No |
| 2 | Record payment on bills to pay and receivables (implemented) | Yes |
| 3 | Books setting, export presets (Excel, Xero, QuickBooks Online) and export batches | Yes |
| 4 | Payments import; supplier, customer and item import | Yes |
| 5 | QuickBooks Online connector, then Xero | Yes |

## 12. Open questions

- Non-stock purchase lines (freight, services): the owner's rule is that every
  payment needs the three-way match, so such a line also needs a receipt (a
  confirmation that the service was delivered) before its bill is paid. The
  bill itself can be recorded first. How a service is "received" is still
  open.
- A bill links one receipt. If the goods on one bill arrive in several
  receipts, only one can be linked today, and the match reports the rest as
  missing. Linking several receipts to one bill needs a model change; decide
  whether it is needed.
- Supplier deposits and prepayments are not supported.
- Sales tax is not calculated; exports leave tax to the accounting system. This
  is also why QuickBooks Online customers with sales tax need the connector.
- Quantities offered on a new bill or invoice are the received or shipped
  quantities, not what is left after earlier bills or invoices; the preview
  reports any excess and the user corrects the line.
