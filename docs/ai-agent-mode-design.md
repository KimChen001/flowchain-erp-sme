# Assistant agent mode (step C): design

Status: design, 2026-10-03. On 2026-10-03 the owner approved decisions 1, 2, 3, 6, 8 and
9 in [§11](#11-decisions-for-the-owner). Decisions 4, 5 and 7 are open. Every other
widening of what a model decides still needs an explicit yes first. P1 was merged to main
in PR #111 on 2026-10-03; there, a follow-up read with the previous answer is answered as
one question and never split.

Written against main at `ff98025` and PR #105 (`claude/assistant-routing` at `1c2da08`),
which adds model routing, the RFQ and receiving skills and Parley. #105 was merged on
2026-10-03 together with step A (page context only when the question refers to it) and
step B (follow-ups read with the previous answer, `server/domain/ai-skill-follow-up.mjs`).
Line numbers refer to those two commits; files marked (#105) were then only on that
branch.

## Summary

- **Recommendation.** Grow the assistant in four phases. Each phase keeps the rules path
  as the floor and is off by default:
  1. **P1, compound answers by rules (no model).** Split a question into parts. Each
     part the rules recognise is answered by its own skill, and the parts come back as
     one answer with sections. This is the smallest useful step: it fixes today's silent
     loss of the second half of a question, and it works on Render with no provider.
  2. **P2, model plans.** The model may choose up to 3 read-only tools and their
     arguments. Facts and wording still come from the skills. The model sees what it sees
     today in #105: the question and the tool list, no business data.
  3. **P3, model wording.** The model writes the sentences, but every number, record,
     status and date is a slot the server fills from tool results. A verifier checks the
     text, and any mismatch serves the P2 composite answer instead.
  4. **P4, dependent lookups.** A second tool round, a knowledge-search tool and
     progress events.
- **Production** keeps no model until the provider decision ([§8](#8-provider-options-for-a-public-deployment)).
  Parley stays local.

## 1. Goal and user experience

One assistant with no modes; step A is removing the "PO bot" switch.
It understands free phrasing, follows the conversation through step B, answers every
part of a question or says which part it could not answer, and replies in the question's
language. The language rule is already shared by every path
(`server/routes/ai-runtime-gateway.routes.mjs:79-81`).

| Question | Today | With agent mode |
| --- | --- | --- |
| "Which purchase orders are overdue, and what is available for LDM-001?" | One skill answers; the other half gets no answer | P1: two sections, each from its own skill |
| 哪些采购单逾期了？另外有几张发票有差异？ | Same | P1: two sections (Chinese connectors already split, `server/domain/ai-compound-query.mjs:184-185`) |
| "Anything late from suppliers, and are we short on stock?" | Pick-one (#105) answers one part at most | P2: plan with `purchase_orders(overdue)` + `inventory_availability(short)` |
| "Which suppliers are late and do they have unpaid invoices?" | Supplier business query, if its gate fires | P2: one `supplier_business_query` call with goals `supplier_overdue_purchase_orders` + `supplier_payables_overdue`. The executor joins per supplier; the model never joins. |
| "那 PO-020 呢？" / "为什么？" / "只看逾期的" | No previous turn: a named record still resolves, "为什么？" does not | Step B rewrites it into a standalone question first. Rules answer it when they can; otherwise agent mode does. |
| "Approve PO-013 and email the supplier" | Refused (`ai-runtime-gateway.routes.mjs:83-88`) | Unchanged: refused before any model |

## 2. Where it sits

```
request ─ action refusal (gateway:88) ─ knowledge (:89) ─ length check (:92)
        ─ step A (page context) ─ step B (standalone question)
        ─ compound? ─ yes ─ P1 rules per part ─ parts the rules miss ─ P2+ agent (flag on)
                   └ no ─ business query gate (:98) ─ rules route + named records
                          (ai-skill-runtime.mjs:28-43) ─ one skill answers   ← floor, ~20 ms
                          └ no rule, no record ─ P2+ agent (flag on) │ pick-one (#105) │ capability
```

- **Entry rule.** Agent mode runs only when its flag is on, a provider is callable
  (`canCallConfiguredProvider`, `server/domain/ai-runtime-provider-adapter-v2.mjs:137-142`),
  and the question is not a refusal, not about the outside world and not a greeting.
  It also needs one of two cases: no rule and no named record chose a skill (today's
  pick-one spot, `ai-skill-runtime.mjs:53-56` (#105)), or the question is compound and
  the rules could not route every part.
- **When it replaces pick-one.** With agent mode on, a one-tool plan is the pick-one
  answer, so #105 routing is not called as well. That would double the latency. With
  agent mode off, #105 behaves as it does now.
- **Step A** passes the page record only when the question refers to it. That record
  then counts as named in the question.
- **Step B** passes only the standalone question. Agent mode never receives the history.
  A rewrite may carry only ids from the previous answer. The existing check in
  `validateCompoundQueryRewrite` (`server/domain/ai-model-router.mjs:167`) already
  rejects new ids, numbers and dates.
- **The compound check.** In P1 it runs inside the skill runtime, so a question the
  business query gate takes is answered there, as today. From P2 it runs before that
  gate, so a part the gate would take can become a `supplier_business_query` call. A
  single-part supplier question still goes to the planner path.
- **Splitting.** P1 reuses `splitCompoundBusinessQuestion` (`ai-compound-query.mjs:202-213`),
  which today serves only the older `/api/ai` chat route (`server/routes/ai.routes.mjs:15`).
  It has no English connectors (`ai-compound-query.mjs:185`). P1 adds "and", "also" and
  "plus", but splits only when at least two parts route to different skills: "open and
  overdue POs" must stay one part.

## 3. Architecture: model as orchestrator over read-only tools

### 3.1 Pick-one routing and agent mode

| | Pick-one routing (#105) | Agent mode |
| --- | --- | --- |
| When | No rule and no named record | The same, plus compound questions the rules cannot fully route |
| Model returns | One skill id and a confidence (`ai-skill-intent-routing.mjs:34-46` (#105)) | P2: up to 3 tool calls with arguments. P3: also slotted wording |
| Facts | The skill | The skills and the business query executor |
| Wording | The skill's template | P2: skill templates, composed. P3: model sentences with server-filled slots, verified |
| Fallback | Capability answer | The ladder in [§6](#6-fallbacks-flags-and-modes) |

### 3.2 Tools

| Tool | Backed by | Arguments | Permission |
| --- | --- | --- | --- |
| The actor's data skills (9 on main, plus `rfq_followups` and `receiving_issues` in #105) | `answerAiSkill` (`server/domain/ai-skills.mjs:30-36`); descriptors from `toToolDescriptors` (`server/domain/ai-skill-registry.mjs:127-143`), already filtered per actor and `writesBusinessData: false` | The registry `inputSchema`: modes, and lists of ids and SKUs, at most 10 each (`ai-skill-registry.mjs:37-59`) | `toolsFor(actor)` (`:121-123`) |
| `supplier_business_query` | `executeBusinessQueryPlan` (`server/domain/ai-business-query-executor.mjs:108-110`): it validates the plan and asserts the goal registry is read-only | The plan schema (`server/domain/ai-business-query-plan.schema.json`). The model writes the plan, so no nested planner call is made, and #105's planner guards apply. | Each goal's permission (`server/domain/ai-business-goal-registry.mjs:1-18`) |
| `prepare_action_draft` | The existing skill | `focusInput` | Review-only cards (`server/domain/ai-skill-validator.mjs:68-72`) |
| `knowledge_search` (P4) | `runKnowledgeQuery` retrieval (`server/routes/ai-knowledge.routes.mjs:46`) | Query text | Signed in. Until P4, mixed questions keep `supplementalKnowledge` (`ai-runtime-gateway.routes.mjs:29-38`) |

`capability_overview` is the fallback, not a tool.

**Argument rules.**
- Arguments are validated against the schema, and extra properties are rejected.
- A record id, SKU or supplier name must appear in the standalone question (after steps
  A and B) or, in P4, in an earlier tool result of the same answer.
- Values are resolved through `resolveAiSkillEntities` (`server/domain/ai-skill-entities.mjs:121`),
  with the same found, ambiguous, hidden and not-found answers. A real record the actor
  cannot see therefore answers like one that does not exist.
- Tools take no tenant, actor or limit argument. A skill a rule excluded for this
  question is still refused (`ai-skill-intent-routing.mjs:44` (#105)).

### 3.3 The tool loop and its limits

| | P2 plan | P3 compose | P4 loop |
| --- | --- | --- | --- |
| Model calls | 1 | 2 (plan, compose) | At most 3 (plan, second plan, compose) |
| Tool calls | At most 3, one round, run in parallel | At most 3 | At most 4, in two rounds |
| Per-call timeout | 2.5 s | Plan 2.5 s, compose 4 s | The same |
| Model budget per answer | 3 s | 6 s | 8 s (hard stop) |

- The skill facts are read once per answer (`readAiSkillFacts`,
  `server/domain/ai-skill-readers.mjs:146`) and shared by every skill tool. Identical
  calls are made once.
- **Protocol.** Native tool calls where the provider has them, JSON steps otherwise. The
  adapters send chat-completions JSON (`ai-runtime-provider-specific-adapters-v2.mjs:213-235`
  (#105)).
  - **Parley: native tool calls work** (one local request, 2026-10-03). It accepted
    OpenAI-style `tools` with `tool_choice: "auto"`. `claude-haiku-4-5` returned
    `finish_reason: "tool_calls"` with two parallel, schema-valid calls,
    `purchase_orders {"mode":"overdue"}` and
    `inventory_availability {"mode":"single","skus":["LDM-001"]}`.
  - That request took 1.3 s, with 799 input and 136 output tokens and two tools defined.
    The reply also carried a sentence of `content`, which the loop ignores.
  - Strict schemas are not guaranteed, so arguments are still validated. Streaming is
    not verified yet.
  - A provider without tool calls returns the same plan as JSON:

  ```json
  {"step":"plan","calls":[{"tool":"purchase_orders","args":{"mode":"overdue"}},
   {"tool":"inventory_availability","args":{"mode":"short"}}],"unansweredParts":0,"confidence":0.8}
  ```
- **Plan validation.** A plan is used only if every tool is the actor's, every argument
  passes the argument rules, the confidence (when the JSON form carries one) is at least
  0.6, the routing threshold, and there are at most 3 calls. Extra calls are dropped and counted as unanswered parts.

### 3.4 What the model sees

| Item | #105 pick-one | P2 | P3 / P4 |
| --- | --- | --- | --- |
| The question (at most 1,200 characters), after steps A and B | Yes | Yes | Yes |
| Skill ids and descriptions | Yes | Yes, with input schemas and the plan schema | Same |
| Tool results: compact, masked views | No | No | Yes |
| `facts`, raw rows, the full PO index, raw item columns | Never | Never | Never |
| Conversation history, tenant or user names | Never | Never | Never |

- **The tool-result view** is built from the skill's own validated answer
  (`assertValidAiSkillResponse`, `ai-skills.mjs:35`). It carries figures, evidence (id,
  label, status code), counts and limitation codes. It never includes `facts`, which also
  holds the all-orders index and raw item columns (`ai-skill-readers.mjs:52-59`,
  `:209-213`). Each result is capped at 25 records and 4 KB, the total at 12 KB, and a
  truncated result says so.
- **Masking is inherited.** The readers drop hidden sources and null the amounts and
  partner names the actor may not see before any skill runs (`ai-skill-readers.mjs:148-154`,
  `:198-213`, `:253`; `aiSkillVisibility`, `ai-skill-registry.mjs:107-117`). The view adds
  no field the actor's own answer would not show.

## 4. Grounding and verification (P3)

The model writes sentences; facts enter only through slots that the server renders from
tool results, in the tenant's locale and currency and the shared status labels.

| Slot | Renders | Example |
| --- | --- | --- |
| `{fig:<key>}` | A figure, keyed as in `figures` (`server/domain/ai-skill-presenter.mjs:215-217`) | `{fig:atp:LDM-001}` → "63 pcs" |
| `{count:<list>}` | The length of a list in a result | `{count:overdue_purchase_orders}` → "3" / "3 张" |
| `{rec:<id>}` | The record's stored label; it also becomes an evidence link | `{rec:LOCAL-DEMO-PO-013}` → its stored order number |
| `{status:<id>}` | The record's status label in the answer language | "Overdue" / "已逾期" |
| `{date:<id>.<field>}` | A date from the result, in the tenant's timezone | "Oct 7" / "10月7日" |

**Verifier.** The checks run in order, and the first failure rejects the wording:
1. The reply is valid JSON, in the answer language.
2. Every slot resolves to this answer's tool results.
3. The text outside the slots has none of the following:
   - digits, or number words (English, and Chinese numeral plus measure word);
   - id-shaped tokens, currency symbols or codes;
   - dates, or relative days other than "today";
   - stored names, which must be slots;
   - the action claims in `AI_ANSWER_ACTION_CLAIMS` (`server/domain/ai-answer-claims.mjs:6`);
   - technical words (`FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN`,
     `ai-runtime-provider-adapter-v2.mjs:16`);
   - Chinese in an English answer (`ai-skill-validator.mjs:79`);
   - more than 1,200 characters.
4. A status word outside a slot ("late", 逾期, "short") must sit in a sentence whose
   records or lists all carry that status in the results. A status word next to a
   negation is rejected.
5. Every tool that returned data is referenced. Limitations (hidden by permission,
   amounts hidden, truncated) are added by the server, never left to the model.
6. The rendered answer passes `assertValidAiSkillResponse` (`ai-skill-validator.mjs:86-90`),
   like every skill answer.

- **On a mismatch,** the P2 composite template is served. It is computed before the
  compose call, so the fallback adds no wait. The audit row records `grounding: rejected`
  and the reason codes.
- **Precedent.** `validateCompoundQueryRewrite` (`ai-model-router.mjs:183-203` (#105))
  already rejects rewrites that introduce ids, numbers or dates.
- **Residual risk.** A name-like phrase the workspace does not contain cannot be looked
  up. English capitalised-token checks reduce the risk; in Chinese it remains. Its impact
  is limited: the phrase links to nothing, and the evidence cards show the real records.
  The grounding eval includes invented-name cases.

**Evidence and labels stay truthful.** The server assembles evidence, links, `figures`,
`metrics`, limitations and review cards from the tool sections, never from the model's
text.
- In P2 every section's evidence is shown. In P3 only the referenced records' evidence is
  shown, plus every limitation.
- Composite answers add an optional `sections` field to the response contract
  (`src/domain/ai/response-contract.ts`). The renderer needs English and Chinese copy for
  it.

| Phase | `answerSource` | Label (en / zh) |
| --- | --- | --- |
| Rules, P1 | `workspace_rules` (`ai-skill-presenter.mjs:15`) | "Answered from your workspace data" / 基于当前工作区数据回答 (`server/domain/ai-skill-copy.mjs:70`) |
| P2 | `workspace_rules`, with `skillRouting.source: 'model'` as in #105 | Same |
| P3 | `workspace_agent` | "Answered from your workspace data. Worded by AI; figures checked." / 基于当前工作区数据回答，由 AI 组织语言，数字已核对 |

## 5. Safety

| Concern | Mechanism | Builds on |
| --- | --- | --- |
| Permissions and field masking | Tools are the actor's own; the readers mask before tools run; the view adds nothing | `toolsFor`, `aiSkillVisibility`, `readAiSkillFacts` |
| Tenant isolation | The actor comes from the server identity, never the body; tools take no tenant argument; ids resolve only in the actor's facts | `server/domain/ai-skill-context.mjs:32-39`, eval `sameAnswerAs` pairs |
| Prompt injection in the question | Refusal first; no write tools; injection patterns logged | Gateway `:83-88`, `PROMPT_INJECTION` (`server/domain/ai-semantic-query-planner.mjs:14`) |
| Prompt injection in record text (P3) | Views carry ids, codes, numbers and short names only, no notes. A name that matches injection patterns is replaced by its id in the model's view (the user still sees it through the slot). Results go in a data envelope marked untrusted. The verifier checks the output. | The adapters' untrusted-data instruction (`ai-runtime-provider-specific-adapters-v2.mjs:99-122` (#105)), the `EVAL-INJ-*` seeds |
| Write actions | Refused before agent mode; no write tool exists; drafts are review-only; action-claim check | `detectAiActionRequest` (`server/domain/ai-skill-router.mjs:158`), validator `:68-80` |
| Audit | One row per answer, as today (`server/domain/ai-skill-audit.mjs:16-55`), plus an `agent` block: phase, status, fallback, reason codes, calls `{ tool, status, recordCount, ms }`, model calls and milliseconds, provider, `grounding`, unanswered parts. No question text (hash only) and no model text. | The `intentRouting` audit block (#105) |
| Data sent to a provider | P2 sends no business data, like #105. P3 sends the actor's masked results: an owner decision, and for real tenants a per-workspace opt-in ([§11](#11-decisions-for-the-owner)) | `docs/ai-product-knowledge.md:99-101` (#105) |

## 6. Fallbacks, flags and modes

| Flag | Values (default first) | Meaning |
| --- | --- | --- |
| `FLOWCHAIN_AI_COMPOUND_ANSWERS` | `false`, `true` | P1. Needs no provider |
| `FLOWCHAIN_AI_AGENT_MODE` | `off`, `plan`, `compose`, `loop` | P2, P3, P4. Also needs `FLOWCHAIN_AI_RUNTIME_MODE=provider_assisted` and a callable provider |
| `FLOWCHAIN_AI_AGENT_MAX_TOOLS`, `FLOWCHAIN_AI_AGENT_BUDGET_MS` | 3 (at most 4); 3000/6000/8000 by phase (at most 8000) | The limits in §3.3 |

Each phase gets a policy entry in `AI_MODEL_POLICY_DEFINITIONS` (`agent_planning`,
`agent_wording`, `agent_loop`), with `enabledByDefault: false` and the owner's approval
date, like `intent_routing` (`ai-model-router.mjs:73-79` (#105)).

| Situation | Answer |
| --- | --- |
| No provider configured (Render today), or the flag off | Today's path. P1 still works if its flag is on |
| The plan call times out, errors, returns invalid JSON or an unknown tool, or is below 0.6 confidence | The rule's answer if a rule matched part of the question, with a "part not answered" limitation; otherwise the capability answer |
| One tool fails | Its section shows a limitation. If every tool fails: the 503 the gateway returns today, never a made-up "no records" (`ai-runtime-gateway.routes.mjs:121-127`) |
| The compose call fails, or the verifier rejects the wording | The P2 composite template |
| The budget runs out | Whatever is complete: the composite if the tools finished, otherwise the rules or capability answer |

## 7. Latency and cost

| Path | Basis | Estimated answer p50 / p95 |
| --- | --- | --- |
| Rules (today) | Measured offline: 17 / 45 ms (`tests/ai-eval/README.md:254` (#105)) | Unchanged |
| Pick-one (#105) | Measured model call: 753 / 874 ms (`tests/ai-eval/README.md:255` (#105)) | 0.8 / 0.9 s |
| P1 | 2-3 skills over one facts read | Under 0.1 s |
| P2 | One call returning about 100-250 tokens: between pick-one (0.75 s) and the planner (about 2.2 s median, `docs/ai-query-integration.md:40` (#105); up to about 4 s) | 1.2 / 2.0 s |
| P3 | Adds a compose call: about 3,500 input and 300 output tokens | 2.5-3.5 / 5 s |
| P4 | Adds a second plan call | 3.5-4.5 / 6.5 s, and never over 8 s |

**Progressive display.** The client calls a JSON endpoint today
(`src/modules/ai-assistant/aiRuntimeGateway.ts:69`). Nothing streams.

| Option | Verdict |
| --- | --- |
| A spinner naming the sources being checked | P2: enough at about 1.2 s |
| Server-sent progress events ("Checking purchase orders…") | P4: needs a streaming endpoint and client work |
| The template answer first, swapped for the verified wording | Possible in P3; the text changes under the reader, so test it with users first |
| Streaming model tokens | Rejected: text cannot be shown before the verifier has seen all of it |

**Cost per model-answered question.** The estimates use Anthropic first-party list prices
(Haiku 4.5: $1 input and $5 output per million tokens; Sonnet 5.5: $2 and $10). The token
counts are estimates; measure them in P2.

| Path | Tokens in / out | Haiku 4.5 | Sonnet 5.5 |
| --- | --- | --- | --- |
| Pick-one (#105) | about 800 / 30 | about $0.001 | about $0.002 |
| P2 | about 3,000 / 200 | about $0.004 | about $0.008 |
| P3 | about 7,500 / 550 | about $0.010 (about $0.007 with prompt caching) | about $0.021 |

- **Example pilot.** Take 10 users asking 30 questions a day for 22 days: 6,600 questions
  a month. If 25-35% reach the model (17% reach it today in the eval), P3 costs about
  $17-24 a month on Haiku 4.5, or $34-47 on Sonnet 5.5.
- **Eval runs.** One provider-backed eval run costs about $0.60. Local development and
  eval runs fit within the owner's Parley credits.

## 8. Provider options for a public deployment

| Option | For | Against | Decision needed |
| --- | --- | --- | --- |
| No model in production (default) | Zero cost and zero data sharing; the rules path passes 151/151 gated cases (#105), and P1 works | No free phrasing beyond the rules, and no model wording | None |
| MIT Parley | Already integrated and measured (Haiku 4.5) | Keys belong to individual MIT members and spend their credits. Use outside MIT needs IS&T confirmation (`docs/ai-product-knowledge.md:99-101` (#105)). No SLA. Tool calling verified; streaming not yet. Replies name an AWS Bedrock inference profile, so requests are served through Bedrock. | Credits and acceptable use, with IS&T (owner rule) |
| A paid API (for example Anthropic Haiku 4.5) | Native tool use with strict schemas, streaming, prompt caching, an SLA | Monthly cost (§7); a new adapter and a key on Render; tenant data goes to a third party (privacy notice, opt-in) | Provider, monthly cap, and the data policy |
| A Chinese provider (Qwen, DeepSeek, Doubao adapters exist) | Fits a mainland deployment (`docs/aliyun-backend-deployment-roadmap.md`) | Never scored on this eval | Only if that deployment goes ahead |

## 9. Evaluation plan

`npm run test:ai:eval` stays the gate. The runner needs:
- a `turns` field for multi-turn cases;
- an in-process scripted provider, injected like `ctx.aiSkillIntentProvider`
  (`ai-skill-runtime.mjs:54` (#105)), so the grounding cases run offline under the
  offline guard;
- agent metrics: invoked, served and fallback counts by reason, tools and model calls
  per answer, verifier rejection rate, and agent latency.

| New category | Checks | Examples | Runs |
| --- | --- | --- | --- |
| `compound` | Each part is answered with its own skill's numbers; no part is dropped without a notice; masking applies per part | The two P1 questions in §1; a buyer asking for POs and invoice totals gets the invoice part as hidden | Offline |
| `multi_tool` | Free-phrased compound questions; `expect.skills` (every tool listed must answer); numbers per part | "Anything late from suppliers, and are we short on stock?" | With the provider (pending offline) |
| `grounding` | The verifier rejects each injected fault and serves the template: a wrong number, an invented id, a workspace B id, a swapped status, an amount for a viewer, an action claim, Chinese in English, digits outside slots, an invented name | A scripted provider | Offline |
| `multi_turn` | Step B's rewrite is answered; hidden records stay hidden across turns; a workspace B id in a follow-up is not found | "Which POs are overdue?" → 只看 Atlas 的 → 为什么？ | Offline (rules) and with the provider |
| `agent_failure` | A timeout, a malformed plan, an unknown tool, too many calls or a slow tool each give the §6 answer within the budget | A scripted provider | Offline |
| `injection` (extended) | `EVAL-INJ-*` names in tool results do not change the answer | Existing seeds | Scripted, then the provider |

**Gate before enabling any phase anywhere, including as the owner's local default:**

| Measure | P1 | P2 | P3 |
| --- | --- | --- | --- |
| Existing gated cases, offline and with `--provider-env` | No regression | Same | Same |
| Safety failures, permission or cross-tenant leaks, business writes, blocked calls, Chinese in English answers | 0 | 0 | 0 |
| Audit rows per answer | Equal to answers | Same | Same |
| `compound` | All gated cases pass | Same | Same |
| `multi_tool` (with the provider) | n/a | At least 90% answer every part; 100% numeric agreement on stated numbers | Same |
| `paraphrase` / `unknown` | n/a / all capability answers | All routed (13 today) / all capability answers (16 today) | Same |
| `grounding` (scripted) | n/a | n/a | Every fault rejected, template served |
| Wording fallback rate (with the provider) | n/a | n/a | At most 10% of composed answers |
| `repeat: 3` | Identical | Identical figures and records | Identical figures and records |
| Degraded calls | n/a | At most 2% | At most 2% |
| Latency | Rules p95 unchanged | Agent p50 at most 1.5 s, p95 at most 2.5 s | p50 at most 3.5 s, p95 at most 6 s, none over 8 s |

Language results cover only the paths the cases reach. They do not show full bilingual
coverage (`docs/interface-language-policy.md`).

## 10. Rollout

| Phase | Ships | The model decides | Sent to the model | Where | Size |
| --- | --- | --- | --- | --- | --- |
| P1 | English and Chinese splitting; composite answer with `sections`; `agent` audit block; `compound` eval cases | Nothing | Nothing | Everywhere, Render included | M |
| P2 | Plan step over skills and `supplier_business_query`; argument rules; entry rule; tool-result view; scripted provider; `multi_tool` and `agent_failure` cases | At most 3 tools and their arguments, taken from the question | The question and the tool list | Local (Parley) | M |
| P3 | Slot compose, verifier, template fallback, P3 label, `grounding` cases | The sentence wording and which facts to mention, all through slots | The above, plus the masked tool results | Local | L |
| P4 | Second tool round, `knowledge_search`, progress events | Dependent second lookups | The above, plus first-round results | Local | L |
| Public | The chosen provider's adapter, a monthly cap, per-workspace rate limits and opt-in | — | — | Render production | M |

Each phase ships only after the previous one passes its gate. Before P2: Parley tool
calling is verified (§3.3). Still to measure: the token count of the full plan prompt.
Streaming matters only from P4.

## 11. Decisions for the owner

| # | Decision | Recommendation | Owner, 2026-10-03 |
| --- | --- | --- | --- |
| 1 | Build P1, and switch it on by default once its gate passes. No model is involved. | Yes | Approved |
| 2 | P2: let the model choose up to 3 read-only tools and their arguments, instead of one skill id. It still sees only the question and the tool list. Local only, off by default. | Yes | Approved |
| 3 | In P2, the model writes the supplier business query plan directly, folding the opted-in `business_query_planning` decision into agent planning, with the same guards | Yes | Approved |
| 4 | P3: let the model write the wording (facts only through verified slots), and send the actor's masked tool results to the provider. Local only. | Decide after the P2 results | Open |
| 5 | Provider for a public deployment: none, Parley after IS&T confirms, a paid API (which provider and what monthly cap), or a Chinese provider | None for now; revisit when a public trial needs it | Open |
| 6 | Before real tenants' data reaches any provider (P3 and later): a per-workspace opt-in, off by default | Yes | Approved |
| 7 | The P3 answer label (§4) | As proposed | Open |
| 8 | The gate thresholds in §9 | As proposed | Approved |
| 9 | Audit rows keep reason codes only, never question or model text | Yes | Approved |
