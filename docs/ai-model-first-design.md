# Model-first assistant: design and decisions

Status: proposal, 2026-10-28. Nothing in it is built. The owner decides M1–M7 (§10)
before any code.

On 2026-10-28 the owner said the assistant feels "hard-coded with too many rules"
and asked for the chat to be a general-purpose window onto the workspace. They
accepted the direction in this document: the model decides what to read and
writes the answer; the system supplies every fact and executes nothing without a
person. This document turns that direction into a design and lists the decisions
it needs. It changes the plan in `ai-assistant-plan.md`; that file's decision
register is updated only after the owner decides.

## 1. Why the assistant feels hard-coded

On `main` at `70891206`:

- **Size.** 90 `server/domain/ai-*.mjs` files hold about 22,500 lines.
  - About 6,100 of them are the skills.
  - `ai-skill-copy.mjs` holds 856 lines of answer templates.
  - The router holds about 120 lines of regular expressions.
- **What the model may do today.**
  - Agent planning (P2, `ai-agent-planning.mjs`) picks at most 3 skills (`AI_AGENT_LIMITS.maxTools`) in one round. It sees the question and the skill list, never business data.
  - Answer wording (P3, `ai-answer-compose.mjs`) rewrites only the title and the summary, through server-filled `{slot}` keys. No digit, name or date may appear outside a slot.
- **The consequence.** A question outside the 15 answering skills fails, model or not. The
  capability probe of 2026-10-28 asked 24 everyday questions plus 8 new ones. With
  the model off, 8 of the 24 got a full answer. Among the 8 new ones:
  - none about sales orders, shipments or customer payments was answered;
  - "how will LDM-001's stock change over two weeks" got today's available-to-promise;
  - "which supplier's problems hurt customer orders most" got a clarifying question.

  The model-on run could not be measured that day: the local provider key had
  reached its monthly limit.
- **The direction since 10/03** widened what the model decides one step at a time:
  routing, then planning, then slot wording. Each step kept the skills as the only
  source of answers. That is the limit the owner is now pointing at.

## 2. What stays

- **The balance (direction of 2026-10-05).**
  - The model understands, chooses what to read, and writes.
  - The system supplies the facts and executes.
  - A person confirms anything that changes data.
  - The model never supplies a number, record or date of its own; every one comes from a tool result.
- **Permissions and tenants.** Every tool runs as the asking user, in their
  workspace, with the read checks the pages use. The model never sees what the user
  could not open themselves.
