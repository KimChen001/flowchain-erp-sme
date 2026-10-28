# AI Safety and Draft-first Explainer v1

## Safety Model

FlowChain treats AI as an assistant for reading, summarizing, explaining, and preparing drafts. It does not treat AI as an autonomous execution engine.

The safety model has four layers:

- deterministic local handlers first;
- external provider safety gate;
- evidence-based responses;
- draft-first action design with user review.

## Deterministic AI First

Supported operational prompts are handled by local read models before any provider fallback. Examples include:

- `今天最需要处理什么？`
- `哪些采购单据有风险？`
- `哪些库存项目需要关注？`
- PR/RFQ/PO/GRN status questions;
- supplier operational summaries;
- PR/RFQ/supplier follow-up draft preparation.

The cockpit fast path uses Today Cockpit, procurement, and inventory read models. It is designed to return quickly and avoid frontend timeout for cockpit-style prompts.

## Provider Safety Gate

External provider calls are disabled by default.

Provider keys alone are not enough to enable external calls. Fake or accidental values in `OPENAI_API_KEY`, `ARK_API_KEY`, or `DOUBAO_API_KEY` do not activate provider fallback. Provider access must be explicitly enabled by configuration.

When provider fallback is disabled, unsupported prompts return a safe local message instead of attempting network calls.

## Evidence-based Responses

AI responses should use business evidence where supported:

- supplier master data;
- item/SKU evidence;
- PR, RFQ, PO, GRN, invoice, and three-way-match evidence;
- inventory movement and exception evidence;
- Today Cockpit recommended actions.

Evidence links use the same canonical navigation shape as Global Search and Today Cockpit where possible.

## Draft-first Actions

AI may prepare reviewable action drafts, such as:

- purchase request draft;
- RFQ draft;
- supplier follow-up draft.

The current system does not let AI:

- create a real PR;
- create a real RFQ;
- create a real PO;
- post receiving;
- mutate inventory;
- send supplier messages;
- execute payment;
- file tax;
- confirm actions without a user.

Draft responses keep:

- `previewOnly: true`;
- `requiresConfirmation: true`;
- `confirmationBoundary.submitted: false`.

## Audit Boundaries

Audit events are best-effort. AI read-only answers and draft previews should not fail just because audit persistence is unavailable.

Audit behavior must not log:

- secrets;
- API keys;
- bearer tokens;
- raw provider tokens;
- full environment values;
- raw stack traces to users.

## Future Confirmation Path

A later phase may introduce controlled confirmation workflows. That future work should keep:

- explicit user review;
- permission checks;
- audit records;
- preview-to-confirm separation;
- repository-backed persistence boundaries.

The proposed design for this path, limited to a draft purchase request and a draft RFQ
from an approved request, is [Assistant actions: propose, confirm, execute](ai-confirmed-actions-design.md)
(2026-10-05, not built yet).

## Non-goals

- Do not enable external AI providers by default.
- Do not add autonomous AI execution.
- Do not add payment, tax, bank, OCR, PDF, or xlsx automation.
- Do not create real business records from AI drafts in the current UAT scope.
