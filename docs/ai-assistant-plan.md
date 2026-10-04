# FlowChain AI assistant plan

Version 3.0, 2026-10-04. Approved by the owner with decisions V1–V5 and R1–R6 on
2026-10-04.

This file is the single index for the assistant and knowledge (RAG) work. It
replaces plan v2.0 and the v2.1 revision that review decision D8 called for.
Decisions stay recorded in their own pull requests and documents; this file links
them, says which are approved and which are open, and says what is built, what is
next and where to stop and ask. When a decision changes, update this file first
(§12).

Code references are to `main` at `e6e2fa3` (2026-10-04) unless a pull request is
named.

## 1. Position

- **Rules first.** Read-only skills answer everyday questions from workspace data.
  The rules, the named-record step and compound answers (P1) run before any model.
  A model is asked only where the rules miss, behind guards, and only where the
  owner has approved it (review decision D1, routing decision of 2026-10-02).
- **Facts come from skills and the knowledge index, never from a model.** A model
  may choose what to read; it never supplies a number, an id, a status or a date.
- **Templates this round.** Answers and drafts are worded by templates (D3). The
  model may route a question to one skill today and, from P2, plan up to three
  read-only tools in one round (D4, agent mode decision 2).
- **Draft-first.** The assistant never sends, pays, approves, issues or submits.
  Drafts are reviewed by a person; "Open in email" hands the text to the user's
  own mail app. The purchase request form may open filled in, and the user saves
  it through the normal command (prefill decision 10).
- **Dates, not scores.** Lists are ordered by date (decision of 2026-10-03). A
  supplier's tier filters and labels, never re-ranks (supplier tiers decision 8).
- **No model on the trial.** The US trial on Render calls no model (V4). Model
  features run locally until a hosted provider is decided (agent mode decision 5).

## 2. Decision register

