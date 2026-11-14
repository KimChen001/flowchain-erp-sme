# Public data workspaces

The local walkthrough (`npm run walkthrough:local`) runs on two public datasets, one workspace each. FlowChain is a research project, so its walkthrough uses public data with stated assumptions rather than invented records.

| Workspace | Dataset | Currency, timezone | App port |
| --- | --- | --- | --- |
| Walmart store CA_1 (M5 public data) | M5 Forecasting, Walmart daily unit sales | USD, America/Los_Angeles | app port (default 15201) |
| UK online gift retailer (UCI public data) | UCI Online Retail II | GBP, Europe/London | app port + 1 |

A FlowChain server serves one workspace, and the two businesses share nothing, so each dataset has its own workspace with its own currency. Both live in one embedded PostgreSQL. Every page of either workspace shows a note (English and Chinese) saying what comes from the data and what is assumed.

## Sources

- **UCI Online Retail II.** Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C5CG6D. Licence CC BY 4.0. Transactions of a UK online gift retailer, many of whose customers are wholesalers, from 2009-12-01 to 2011-12-09.
- **M5 Forecasting Accuracy.** Makridakis, S., Spiliotis, E., Assimakopoulos, V. (2022). M5 accuracy competition: Results, findings, and conclusions. International Journal of Forecasting 38(4), 1346-1364. Kaggle's competition rules were not checked, so this data is used locally for non-commercial research only.

Neither dataset, nor any number derived from it, is committed to this repository. The seed reads a local extract and stops with instructions when it is missing.

## Extract

```bash
python -I scripts/public-data/extract_public_data.py --uci <online+retail+ii.zip> --m5 <folder with calendar.csv, sales_train_evaluation.csv, sell_prices.csv> --out ~/flowchain-data/public-data-extract.json
```

The extractor uses the Python standard library only and runs isolated (`-I`), so nothing from the data folders is imported. It reads the M5 CSV files and the spreadsheet XML inside the UCI workbook, refuses any XML part that declares a DTD, checks every input file against the SHA-256 recorded when it was downloaded, and refuses to write inside the repository. It takes about 35 seconds.

### Selection rules

UCI Online Retail II:

- **Window:** the 365 days ending on the last invoice day in the data (2010-12-10 to 2011-12-09).
- **Sale lines:** invoice number not starting with C, quantity > 0, price > 0, StockCode of five digits with an optional letter (drops postage, fees, manual adjustments and gift vouchers).
- **Products:** sold on at least 30 days of the window across all customers; the 200 with the most units, ties by code. Name: the most frequent description. Price: the median line price in the window.
- **Customers:** a Customer ID divisible by 4, a fixed one-in-four sample, so the history stays within what the reorder list reads (20,000 shipment lines in 90 days). Lines without a Customer ID are left out. The data has no customer names, so a customer is named by its ID and country.
- **Orders:** each sale invoice of a sampled customer, with its lines for the selected products; lines of one product at one price are added up.
- **Cancellations:** invoices starting with C of a sampled customer, for the selected products. The extract keeps them; see Limitations.

M5, store CA_1:

- **Window:** the last 365 days of `sales_train_evaluation.csv` (2015-05-24 to 2016-05-22).
- **Items:** in each of the store's seven departments, the 28 items with the most units in the window, ties by `item_id`: 196 items, under the 200 items the app's business read context lists. M5 has no product names; an item is named by its department and number (FOODS_3_090 is "Foods 3 item 090").
- **Sales:** daily units as recorded; days without sales are 0.
- **Prices:** the store's weekly sell price; a week without one takes the nearest earlier week's price, else the nearest later one.

## Mapping

| FlowChain record | UCI | M5 |
| --- | --- | --- |
| Item | StockCode, name, median price | `item_id`, department, latest weekly price |
| Customer | Customer ID and country | one customer: the store's shoppers (point of sale) |
| Sales order | one per invoice, at its time | one per day, every item sold that day at that week's price |
| Shipment | posted one hour after the invoice | posted at 21:00 that day |
| Customer invoice and receivable | one per shipment, issued on the day | none (point of sale) |
| Supplier invoice, three-way match, payable, payment | one per posted receipt [assumed], see below | none |

Shipments, receipts and opening stock go through FlowChain's own posting commands in date order, so stock, inventory movements, order status and the reorder list agree. UCI supplier invoices go through the supplier invoice, three-way match, approval and payment commands the same way, so match results, match exceptions and payables come from the app's own rules. Each record keeps its original date and source number in its metadata.

## Dates

Dates move by whole days so the last day of the data is the day before the seed day in the workspace timezone. A rerun of the walkthrough keeps its data; `--reset` seeds again as of the new day. Weekdays move with the dates: a pattern on a Saturday in the data falls on another weekday in the workspace.

## Assumed (not in the data)

Both datasets have demand only. Everything a buyer also needs is assumed, by the research rules (`data/public/m5/SELECTION.md` of the research folder), and labelled so in the workspace note:

