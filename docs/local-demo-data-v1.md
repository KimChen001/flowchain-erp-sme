# Local demo data v1

Demo data is explicit, deterministic, tenant-scoped, versioned, idempotent, and local-development only. Production routes contain no demo fallback.

`npm run pilot:setup:demo` creates four suppliers, six items, three customers, one demo warehouse, three locations, two payment terms, and two tax codes. Stable identifiers begin with `LOCAL-DEMO-`. A collision with a non-demo supplier code or item SKU fails instead of overwriting the record.

`npm run pilot:setup:scenario` requires the master demo first and creates one open purchase request, two purchase orders, one partial receiving document, one supplier invoice with a matching variance, and one sales order. These records are marked `localDemo` and do not post inventory, create payments, or perform irreversible financial actions.

Running either command repeatedly leaves the same record counts. Ordinary `pilot:setup` creates no business demo records.
