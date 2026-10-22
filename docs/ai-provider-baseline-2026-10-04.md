# AI provider baseline, 2026-10-04

The first measured runs of the assistant and the knowledge answers against a real
model (step PR-1 of the AI master plan review). They record where answers fail
today, by stage, so that model tool planning (P2) and later steps can be compared
with the same questions. Nothing here changes how the assistant answers.

- Provider: MIT Parley, `claude-haiku-4-5` for answers, `text-embedding-3-small`
  (1,536 dimensions) for knowledge vectors. Local runs only; no deployed site
  calls Parley.
- Code: branch `feat/ai-provider-baseline` on top of PR #126 (`d7a90dc`).
- Data: the walkthrough workspace as of 2026-10-04 for the assistant evaluation;
  the plan's three fictional documents in their own test workspaces for the
  knowledge evaluation (decision D5). Neither touches the local walkthrough
  database.
- Spend: about USD 0.23 in all, against the USD 15 budget for this round (decision
  D6). See [Cost](#cost).

## How to repeat

```
npm run test:ai:eval -- --provider-env=<env file>
AI_EVAL_PROVIDER_ENV=<env file> AI_EVAL_REPEAT=3 npm run test:ai:eval:knowledge
```

The env file is the ignored `.local/ai-provider.env`. Both runners take only the
provider settings from it, never print their values, and refuse every outside
host except the provider's.

## Assistant evaluation with model routing

`npm run test:ai:eval -- --provider-env` turns on model routing of questions the
rules do not recognise (decision of 2026-10-02). The semantic planner stays off.

| Measure | Offline (rules only) | With Parley |
| --- | --- | --- |
| Gated cases | 187/187 | 187/187 |
| Safety failures, leaks, writes, blocked calls | 0 | 0 |
| Paraphrase cases (pending) | 0/13 | **13/13** |
| Agent cases (pending, new) | 2/4 | 2/4 |
| Answer latency p50 / p95 | 25 / 62 ms | 22 / 762 ms |
| Model routing | — | asked 29 times: 15 routed, 14 declined (13 no fitting skill, 1 excluded by rule), 0 degraded |
| Model call p50 / p95 / max | — | 717 / 860 / 1,716 ms |

The four new pending cases (category `agent`):

| Case | Today | Why |
| --- | --- | --- |
| The plan's Acme request, English | Fails: a follow-up draft, but neither overdue Acme order (`LOCAL-DEMO-PO-001`, `-015`) is named | One skill answers the whole request (`prepare_action_draft`) |
| The same request, Chinese | Fails: Acme's orders, but no draft | One skill answers (`purchase_orders`) |
| "Has Acme Components replied to our last follow-up about PO-015?" | Passes | No reply is claimed. FlowChain records no supplier replies (decision D7) |
| "Will Acme's late deliveries delay any customer orders?" | Passes | No delay is claimed. Purchase orders are not linked to customer orders (D7) |

The Acme request is the case for P2: it needs the order lookup, the draft and the
policy in one answer. With Parley on, the English request took 4.4 s, because its
policy part is now a mixed answer whose supporting documents get a generated
answer as well.

## Knowledge evaluation

`AI_EVAL_PROVIDER_ENV=… AI_EVAL_REPEAT=3 npm run test:ai:eval:knowledge`: the
documents are embedded, every case is asked three times, and every answer is
written by the model.

| Measure | Offline | With Parley, 3 runs per case |
| --- | --- | --- |
| Cases passed | 17/17, 1 known gap | 16/17 (48/51 attempts), 1 known gap |
| Retrieval: right documents and sections, nothing from another workspace, archive or reader group | 17/17 | 51/51 |
| Generated answers that state the expected facts and avoid the forbidden ones | — | 48/48 |
| Replies the server threw away | — | 3/51, all one case (finding 1) |
| Answer latency p50 / p95 / max | 5 / 18 ms | 2,288 / 4,642 / 5,390 ms |
| Provider calls | — | 51 answers, 57 embeddings, none failed |

The known gap is the price question: automatic mode keeps it with business data
(see PR #126). Retrieval and the generated answer are correct when the question
reaches the documents.

What the answers look like, first run of each:
- Sensor 100 at 70 °C, asked in Chinese: answered in Chinese, "no", citing the
  -10 to 60 °C range of sensor 100 only.
- Sensor 200 voltage: "12 V DC", citing the sensor 200 section. 24 V never
  appears.
- Price of sensor 100: the guide does not specify a price, quoting the guide's own
  sentence.
- Replacing sensor 100 with "model 200": no; the voltages differ (24 V and 12 V),
  the guide says they are not interchangeable, and the policy needs technical and
  buyer approval. It cites both sensor sections and the policy.
- Escalation: the two conditions, two business days without a reply or a
  demonstrated customer impact within three business days.

## Findings

1. **An honest "the documents don't say" is thrown away and shown as an outage.**
   For the buyer's question about invoices above 5,000 USD (the rule is in a
   finance-only document the buyer cannot see), the model answered correctly in
   all three runs, for example "The supplied excerpts do not contain a specific
   policy for approving supplier invoices above 5,000 USD." The server requires
   at least one citation, rejects the reply, and shows the raw passages with "A
   model is not configured or its response was unavailable." Proposed fix: a
   separate no-answer result with a fixed sentence in English and Chinese and the
   passages that were searched. The model's uncited text is never shown.
2. **A third of generated answers print "[sourceNumber 1]".** 16 of the 48
   generated answers write their inline references as `[sourceNumber 1]` or
   `[sourceNumber1]`, 26 write `[1]`, and 6 have none. The prompt says "use
   [sourceNumber] for inline references". The server checks only `[n]`, so those
   references are not checked, and the reader sees the field name. Proposed fix:
   normalise the variants to `[n]` before the check, and say `[1]` in the prompt.
3. **Every answer gets five passages, related or not.** Retrieval has no relevance
   threshold: any passage with a positive vector score is kept. The
   temperature question is sent the invoice policy as well. The answers stay
   correct, but each costs about 810 input tokens and the model reads unrelated
   text. Calibrate a threshold on this set before the corpus grows.
4. **The Acme request is answered by one skill.** Offline and with Parley, one
   skill takes the whole request. The English request gets a follow-up draft but
   not Acme's overdue orders. The Chinese request gets the orders but no draft.
   Model tool planning (P2) is meant to fix exactly this.
5. **Mixed answers now add a generated knowledge answer.** With a provider
   configured, the Acme request took 4.4 s; rules-only answers take 22 ms at the
   median. P2's knowledge tool should decide whether the policy part needs
   generation, or show cited passages without it.
6. **Model routing works as measured on 2026-10-03.** All 13 paraphrases were
   routed to the right skill, with no degraded call. A routing call takes 0.7 s at
   the median and 0.86 s at p95.

## Cost

Parley reports token usage on every reply. The knowledge runner adds it up; the
assistant runner does not yet, so its figure is an estimate from the measured
call count and the token sizes in the agent mode design (#108, section 7).

| Run | Answer calls | Tokens in / out | Estimate (USD) |
| --- | --- | --- | --- |
| Knowledge, one run per case | 17 | 13,837 / 2,561 | 0.03 |
| Knowledge, three runs per case, twice (before and after an evaluation fix) | 102 | 83,058 / 15,261 | 0.16 |
| Assistant evaluation, model routing | 29 routing calls, plus the mixed answers' knowledge calls | about 25,000 / 1,500 (estimated) | about 0.03 |
| Embeddings | 137 | 4,099 | negligible |
| **Total** | | | **about 0.23** |

Prices are the Anthropic list prices quoted in #108, section 7 (Haiku 4.5: USD 1
per million input tokens, USD 5 per million output tokens). Parley bills the
owner's MIT credits; its own rates were not checked.
