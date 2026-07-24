# Phase 5.4A AI Read Accuracy and Cross-domain Query Planning

## Baseline and scope

- Base: `fb665ec3968752cfd1dc10d08415db30b91c4d30`.
- Feature branch: `codex/ai-read-accuracy-query-planning`.
- Migration: none. This phase adds read-only domain policy, planning, execution, response, tests, and UI projection only.
- Existing AI Chat routes, response contract v2, evidence graph, tool registry, provider adapters, provider safety, session grounding, draft preparation, and proven simple fast paths remain in place.
- This phase does not add ActionProposal, WorkItem, Universal Intake, automation, bank connectivity, or any business write command.

## Audited surfaces

The audit covers `server/routes/ai.routes.mjs`, the business intent router, compound query, supplier operational query, finance collaboration query, chat status, read context, tool registry, session grounding, evidence graph query, response contract v2, runtime business read service, provider adapters and provider safety. It also covers the AI panel/renderers and the Supplier, PayableObligation, SupplierInvoice, SettlementDocument, CashbookEntry, PurchaseOrder, ReceivingDocument, RFQ, and bank reconciliation read sources.

## Current strengths

- The existing chat panel and response contract already support structured cards, evidence, limitations, actions, and deep links.
- Explicit fast paths provide stable answers for known PO, PR, RFQ, SKU, GRN, supplier, planning, inventory, and finance questions.
- Evidence Graph and session grounding preserve business-object context and return navigation.
- Draft preparation is review-only and remains outside this read-planning path.
- Provider adapters have timeout, output normalization, evidence grounding, and forbidden-action safety checks.
- The tool registry records read/write metadata and exposes no direct database access to the model.

## Confirmed limitations

- Existing AI read models frequently use raw array length as a business count before validating entity identity and required fields.
- Empty objects, placeholder rows, and incomplete records can be presented as confirmed business facts.
- Procurement read projections can synthesize fallback PO or GRN identifiers when source identifiers are missing.
- Complex supplier questions can be intercepted by supplier, finance, session, or status fast paths before cross-domain scope is resolved.
- Compound intent detection has a limited catalog and does not represent scope, time, comparison, ambiguity, or previous-result semantics as a strict plan.
- Supplier operational answers do not consistently use PostgreSQL PayableObligation, SettlementDocument, SupplierInvoice, and safe bank reconciliation projections.
- Generic words such as supplier, vendor, payment, follow-up, and risk can be mistaken for entity names.
- Provider-assisted planning does not yet produce or validate a constrained BusinessQueryPlan.
- Existing tests emphasize fixed prompts rather than scope, goal, time-window, permission, validity, and fact assertions.

## Record validity policy

Add `ai-business-record-validity.mjs` with explicit `valid`, `incomplete`, `invalid`, `hidden`, and `unavailable` states. Supplier, payable, invoice, purchase order, receiving, settlement, and bank reconciliation records receive minimum-field validators. Business counts use valid records only and always include a `recordValiditySummary`.

Confirmed metrics use one of `confirmed`, `confirmed_zero`, `incomplete`, `hidden`, or `unavailable`. Hidden and unavailable sources never become zero. Placeholder identifiers and generated fallback business identifiers are invalid evidence.

## Query planning boundary

Add a strict `business-query-plan-v1` schema and validator. Plans contain scope, allowlisted goals, filters, grouping, comparison, ranking, requested evidence, ambiguity, clarification, and confidence. Plans cannot contain SQL, Prisma model names, tool names, writes, amounts, counts, or business conclusions.

The semantic planner receives only the question, module, safe current object reference, safe previous-result reference, workspace time/timezone, and goal catalog. Provider planning is disabled by default behind `FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER=true`. Invalid, unavailable, or timed-out provider output falls back to deterministic planning and never executes unvalidated output.

## Routing precedence

Preserve technical diagnostics and unambiguous ID/current-object fast paths. Detect cross-domain, global, set, comparison, time-bound, and previous-result questions before supplier resolution and broad legacy fast paths. Validated plans execute through the deterministic registry. Unsupported or ambiguous plans return clarification. General provider fallback remains last.

## Scope resolution

Support `single`, `set`, `all`, `current_context`, and `previous_result`. Resolve explicit supplier IDs/names only against valid authorized suppliers. Generic words are never names. Missing entities return not-found clarification; multiple matches return ambiguity without execution.

## Goal registry and executor

Add a closed goal registry and read-only executor. Each goal maps server-side to one registered read operation, executes at most once, enforces a total goal limit, and returns an explicit DTO with state, validity, evidence, limitations, and field visibility. Independent goal failures remain isolated and result ordering is stable.

## Supplier action summary

Add a cross-domain read service that joins authorized valid supplier, payable, invoice, settlement, purchase order, receiving, RFQ, and safe bank reconciliation summaries. Database mode does not backfill formal finance or transaction facts from JSON fixtures. Missing sources are unavailable rather than zero.

Payment readiness and block reasons are deterministic. Priority uses version `supplier-action-priority-v1`, is stable and explainable, and may use authorized backend amounts without exposing them when amount visibility is absent.

## Time and result semantics

Add workspace-timezone resolution for today, current week, next 7 days, next 30 days, month end, overdue, and all. The authorized result pack is fully tenant-, permission-, amount-, partner-, and sensitivity-filtered before optional answer synthesis.

## UI integration

Extend existing AI response rendering with scope, plan summary, result state, multi-section, clarification, and evidence-link cards. Do not show raw plan JSON, tool names, permission codes, SQL, Prisma names, or model reasoning.

## Authoritative sources

- Supplier: tenant-scoped Supplier master repository/model.
- Payables and invoices: PostgreSQL PayableObligation and SupplierInvoice read projections.
- Settlement and cashbook: formal settlement/cashbook read services.
- Purchase orders and receiving: formal procurement and receiving read models.
- RFQ: formal RFQ read model where available; otherwise unavailable in database mode.
- Bank reconciliation: Phase 5.3.1 explicit safe DTO only.

## Tests and release gates

Add focused domain tests for validity, plan validation, deterministic planning, executor behavior, and supplier summaries; semantic plan evals that assert structure rather than exact prose; real PostgreSQL cross-domain tests; API non-mutation tests; and browser acceptance for scope, states, permissions, clarification, evidence, and responsive layout. Existing AI and Phase 5.3.1 gates remain unchanged.

## CI 40001 investigation

Repeatedly run `test:db:phase-5-2c1-controls` and isolate `advance-dispute-eligibility`. Determine whether the serialization failure is a missing bounded command retry, concurrent test contamination, database isolation problem, or normal PostgreSQL serialization conflict. Do not skip the test, swallow `40001`, or add workflow-wide reruns.

## Non-goals

- No new migration or persistent model.
- No direct LLM database access or model-computed facts.
- No sentence-by-sentence intent regex catalog.
- No business writes, approvals, posting, payments, reconciliation commands, intake, automation, or long-term conversation memory.

## Verification checkpoint

- Semantic eval: 120/120 cases passed (100%).
- AI domain and route regression slice: 166/166 tests passed.
- API business-query gate: 4/4 passed.
- PostgreSQL cross-domain read gate: 2/2 passed with no skipped tests.
- Browser business-query gate: 5/5 passed at desktop, 768px, and mobile widths.
- Typecheck and production build passed.
- The first Phase 5.2C.1 repetition reproduced PostgreSQL SQLSTATE 40001 in the O2C Serializable transaction. The command service now retries that transient adapter conflict at most twice with bounded backoff and preserves the existing concurrency error after exhaustion. Two subsequent repetitions passed 5/5 with no skips.
