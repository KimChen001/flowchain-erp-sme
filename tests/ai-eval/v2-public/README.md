# Assistant v2 evaluation on public demand data

The measure for tuning the assistant (owner direction 2026-11-06: no model
training; the assistant gets smarter by changing its prompt and tools and
checking every change against the same questions). It asks a live assistant
v2, on a workspace seeded from public demand data, questions whose answers are
worked out independently, and scores what it says.

Two suites:

- **uci** (the question set, run after every assistant change): 58 questions,
  37 in English and 21 in Chinese, on the UCI walkthrough workspace that the
  local walkthrough and the showcase use. See
  [The question set](#the-question-set-uci-walkthrough) below.
- **m5** (the first lane): 13 questions on the 12-item M5 research instance,
  including the order decisions checked against the research solver.

## The question set (UCI walkthrough)

The workspace is the one `npm run walkthrough:local` seeds
(docs/public-data-workspaces.md): 200 UCI products, a year of public sales,
and the assumed purchasing side with its scene. The scene has two late Acme
orders for 85123A (one partly received), a late Globex order, a cakestand
under its reorder point, and an order waiting for approval.

Expected figures come from the seed's own plan (`scripts/public-data/plan.mjs`,
rebuilt from the local extract and the seed day). The formulas are written
out in `uci-facts.mjs`, and nothing is read from the assistant's tools, so a
tool that computes wrongly fails its case. The cases are in `uci-cases.mjs`.

| Kind | What it asks |
|---|---|
| today | what to handle first, which orders are late (EN, ZH) |
| stock | on hand, available to promise, position with what is on order, below safety stock, thresholds, days of stock, average demand, an item's name |
| scenario | if neither late order arrives, only one of them, both; another week's delay at Acme or Globex |
| reorder | what to reorder this week (EN, ZH), "蛋糕架还要补货吗", why the hero is not listed |
| purchasing | the order waiting for approval, what is on order, Acme's items, the last receipt and its date |
| supplier | who supplies an item, Acme's tier, on-time rates over 90 days (the scorecard's rule), the supplier count, terms |
| sales | units and sales in the last two whole months, top customers and products, month on month |
| finance | receivables and the largest debtor, stock value and a year's holding cost |
| cost | EOQ at £20 an order; 240 against 120 at a time |
| conversation | a second turn that leans on the first, and the order form after the reorder list |
| boundary | "delete all the late orders" is declined; a chasing email names what is still due |

Sales questions name the two whole months before the seed day, so a case
asks the same thing whatever day it runs. "Late" and the 90-day on-time rate
count from the day the questions are asked (Europe/London).

Besides its figures, every answer is checked for: status 200 and no error,
the language asked in, no figure the answer check flagged, and tidy text (no
raw decimals such as 7.1556, no "10 月 1, 2026", no opening "Let me check…",
and no text part after a table that says the answer again).

One run varies: on DeepSeek V4.1 Flash, 11 cases passed in one run and failed
in the next, and 9 the other way. To judge a change, run it with
`--repeat=2` or more and `--compare=<the earlier report.json>`, which lists
the cases that passed less or more often than before.

Run it on a walkthrough server with a model (`--ai-env`), from a checkout
whose `node_modules` the walkthrough can use:

```
npm run walkthrough:local -- --ai-env=<provider env file>
npm run eval:assistant:uci -- --port=<the UCI API port> --walkthrough-dir=<the walkthrough data folder>
```

`--walkthrough-dir` reads the extract and the seed day from its `seeded.json`.
Without it, pass `--extract=<extract.json> --as-of=<seed day>`. Also:
`--only=<ids>`, `--kind=<kinds>`, `--repeat=<n>` (each case n times, for a
model that varies), `--list` (the cases and expected figures, nothing asked),
`--out=<folder>`, `--compare=<report.json>`. Cases take turns between kim@example.com and
daniel@example.com (`--emails=`), since each user may ask 30 questions in 10
minutes; a question the limit turns away is asked again after a minute.

## M5: the data

Real demand, assumed supply side, as in the research instances
(`.local/research/interactive-optimization`, local only, git-ignored):

- **M5** (Walmart daily unit sales, store CA_1, the last 90 days of the
  competition window): 6 FOODS_3 items (steady demand) and 6 HOUSEHOLD_1 items
  (intermittent demand), with their shelf prices.
- **UCI Online Retail II** (a UK online gift retailer, 2011): 6 items. The set
  is GBP, so it seeds a GBP workspace on its own (`PLAYWRIGHT_PUBLIC_DATA_SETS=uci`);
  the cases below use M5.

Labelled assumptions (`scripts/public-data-instance.mjs`, the research rules):
lead time 14 days, review period 7 days, MOQ a week of demand rounded up to a
multiple of 10, on hand the demand over the lead time, reorder point the demand
over lead time + review, safety stock a week of demand, the public price as the
purchase price, holding cost 25% a year, shortage 5 times holding. Licences:
the M5 Zenodo mirror and UCI Online Retail II are CC BY 4.0.

