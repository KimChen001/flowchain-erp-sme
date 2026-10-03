# Conversational supplier query integration

The integration branch ports the three previously local AI commits onto the current main architecture and English interface changes. It retains canonical navigation and handler dispatch.

## First functional slice

Ask which suppliers need payment, inspect the returned supplier sections and evidence, then ask what else needs follow-up for those suppliers. Only suppliers present in the returned sections become follow-up references. PostgreSQL and server-resolved tenant/actor authorization remain authoritative.

The read model applies currency and supported payable-state filters before computing counts. Ranking uses a stable score/order and the requested limit. Unsupported status/grouping filters return clarification before reading, rather than silently broadening the query. Mixed currencies have no combined amount. Receiving queries require access to every referenced warehouse. Unattributed bank exceptions are not assigned to every supplier.

New result copy follows the interface language (English by default, Chinese available), and number formatting follows the existing locale independently. The surrounding older assistant UI still has untranslated strings.

## Validation and remaining release work

Validation covers deterministic planning, endpoint contracts and follow-up scope, real PostgreSQL tenant/warehouse isolation, the bounded provider request, and browser layouts at desktop, tablet, and phone widths. Provider transport tests use controlled servers. No customer data evaluation has been run.

### Model planner evaluation

`node scripts/run-ai-business-query-evals.mjs --provider` scores the configured model planner on the same 120 planning cases. It loads the ignored local provider file and makes one real request per case. It does not print credentials, requests, or raw replies. A plan counts as a clarification when it asks for filters the executor cannot apply, because users then get a clarification answer.

Results on 2026-10-02, with `claude-haiku-4-5` through MIT Parley's chat completions endpoint, using the plain chat-completions body (`FLOWCHAIN_AI_PROVIDER_KIND=deepseek_chat`):

| Planner | Cases passed |
| --- | --- |
| Deterministic | 120/120 |
| Model, before fixes | 0/120 |
| Model, after request fixes | 102/120 |
| Model with deterministic guards (what users get) | 117/120 |

- **Before the fixes**, the bounded request carried no goal names, so the model invented them. Every plan failed validation and fell back to the deterministic plan.
- **The fixes:**
  - The model-facing schema now lists the goal names with short descriptions.
  - It offers only filters the executor applies.
  - Previous-result references keep their IDs.
  - The instruction gives defaults for unstated scope and time.
- **After the request fixes**, there were no fallbacks. Data-quality questions still asked for clarification, and multi-area payment questions dropped goals.
- **Two guards** now keep the deterministic plan in charge where the rules are confident:
  - A model clarification never replaces a deterministic plan that needs none (`provider_clarification_overridden`).
  - A model plan keeps every goal of such a deterministic plan and may only add goals. If the merged plan exceeds the goal limit, the deterministic plan is used.
- **With the guards**, the model plan was served on 114 cases, with a median planning latency of about 2.2 s.
- **The three remaining misses** are vague prompts ("帮我看看供应商。", "供应商情况。", "看看供方。"). The rules ask for clarification on these, but the model answers.

The planner runs only on questions the deterministic gate already routes here. The cases were written for the deterministic planner, so they measure agreement with its conventions, not coverage of new phrasing. `FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER` stays off by default. The owner turned it on for local development on 2026-10-02. The `business_query_planning` policy in `server/domain/ai-model-router.mjs` records this as the only opt-in model decision.

Before production rollout, review cross-domain derived facts under combinations of permissions/capability flags, complete currency-grouped exact decimal totals, expand bilingual assistant coverage, and validate a real customer workflow. Query planning is a bounded read workflow, not an autonomous agent loop. Persistent conversation/run history, observability from actual runs, and RFQ reviewed action execution are later slices. PR 26 remains independent and is not implicitly merged by this integration.
