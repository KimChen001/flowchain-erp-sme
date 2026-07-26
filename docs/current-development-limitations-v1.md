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
- Phase 5.4A does not provide business commit adapters.

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
- universal CSV/XLSX parsing, email intake, PDF/OCR, or automatic import commit.

## Operational Limits

- Universal Intake is preview-only and requires explicit enablement.
- Only manual artifact upload is enabled in Phase 5.4A.
- Mapping activation and review require permissions distinct from upload.
