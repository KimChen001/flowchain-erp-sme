# FlowChain AI assistant plan

Version 4.0, 2026-10-05.
- **v3.0.** Approved by the owner on 2026-10-04, with decisions V1–V5 and R1–R6.
- **v4.0.** Adds the owner's AI direction of 2026-10-05 (decisions 1–7, §2). That
  direction:
  - revises V4: AI comes on for the trial workspaces the owner opts in;
  - starts stage E: the assistant may create a draft, once a person confirms it.

  Under §12 that makes it a new major version.

This file is the single index for the assistant and knowledge (RAG) work. It
replaces plan v2.0 and the v2.1 revision that review decision D8 called for.
Decisions stay recorded in their own pull requests and documents; this file links
them, says which are approved and which are open, and says what is built, what is
next and where to stop and ask. When a decision changes, update this file first
(§12).

Code references are to `main` at `51b21d7` (2026-10-05, #140 merged) unless a pull
request is named. The state in §3–§8 was brought up to date on 2026-10-06, after
#142, #148, #150, #152, #155 and #144 merged, and with #156 (gap 3).

## 1. Position

- **The balance (direction of 2026-10-05).** The model understands and proposes; the
  system supplies the facts and executes; a person confirms.
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
  - Drafts are reviewed by a person.
  - "Open in email" hands the text to the user's own mail app.
  - The purchase request form may open filled in, and the user saves it through the
    normal command (prefill decision 10).
- **Confirmed drafts, from C1 (stage E, design #151, decisions A1–A8 open).**
  - The assistant may create two things, each only when the user clicks Confirm on
    its preview in the chat, through the same command and permission as the form
    (direction decisions 3 and 5):
    - a draft purchase request;
    - a draft RFQ from an approved request.
  - Nothing more. Until C1 merges, the assistant creates nothing.
- **Dates, not scores.** Lists are ordered by date (decision of 2026-10-03). A
  supplier's tier filters and labels, never re-ranks (supplier tiers decision 8).
- **A model only for opted-in trial workspaces (direction decisions 1 and 2, revising
  V4).**
  - The US trial on Render calls a model only for the workspaces the owner opts in,
    under a monthly spend cap. The model is the Anthropic API, claude-haiku-4-5.
  - Every other workspace stays rules-only.
  - Built in #150. It goes live once the owner provides the key and the budget;
    until then the trial calls no model.
  - Parley stays local only.

## 2. Decision register

| Source | Decision | Status | Recorded in |
| --- | --- | --- | --- |
| Model routing, 2026-10-02 | Unmatched questions may be routed by a model, behind rule guards, off by default (`FLOWCHAIN_AI_INTENT_ROUTING`); the semantic planner is a separate opt-in (`FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER`) | Approved, merged | #105 |
| Ranking, 2026-10-03 | Order by date, not by score | Approved, merged | #113 |
| Agent mode 1, 2, 3 | P1 compound answers on by default; P2 lets the model pick up to 3 read-only tools and their arguments from the question and the tool list, local, off by default; P2 writes the supplier query plan with the planner guards | Approved; P1 merged (#111); P2 built in draft #144, gate passed with Parley on 2026-10-05 | #108 §11 |
| Agent mode 6, 8, 9 | Per-workspace opt-in before real tenant data reaches any provider; the §9 gate thresholds; audit rows keep reason codes only | Approved; the opt-in is built in #150 | #108 §11 |
| Agent mode 5 | A provider for a public deployment | Answered for opted-in trial workspaces by direction decision 2; any wider use stays open | #108 §11 |
| Agent mode 4, 7 | P3 model wording with masked tool results sent to the provider; the P3 answer label | **Open**; waits until the owner has used the model in the walkthrough and on the trial (direction decision 7) | #108 §11 |
| Prefill 1–8 | P1 prefill with field sources; a next step and draft on every answer line; mailto; "Log as sent" stores the text (P2); others' values deferred; history prices are hints; audit-row measurement; Tab accepts | Approved; P1 merged (#119, #120, #122, #124) | #116 §9 |
| Prefill 9 | P3 model completion of descriptive text | **Open**, decided with agent mode decision 4 | #116 §9 |
| Prefill 10 | Open a filled-in purchase request when asked for an order; not when open orders cover it, and then say them first | Approved, merged (#125) | #116 §9 |
| Review D1 | Keep rules first; revisit model-first only with P2 latency and accuracy data | Approved | review of v2.0 |
| Review D2 | Knowledge search may be one of the P2 tools (one round, at most 3 tools) | Approved; this moves it out of P4 | review of v2.0 |
| Review D3 | No model wording or draft rewriting this round | Approved | review of v2.0 |
| Review D4 | One tool round only, not three rounds and six calls | Approved | review of v2.0 |
| Review D5 | Evaluation data in an isolated embedded PostgreSQL with the Acme scenario seed; the three fictional documents in their own test workspaces | Approved, built (#126, #130) | review of v2.0 |
| Review D6 | Parley budget of USD 15 for this round; ask when close | Approved; about USD 0.53 spent by 2026-10-04 | review of v2.0 |
| Review D7 | Escalation, customer impact and "no duplicate reminder" are answered honestly as not recorded; they become must-be-honest eval cases; the data models are a later project | Approved; cases gated in #139 | review of v2.0 |
| Review D8 | Move the plan into `docs/` as v2.1 | Replaced by V1 | review of v2.0 |
| V1 | This file: an English index (v3.0, now v4.0) | Approved, this file | gap audit |
| V2 | One gate: agent mode §9 plus the knowledge cases for P2 and PR-3; the 40 + 10 task set before any public "agent" claim | Approved, §8 | gap audit |
| V3 | Timeline: small fixes, prefill merges and PR-2 before 10/25; PR-3 and the browser walkthrough of the Acme request in the last week of October; November fixes only; P3, new data models and the invoice-difference explanation after the November report | Approved, §6 | gap audit |
| V4 | The trial assistant stays model-free until agent mode decision 5 | Approved 2026-10-04; **revised** 2026-10-05 by direction decision 1 | gap audit |
| V5 | Supplier follow-ups only for orders issued to the supplier | Approved, merged (#140); the order answer follows in #152 | gap audit |
| R1–R6 | Merge mechanics, CI shards, trial customers, trial scope and the V4 lock, the PR-2 slip rule, weekly capacity | Approved; CI shards merged (#141) | roadmap of 2026-10-04 (§6) |
| Follow-ups, 2026-10-06 | A follow-up draft only for an order issued to its supplier and overdue; an order due soon gets "no follow-up yet" and no draft. Revises prefill P1 ("overdue, due or partially received") | Approved; built in #163 | PR-4 |
| Supplier tiers 8 | In the assistant a tier filters and labels, never re-ranks | Approved; T1–T3 merged (#137, #138, #145, #146), drafts in #148 | #135 |
| Direction 1 | V4 becomes: AI on for the trial workspaces the owner opts in; the rest stay rules-only | Approved 2026-10-05; built in #150 | AI direction, 2026-10-05 |
| Direction 2 | Trial provider: the Anthropic API, claude-haiku-4-5; the owner supplies the key and a monthly budget, starting at USD 20 per workspace | Approved; waits for the key and budget | AI direction |
| Direction 3 | Actions v1: create a draft purchase request, and a draft RFQ from an approved request | Approved; designed in #151 | AI direction |
| Direction 4 | Supplier email is a later step, with its own permission, the platform mail channel and a rate limit | Approved; not started | AI direction |
| Direction 5 | Confirmation is a preview card in the chat with one click; the form stays the route to edit first | Approved; designed in #151 | AI direction |
| Direction 6 | The old "AI creates no real records" promises are updated | Approved; #151 A8 proposes the timing: with the C1 build | AI direction |
| Direction 7 | P3 waits until the owner has used the model in the walkthrough and on the trial | Approved | AI direction |
| Actions A1–A8 | Where proposals live, who confirms, auto-open, the source mark, RFQ invitees, the switch, the old confirm route, the wording timing | **Open** | #151 §12 |

## 3. State on main and in open pull requests

| Stage | On main | In open pull requests | Still missing |
| --- | --- | --- | --- |
| A. Baseline | Real-provider runs of both evaluations, recorded in `docs/ai-provider-baseline-2026-10-04.md` (#130); token totals for planning calls in `--agent` runs (#144) | — | Failures sorted per case by stage (routing, data, retrieval, generation, permission, provider); the model name in reports |
| B. Model tool planning (P2) | Agent planning, off by default (`FLOWCHAIN_AI_AGENT_MODE=plan`, #144): native tool calls, the supplier business query tool, a tier argument (also on the draft tool), the Acme entry rule with cases in both languages, the `agent` audit block, the limited-mode label. The P2 gate passed with Parley (§8) | — | Naming an unanswered part; a scripted provider for offline runs; the `agent_failure` category; multi-turn `turns` |
| C. Knowledge evidence | Routing of product and policy questions, whole model codes, Markdown section chunks (#126); an honest "the documents don't say" is a no-answer, citations read `[1]`, 18 knowledge cases (#139); the Acme workspace in the assistant evaluation holds the three policy documents, and knowledge answers get an audit row (#156) | #159 (PR-3): knowledge search as a P2 tool. The planner writes search words in the documents' language and the passages are shown without generation | A relevance threshold (baseline finding 3); conflicting documents (handling and a case); a prompt-injection document case; document version and effective date; the original file; headings and pages for PDF and DOCX; retrieval across languages without a model (offline, a Chinese question still finds no English policy) |
| D. Reviewable drafts | The purchase request form opens prefilled with field sources; message drafts with To, Subject and Open in email; a next step and draft on every answer line; receiving and quote prefill; the order form opens by itself; follow-ups only for issued orders, in the order answer too; a tier the question names narrows the drafts (#118, #119, #120, #122, #124, #125, #140, #148, #152) | #163 (PR-4): follow-ups only for overdue orders; drafts narrowed to a named supplier; one message per supplier; partly received lines and a partial-delivery question; "no email on file"; the cited policy shown with the draft | A supplier email recorded nowhere else stays missing; one message across suppliers is not planned |
| E. Authorized execution | Nothing; the legacy `/api/user-confirmed-actions` route is still mounted, with no permission check and no caller | #151: the design. The assistant proposes, a person confirms, the system runs the existing command. v1 is a draft purchase request and a draft RFQ from an approved request; decisions A1–A8 | C1 (purchase request), C2 (RFQ), C3 (model proposal tools) |
| Model on the trial (direction 1–2) | A per-workspace switch, off by default; usage per workspace and month; a cap (USD 20 by default); the `anthropic_chat` adapter (#150). No change on any deployed site until a key is set | #143: no provider settings in the Blueprint (R4) | The owner's key and budget; the Blueprint change with #143's test as an allow-list; one real call checking `tool_choice: "required"`; a rate limit |
| Supplier tiers (#135) | Tier on the supplier, the supplier list and page, tier labels and filters in answers, tier-narrowed drafts (#137, #138, #145, #146, #148) | — | — |
| Evaluation | `npm run test:ai:eval`: 245 cases, 215 gated, 30 scored only (14 `multi_tool` cases for `--agent` runs); the as-of day is the workspace day (#155); a `knowledge` expectation (#156). `npm run test:ai:eval:knowledge`: 18 cases | — | `agent_failure`, `multi_turn` and `grounding` categories; multi-turn `turns`; a task-level completion score; the 40 + 10 task set |

The plan's own definition of a first usable version, one real "data + evidence +
draft" answer, is met with agent planning on: both Acme cases pass the §5
acceptance on Parley (#163). It is not met offline, where the request needs the
model to become one answer (§5).

## 4. Gaps found on 2026-10-04, and since

Status as of 2026-10-06:
- **Fixed:** 1–4, 12 (#163), 16 and 17.
- **Handled in open pull requests or designs:** 8 (#143); 14 and 15 (C1, #151).
- **In part:** 6 (#159), 7, 9 and 10.
- **Open:** 5, 11 and 13.

1. **Unissued orders were chased.** `LOCAL-DEMO-PO-023` (approved, never issued)
   counted as overdue and got a supplier follow-up draft. Fixed by #140 (V5),
   merged; #152 applies the rule to the order answer too.
2. **The Chinese twin of the Acme request got no policy.** 按…政策 with words in
   between was not read as a policy question. Fixed by #139, merged.
3. **No environment holds both Acme's orders and the purchasing policy.** The
   assistant evaluation workspace has the orders and the walkthrough's own two
   documents, which have no follow-up rules; the knowledge evaluation workspace has
   the policy and no orders. Before PR-3, import the three fictional documents into
   the isolated Acme scenario workspace that `run-eval` seeds (D5). Done in #156:
   an English question about Acme and the policy cites *Overdue goods* or *Follow-up
   and escalation*. The Chinese twin still finds nothing offline, because keyword
   retrieval does not cross languages; PR-3 must solve that.
4. **The agent mode entry rule may not reach the Acme request.** In #108 §2,
   knowledge routing runs before agent mode, and agent mode enters only when the
   rules miss a part. Today the whole request is taken by `prepare_action_draft`,
   and P1 skips drafts. PR-2 must define an entry rule that sends such a request to
   the planner, with an evaluation case that asserts it. Done in #144, merged: the
   entry rule, and the cases `agent-acme-follow-up-en` and `-zh`.
5. **#108 still lists knowledge search under P4.** D2 moved it to P2 (PR-3). This
   file takes precedence until #108 is updated or merged as a record.
6. **Latency.** With Parley, the mixed Acme answer took 4.4 s and knowledge answers
   take 4.6 s at p95, against the P2 gate of 2.5 s at p95. PR-3 must either show
   cited passages without generation inside a P2 answer, or ask the owner for a
   separate knowledge budget.
   - **In part (#159):** inside a P2 answer the documents are shown as passages
     without generation. On Parley, answers on the model path took p50 990 ms and
     p95 1,716 ms, search included.
   - **Still open:** a question about the documents alone still takes the knowledge
     path with a generated answer (3.4 s in that run). Its budget is the knowledge
     one.
7. **Data handling.** There is no per-workspace opt-in yet (agent mode decision 6),
   the knowledge path sends excerpts to any configured provider, and the AI
   endpoints have no rate limit or spend cap. Parley keys belong to individual MIT
   members and may not reach a site outside MIT until IS&T confirms
   (`docs/ai-product-knowledge.md`). Hence V4.
   - **Built in #150:** the per-workspace opt-in and a monthly spend cap. Where the
     opt-in applies (in production by default) and is off, or the cap is reached,
     the knowledge path gets no provider either.
   - **Still open:** a rate limit.
   - **Parley stays local.**
8. **`OPENAI_API_KEY` is still declared in `render.yaml`**, and the legacy
   `/api/ai` route reads it. It is removed in the trial scope lock (R4, #143, open).
9. **Audit.**
   - **In part:** #144 writes an `agent` audit block of codes and counts, and #150
     counts calls, tokens and cost per workspace and month.
   - **In part, 2026-10-06:** knowledge answers get the same audit row, with the
     answer mode, the citation count and the cited document ids (#156).
   - **Still open:** audit rows have no model name, and failures leave no audit row.
10. **Degraded states are invisible.** `skillRouting.modelStatus` is not shown, and
    a knowledge outage is worded as a workspace data failure.
    - **In part:** #144 shows a limited-mode label when agent planning was tried and
      failed.
    - **Still open:** the knowledge outage wording.
11. **The trial's 95% evidence-correctness target cannot be sampled**, because
    audit rows hold reason codes only (agent mode decision 9). The proposal is a
    Yes/No control with a reason code, stored as codes only.
12. **Drafts follow records, not suppliers.** "Draft a message to Acme" gives the
    workspace's top drafts, which may be for other suppliers. #148 (merged) narrows
    the drafts to a tier the question names; #163 narrows them to a supplier the
    question names, and writes one message per supplier.
13. **Data limits.** Lateness is per order, not per line; days are calendar days;
    a single line cannot be cancelled; no supplier replies are recorded.

Found on 2026-10-05:

14. **Double ordering.** A shortage counts a purchase request as cover only while it
    is `submitted`. A draft request, or an approved one not yet turned into an
    order, is ignored, so the assistant can propose a second request for the same
    item. Fixed in C1 (#151 §4.4).
15. **提交 is not refused.** "submit" is in the English refusal verbs; 提交 is
    missing from the Chinese ones. Fixed in C1.
16. **The order answer skipped V5.** When open orders covered a shortage, it built
    its follow-up card from the first supplying order, bypassing the shared draft
    candidates. Fixed in #152, merged.
17. **The evaluation and the server counted different days.** Since 21346a5 the
    server counts "today" and "overdue" in the workspace day, but `run-eval` seeded
    the walkthrough as of the UTC day. Between UTC midnight and midnight in New York
    the evaluation failed on main. Fixed in #155: the as-of day is the workspace day.

## 5. The Acme request

> Check Acme's outstanding orders, explain which need follow-up under our
> purchasing policy, and prepare a message asking about partial delivery.

| Part | Delivered by | Status |
| --- | --- | --- |
| Acme's open and overdue orders, with original and current promise dates | `purchase_orders` | On main |
| The policy, cited | Knowledge search as a P2 tool | Gap 3 done (#156). With agent planning on, both languages cite the policy section through the planner's search (#159; the Acme cases pass in English and Chinese on Parley). Offline, only English |
| Which orders need follow-up under the policy: issued, overdue lines; due-soon orders shown apart | V5 (#140), then a policy-aligned selection | Follow-ups only for issued, overdue orders (owner decision 2026-10-06, #163); a due-soon order says "no follow-up yet" |
| A message asking about the remaining quantity | Per-line drafts (#120, #122), partial-delivery wording | One message to Acme about both overdue orders, with how much arrived and a partial-delivery question (#163) |
| Customer impact, escalation, duplicate reminders | Honest "not recorded" answers (D7) | Gated on main (#139) |
| One answer for all parts | P2 planning (PR-2) with the entry rule of §4.4 | On main with the flag off (#144), with the entry cases in both languages |

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

The eval lane was planned for this week and was merged on 10/05, one at a time with
the baseline regenerated after each:
- the CI shards (#141);
- the small fix (#139);
- prefill P1b and P1c (#120, #122) and the receiving and quote prefill (#124);
- the order auto-open (#125);
- issued-only follow-ups (#140).

P2 was planned for 10/12–10/23 and is already built and through its gate. The owner
approved on 10/05 using the freed time to bring the Acme request forward.

| Window | AI work | Pull request | Done when |
| --- | --- | --- | --- |
| 10/6–10/11 | Merged by 10/06: this file (#142), supplier tier drafts (#148), AI per workspace (#150, no change on any deployed site until the owner provides a key), V5 in the order answer (#152), the eval's workspace day (#155), P2 with the flag off (#144), the Acme scenario workspace with the three policy documents (gap 3, #156). Still open: the trial scope lock | #143 | Each merged after main with its baseline regenerated, one at a time; the README count rechecked by the last one; gap 3 seeded and checked by the knowledge evaluation |
| 10/12–10/18 (scope freeze) | Knowledge search as a P2 tool, moved up from 10/26 and built on 10/06 (#159). C1, confirmed draft purchase requests, if A1–A8 are decided by 10/11. B live on the trial once the owner provides the key and budget: the Blueprint, #143's test as an allow-list, one real call, the gate run with claude-haiku-4-5 | PR-3, C1, B | PR-3: §8 knowledge and the §5 acceptance offline. C1: the tests in #151 §10. B: the §8 gate on the trial provider before any workspace is switched on |
| 10/19–10/23 (release candidate) | Fixes to what merged; the Acme request in a browser walkthrough | — | §5 acceptance in both languages |
| 10/26–10/31 | C2 (RFQ from an approved request). C3 (model proposal tools) if C1 has landed. PR-4 (partial-delivery wording, the policy with the draft) was built on 10/06 (#163) | C2, C3 | C2 and C3: #151 §10 |
| November | Fixes only, at most 3 merges a week | — | — |
| 12/1–12/18 | The invoice-difference explanation (rules and templates, after the bills stack lands). The trial review: model use and spend per workspace, confirmed drafts and how many were cancelled. It decides P3 (direction decision 7), supplier email (direction decision 4) and the first data model | — | Explanation: at least 10 English and Chinese cases with full numeric agreement |
| Q1 2027 | One AI data model, by default the PO-to-sales-order link (customer impact); P3 if decided; supplier email if decided; a native Messages API adapter for Anthropic; the 40 + 10 task set before any public "agent" claim | — | §8 |

**Slip rules:**
- **PR-3.** If it is not merged by the scope freeze on 10/18, it returns to 10/26–10/31,
  its v3.0 slot.
- **C1.** It is in the trial only if it merges by 10/18; otherwise it moves to
  10/26–10/31, next to C2.
- **B.** It goes live whenever the key and budget arrive, after its gate run.
- **December.** Moving PR-3 there needs the owner to amend V3 (R5).

## 7. PR-2 checklist (P2 tool planning)

Status in #144 as of 2026-10-05: **done** or **not yet**.

- **Done, with one change.** Parley native tool calls in the chat adapter; one call
  returns at most 3 calls; any `content` beside them is ignored.
  - The plan said `tool_choice: "auto"`. #144 sends `"required"` plus a
    `no_matching_skill` tool, and caps replies at 300 tokens. With `"auto"` the model
    wrote long refusals that ran past the timeout.
- **Done.** Tools from `toToolDescriptors`, in the provider's format, plus
  `supplier_business_query` (agent mode decision 3). Knowledge search is added in
  PR-3 (D2). #144 also adds a supplier tier argument, accepted only when the
  question names a tier.
- **Done, without the confidence threshold.** Argument rules (#108 §3.2):
  - ids must appear in the standalone question and resolve through
    `resolveAiSkillEntities`;
  - tenant, actor and limits are never model arguments;
  - at most 3 calls.

  Tool calls carry no confidence, so the "confidence at least 0.6" rule is replaced
  by dropping every argument the question does not support.
- **Done.** The entry rule of §4.4, so a compound request the rules take whole can
  reach the planner, and knowledge routing does not pre-empt it.
- **Done.** A flag (`FLOWCHAIN_AI_AGENT_MODE=plan`, off by default) and an
  `agent_planning` policy entry with its approval date. With the flag off,
  behaviour is unchanged.
- **In part.** Fallbacks (#108 §6): rules and pick-one routing stay the floor, and a
  timeout (2.5 s by default) degrades to the rules' answer.
  - **Not yet:** when the planner declines or drops one part, the answer does not
    say which part went unanswered.
- **Done.** An `agent` audit block with codes and counts only: tools, status, record
  counts, milliseconds, model calls, fallback reason (agent mode decision 9).
- **Done.** A limited-mode label, in English with a Chinese translation, shown only
  when a model step was tried and failed.
- **In part.** The `multi_tool` category (14 cases); token totals for planning calls
  in `--agent` runs.
  - The planner's failure modes (throw, hang, invalid record, declined) are unit
    tests with scripted providers, not runner cases.
  - **Not yet:** an in-process scripted provider for offline runs, the
    `agent_failure` category, and multi-turn `turns`.
- **Done.** Evaluation cases asserting that the Acme request enters the planner, in
  both languages.

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

**P2 result, with Parley (claude-haiku-4-5 through Bedrock), #144:**
- **Latest run, 2026-10-06** (as of the workspace day 2026-10-05), after merging
  `63450ab` and with the tier on the draft tool:
  - no regression in the 212 gated cases;
  - the Acme entry cases pass in both languages;
  - degraded calls: 0 of 54;
  - planning latency: p50 837 ms, p95 1,221 ms;
  - `multi_tool`: 14 of 14.
- **Earlier runs on 2026-10-05:** `multi_tool` 13 of 14, and p95 1,307 and
  1,743 ms. The miss was `mt-tier-draft-en`: for "prepare a message to them" the
  model picked `supplier_attention`, which then took no tier. One run at 14 of 14 is
  not yet a trend.

**PR-3 result, with Parley, 2026-10-06 (#159):**
- **Passes the gate.**
  - 215/215 gated, no regressions.
  - Degraded calls: 1 of 56, a timeout.
  - Planning latency: p50 927 ms, p95 1,659 ms.
  - Whole answers on the model path: p50 990 ms, p95 1,716 ms.
- **Pending cases: 30/30**, including the Chinese Acme request and
  `policy-acme-overdue-zh`.
- **One run was not counted:** it had 15 network errors from Parley.

**PR-4 result, with Parley, 2026-10-06 (#163):**
- 218/218 gated, no regressions; 0 of 56 calls degraded; planning p50 847 ms,
  p95 1,256 ms.
- **Pending: 30/30.** The Acme cases in both languages now also check the
  follow-up: one message covering PO-001 and PO-015 with the partial-delivery
  question, and none for PO-002 or PO-021. That is the §5 acceptance.

**Knowledge:** the knowledge cases pass offline; a provider run is scored per case
and allows a no-answer only where a case lists it.

**B, before any trial workspace is switched on:**
- the P2 gate is run once with the trial provider (the Anthropic API,
  claude-haiku-4-5) and the owner's key;
- the knowledge cases are scored with it;
- one call confirms that the endpoint honours `tool_choice: "required"`.

**C1 and C2:**
- the tests of #151 §10 pass;
- no answer writes anything; the only writes are the two commands, each after the
  user's click on Confirm;
- a second confirm of the same proposal creates nothing new.

**Before any public claim of an "agent":** at least 40 frozen task scenarios plus
10 held out from prompt tuning, at least 90% task completion, covering paraphrase,
multi-turn references, compound requests, duplicate names, empty data, missing
history, cancelled orders, conflicting documents, exact model codes, provider
outages and permission limits.

Deterministic and real-model results are always reported separately.

## 9. Stop points: ask the owner first

- Model wording of answers or drafts, or sending tool results to a model (agent
  mode decision 4, prefill decision 9).
- A model call from a deployed site other than for a workspace the owner opted in
  and under its cap; any provider other than the Anthropic API there; raising the
  cap (direction decisions 1 and 2).
- Provider keys: the owner supplies them and sets them as secrets. Agents never
  write a key to a file or echo it.
- Any action beyond the two confirmed drafts of #151: submit, approve, issue, send,
  pay, delete, bulk creation, or supplier email (direction decisions 3 and 4).
- Building C1 before A1–A8 are decided.
- A second tool round (P4).
- New data models: supplier replies, a business-day calendar, the PO-to-sales-order
  link (D7, option B).
- Provider spend beyond the D6 budget (Parley) or the monthly cap (Anthropic).
- Changing a gate threshold, including a separate knowledge latency budget (§4.6).
- Any public "agent" wording before the 40 + 10 set passes.
- Merges: the owner merges; agents rebase and report when a pull request is ready.

## 10. Not this round

Model-written answers or draft rewriting; multi-round tools; NVIDIA embeddings or
a reranker (the baseline shows no ranking errors; a relevance threshold comes
first); self-hosted models or GPUs; training on customer data; authorized
execution beyond the two confirmed drafts (stage E, #151); supplier-reply,
business-day or PO-to-sales-order data models; sending messages to suppliers;
payments.

## 11. Running the evaluations

```
npm run test:ai:eval
npm run test:ai:eval -- --update-baseline
npm run test:ai:eval -- --provider-env=<env file>
npm run test:ai:eval -- --agent --provider-env=<env file>   # P2 planning, with #144
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
| v3.0 | 2026-10-04 | This file as approved with V1–V5 and R1–R6. Never merged on its own. Superseded by v4.0. |
| AI direction | 2026-10-05 | The owner felt the assistant was unused: "the site has no AI, and it cannot do things for me". Decisions 1–7, approved as recommended (§2). They revise V4 and start stage E (#150, #151). The reasoning page is kept outside the repository. |
| **v4.0** | 2026-10-05 | This file: the direction added; §3–§7 brought up to `main` at `51b21d7` and the open pull requests; the roadmap moves PR-3 forward because P2 is built. |

**Keeping it current.** When a decision is taken or reversed, update §2 first. When
a pull request in §3, §5 or §6 lands, update its row. A change of direction, such as
D1 revisited or P3 approved, is a new major version with a line in this table.
