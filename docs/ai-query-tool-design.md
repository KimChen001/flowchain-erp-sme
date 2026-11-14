# Assistant query tool: design (draft for review)

Status: draft, 2026-11-08. Nothing is built yet. Decisions Q1–Q13 at the end
are for the owner.

## 1. Why

Assistant v2 answers through about 40 fixed tools. Each one is a window on one
page or one calculation: `list_purchase_orders`, `reorder_list`,
`sales_summary`, `list_receivables`, and so on. The model can only ask what a
window shows, so every new kind of question finds a gap. The public-data
rehearsals on 2026-11-07 and 11-08 found these gaps:

| Question | What went wrong | Fixed by |
|---|---|---|
| "上个月销售额是多少？", "top customers this quarter" | No tool read completed sales, so the answer said FlowChain does not record sales. | A new tool, `sales_summary` (#279) |
| "Which customer owes us the most?" | The receivables list returned the first 100 of 542 open items. | A new view, `list_receivables` by_customer (#279) |
| "The details of the other 195" | The reorder list could not be paged. 50 rows were too large, so the answer sent the user to filter by supplier. | New parameters, `offset` and `due` (#290) |
| "The other 195 are due Nov 10 to 16" | A range read off the first 20 rows. | New counts and range fields (#290), plus a prompt rule |
| "What happens if Acme delays a week?" | Counts open sales orders only, so it reports no shortfall on data where everything has shipped. | Still open |

Each fix added a tool, a parameter or a prompt rule. The prompt is now a long
list of rules, and a small model follows a long list poorly. A user's next
question will find the next gap.

## 2. Goal and non-goals

Goal: one read-only tool with which the model composes its own question over
the workspace's records, within the user's permissions. It can filter, group,
total, sort and page. Answers stay grounded in what the tool returns, and the
narrow list tools can retire.

Non-goals:
- No writes. Changes still go through confirm cards and the user's click.
- No SQL written by the model.
- No replacement for the algorithms. The reorder list, the order plan solver,
  order quantity costs, the stock projection and the supplier risks stay tools
  of their own.
- Not a reporting UI.

## 2.1 Lessons from a reference design

A public write-up of a "trusted analytics" design (called Hermes there) solves
the same problem for e-commerce analysis. Its principle is that the model
handles understanding and the program holds the execution boundary. Five of
its ideas fit FlowChain, and this design adopts them:

| Idea | What it means here |
|---|---|
| The model hands over intent only, and SQL comes from a deterministic compiler | The spec (§3) names datasets, fields and defined metrics. The server checks it and compiles parameterised SQL. There is no back door where the model writes SQL when the compiler cannot. |
| A versioned semantic layer: metrics, dimensions and join rules | Datasets and metric formulas live in one manifest with a version (§4, §7). For example, net sales is invoiced minus credited, each totalled and then aligned by the grouping. An answer can say which version it used. |
| The model has no database rights | Queries run under a database role that can only read the analytics views (§5). |
| Every conclusion carries a reference to the fact behind it | Each result gets a snapshot id, and its values can be cited. The backend checks the citations, and the panel can show where a number came from (§6, phase 2). |
| Planning, execution and explanation are separate | The model plans (the spec), the server executes, and the model explains from the result. The grounding check stays between execution and the answer. |

Where FlowChain differs, on purpose:
- **No confirmation before each read.** Hermes shows the query and waits for a
  person's go-ahead before running it. FlowChain's reads are scoped, limited
  and cheap, and a chat that stops for every lookup would not be usable.
  Confirmation stays where it is today: before any write.
- **Results do go back to the model.** It has to write the answer from them.
  Text fields from records (item names, notes) are passed as data, inside the
  result, under the injection guard that already runs.
- **The debating agents come later.** Hermes uses an advocate, a sceptic and a
  judge over frozen evidence to explain "why" questions, and says the evidence
  supports an explanation, not a proof of cause. That fits FlowChain's "why did
  stock run low" questions. It is a phase after this one and is not designed
  here.

## 3. The tool

One tool, `query_records`. It takes a JSON spec that names datasets, fields
and defined metrics from the semantic manifest (§4, §7). The server checks the
spec against the manifest version in force and compiles parameterised SQL. A
spec the compiler cannot compile is refused, with the reason; the model never
writes a query string.

```jsonc
{
  "dataset": "sales_invoice_lines",
  "filters": [{ "field": "invoice_date", "op": "between", "value": ["2026-10-01", "2026-10-31"] }],
  "period": { "field": "invoice_date", "named": "last_month" },  // instead of a date filter
  "group_by": ["customer"],                                      // up to 3; dates by day | week | month | quarter
  "measures": [{ "fn": "sum", "field": "line_amount" }, { "fn": "count_distinct", "field": "invoice_number" }],
  "with_share": true,                                            // each group's share and running share, from the server
  "sort": [{ "by": "sum_line_amount", "dir": "desc" }],
  "limit": 5,                                                    // rows up to 50, groups up to 200
  "offset": 0
}
```

- Filter ops: eq, ne, in, gt, gte, lt, lte, between, contains (text), is_null.
- Measures: count, count_distinct, sum, avg, min, max, over numeric fields only.
- Without group_by, `select` names the row fields to return.

The result holds:
- `rows`, or groups with their measures;
- `total`, `shownFrom` / `shownTo` and `more`;
- totals over the whole match;
- refs for the records rows name, so links and grounding work as now;
- `described`: the query in words ("Sales invoice lines dated Oct 1–31, 2026,
  grouped by customer, largest 5 by line amount"). The answer can say what it
  read.

More examples:
- Late purchase order lines by supplier: dataset `purchase_order_lines`,
  filter `late eq true`, group by `supplier`, measures `count` and
  `sum remaining_quantity`.
- Items below safety stock with no open order: dataset `stock`, filters
  `below_safety_stock eq true` and `incoming eq 0`.
- The best-selling items last month, with quantities: dataset
  `sales_invoice_lines`, period `last_month`, group by `sku`, measures
  `sum quantity` and `sum line_amount`.

## 4. Datasets (the semantic layer)

A dataset is a pre-joined view with named, typed fields. Each field records:
- its type;
- its label in English and Chinese;
- whether it can be filtered and grouped;
- a permission tag (price, amount, partner) where it needs one.

Datasets and fields are defined once, in code, beside the read models the
pages use. That way a figure means the same thing in the chat and on the page.
The stock position, for instance, comes from the same allocation code as the
inventory page.

Phase 1, the three most asked:

| Dataset | One row per | Fields |
|---|---|---|
| `stock` | item | SKU, item name, unit, on hand, reserved, available, incoming, position, safety stock, reorder point, below safety stock (judged on available), at or below the reorder point (judged on position), average daily demand over 90 days, days of stock, preferred supplier |
| `purchase_order_lines` | open or closed purchase order line | order number, status, supplier, SKU, item, ordered, received and remaining quantity, unit, unit price¹, line amount¹, currency, order date, promised date, first promised date, days overdue, late |
| `sales_invoice_lines` | customer invoice line | invoice number, invoice date, status, customer, SKU, item, quantity, unit, unit price², line amount², currency |

¹ Only for roles that read prices. ² Only for roles that read amounts.

Phase 2:
- receiving lines;
- supplier invoice lines and matches;
- receivables;
- sales order lines and shipments;
- purchase requests;
- RFQ quotes;
- inventory movements.

No dataset holds email addresses or phone numbers, so the privacy check (no
"@" in any read-tool output) keeps holding.

## 5. Execution and safety

- **Compiled on the server.** The spec becomes a Prisma `groupBy`, `aggregate`
  or `findMany`, or a parameterised query over read-only views. It is never
  text from the model.
- **Database role.** Compiled queries run as a role that may only `SELECT`
  from the analytics views, not as the application's role. A bug in the
  compiler can then read too much at worst, never change anything. Each query
  runs in a read-only transaction with a statement timeout.
- **Scoping.** The tenant and the user's warehouses come from the session,
  never from the spec, the same way `reportReadAccessFor` scopes the pages.
- **Field permissions.**
  - A role is offered only the datasets and fields it may read.
  - The tool definition it receives lists only those fields.
  - A spec naming another field is refused, with the reason and the fields it
    may use.
  - Price and amount fields follow `procurement.prices.read` and
    `finance.amounts.read`, as `aiSkillVisibility` does now.
- **Limits.**
  - Rows: up to 50 a page.
  - Groups: up to 200.
  - Time: a 5-second limit per query.
  - Source rows: a cap on the rows scanned. Over the cap, the result is marked
    partial.
  - Size: results stay under the 24,000-character cap by dropping wide text
    fields before rows.
- **Audit.** The audit row records each query's dataset, fields and operators,
  never the values or the rows.

## 6. Grounding

Totals, groups and shares come from the server, so the numbers an answer
writes are in the result and the existing check reads them as it does now.
`with_share` gives each group's share and running share, so "the top five
together are 29.5%" is a figure the tool gave, not a sum the model worked out.
The `described` line lets the answer say what it read and what it left out.

Phase 2 adds fact references, as in the reference design:
- Each query result is kept as a snapshot. The snapshot holds the compiled
  query, its parameters, the manifest version and the rows, and it has an id.
- A value in it can be cited as snapshot, row and column.
- The answer cites the values it relies on.
- The backend checks that each citation exists and holds the written value.
- The panel shows a cited number's row and query on click.

This is stronger than today's check, which only asks whether a number appears
somewhere in the results. It also makes "where does this number come from?"
answerable in the UI.

## 7. Defined metrics

Business figures that need a definition are computed by the server and
returned with their definition, so the model does not improvise them.

Phase 1:
- days of stock;
- below safety stock;
- late;
- share and running share.

Phase 3:
- on-time delivery against the first promised date;
- in full;
- OTIF;
- spend;
- sales;
- inventory turns. Turns need sales at cost, which the public data does not
  have; it is shown as an assumption.

## 8. What happens to the current tools

They coexist at first. Each one retires after the evaluation (§10) shows
`query_records` answers its questions as well.

| Replaced in time | Kept |
|---|---|
| `list_purchase_orders`, `list_sales_orders`, `list_receipts`, `list_supplier_invoices`, `list_purchase_requests`, `list_rfqs`, `list_suppliers`, `spend_analysis`, `sales_summary`, `list_receivables` (items, by_customer), `stock_position` (in part), `price_history` (in part) | `reorder_list`, `suggest_purchase_lines`, `optimize_order_plan`, `order_quantity_costs`, `stock_projection`, `late_order_impact` (to be rewritten with recorded demand), `supplier_risks`, `supplier_performance` (until the metric exists), `attention_list`, `search_records` (fuzzy search), `search_documents` (knowledge), `calculate`, every UI tool |

## 9. Prompt

One short section covers it:
- what the datasets are;
- query first, then answer;
- say what you read.

The rules that the tool makes unnecessary go: counting rows, ranges, paging
and which figure each threshold is judged on. The rest of the prompt should
get shorter over time, not longer.

## 10. Evaluation

Before `query_records` becomes the default, and before any tool retires:
- **A test set.** About 40 conversations of 3 to 6 turns each, in English and
  Chinese, on the UCI and M5 workspaces. They include off-script follow-ups
  like "what is 195?" and "show me the rest".
- **Ground truth.** A direct database query computes each expected figure.
- **Measures.** Answer rate (no refusal), correct figures, flags, latency and
  cost.
- **Models.** Haiku 5.5, DeepSeek V4 Pro, and Sonnet 5.5 once Parley works
  again, on the same set.

## 11. Plan

| Phase | Work | Rough size |
|---|---|---|
| 1 | The tool, the three datasets, field permissions, limits, audit, tests (including the postgres privacy check), and 15 of the evaluation conversations | 3–4 days |
| 2 | The other datasets, the full evaluation, and retiring the replaced list tools | 3 days |
| 3 | The defined metrics, and rewriting `late_order_impact` on recorded demand | 2 days |

Start after the talk on 11/10. When is the owner's call, given the
applications due Dec 1.

## 12. Risks

- **The model writes a wrong spec.** The schema in the tool definition lists
  the real fields with enums. Errors name the valid fields. The evaluation
  measures how often this happens.
- **Performance.** The public data is small: 24,000 invoice lines. Larger
  tenants need database-side aggregation (`groupBy`), not grouping in
  JavaScript, plus the scan cap.
- **Leaks.**
  - Scoping and field permissions are enforced on the server.
  - Tests cover each role.
  - The postgres privacy test runs every dataset.
- **A figure means one thing on the page and another in the chat.** Datasets
  reuse the pages' read models instead of their own queries.

## 13. Decisions for the owner

| # | Question | Recommended |
|---|---|---|
| Q1 | A JSON spec compiled on the server, or read-only SQL over views written by the model? | JSON spec: safer, easier to check, enough for the questions seen |
| Q2 | Which datasets in phase 1? | `stock`, `purchase_order_lines`, `sales_invoice_lines` |
| Q3 | Replace the list tools at once, or coexist and retire them after the evaluation? | Coexist, then retire |
| Q4 | Limits | 50 rows a page, 200 groups, 5 seconds, a scan cap |
| Q5 | Shares and running shares from the server (`with_share`)? | Yes |
| Q6 | Which models does the evaluation compare? | Haiku 5.5, DeepSeek V4 Pro, and Sonnet 5.5 when Parley works |
| Q7 | Build the evaluation set before the tool becomes the default? | Yes, 40 conversations |
| Q8 | Keep fuzzy search (`search_records`) and knowledge search separate? | Yes |
| Q9 | Run compiled queries as a database role that can only read the analytics views? | Yes, from phase 1 |
| Q10 | Keep each result as a snapshot, and cite and check values by snapshot, row and column (fact references)? | Yes, in phase 2 |
| Q11 | Ask the user to confirm each read before it runs, as the reference design does? | No: reads are scoped, limited and cheap; confirmation stays for writes |
| Q12 | Keep metric formulas in a versioned manifest, and name the version in the result? | Yes, a small manifest in phase 1 (sales, spend, days of stock, below safety stock) |
| Q13 | Debating agents (advocate, sceptic, judge) for "why" questions? | Later, after phase 3; not part of this design |