- **Suppliers:** M5, one per department ("Foods 3 vendor (assumed)"); UCI, one per StockCode family of the first two digits, with families of fewer than five products sharing one ("Supplier of 22xxx codes (assumed)"). Two UCI families have fictional names for the walkthrough scene (below).
- **Lead time** 14 days; **review** every 7 days, on Mondays.
- **Minimum order** a week of average daily demand, rounded up to 10.
- **Safety stock** a week of average demand; **reorder point** 21 days (lead time plus review) of average demand. The average is over the last 90 days of the window, the window the reorder list reads and the research instances use.
- **Purchase price** (since 2026-11-12) a share of the public selling price, because neither dataset has costs: **50 %** for UCI (of the item's median price) and **75 %** for M5 (of the store's price on the day the purchase order is placed), worked in whole pence or cents. The item's supplier terms (reference price) carry the same price, at the last day's price for M5. Every purchase order line records it in its metadata (`purchasePriceAssumed: { percentOfSellingPrice, sellingPrice }`), and the workspace note states it. So stock value, holding cost and the order plan's costs are at this price, and gross profit (sales less units sold at this price) can be read, as an assumption. Before 2026-11-12 the purchase price was the selling price, which left gross profit near zero. The research instances (`scripts/public-data-instance.mjs`) keep the selling price as their proxy, so h = 25 %/yr × price × (L + 7)/365 and π = 5h there still match the research rule.
- **Purchasing history:** a weekly-review base-stock policy. The base stock level is the reorder point plus the safety stock (average demand over lead time and review, plus the buffer). Opening stock, the day before the window, is that level plus the minimum order. At each Monday review an item whose position (on hand plus on order) is at or below its base stock level is ordered up to that level plus its minimum order; the purchase order arrives 14 days later, at 07:00, and is received in full. Public demand is never cut: when a day's demand is more than the stock on hand, the item's order at the latest review that arrives by then is raised by the shortfall plus its safety stock (or such an order is added, at least the minimum), and before the first such review the opening stock is raised. Purchase orders placed in the last 14 days are still open.
- **UCI payment terms:** customer invoices are due 30 days after the invoice and paid on the due date; receivables before the seed day are settled.
- **UCI supplier invoices and payments** (since 2026-11-12; `PUBLIC_DATA_SUPPLIER_INVOICE_RULES` and `planSupplierInvoices` in `scripts/public-data/plan.mjs`, recorded by `scripts/public-data/seed-payables.mjs`). Each difference is one stated rule, and the invoices a rule picks are chosen by a fixed hash of their order, so the same seed day always gives the same invoices:
  - **One invoice per posted receipt**, dated 0 to 5 days after it, due 30 days after the invoice (NET30, labelled `paymentTermsAssumed` like the customer invoices). Numbered `INV-<supplier code>-0001` upwards per supplier. A receipt whose invoice day falls on or after the seed day is received and not invoiced yet.
  - **Price above the order** (about 5 % of invoices): one line priced 2 to 5 % above the purchase order price, rounded up to the penny. The three-way match records a price and an amount exception on that line.
  - **Billed more than received** (about 3 %): one line was delivered 5 % short (at least one unit). The purchase order line was for the full quantity; the receipt has what arrived, so stock is as before. The supplier bills the full ordered quantity: the invoice is recorded against the purchase order, submitted, then linked to the short receipt, and the match records a quantity exception. The buyer closes the rest of the order the same day with FlowChain's close command (the order then reads closed, not open or late). FlowChain refuses an invoice entered from a receipt for more than the receipt holds, so this is the app's own path to such a difference.
  - **Dated before the receipt** (about 2 %): the invoice is dated 1 to 3 days before the goods arrived, recorded against the purchase order on its own day, and linked to the receipt on the day it is posted; it then matches.
  - **Held:** an invoice with a difference stays at the three-way match with its exceptions open: not approved, so it has no payable and is not paid.
  - **Paid:** a matched invoice is approved the day it matches, which records its payable. One due before the seed day is paid on its due date (a payment record, method Other, reference "Bank transfer <invoice>"), except 10 % of those due in the 60 days before the seed day, which are left unpaid and so are overdue. One due on or after the seed day is open.
  - Each record is labelled assumed in its metadata (`invoiceRule`, and for a difference the line, the order and invoice prices or the ordered and received quantities) and dated by the plan; the commands' own audit rows are moved to the same business times.
  - The weekly orders carry the differences; the walkthrough scene's orders do not, so the scene is unchanged.

## The walkthrough scene (UCI workspace)

A buyer's first look at FlowChain needs a few purchasing problems to look at. The UCI workspace therefore has one labelled scene, all of it on the assumed purchasing side; the public sales are unchanged. It is defined in `scripts/public-data/scene.mjs`, dated back from the seed day (`--as-of`), and the plan stops with the reason if the data no longer supports it.

