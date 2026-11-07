# Assistant v2 evaluation on public demand data

The measure for tuning the assistant (owner direction 2026-11-06: no model
training; the assistant gets smarter by changing its prompt and tools and
checking every change against the same questions). It asks a live assistant
v2, on a workspace seeded from public demand data, questions whose answers are
worked out independently, and scores what it says.

## The data

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

## The cases (`cases.mjs`)

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

## Running it

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

| Date | Code | Passed | Notes |
|---|---|---|---|
| 2026-11-06 | main ff16f34d + this PR | 10/13, then 12/13 | First run: the decision answers matched the research optima, but two were flagged for a quantity the solver gave in its plan text and a budget remainder; both fixed here. Left: the answer to "which items are below their reorder point" counts table rows itself ("6 FOODS_3 items", "10 of the 12"). |
