# Draft-first Action Boundary v1

## Purpose

Draft-first Action Boundary v1 defines how AI-assisted actions should appear before FlowChain adds any confirmed write behavior. AI can prepare reviewable drafts, but it cannot submit, send, post, close, or create business records autonomously.

## Supported Draft Action Types

- `purchase_request_draft`
- `rfq_draft`
- `po_followup_draft`
- `inventory_exception_closure_draft`
- `supplier_followup_draft`

Each draft uses common fields:

- `id`
- `type`
- `title`
- `status`
- `source`
- `createdBy`
- `createdAt`
- `requiresConfirmation`
- `originEvidence`
- `payload`
- `validation`
- `auditTrail`

The only current status is `preview`.

## Preview-only API

- `GET /api/action-drafts/schema`
- `POST /api/action-drafts/preview`
- `POST /api/action-drafts`
- `POST /api/action-drafts/save`

The preview endpoint validates a draft payload and returns a draft shape. It does not call `writeDb`, persist a draft, create a PR/RFQ/PO, close inventory exceptions, or send supplier messages.

The save endpoints persist only the ActionDraft shell in database mode. JSON mode returns a demo-safe `501`. Saving a draft does not create a PR/RFQ/PO, close inventory exceptions, send supplier messages, or confirm the draft.

In database mode, draft preview and draft save also attempt best-effort AuditLog events. Audit failure does not block preview or save responses, and the audit summary omits raw prompts, request bodies, secrets, and database URLs.

`purchase_request_draft` now has a specialized preview helper for inventory-driven PR suggestions. It still returns preview-only draft data and does not create a real PR.

`rfq_draft` and `supplier_followup_draft` also have specialized preview helpers. They return reviewable draft payloads and never create RFQs or send supplier messages.

## Review UI Shell

The frontend review shell lives in `src/modules/action-drafts/ActionDraftReviewShell.tsx`.

It can display:

- draft title, type, source, status, and confirmation boundary;
- business-readable payload fields;
- origin evidence through canonical evidence links where safe;
- validation warnings and missing fields;
- an audit preview note.

Safe controls:

- close;
- cancel local preview;
- copy draft content;
- for supplier message drafts (`po_followup_draft`, `supplier_followup_draft`), edit
  the recipient, subject and multi-line message, and **Open in email**: a `mailto:` link
  that starts the message in the user's own mail app. FlowChain sends nothing.

Fields the assistant suggested carry their source (record, default or template) in the
draft's `prefill` map, and the review shows it next to each field while it still holds
the suggestion (`docs/ai-prefill-autocomplete-design.md`).

The confirm button is visible but disabled. Real confirmation, submit, send, post, or close behavior remains future work.

## Confirmation Boundary

- A draft is not submitted.
- A user must review the draft.
- A user must confirm before any future write behavior.
- Future confirmation actions must be explicit and type-specific.
- Autonomous execution is not allowed.

## Audit Boundary

Current database-mode draft events use:

- `draft_previewed`;
- `draft_saved`;
- `ai_draft_used` (`POST /api/action-drafts/used`): the user copied a draft or opened it
  in their mail app. It records the draft type, the use and, for a prefilled draft, which
  suggested fields were kept, edited or cleared, as codes. It never stores the text.

Future confirmed actions should record audit events that include:

- actor and source;
- draft type and confirmed action;
- origin evidence;
- before/after state where applicable.

The boundary does not store secrets and does not store raw prompts by default.

## Conceptual Mapping

- Today Cockpit inventory risk -> `purchase_request_draft`
- Today Cockpit procurement followup -> `supplier_followup_draft`
- Three-way match exception -> `po_followup_draft`
- Inventory exception -> `inventory_exception_closure_draft`
- AI PR prompt -> `purchase_request_draft`
- AI RFQ prompt -> `rfq_draft`

## Non-goals

- No real PR, RFQ, or PO creation.
- No inventory mutation.
- No receiving posting.
- No supplier message sending.
- No payment execution.
- No business-document persistence from drafts.
- No autonomous actions.
- No external AI provider enablement.