- **Suppliers.** StockCode family 85 is *Acme Home Goods* (orders@acme-homegoods.example) and family 84 *Globex Party Supplies* (orders@globex-party.example): fictional names on reserved `.example` domains. Acme is Tier 1, set by the buyer with a written reason that states its share of purchase spend. Every third Acme order before the last three weeks arrived 2 days after its promised date, so its on-time rate shows.
- **Buyer.** Daniel (daniel@example.com, buyer, the manager's role) owns the purchase orders and set the tier.
- **Hero.** 85123A White Hanging Heart T-Light Holder ends below its safety stock. Acme has two late open orders for it: one partly received, one with nothing received. Together they cover its reorder point, so the reorder list does not suggest it.
- **Second supplier.** 84879 Assorted Colour Bird Ornament has one late Globex order with nothing received, so late orders span two suppliers.
- **Reorder.** 22423 Regency Cakestand 3 Tier has no open order and ends 20 under its reorder point; the reorder list suggests its minimum order.
- **Approval.** 85152 Hand Over The Chocolate Sign has a purchase order waiting for approval.

The scene items place no weekly orders in the last weeks (the hero and the bird ornament three weeks back, the cakestand from the latest review that still leaves it just under its reorder point), and their stock is cut back by cutting earlier received orders, never below an order's minimum and never so far that a public order goes unmet. The workspace note names the two suppliers as fictional and the scene as assumed.

## Size and seed time

Seeded as of 2026-11-10 (the data's last day moved to 2026-11-09), on a Windows laptop with the embedded PostgreSQL:

| | M5 (Walmart CA_1) | UCI Online Retail II |
| --- | --- | --- |
| Items | 196 (7 departments x 28) | 200 |
| Customers | 1 (point of sale) | 1,023 |
| Sales orders (shipped) | 364 (one a day) | 3,548 (each with an issued customer invoice) |
| Sales order lines | 54,927 | 24,092 |
| Units sold | 503,462 | 437,167 |
| Suppliers [assumed] | 7 | 7 (Acme and Globex named) |
| Purchase orders [assumed] | 370 (5,819 lines), 14 open | 356 (3,825 lines), 17 open, 10 closed short |
| Receipts posted | 356 | 339 (4 not invoiced yet) |
| Supplier invoices [assumed] | none | 335: 308 matched and approved (276 paid, 5 overdue, 27 open), 27 held at the match (17 priced above the order, 10 billing more than received); 7 dated before their receipt |
| Seed time | about 14 minutes | about 14 minutes (the supplier invoices about 35 seconds) |

Gross profit over the window, at the assumed purchase prices: UCI £276,236 on £588,460 of sales (46.9 %), M5 $275,200 on $1,105,462 (24.9 %). The extract takes about 50 seconds. The workspaces are seeded one after the other (side by side, their serializable postings abort each other), so a first start takes about 28 minutes.

## Run it

```bash
npm ci
npx prisma generate
npm run walkthrough:local -- --extract=~/flowchain-data/public-data-extract.json
npm run walkthrough:local -- --reset --as-of=2026-11-10   # seed as of a given day
```

`FLOWCHAIN_WALKTHROUGH_PRIMARY=uci` puts the UCI workspace on the app port and M5 on the second. `FLOWCHAIN_WALKTHROUGH_DIR`, `FLOWCHAIN_WALKTHROUGH_PG_PORT`, `FLOWCHAIN_WALKTHROUGH_API_PORT`, `FLOWCHAIN_WALKTHROUGH_APP_PORT`, `FLOWCHAIN_WALKTHROUGH_SECOND_API_PORT` and `FLOWCHAIN_WALKTHROUGH_SECOND_APP_PORT` move the data folder and ports. `npm run dev:local -- --public-data` (M5) or `--public-data=uci` seeds a development database once, while its workspace is empty. `npm run public-data:seed -- --dataset=m5` seeds one provisioned workspace directly.

## Limitations

- UCI cancellations are not yet posted as customer returns: the returns module is outside the trial capability set the walkthrough runs, and a credit note needs a posted return. They stay in the extract.
- One in four UCI customers, and 200 of about 3,900 products sold in the window; 196 of CA_1's 3,049 items. The business read context also lists at most 200 customers and the 500 most recent sales orders; the reorder list and Today warn about the sales orders only when an order that can still need stock was left out.
- Suppliers deliver on time and in full apart from the walkthrough scene and the supplier invoice rules above; purchase prices are a fixed share of selling prices, so every UCI item has the same 50 % cost ratio on its median price.
- M5 has no supplier invoices or payments: it carries the purchase price ratio only.
- Supplier invoices carry no tax lines, and supplier credit notes and returns are not seeded.

## Tests

CI cannot read local files, so the PostgreSQL tests and the browser test harness (`scripts/browser-product-recovery-api.mjs`) use a small fictional workspace in `tests/fixtures/workspace/`. It is test-only and never seeded into a workspace a person uses. The planning rules above are tested on a synthetic extract in `server/domain/public-data-workspace-plan.test.mjs`.
