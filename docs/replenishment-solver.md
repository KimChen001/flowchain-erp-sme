# Replenishment solver

What to order now across items, under a budget and the suppliers' minimum order quantities, solved exactly.
Assistant v2 calls it as the `optimize_order_plan` data tool, so the model does not trade items off against a
budget in its head; a study can call the same code from a script. Added 2026-11-06.

## Model

The research prototype's single-cycle sample average approximation (research note v5, appendix A), unchanged:

| Symbol | Meaning | From |
|---|---|---|
| I_i | stock position: on hand − reserved + every open purchase order line (late or not) + open purchase requests | allocation read model, as the reorder list since #249; requests as `suggest_purchase_lines` counts them |
| c_i, m_i, L_i | unit price, minimum order quantity, lead time | the preferred approved supplier: reference price, MOQ, lead time |
| R | review period, days to the next chance to order | 7 (assumed; the user can change it) |
| h_i | holding cost per unit left at the end of the cycle = rate × c_i × (L_i + R) / 365 | rate 25% a year (assumed, as in #269) |
| π_i | shortage cost per unit short = 5 h_i, or s/(100 − s) h_i for a service level s | assumed; the user can give a service level |
| D_ik | demand over L_i + R days in scenario k | 90 days of posted shipments, 200 scenarios |
| B | budget | the user's, or none |

min (1/N) Σ_k Σ_i [ h_i (I_i + q_i − D_ik)^+ + π_i (D_ik − I_i − q_i)^+ ]
s.t. m_i z_i ≤ q_i ≤ M_i z_i, z_i ∈ {0, 1}, q_i integer, Σ_i c_i q_i ≤ B.

- No purchase term: stock left over carries into the next cycle, so money enters through B and h.
- Scenarios: a circular block bootstrap of the 90 days, 7-day blocks, the same blocks for every item. The draws are
  numpy's `default_rng(seed).integers` (ported in `server/domain/numpy-random.mjs`), so seed 7 gives the prototype's
  200 scenarios exactly, and seed 1007 its 20,000 held-out samples.
- Every plan is costed on the 200 scenarios (where the optimum is proven, gap 0) and on the 20,000 held-out samples.
  The assistant reports the held-out cost, which carries no optimiser bias.
- HiGHS solves the epigraph form of the same objective: each item's cost is convex and piecewise linear in q, so it is
  the largest of its pieces. That needs one cost variable per item instead of two per scenario. The prototype's u/v
  form is kept (`formulation: 'scenarios'`), and the tests check that both forms give the same plan and objective.
  On a 6-item instance with a binding budget, the epigraph form takes 0.1–0.2 s instead of 0.8–3 s; on 40 items, 0.9 s.
- HiGHS is `highs` 1.15.4 (highs-js, MIT; HiGHS itself is MIT). It is WebAssembly with no native add-on and no
  network. It loads on the first solve, server side only (nothing under `src/` imports it). Each solve runs in a
  worker thread, so a long solve does not hold up other requests.

## The assistant tool

`optimize_order_plan` (`server/domain/ai-assistant-v2-data-tools.mjs`) reads the records, solves the plan and
returns it:

- `decision`: the lines to order, their spend, the expected cost, and the saving against no order, the reorder
  list and the user's plan.
- `budget`: whether the budget binds, and what lifting it would buy.
- `minimumOrders`: which items were raised to their minimum, and which were skipped because the minimum costs more
  than it saves.
- `plans`: the plans side by side.
- `items`: per item the position, open requests, days covered, expected demand, the minimum and its value, the best,
  reorder-list and proposed quantities, the chance of running short with each, and why.
- `assumptions` and `method`, as data.

Arguments: budget, plan (a proposed order), fixedLines, exclude, extraDemand (a known order the history does not
show), skus, supplier, serviceLevelPercent, holdingRatePercent, reviewDays.

The tool reads, and never orders. When the model passes a decision's quantity on a purchase request form line, the
form shows it as the best plan's (`order_plan`). The user still ticks the line and creates the draft.

Items are left out, with the reason, when there is no item record, the item is inactive, it has no stock unit or
another purchase unit, it has no stock row, no approved supplier, no lead time or no reference price, the price is in
another currency, or it has fewer than 8 shipment days. The tool refuses when prices are hidden from the role, and
for a reader of only some warehouses. Order numbers and supplier names follow the role's visibility. At most 40
items are planned at once: those named, then those whose stock runs out first.

## Research hooks

`planReplenishment(input, options)` is pure and deterministic: the same input gives the same output, in a worker or
inline. `scripts/replenishment-solver.mjs` runs it on a replenishment-inputs export
(`scripts/export-replenishment-inputs.mjs`):

```bash
# OR alone, with the prototype's budget (the spend of the deployed rule's order)
node scripts/replenishment-solver.mjs export.json --budget=rule --label=or_alone --log=calls.jsonl
# A given plan (an LLM's or a buyer's), costed beside the optimum, no order and the deployed rule
node scripts/replenishment-solver.mjs export.json --budget=5000 --plan=LDM-002:50 --label=llm_plan --log=calls.jsonl
# LLM-estimated parameters fed to OR
node scripts/replenishment-solver.mjs export.json --params=llm-params.json --label=llm_params_to_or --log=calls.jsonl
```

- `--params` takes `{ "parameters": { budget, holdingRatePercent, shortageCostMultiple, serviceLevelPercent,
  reviewDays }, "items": { "<SKU>": { extraDemand, leadTimeDays, moq, unitPrice, onHand, openRequests, dailyDemand } } }`.
- "OR plan given to the LLM" is the same output, or the assistant tool's result, shown to the model.
- Each call can be logged as one JSON line, with the inputs, options, full result and a sha256 of the inputs, so the
  arms can be matched by instance. Use `--log=<file>` for the script, or `FLOWCHAIN_REPLENISHMENT_SOLVER_LOG=<file>`
  for the server, where the log records the assistant's tool arguments too. Logging is off by default.

## Reproduction

`server/domain/replenishment-solver.test.mjs` runs the post-#249 export of the local walkthrough (main a83d07cb,
reseeded 2026-11-05) with the prototype's parameters. The test fixture holds the fields the solver reads.

| Plan | Held out | In sample |
|---|---|---|
| q* = 25 LDM-001 | 740.50 | 738.22 |
| No order | 780.41 | 776.39 |
| Reorder list after #249 (50 LDM-002) | 827.55 | 818.94 |

These are the prototype's figures to the cent, from the same scenarios. Offline, the solver also matched the frozen
r2 export (747.08 / 790.17 / 834.10). It matched the safety-stock scenario instance as well: q* = (63, 158, 111, 0,
558, 0) at B = $24,520, with held-out costs 464.79 against the rule's 590.24, and the ±10% budget plans.

## Limits

- One cycle. Lead times are fixed; a supplier delay is a what-if through the lead time.
- The 90 days are taken as representative. The held-out samples re-use them, so they cannot reward information the
  history does not hold. `extraDemand` is how known information enters.
- Costs are assumed, not accounting data. Because π is proportional to price, cheap items are cut first under a tight
  budget. The expected cost is a planning figure, not cash; spend is cash.
- The position counts open purchase requests, as the assistant's other order tools do. The export, and so the
  research instances, do not: on the 11/05 showcase, LOCAL-DEMO-PR-001 (50 LDM-001, submitted) covers the order the
  prototype's q* places.
