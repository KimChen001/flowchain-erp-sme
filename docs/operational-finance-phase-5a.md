# Phase 5A — Procure-to-Pay Operational Finance

## Authoritative model decision

The existing PostgreSQL `SupplierInvoice`, `SupplierInvoiceLine`, and
`ThreeWayMatch` tables remain authoritative and are extended additively.
Phase 5A does not introduce parallel invoice or match models.

The additive P2P migration adds:

- line-level `ThreeWayMatchLine` facts;
- governed `FinanceMatchException` review facts;
- `PayableObligation` records that explicitly do **not** represent payment;
- supplier credit memos linked to both a posted supplier return and the
  original supplier invoice line.

All quantities, unit prices, tax entries, and amounts are persisted as
`Decimal(18,4)`. Policy decisions use fixed-scale integer arithmetic rather
than JavaScript floating point.

## Transaction boundary

Writes use focused commands, signed tenant identity, provisioned roles,
`expectedVersion`, stable idempotency hashes, `BusinessCommandExecution`,
`SERIALIZABLE` transactions, deterministic source-line locks, and `AuditLog`.

Invoice matching evaluates every invoice line independently against:

- the original purchase-order line;
- a non-reversed posted receiving line;
- previously invoiced quantity;
- source and invoice currency;
- configured quantity, price percentage, price absolute, and amount
  tolerances.

Line variances cannot offset each other. Currency mismatches fail closed and
no FX rate is inferred.

## Lifecycle boundary

Supplier invoice:

`draft → submitted → matched | exception → approved | held`

Payable obligation:

`approved → held | export_ready`

`export_ready` means that an accounting export may be prepared. It does not
mean paid, settled, posted to a ledger, or transmitted to a bank.

Supplier credit memos require a non-reversed posted
`supplier_return_dispatch` and an original supplier invoice line. Pricing is
either the original invoice price or a manager-reviewed explicit amount.

## Numbering

Supplier invoice numbers are unique per supplier, while payable numbers are
unique per workspace. Approval assigns `AP-{invoice number}` while it is free,
`AP-{supplier code}-{invoice number}` when another supplier already holds it,
and then `-2`, `-3` and so on. The approval preview shows the number the
approval will record. A typed `obligationNumber` is kept as entered, and one
that is already used is refused with `PAYABLE_OBLIGATION_NUMBER_DUPLICATE`
(409).

Approval looks the candidate numbers up by exact value inside its
serializable transaction. Two approvals in the same workspace can still
conflict there, even when their numbers differ, and two approvals can race
for the same number. In both cases the approval is retried automatically up to
two times, and the retry assigns the next free number. Only when the retries
run out does the user get a retryable 409 (`FINANCE_CONCURRENCY_CONFLICT` or
`PAYABLE_OBLIGATION_NUMBER_CONFLICT`). The other P2P commands are not retried.

A collision number such as `AP-SUP-001-1001` contains the supplier code.
The payable number is the payable's business identifier and is never masked,
so a user who can read payables or settlements without
`finance.partner_snapshot.read` can see that code, even though the supplier
name on the same row is hidden. The invoice's `supplierId` was already
visible to these users.

Supplier credit memo numbers are stored as entered and are unique per
workspace (`SUPPLIER_CREDIT_MEMO_NUMBER_DUPLICATE`, 409). Two suppliers that
both issue credit memo `CM-1` therefore cannot both be recorded under that
number; making it unique per supplier needs a schema change.

## Explicit exclusions

Phase 5A creates no bank payment, check, ACH, payment batch, bank
reconciliation, general-ledger entry, journal entry, tax filing, inventory
valuation, COGS, automatic FX conversion, or QuickBooks transaction.

## Acceptance commands

```text
npm run test:db:operational-finance
npm run test:api:operational-finance
```

The PostgreSQL gate covers both a fresh deployment and an upgrade from the
Phase 4 final schema. Database acceptance requires zero failed and zero
skipped tests.