The workspace (`scripts/setup-public-data-scenario.mjs`) gets one supplier and
one customer per set, the items with their supplier terms, an opening stock
entry, and the 90 days of demand as customer orders shipped in full on their
day through the outbound posting commands, ending yesterday. Stock ends at the
assumed on hand.

## M5: the cases (`cases.mjs`)

| Kind | Cases | Expected answer from |
|---|---|---|
| Facts | average daily demand (EN, ZH), units shipped, days of stock, items below their reorder point | the instance |
| Cost | 400 vs 800 units (break-even cost per order), EOQ at $50 an order, what stock is worth and costs to hold (EN, ZH) | textbook formulas written out in `cases.mjs` |
| Decisions | the order at a $2,660 budget (FOODS_3), at $600 (HOUSEHOLD_1), and without a budget | the research SAA MILP optima (`outputs/public-instance-m5.json`, HiGHS, gap 0) |
| Conversation | the reorder list, then "ok, 400 of FOODS_3_090" | the form holds 400 |

Each answer is scored (`score.mjs`): every expected figure within its
tolerance, SKUs named, each optimal quantity next to its SKU, the form's line,
the reply in the question's language, status 200, and no figure the answer
check flagged.

## M5: running it

It calls the configured model: about $0.6 for the 13 cases on Sonnet 5.5.

1. Start a server on the public data with assistant v2 and a provider, for
   example:

   ```
   PLAYWRIGHT_API_PORT=18941 \
   PLAYWRIGHT_PUBLIC_DATA_DIR=<research>/data/public \
   PLAYWRIGHT_PUBLIC_DATA_SETS=m5_main,m5_intermittent \
   FLOWCHAIN_AI_ASSISTANT_MODE=assistant_v2 <provider settings> \
   node scripts/browser-product-recovery-api.mjs
   ```

2. Run the cases:

   ```
   npm run eval:assistant:public -- --port=18941 --data=<research>/data/public
   ```

   `--only=eoq,plan-budget-steady` runs some; `--out=<folder>` writes
   `report.md` and `report.json` there.

## Results so far

### uci

| Date | Code, model | Passed | Notes |
|---|---|---|---|
| 2026-11-09 | main 666b9335, DeepSeek V4.1 Flash | 45/58, then 42/58 | Baseline, two runs: $0.95 a run, median 10 s and 57k input tokens a case. Four cases failed both times. One answer in run 2 was lost to a network drop. Failures by cause are below. |
| 2026-11-11 | main a7065fbe + #300 + #301 + #305, Flash through OpenCode | 104/116 (`--repeat=2`) | Asked a day after the seed day, which moved the tools' 90-day window: 4 more answers (6.6 a day, EOQ 575) were right but scored against the seed day's 7.24 and 581, so the average now counts from the day asked. $1.75, median 14 s. Better than the baseline: 13 cases. Worse: 6. The 12 left: receivables split into not yet due and overdue (right, but the aging fields read as no amount, 4), an answer written before reading (264, then 168), "蛋糕架" not found (#290 not merged), a supplier question given up after one lookup, items not named on late orders, and 3 flags for "7 天", "top 10" and "90 天". |

What the baseline found (both runs):

- **Correct figures flagged by the answer check (6–7 cases a run).** These are figures the model works out itself and that no tool returned. Examples: the 360 still to receive on two orders, "the other 14 open orders", "48 short of its safety stock", the top five customers' £24,562 (31%), a position of 232 after a 100-unit order, and the ageing buckets "1–30, 31–60". A figure written as "available" is also flagged even when `calculate` worked it out (168).
- **Tool gaps.**
  - "Which product sold the most units" gets the top earner. `sales_summary` sorts by value, so the answer named 23084 instead of 16014.
  - The last receipt of an item can't be read, since receipts carry no item lines.
  - The supplier scorecard gives months and quarters, not the last 90 days. That worked in 1 of 2 runs for Acme and 1 of 2 for Globex.
  - Acme's written tier reason isn't readable.
  - "84879 在 10 月卖了多少件" once answered 0.
  - "蛋糕架" was not found once.
- **Reasoning slips.**
  - "No items are below their stock levels" (18 are).
  - "Cover you to Feb 2026 levels" (flagged).
  - "前 10 位合计不到两成" (the top five are 31%).
  - The reorder form's cover-days rule suggested 72 cakestands where the reorder list says 60.
- **Answers said twice.** A second text part after the table repeats the answer (4 in run 2), or adds a filler line ("Your answer is above").

### m5

| Date | Code | Passed | Notes |
|---|---|---|---|
| 2026-11-06 | main ff16f34d + this PR | 10/13, then 12/13 | First run: the decision answers matched the research optima, but two were flagged for a quantity the solver gave in its plan text and a budget remainder; both fixed here. Left: the answer to "which items are below their reorder point" counts table rows itself ("6 FOODS_3 items", "10 of the 12"). |
| 2026-11-07 | main 5e982cad + counts beside lists | 13/13 ($0.65) | The answer check now takes the counts a whole list holds (rows sharing a supplier or a flag) and a count written beside the records it lists; "The other 6 are HOUSEHOLD_1 items" passes. |
