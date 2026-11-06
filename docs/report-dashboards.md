# Report dashboards

The analytics dashboards (`/app/reports/overview`, `procurement?view=analytics`,
`sales`, `inventory`, `finance` and `suppliers`) draw their visuals with Apache
ECharts (Apache-2.0). It is bundled as `vendor-echarts` and loads only with the
reports pages. The server builds every visual in
`server/domain/report-dashboard-visuals.mjs` from the same filtered scope as the
KPIs and the detail table; the client renders it in `src/modules/reports/charts/`.

## Rules every visual follows

- A visual aggregates the whole filtered scope, not the 50-row detail page.
- Only recorded values are used. A missing amount, quantity or date is left out
  and the visual says so; it is never counted as zero.
- Amounts are added only within one currency: the currency filter, or the single
  currency every row is in. Otherwise the visual counts documents, or (the value
  bridge) asks for a currency.
- Quantities are added only within one SKU, because SKUs use different units.
- Receipts use the arrival date, falling back to the creation date. Every other
  filter follows the receipt's purchase order.
- Overdue counts use today in the workspace timezone.
- Three-way match outcomes come from the invoice: matched, exception (recorded as
  exception or variance) or awaiting match.
- No visual judges a figure against an assumed target. The supplier matrix uses
  the median spend and the average on-time rate as its guides.
- On time is the supplier scorecard's figure (`server/domain/supplier-scorecard.mjs`),
  counted in deliveries: the lines of one purchase order that share an original
  promised date. A delivery is on time when every line's first posted receipt
  arrived by that date plus the grace days; past that day with a line not
  received it is late, and while a line is not yet due it waits. The original
  promise is the date on the PO at approval, which may be the buyer's need date
  until suppliers confirm dates. A rate needs at least 5 deliveries.
  Only orders the supplier got are measured: issued, with a sent transmission
  status or an issue time, or with a posted receipt in any warehouse. An order
  approved but not sent, with nothing received, is left out and listed on the
  scorecard as "Not sent to supplier" (owner decision 2026-10-06).

## Visuals

| Dashboard | KPIs | Visuals |
| --- | --- | --- |
| Overview | Committed amount, open POs, inventory risk SKUs, sales orders | Record activity by month, purchase order status, purchasing by supplier, committed spend by month, purchase order lifecycle |
| Procurement | Committed amount, open POs, overdue open POs, on-time deliveries | Committed spend by month (bars and order count), lifecycle funnel, spend concentration (Pareto with A/B/C classes), ordered/received/invoiced value bridge, spend treemap by supplier and item, status, receiving calendar |
| Finance | Invoice amount, invoices matched, awaiting match, match exceptions | Submitted invoices by month, match-rate gauge, match outcome, supplier-to-outcome flow (Sankey), variance by supplier, invoice status |
| Sales | Sales orders, open demand, order amount, orders shipped in full | Orders by month, fulfillment funnel, customer concentration, shipped-in-full gauge, open demand by SKU, status |
| Inventory | On hand, risk SKUs, out-of-stock SKUs, SKUs short against demand | On hand by SKU, stock position by SKU, available to promise by SKU, stock status, stock status by risk heatmap |
| Suppliers | Suppliers, committed amount, suppliers with committed orders, on-time deliveries | Performance matrix (spend × on-time, sized by deliveries measured), scorecard radar, on-time ranking, spend treemap, purchase orders by supplier and month |

The lifecycle and fulfillment funnels count, at each stage, the orders that
reached it and every stage before it. The value bridge compares net line values:
ordered and received quantities at the order price, and the invoice lines linked
to each order.

## Interactions

- Selecting a bar, slice, cell or bubble filters the dashboard. The filter is in
  the page link and survives a refresh.
- Each visual offers Show data (a table whose rows also filter), focus mode, a PNG
  download, a CSV download (plain numbers, UTF-8) and View business details.
- In a treemap, selecting a supplier drills into its items; the breadcrumb returns.
- Date presets (this month, last 3 months, year to date, last 12 months, all
  dates) use the workspace timezone.
- KPI sparklines show monthly committed amounts (one currency) or counts, and need
  two dated months. Rate KPIs show a bar from 0 to 100%.
- Key insights restate figures already on the page as sentences.

## Language

Visual titles, descriptions, stage, measure and insight text are English with a
Chinese translation in `src/modules/reports/analyticsCopy.ts`. Status codes are
translated by `reportStatusCopy`. Supplier, customer and SKU names stay as
recorded. Both languages are covered by `npm run test:browser:reports`.

## Tests

`server/domain/report-dashboard-visuals.test.mjs` covers the aggregation rules
above; the browser suite covers rendering, filtering and export in both languages.