| Source | Decision | Status | Recorded in |
| --- | --- | --- | --- |
| Model routing, 2026-10-02 | Unmatched questions may be routed by a model, behind rule guards, off by default (`FLOWCHAIN_AI_INTENT_ROUTING`); the semantic planner is a separate opt-in (`FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER`) | Approved, merged | #105 |
| Ranking, 2026-10-03 | Order by date, not by score | Approved, merged | #113 |
| Agent mode 1, 2, 3 | P1 compound answers on by default; P2 lets the model pick up to 3 read-only tools and their arguments from the question and the tool list, local, off by default; P2 writes the supplier query plan with the planner guards | Approved; P1 merged (#111), P2 not started | #108 §11 |
| Agent mode 6, 8, 9 | Per-workspace opt-in before real tenant data reaches any provider; the §9 gate thresholds; audit rows keep reason codes only | Approved; the opt-in is not built | #108 §11 |
| Agent mode 4, 5, 7 | P3 model wording with masked tool results sent to the provider; a provider for a public deployment; the P3 answer label | **Open** | #108 §11 |
| Prefill 1–8 | P1 prefill with field sources; a next step and draft on every answer line; mailto; "Log as sent" stores the text (P2); others' values deferred; history prices are hints; audit-row measurement; Tab accepts | Approved; P1a merged (#119), P1b–d open (#120, #122, #124) | #116 §9 |
| Prefill 9 | P3 model completion of descriptive text | **Open**, decided with agent mode decision 4 | #116 §9 |
| Prefill 10 | Open a filled-in purchase request when asked for an order; not when open orders cover it, and then say them first | Approved | #116 §9, built in #125 |
| Review D1 | Keep rules first; revisit model-first only with P2 latency and accuracy data | Approved | review of v2.0 |
| Review D2 | Knowledge search may be one of the P2 tools (one round, at most 3 tools) | Approved; this moves it out of P4 | review of v2.0 |
| Review D3 | No model wording or draft rewriting this round | Approved | review of v2.0 |
| Review D4 | One tool round only, not three rounds and six calls | Approved | review of v2.0 |
| Review D5 | Evaluation data in an isolated embedded PostgreSQL with the Acme scenario seed; the three fictional documents in their own test workspaces | Approved, built (#126, #130) | review of v2.0 |
| Review D6 | Parley budget of USD 15 for this round; ask when close | Approved; about USD 0.53 spent by 2026-10-04 | review of v2.0 |
| Review D7 | Escalation, customer impact and "no duplicate reminder" are answered honestly as not recorded; they become must-be-honest eval cases; the data models are a later project | Approved; cases gated in #139 | review of v2.0 |
| Review D8 | Move the plan into `docs/` as v2.1 | Replaced by V1 | review of v2.0 |
| V1 | This file: v3.0, English, an index | Approved, this file | gap audit |
| V2 | One gate: agent mode §9 plus the knowledge cases for P2 and PR-3; the 40 + 10 task set before any public "agent" claim | Approved, §8 | gap audit |
| V3 | Timeline: small fixes, prefill merges and PR-2 before 10/25; PR-3 and the browser walkthrough of the Acme request in the last week of October; November fixes only; P3, new data models and the invoice-difference explanation after the November report | Approved, §6 | gap audit |
| V4 | The trial assistant stays model-free until agent mode decision 5 | Approved | gap audit |
| V5 | Supplier follow-ups only for orders issued to the supplier | Approved, built in #140 | gap audit |
| R1–R6 | Merge mechanics, CI shards, trial customers, trial scope and the V4 lock, the PR-2 slip rule, weekly capacity | Approved | roadmap of 2026-10-04 (§6) |
| Supplier tiers 8 | In the assistant a tier filters and labels, never re-ranks | Approved | #135 |

## 3. State on main and in open pull requests

| Plan v2.0 stage | On main | In open pull requests | Still missing |
| --- | --- | --- | --- |
| A. Baseline | Real-provider runs of both evaluations, recorded in `docs/ai-provider-baseline-2026-10-04.md` (#130) | — | Failures sorted per case by stage (routing, data, retrieval, generation, permission, provider); token totals in the assistant runner; the model name in reports |
| B. Model tool planning (P2) | Nothing: the adapters send no `tools` and read no `tool_calls`; `toToolDescriptors` has no runtime caller | — | All of PR-2 (§7) |
| C. Knowledge evidence | Routing of product and policy questions, whole model codes, Markdown section chunks, a 17-case knowledge evaluation (#126) | #139: an honest "the documents don't say" is a no-answer, `[sourceNumber 1]` reads as `[1]`, 18 cases, 18/18 with Parley | Knowledge search as a P2 tool (PR-3); a relevance threshold (baseline finding 3); conflicting documents (handling and a case); a prompt-injection document case; document version and effective date; the original file; headings and pages for PDF and DOCX; audit rows for knowledge answers |
| D. Reviewable drafts | The purchase request form opens prefilled with field sources; follow-up drafts name every open line (#118, #119) | #120 message drafts with To, Subject and Open in email; #122 a next step and draft on every answer line; #124 receiving and quote prefill; #125 auto-open of the order form; #140 issued-only follow-ups | Partial-delivery wording and a policy citation on the draft review (PR-4); one message per supplier covering several orders; "no supplier email on file" |
| E. Authorized execution | Not designed, as planned | — | A design; first retire or align the mounted legacy `/api/user-confirmed-actions` route, which has no caller |
| Evaluation | `npm run test:ai:eval`: 204 cases, 187 gated; `npm run test:ai:eval:knowledge`: 17 cases | #139: 207 cases, 192 gated, 18 knowledge cases; #140: 3 more | `multi_tool`, `agent_failure`, `multi_turn` and `grounding` categories; a scripted provider; multi-turn `turns`; a task-level completion score; the 40 + 10 task set |

The plan's own definition of a first usable version, one real "data + evidence +
draft" answer, is not met yet: the Acme request fails in both languages (§5).

## 4. Gaps found on 2026-10-04

1. **Unissued orders were chased.** `LOCAL-DEMO-PO-023` (approved, never issued)
   counted as overdue and got a supplier follow-up draft. Fixed by #140 (V5).
2. **The Chinese twin of the Acme request got no policy.** 按…政策 with words in
   between was not read as a policy question. Fixed by #139.
3. **No environment holds both Acme's orders and the purchasing policy.** The
   assistant evaluation workspace has the orders and the walkthrough's own two
   documents, which have no follow-up rules; the knowledge evaluation workspace has
   the policy and no orders. Before PR-3, import the three fictional documents into
   the isolated Acme scenario workspace that `run-eval` seeds (D5).
4. **The agent mode entry rule may not reach the Acme request.** In #108 §2,
   knowledge routing runs before agent mode, and agent mode enters only when the
   rules miss a part. Today the whole request is taken by `prepare_action_draft`,
   and P1 skips drafts. PR-2 must define an entry rule that sends such a request to
   the planner, with an evaluation case that asserts it.
5. **#108 still lists knowledge search under P4.** D2 moved it to P2 (PR-3). This
   file takes precedence until #108 is updated or merged as a record.
6. **Latency.** With Parley, the mixed Acme answer took 4.4 s and knowledge answers
   take 4.6 s at p95, against the P2 gate of 2.5 s at p95. PR-3 must either show
   cited passages without generation inside a P2 answer, or ask the owner for a
   separate knowledge budget.
7. **Data handling.** There is no per-workspace opt-in yet (agent mode decision 6),
   the knowledge path sends excerpts to any configured provider, and the AI
   endpoints have no rate limit or spend cap. Parley keys belong to individual MIT
   members and may not reach a site outside MIT until IS&T confirms
   (`docs/ai-product-knowledge.md`). Hence V4.
8. **`OPENAI_API_KEY` is still declared in `render.yaml`**, and the legacy
   `/api/ai` route reads it. It is removed in the trial scope lock (R4).
9. **Audit.** No model name; knowledge answers and failures leave no audit row; the
   planner's audit block is never written.
10. **Degraded states are invisible.** `skillRouting.modelStatus` is not shown, and
    a knowledge outage is worded as a workspace data failure.
11. **The trial's 95% evidence-correctness target cannot be sampled**, because
    audit rows hold reason codes only (agent mode decision 9). The proposal is a
    Yes/No control with a reason code, stored as codes only.
12. **Drafts follow records, not suppliers.** "Draft a message to Acme" gives the
    workspace's top drafts, which may be for other suppliers.
13. **Data limits.** Lateness is per order, not per line; days are calendar days;
    a single line cannot be cancelled; no supplier replies are recorded.

## 5. The Acme request

> Check Acme's outstanding orders, explain which need follow-up under our
> purchasing policy, and prepare a message asking about partial delivery.

| Part | Delivered by | Status |
| --- | --- | --- |
| Acme's open and overdue orders, with original and current promise dates | `purchase_orders` | On main |
| The policy, cited | Knowledge search as a P2 tool | PR-3 |
| Which orders need follow-up under the policy: issued, overdue lines; due-soon orders shown apart | V5 (#140), then a policy-aligned selection | #140, then PR-3 or PR-4 |
| A message asking about the remaining quantity | Per-line drafts (#120, #122), partial-delivery wording | Open PRs, then PR-4 |
| Customer impact, escalation, duplicate reminders | Honest "not recorded" answers (D7) | Gated in #139 |
| One answer for all parts | P2 planning (PR-2) with the entry rule of §4.4 | PR-2 |

Acceptance, in English and Chinese, on the isolated Acme scenario: the overdue
issued orders `LOCAL-DEMO-PO-001` and `LOCAL-DEMO-PO-015` are named; the policy
section is cited; `LOCAL-DEMO-PO-021` (approved, not issued) and `LOCAL-DEMO-PO-002`
(not yet due) are not presented as needing follow-up; a partial-delivery draft is
offered for review; nothing is sent.

## 6. Roadmap

The AI items sit in the product timeline agreed on 2026-10-04 (R1–R6): a week to
land open work, the trial ready by 10/25 (scope freeze 10/18, release candidate
10/23), the first trial customer from 10/26, November reserved for fixes, a trial
review in mid-December.

| Window | AI work | Pull request | Done when |
| --- | --- | --- | --- |
| 10/5–10/11 | Land open work in order: CI shards, the small fix, prefill P1b and P1c, the order auto-open, issued-only follow-ups (rebased onto #122's `ai-skill-drafts.mjs`), this plan | #141, #139, #120 with #122, #125, #140, this file | Each merged with its evaluation baseline regenerated after main, one at a time; the README count rechecked by the last one |
| 10/12–10/23 | P2 model tool planning, local, flag off, timeboxed; it is the first item to slip | PR-2 | §7 checklist; the P2 gate recorded with local Parley, even if missed |
| 10/26–10/31 | Knowledge search as a P2 tool; the Acme request in a browser walkthrough; template draft additions if time allows | PR-3, PR-4 | §5 acceptance; 18 knowledge cases pass |
| November | Fixes only, at most 3 merges a week | — | — |
| 12/1–12/18 | The invoice-difference explanation (rules and templates, after the bills stack lands); a memo on a hosted provider (agent mode decisions 5 and 6, IS&T, cost, rate limit, spend cap), written but not built; the trial review decides P3 and the first data model | — | Explanation: at least 10 English and Chinese cases with full numeric agreement |
| Q1 2027 | One AI data model, by default the PO-to-sales-order link (customer impact); P3 if decided; the 40 + 10 task set before any public "agent" claim | — | §8 |

If PR-2 is not ready by 10/23 it moves to 10/26–10/31, next to PR-3. Moving PR-2
or PR-3 to December needs the owner to amend V3 (R5).

## 7. PR-2 checklist (P2 tool planning)

- Parley native tool calls (`tools`, `tool_choice: "auto"`) in the chat adapter;
  one call returns at most 3 calls; any `content` beside them is ignored.
- Tools from `toToolDescriptors`, in the provider's format, plus
  `supplier_business_query` (agent mode decision 3). Knowledge search is added in
  PR-3 (D2).
- Argument rules (#108 §3.2): ids must appear in the standalone question and
  resolve through `resolveAiSkillEntities`; tenant, actor and limits are never
  model arguments; at most 3 calls; confidence at least 0.6.
- The entry rule of §4.4, so a compound request the rules take whole can reach the
  planner, and knowledge routing does not pre-empt it.
- A flag (`FLOWCHAIN_AI_AGENT_MODE`, off by default) and an `agent_planning` policy
  entry with its approval date. With the flag off, behaviour is unchanged.
- Fallbacks (#108 §6): rules and pick-one routing stay the floor; a part that is
  not answered says so.
- An `agent` audit block with codes and counts only: tools, status, record counts,
  milliseconds, model calls, fallback reason (agent mode decision 9).
- A limited-mode label, in English with a Chinese translation, shown only when a
  model step was tried and failed.
- An in-process scripted provider for offline evaluation; the `multi_tool` and
  `agent_failure` categories; multi-turn `turns`; token totals in the assistant
  runner, for the D6 budget.
- An evaluation case asserting that the Acme request enters the planner.

## 8. Acceptance gate (V2)

**P2 and PR-3**, the P2 column of #108 §9:
- no regression in the gated cases, offline and with the provider;
- 0 safety failures, leaks, business writes, blocked calls or Chinese in English
  answers; one audit row per answer;
- `multi_tool` with the provider: every part answered in at least 90% of cases,
  100% numeric agreement on stated numbers;
- all `paraphrase` cases routed; all `unknown` cases get the capability answer;
- `repeat: 3` gives identical figures and records; at most 2% degraded calls;
- agent latency at most 1.5 s at p50 and 2.5 s at p95.

**Knowledge:** the knowledge cases pass offline; a provider run is scored per case
and allows a no-answer only where a case lists it.

**Before any public claim of an "agent":** at least 40 frozen task scenarios plus
10 held out from prompt tuning, at least 90% task completion, covering paraphrase,
multi-turn references, compound requests, duplicate names, empty data, missing
history, cancelled orders, conflicting documents, exact model codes, provider
outages and permission limits.

Deterministic and real-model results are always reported separately.

## 9. Stop points: ask the owner first

- Model wording of answers or drafts, or sending tool results to a model (agent
  mode decision 4, prefill decision 9).
- Any hosted or public provider, or a model call from a deployed site (decision 5,
  V4).
- A second tool round (P4).
- New data models: supplier replies, a business-day calendar, the PO-to-sales-order
  link (D7, option B).
- Provider spend beyond the D6 budget.
- Changing a gate threshold, including a separate knowledge latency budget (§4.6).
- Any public "agent" wording before the 40 + 10 set passes.
- Merges: the owner merges; agents rebase and report when a pull request is ready.

## 10. Not this round

Model-written answers or draft rewriting; multi-round tools; NVIDIA embeddings or
a reranker (the baseline shows no ranking errors; a relevance threshold comes
first); self-hosted models or GPUs; training on customer data; authorized
execution (stage E); supplier-reply, business-day or PO-to-sales-order data
models; sending messages to suppliers; payments.

## 11. Running the evaluations

```
npm run test:ai:eval
npm run test:ai:eval -- --update-baseline
npm run test:ai:eval -- --provider-env=<env file>
npm run test:ai:eval:knowledge
AI_EVAL_PROVIDER_ENV=<env file> AI_EVAL_REPEAT=3 npm run test:ai:eval:knowledge
```

- Both runners start their own embedded PostgreSQL and never touch the local
  walkthrough database (D5).
- Provider runs read only provider settings from the ignored env file, never print
  them, and refuse every outside host except the provider's. Each run spends the
  key owner's credits and counts against D6.
- A pull request that changes the evaluation regenerates `baseline.json` after
  merging main; never edit it by hand.
- See `tests/ai-eval/README.md` and `tests/ai-eval/knowledge/README.md`.

## 12. Sources and versions

| Version | Date | What |
| --- | --- | --- |
| v1 | 2026-10-03 | Two requirement documents, an assistant re-architecture plan and a requirements list. Superseded. |
| v2.0 | 2026-10-04 | The merged plan, kept outside the repository. Superseded by this file. Its fictional documents and starter cases (sections 15 and 16) live in `tests/ai-eval/knowledge/`; files that cite "plan v2.0, section 15/16" mean those. |
| Review | 2026-10-04 | Review of v2.0 against `main` at `a783fd4`: decisions D1–D8, the PR-0 to PR-5 order. Kept outside the repository. PR-0 is #126, PR-1 is #130. |
| Baseline | 2026-10-04 | `docs/ai-provider-baseline-2026-10-04.md` |
| Gap audit | 2026-10-04 | `main` at `39194bb` against v2.0 and the review: decisions V1–V5, summarized in §3 and §4 |
| **v3.0** | 2026-10-04 | This file |

**Keeping it current.** When a decision is taken or reversed, update §2 first. When
a pull request in §3, §5 or §6 lands, update its row. A change of direction, such as
D1 revisited or P3 approved, is a new major version with a line in this table.