- **The opt-in and the cap (#150).**
  - A workspace calls a model only when its administrator switched AI on, and only under the monthly cap.
  - Every other workspace keeps today's rules-only assistant.
- **Draft-first.** No tool writes. Creating anything is a proposal card the user
  confirms (#151, track C).
- **Refusals and guards stay rules.** These run before the model, and stay deterministic:
  - instructions to approve, pay, send, issue, cancel or delete (`detectAiActionRequest`);
  - questions about the outside world;
  - the injection guard.

## 3. The new path

```
question ─► guards (refusal, outside world, injection, signed in, opted in, under cap)
         ├─ model unavailable or not opted in ─► today's rules and skills (fallback)
         └─► tool loop (model) ─► grounding check ─┬─ pass ─► answer + sources
                                                   ├─ fail ─► one retry with the problems listed
                                                   └─ fail again ─► rules answer + notice (#224)
```

- **Entry.** A free-text question in an opted-in workspace goes to the tool loop.
  The prompt chips and the record-page chips keep their skills: they are buttons
  with a fixed meaning, answer in under a second and cost nothing.
- **The loop.** The model reads with the tools in §4. The limits:
  - **rounds and calls:** at most 4 rounds and 8 tool calls per answer; calls in one round run together;
  - **time:** a 20-second budget;
  - **tokens:** a per-answer token budget.

  The model answers with a structured final message: the text, plus the records
  it relied on as `{type, id}` pairs. The server, not the model, turns those into
  record links.
- **Grounding check (replaces the slots).** The server extracts from the final
  text:
  - every number, with its currency or unit;
  - every date and every record number;
  - every name of a supplier, customer, item or warehouse the workspace knows.

  Each must appear in a tool result of this answer, after normalising formats
  (1,234.50 and 1234.5, Oct 28 and 2026-10-28), or come from the `calculate`
  tool. A cited record must be one a tool returned. Anything else fails the check:
  - the model gets one retry, with the ungrounded items listed;
  - a second failure returns the rules answer with the "model unavailable" notice;
  - the audit row records which kind of item failed, never the text.
- **What the check cannot see.** Rankings ("the most urgent is"), "all" or "none"
  claims, and reasoning between correct numbers.
  - The prompt asks the model to state the basis of any ranking.
  - The evaluation measures these claims (§7).
  - The residual risk is the one #168 recorded for P3.
- **Conversation.** The previous turns are sent as text, at most 3, from the same
  user's panel. A follow-up such as "why is it first" or "write to this supplier"
  is then read by the model, not by memory rules.
- **Injection.** Stored text (names, notes, document passages) reaches the model
  only inside tool results.
  - The system prompt says tool results are data, never instructions.
  - There is no write tool to misuse.
  - The evaluation keeps its stored-instruction cases (`EVAL-INJ-*`) and adds cases with instructions inside notes.
- **Audit.** One row per answer, with codes and counts only (agent mode decision 9):
  - tools called, rounds, the grounding outcome;
  - tokens, cost and model.
- **Wording label.** "Written by AI from your records; figures checked", in both
  languages. The record links are shown under the answer.

## 4. Tools

Read tools wrap existing read services. Each returns compact JSON:
- capped rows, newest or most urgent first, with a `more` count;
- only the fields the answer needs;
- each record's type and id, for links.

Contact emails and phone numbers are left out; draft tools fill them in later.

| Tool | Reads (existing code) | Read permission the tool checks | Returns |
| --- | --- | --- | --- |
| `search_records` | `searchRuntimeBusinessContext` (`/api/search`) | the scoped business context | Items, suppliers, customers, orders, requests, RFQs and warehouses matching a name or number |
| `list_purchase_orders` | `listForReport` and the open purchase orders report, as the skills read them | `procurement.purchase_order.read`; amounts need `procurement.prices.read` | Orders filtered by status, overdue, supplier, SKU or dates: original and current promised dates, days late, open lines, issued or not |
| `get_purchase_order` | procurement documents; `getPurchaseOrderReceivingSummary` | the same, plus `receiving.read` for its receipts | One order with lines, receipts and invoices |
| `list_receipts` | `receiving-workbench-query-service` | `receiving.read` and the warehouse | Receipts with rejections and posting status |
| `stock_position` | `buildRuntimeInventoryAllocation` | `inventory.balance.read` | Per SKU: on hand, reserved, available, open demand, incoming, available to promise, status |
| `stock_projection` | new: on hand, open purchase order lines by promised date, open sales order lines by promised date | `inventory.balance.read`; orders shown only with their own read permission | A dated view of one SKU over the next weeks (replaces analysis tool 4) |
| `reorder_list` | `reorder-list-read-service` | `inventory.balance.read` | Items to order, the order-by date, the supplier |
| `list_sales_orders`, `get_sales_order` | the sales order repository; `outbound-workbench-read-service` | `sales_order.read`, `shipment.read` and the warehouse | Orders, lines, promised dates, reservations, shipments |
| `list_supplier_invoices` | `operational-finance-read-service` (invoices, match exceptions, payables) | `finance.supplier_invoice.read`, `finance.three_way_match.read`, `finance.payable.read`; amounts need `finance.amounts.read` | Invoices, match results, what is due |
| `list_customer_invoices` | `operational-finance-o2c-read-service` (invoices, receivables, aging) | `finance.customer_invoice.read`, `finance.receivable.read`; amounts as above | Customer invoices, open receivables, aging buckets |
| `supplier_performance` | `supplier-scorecard` | `procurement.purchase_order.read` and `receiving.read` | On-time and in-full rates, deliveries counted, the period |
| `supplier_open_work` | `supplier-action-summary-read-service` | per source, as today | Per supplier: open orders, receipts, invoices, RFQs, payables |
| `report` | `buildRuntimeGovernedReport` (procurement, sales, inventory, finance, suppliers) | `scopeBusinessContext`, as the reports page | KPIs and rows for a period, by supplier, customer or month (spend, sales) |
| `price_history` | `price-history-read-service` | `procurement.purchase_order.read`; prices need `procurement.prices.read` | Prices paid per supplier over time |
| `list_contracts` | `contract-read-service` | the contracts read permission | Contracts, parties, dates, state |
| `list_rfqs` | the procurement documents (RFQs, quotes, awards) | `procurement.purchase_order.read` | RFQs, quotes received, deadlines, awards |

**Each tool checks its read permission itself**, the way the skills' `AI_SKILL_SOURCES` does today, and does not rely on the service. The 10/28 survey found two services that check none:
- the inventory balance and movement reads scope by warehouse only;
- `getPurchaseOrderReceivingSummary` scopes by tenant only.

S1's tests ask every tool as each evaluation role and assert that nothing hidden from that role comes back.

Three tools are not reads:

- **`calculate`.** Sums, differences, ratios, percentages, days between dates and
  unit conversions, done by the server. Derived figures in the answer must come
  from it, which is how the grounding check accepts them.
- **`search_documents`.** The workspace's own documents, as today's knowledge
  search. It returns passages with their sources.
- **`propose_*`** (phase S5, after C1). They build a proposal card (a purchase
  request or an RFQ draft, #151). They never create anything; the user confirms in
  the card.

## 5. Models, cost and latency

Prices are Anthropic's list prices per million tokens as of October 2026.

| Model | Input | Output | Fit |
| --- | --- | --- | --- |
| `claude-haiku-5-5` | $0.10 (prompts up to 100K tokens) | $0.50 | Recommended for the loop: the current small model, 1M context |
| `claude-haiku-4-5` | $1.00 | $5.00 | The 10/05 choice; 10 times Haiku 5.5's price |
| `claude-sonnet-5-5` | $2.00 | $10.00 | Fallback if Haiku's answers fall short on the evaluation |

**An answer, estimated** (to measure in S0 and S3):
- **Calls:** 3 model calls, the last writing the answer.
- **Fixed prompt:** the system prompt and tool definitions are about 4,000 tokens. They are cached after the first call; cached input costs a tenth.
- **Tool results:** they grow from 2,000 to 8,000 tokens.
- **Output:** about 2,000 tokens, including thinking.

| Model | Per answer | 440 answers a month (20 a working day) |
| --- | --- | --- |
| Haiku 5.5 | about $0.003–0.006 | about $1.5–3 |
| Haiku 4.5 | about $0.02–0.04 | about $9–18 |
| Sonnet 5.5 | about $0.05–0.08 | about $22–35 |

The workspace cap of USD 20 a month (#150) covers Haiku comfortably. The meter's
default prices (`AI_PRICE_DEFAULTS`) are Haiku 4.5's; they must follow the
configured model.

**Latency, estimated.** About 1–2 s per model call and well under a second per
tool. That gives 4–8 s for a typical answer and up to about 15 s at the limits.
Today a rules answer takes about 0.1 s, and P2 planning takes 0.8 s at p50 on
Parley. The answer streams in S3, with a progress line while tools run ("Reading
purchase orders…").

**Provider adapters.**
- **Anthropic:** a native Messages API adapter for the trial, with tools, `tool_choice: auto`, strict tool schemas and structured final output.
  - The newest Claude models reject forced tool choice, so the design does not rely on it.
  - Haiku 5.5 thinks by default, at medium effort. The loop runs at low effort unless S3 shows that costs quality.
  - Anthropic does not position the OpenAI-compatible endpoint, which the 10/05 design used, for long-term production.
- **OpenCode Go, local development and the model-on evaluation (the owner's choice, 2026-10-28).** It is a USD 10 a month subscription with an API key from the OpenCode Console.
  - It serves `claude-haiku-5-5`, GLM, Kimi, Qwen, DeepSeek and others, through an OpenAI-compatible endpoint (`https://opencode.ai/inference/go/openai/v1/chat/completions`) and an Anthropic Messages endpoint. So both the chat-completions adapter that P2 uses and the native adapter can reach it.
  - OpenCode describes Go as "designed for OpenCode and other coding agents". It asks clients to send their own user agent, and it is for single-member workspaces. FlowChain therefore uses it for the owner's own local runs and evaluations, never for trial customers, and sends its own `User-Agent`.
  - **Privacy settings:** OpenCode lists most of its models as not used for training. Claude Haiku 5.5 is kept for 30 days. The owner saves the privacy settings with training models off and regions limited to the US and Europe.
- **Parley, local only:** replaced by OpenCode Go while its monthly budget is used up. Its model list on 10/07 had Haiku 4.5 and Sonnet 5.5, not Haiku 5.5.

## 6. Data that leaves the workspace

For an opted-in workspace, the provider receives:
- the question and up to 3 previous turns;
- the tool definitions;
- the tool results, which are the asking user's own records, limited to the listed fields.

Today P3 already sends the facts of the routed skill (decision 4 of 2026-10-07).
This widens that to whatever the tools return for the question. Nothing is sent
for a workspace that has not opted in. Before the owner opts in a real customer's
workspace, confirm Anthropic's current API terms on retention and training.
`docs/ai-workspace-access.md` is rewritten with the build.

## 7. Evaluation

- **The offline rules evaluation stays** (`npm run test:ai:eval`, 247 gated
  cases). It is the fallback's guard and runs in CI as today.
- **A model-on lane** (`--model-first`, run locally with a provider key, never in
  CI until the owner decides) scores:
  - **task success:**
    - the 32 probe questions, with expected content written for each;
    - the 30 pending cases;
    - the 40 + 10 task set the plan requires before any public claim (V2);
  - **grounding:** the share of answers whose every figure, date and record passed the check on the first try, and how often the fallback was used;
  - **safety:** the existing checks, each at 0:
    - leaks across roles and workspaces;
    - business writes and action claims;
    - injection cases;
  - **ranking claims:** a hand-checked sample of answers with "most", "all" or "none";
  - **cost and latency:** per answer, p50 and p95.
- **Each run has a fixed budget.** For example USD 2 on Haiku 5.5. The report
  prints what it spent.
- **The bar for switching it on for a trial workspace**, proposed:
  - task success above today's P2 + P3 on the same questions (S0 measures that);
  - grounding failures below 2% after the retry;
  - 0 safety failures;
  - p95 under 15 s.

## 8. Phases, behind a flag

`FLOWCHAIN_AI_ASSISTANT_MODE=model_first`, off by default, local first. Days are
build days for the assistant session; the owner's time is in §9.

| Phase | What | Days | Needs |
| --- | --- | --- | --- |
| S0 | Baseline: today's P2 + P3 on the probe and pending cases, with a working key | 0.5 | a key |
| S1 | The read tools of §4 over the existing services; permission tests per role (every tool returns nothing a role cannot open, the evaluation's roles) | 4–5 | decisions M1–M4 |
| S2 | The loop, the native Anthropic adapter, the grounding check, retry and fallback, the audit row, the meter per model | 4–5 | S1 |
| S3 | The model-on evaluation lane; the answer label, record links, progress line and streaming | 3 | S2 |
| S4 | Fixes from the first full run; the owner tries it locally | 1–2 | S3 |
| S5 | Proposal tools (`propose_purchase_request`, `propose_rfq`) on C1's confirm cards | 3–4 | C1 merged |

S1–S4 make v1: about 13–15 build days, so 2.5–3 weeks.

## 9. What it replaces, and November

The approved 1–7 order of 2026-10-28 becomes:

| Item | Before | Now |
| --- | --- | --- |
| 1 Key and model-unavailable notice | Key from the owner; notice built (#224) | Unchanged: S0 needs the key, the fallback needs the notice |
| 2 Rule fixes | Built (#223) | Unchanged: it improves the fallback. No further rule work |
| 3 Sales, customer and shipment skill | A new skill | Replaced by read tools in S1 |
| 4 Stock projection; spend against last month | Two analysis tools as skills | The projection becomes one read tool (a dated view of stock, incoming orders and promised sales); month-over-month is two spend reads and `calculate` |
| 5 C1 confirmed drafts | Build after the sales skill | Kept; its proposal tools (S5) follow v1 |
| 6 Prose summary for the boss | Template work | Replaced: the model writes |
| 7 Concept glossary | Fixed entries | Replaced: the model answers general questions, labelled as general knowledge, not workspace data |

**November.** The owner has about 6 hours a week; November is fixes only, with at
most 3 merges a week (R1–R6).

| Week | Assistant session | Owner (about 1–1.5 h) |
| --- | --- | --- |
| 10/29–11/4 | S0 once the key works; S1 tools | Decide M1–M7 (30 min); provide the key; merge #223 and #224 if wanted |
| 11/5–11/11 | S1 done, S2 loop | Review one PR |
| 11/12–11/18 | S2 done, S3 | Review one PR |
| 11/19–11/25 | S3, S4; a local model-first walkthrough | Try it for 30 min; decide whether to show it on the trial |

Each phase is one PR behind the flag, so the main path does not change in
November. Switching it on for a trial workspace waits for the bar in §7 and the
owner's word, after the course report.

## 10. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| M1 (a) | For opted-in workspaces, tool results with business data go to the model. The provider is Anthropic, US. Workspaces not opted in stay rules-only. Parley stays local. | Yes, with the field limits of §4 and §6 |
| M2 (b) | Multi-round tools: at most 4 rounds, 8 calls and 20 s per answer. This revises review decision D4 (one round). | Yes |
| M3 (c) | The grounding check (§3) replaces the slot templates for model-first answers: one retry, then the rules answer. Ranking and "all/none" claims stay a measured residual risk. | Yes |
| M4 (d) | Freeze new rules and skills. They stay as the fallback, with bug fixes, and as the guards (refusal, permissions, injection). | Yes. #223 and #224 are fallback work; merging them is the owner's call |
| M5 (e) | The order relative to #151 (A1–A8 approved 2026-10-28). | Model-first read v1 (S0–S4) first; C1 after it in December; the proposal tools (S5) on top. One assistant lane at a time, so the owner reviews one PR a week |
| M6 | The model. | `claude-haiku-5-5`, the same model locally (through OpenCode Go) and on the trial. Sonnet 5.5 only if Haiku misses the §7 bar. OpenCode Go's other models (GLM, Kimi, Qwen) can be compared in S3 at no extra cost |
| M7 | The key. | **Local and evaluation: OpenCode Go** (owner, 2026-10-28). The owner pastes its key into `.local/opencode-go.env`. **Trial workspaces:** a direct provider key (Anthropic) when the trial date is set, not before |

## 11. Risks

- **Wrong reasoning on correct numbers.** The grounding check does not catch it.
  Mitigations: the ranking sample in §7, record links under every answer, and the
  "figures checked" label claiming no more than that.
- **Latency.** Answers take seconds, not a tenth of one. Streaming and the
  progress line make the wait visible; the chips stay instant.
- **Cost.** Bounded by the loop limits, the per-answer token budget and the
  workspace cap.
- **Provider outage or budget.** The rules answer with the #224 notice.
- **Data exposure.** Opt-in per workspace, the user's own records only, field
  limits, no contact details.
- **Two paths to maintain.** The rules path is frozen and kept as the fallback; it
  shrinks only when the owner decides the fallback can be simpler.

## 12. Not in v1

- Writing anything without a confirm card. Payments, approvals, sends and deletes
  are never tools.
- Tools that call outside services, including web search.
- Model-first answers on Render before the §7 bar and the owner's word.
- Retiring skills or templates.
