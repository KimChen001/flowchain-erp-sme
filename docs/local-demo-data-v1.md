# Local demo data v1

Demo data is explicit, deterministic, tenant-scoped, versioned, idempotent, and local-development only. Production routes contain no demo fallback.

`npm run pilot:setup:demo` creates four suppliers, six items, three customers, one demo warehouse, three locations, two payment terms, and two tax codes. Stable identifiers begin with `LOCAL-DEMO-`. A collision with a non-demo supplier code or item SKU fails instead of overwriting the record.

`npm run pilot:setup:scenario` requires the master demo first and a USD workspace. It creates the US walkthrough scenario: one open purchase request, one RFQ, 32 purchase orders from six suppliers across every status (draft, pending approval, approved, issued, partially received, fully received, cancelled), 14 receiving documents with arrival times (early, on-time, late and rejected deliveries), 11 supplier invoices due across the current, 1-30, 31-60, 61-90 and 90+ aging buckets, and one sales order. Every date is an offset from the seed day in the workspace timezone; pass `-- --as-of=YYYY-MM-DD` (or set `FLOWCHAIN_SCENARIO_AS_OF`) to pin it. Invoice variances are stored as a three-way match computes them, tax-exclusive, with the `price_variance` type code. Re-running the command re-dates the scenario to the new seed day, except documents a business command has changed (their version has moved) and quotation revisions, which the database keeps immutable. These records are marked `localDemo` and do not post inventory, create payments, or perform irreversible financial actions; receipts are recorded but unposted.

Running either command repeatedly leaves the same record counts. Ordinary `pilot:setup` creates no business demo records.
