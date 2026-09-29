# Open purchase orders

Open `/app/reports/procurement` from Reports. The existing dashboard remains
available at `/app/reports/procurement?view=analytics`; existing saved dashboard
links retain their dashboard rendering.

The report defaults to orders with outstanding receipts, including drafts.
Cancelled, rejected, closed, completed and fully received orders are excluded.
Date filters use order creation dates. Overdue days use the earliest promise
among outstanding lines, falling back to the order expected date, measured at
the displayed UTC reporting date. Missing dates and receipt quantities remain
unknown. Quantities with different units are not added together.

Filters, sort order, page size and column visibility are stored in the URL and
can be bookmarked. Amounts represent full order amounts, not payable balances;
each currency has its own subtotal with no FX conversion. Export includes every
matching order plus report scope and metric definitions. Currency and unit
columns are always included in the workbook to preserve numeric meaning.

`GET /api/reports/open-purchase-orders` uses the authenticated workspace identity.
Its dedicated repository read does not inherit the operational snapshot's
500-order cap. Filtering, summary calculation and sorting precede pagination.
The first version reads the workspace orders into memory; large deployments
should move aggregation and export streaming into the database before increasing
volume substantially. Other report dashboards retain their existing limits.

Validation covers 601-order pagination and export, partial receipts, missing
values, invalid dates, mixed units and currencies, tenant scope, English and
Chinese UI, and the downloaded workbook's rows and numeric cell values.
