# Current Development Limitations v1

## Current State

FlowChain has a PostgreSQL-only runtime and tenant-scoped operational
foundations. Managed SaaS deployment and every future integration remain
subject to explicit release gates.

## Data and Persistence

- `DATABASE_URL` is required.
- JSON persistence and automatic production fallback are removed.
- Universal Intake stores only metadata and bounded row structures in
  PostgreSQL; artifact bytes remain in external storage.
- Phase 5.4B does not provide business commit adapters.
- Universal Intake is the sole forward-looking intake authority.
- Legacy Pilot Import production routes are retired and fail closed. Existing
  `ImportBatch` and `ImportIssue` rows are non-authoritative historical
  compatibility data and receive no new production writes.

## Draft-first Boundary

- Action drafts are preview-only.
- Purchase request draft preview does not create a purchase request.
- RFQ draft preview does not create an RFQ.
- Supplier follow-up draft preview does not send supplier messages.
- Exception case draft preview does not create a case until explicitly confirmed.
- Confirm/submit behavior remains disabled or future-work unless a later round explicitly implements it.
- No autonomous AI execution is implemented.

## AI Boundary

- External AI providers are disabled by default.
- Placeholder API keys do not activate provider calls.
- Deterministic local AI paths answer supported cockpit, procurement, inventory, supplier, RFQ, planning, and draft-preparation prompts.
- AI answers should include business evidence where supported.
- Audit persistence failures must not break read-only AI answers.

## Business Scope Limits

The current project does not implement:

- full ERP coverage;
- SAP/Oracle replacement behavior;
- full finance or GL;
- payment execution;
- tax filing;
- bank integration;
- CRM/customer lifecycle suite;
- HR/payroll;
- complex WMS execution;
- real supplier message sending;
- transaction-document intake, email intake, PDF/OCR, voice/chat extraction, or
  automatic import commit.

## Operational Limits

- Universal Intake is preview-only and requires explicit enablement.
- Manual CSV/XLSX upload and Paste Table/Paste JSON are enabled only for
  Supplier, Item, and Customer previews.
- Custom fields extend those standard entities but do not create custom
  entities or drive operational forms, conditional rules, or workflows.
- Public direct IntakeRecord insertion is retired; parser ownership is required.
- Mapping activation and review require permissions distinct from upload.
- Governed business-object commit adapters start in Phase 5.4C; commit requests
  remain blocked in Phase 5.4B.
# Phase 5.4B.1 limitations

- Supplier, Item, and Customer formal commit workflows remain outside this stabilization release.
- The local scenario is preview data and deliberately performs no inventory posting, payment, or irreversible finance action.
- Demo removal is intentionally manual and prefix-scoped; the launcher never wipes a database.
- Dependency major-version hardening remains a separate backlog. On 2026-07-27,
  `npm audit --omit=dev` reported 8 production dependency advisories
  (4 moderate, 4 high, 0 critical). This stabilization release does not mix in
  major upgrades to Prisma, React Router, Undici, or XLSX. Structured Intake
  keeps its bounded production parser path; the legacy `xlsx` dependency
  remains in the separately governed bank-statement and workbook surfaces.
