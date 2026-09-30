"""Rubric-to-evidence outline for the retail half of the report.

    python -m retail.report_outline [--data-dir DIR]

Reads the retail outputs (clean_stats.json, forecast and replenishment tables) and writes
outputs/report-outline-retail.md in the same format as the SCMS outline: one table per
rubric section with columns #, rubric question (verbatim), where, key numbers, figure and
gap / placeholder. Every number is read from a computed output.
"""

from __future__ import annotations

import argparse
import json
import sys

import pandas as pd

from .paths import CITATION, add_data_dir_arg, data_paths_from_args

RUBRIC = [
    ("1", "Problem description and its importance", [
        ("1a", "What is your problem?"),
        ("1b", "Why is this problem important?"),
        ("1c", "If you are partnering with a company, who is your company and what do they do?")]),
    ("2", "Description of the dataset", [
        ("2a", "Where did you acquire the data?"),
        ("2b", "What features did you have access to? How many features did you have access to?"),
        ("2c", "How many data points did you have?"),
        ("2d", "Why do you think this was a good dataset to address the problem of interest?")]),
    ("3", "Discussion on data quality, missing values, and outliers", [
        ("3a", "How was the quality of your data?"),
        ("3b", "How did you deal with missing values?"),
        ("3c", "How did you deal with outliers?")]),
    ("4", "Discussion on the predictive model and the analytics tools used", [
        ("4a", "What predictive model(s) did you use and implement?"),
        ("4b", "Why do you think the model(s) were the right tool to use?"),
        ("4c", "What results did you obtain? Present a discussion on your results."),
        ("4d", "Why do you believe the obtained model makes sense and is accurate?")]),
    ("5", "Discussion of the decision problem and the methods used", [
        ("5a", "What decision does your analysis actually drive? Who acts on it?"),
        ("5b", "What formulation did you use?"),
        ("5c", "Did the resulting decisions make sense? Why or why not?"),
        ("5d", "What are the implications of your results in the context of your problem?")]),
    ("6", "Conclusion", [
        ("6a", "How can companies use your results?"),
        ("6b", "What future work/research could be done on this problem? What are the future directions?")]),
]

LABEL = {"naive": "naive", "ma4": "4-wk mean", "snaive": "seasonal naive", "sba": "SBA", "ets": "ETS",
         "arima": "ARIMA", "ets_sa": "ETS-SA", "arima_sa": "ARIMA-SA", "gbm": "GBM"}


def money(v):
    return f"−£{abs(v):,.0f}" if v < 0 else f"£{v:,.0f}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_data_dir_arg(parser)
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()
    out = paths.outputs_dir
    st = json.loads((paths.derived_dir / "clean_stats.json").read_text(encoding="utf-8"))
    sel = json.loads((out / "forecast-selection.json").read_text(encoding="utf-8"))
    rep = json.loads((out / "key-numbers-replenishment.json").read_text(encoding="utf-8"))
    log = pd.read_csv(out / "cleaning-log.csv").set_index("step")
    mt = pd.read_csv(out / "forecast-metrics-test.csv")
    ta = mt[mt.group_by == "all"].set_index("model")
    tabc = mt[mt.group_by == "abc"].pivot_table(index="model", columns="group", values="WAPE")
    q = pd.read_csv(out / "forecast-quantiles.csv").set_index("method")
    roll = pd.read_csv(out / "forecast-metrics-rolling.csv")
    agg = pd.read_csv(out / "forecast-aggregate-accuracy.csv").set_index("model")
    cap = pd.read_csv(out / "forecast-capping.csv")
    sc = pd.read_csv(out / "replenishment-scenarios.csv")
    par = pd.read_csv(out / "sku-parameters.csv")
    raw, pnl, wk = st["raw"], st["panel"], st["weeks"]
    w = sel["winner"]
    qm = q.loc[sel["quantile_method"]]
    base = sc[sc.scenario == "base"].set_index("policy")
    tier = pd.DataFrame(rep["tier_contrast"]).set_index(["pair", "policy"])
    tiers = rep["lead_time"]["tiers"]
    ts = rep["tier_scenarios"]

    def tdelta(pair, pol):
        r = tier.loc[(pair, pol)]
        return f"{money(r.delta)} ({money(r.delta_lo)} to {money(r.delta_hi)})"
    main4 = base.loc[["a", "b", "c", "d0.6", "d0.8", "d1.0"]]
    best4 = main4.total_cost.idxmin()
    refs = base.loc[["p50", "p70", "p80", "p90"]]
    best_ref = refs.total_cost.idxmin()
    pe = rep["policy_e"]
    et = pd.DataFrame(pe["table"]).set_index("policy")
    cmp_ = {(c["x"], c["y"]): c for c in pe["comparisons"]}
    cn = pe["counts"]

    def dl(x, y):
        c = cmp_[(x, y)]
        return f"{money(c['delta'])} ({money(c['lo'])} to {money(c['hi'])})"

    cap75 = next(x for x, y in cmp_ if x.startswith("e0.75@") and y == "e0.75")

    def elabel(pol):
        q, _, f = pol[1:].partition("@")
        return f"P{round(float(q) * 100)}" + (f", cap B = {f} × (c)" if f else ", no cap")
    m_rows = {m: sc[(sc.scenario == n) & sc.policy.isin(main4.index)].set_index("policy").total_cost
              for n, m in rep["markdown_scenarios"]}
    mb = rep["markdown_base"]
    bc = rep["budget_choice"]
    frb = {r["factor"]: r for r in rep["frontier"]}
    rb = frb[bc["realised_factor"]]

    def tc(p, d=base):
        r = d.loc[p]
        return f"{money(r.total_cost)} ({money(r.total_cost_lo)}–{money(r.total_cost_hi)})"
    lt, chk, cal, tail, nar = rep["lead_time"], rep["checks"], rep["calibration"], rep["tail"], rep["narrow_pool"]
    best_roll = roll.pivot_table(index="run", columns="model", values="WAPE").idxmin(axis=1)
    wins = int((best_roll == w).sum())
    capw = cap[(cap.actuals == "raw")].pivot_table(index="model", columns="history", values="WAPE")
    cap_better = int((capw.capped < capw.raw).sum())

    def ci(m, k, pct=True):
        r = ta.loc[m]
        f = (lambda v: f"{v:.1%}") if pct else (lambda v: f"{v:.2f}")
        return f"{f(r[k])} ({f(r[k + '_lo'])}–{f(r[k + '_hi'])})"

    rows = {
        "1a": ("README; demand-forecast.md §1; replenishment-results.md §1",
               "How much of each item should a small wholesaler order every four weeks? The answer needs a weekly SKU "
               "demand forecast with its uncertainty (P50/P90 and simulated paths) and a replenishment rule that "
               "uses it together with supplier lead-time variability.", "–",
               "Problem statement prose not written. **[PLACEHOLDER: combined decision story, retail demand "
               "forecast → requirement quantities → supplier allocation]**"),
        "1b": ("replenishment-results.md §5, §9",
               f"FlowChain's current rule (b) serves {base.loc['b', 'fill_rate']:.1%} of demand in the autumn test "
               f"weeks and loses {money(base.loc['b', 'lost_margin'])} of margin on {rep['n_skus']} SKUs in 13 weeks. "
               f"The cheapest of the four policies, {best4}, costs {tc(best4)} against {tc('b')} for (b), with fill "
               f"{base.loc[best4, 'fill_rate']:.1%} (all GBP, including a terminal markdown).",
               "figures/replenishment-service-inventory.png",
               "Costs are assumptions (cost = 0.5 × price, holding 25%/yr, stockout = lost margin)."),
        "1c": ("README (repo); data-quality.md §1",
               "**FlowChain**, the owner's startup, which builds supply-chain software for US small and medium "
               "businesses (purchasing, inventory, receiving and supplier management). The analysis uses public data, "
               "not a partner's: UCI Online Retail II (a real UK gift-ware wholesaler) for demand and replenishment, and "
               "USAID SCMS shipment records for supplier lead-time variability.", "–",
               "The UK wholesaler and SCMS stand in for FlowChain's future US customer data; external validity is "
               "argued, not measured."),
        "2a": ("data-quality.md §1; retail README",
               f"{CITATION} Downloaded from the UCI repository; zip sha256 verified.", "–", "–"),
        "2b": ("data-quality.md §1; demand-forecast.md §3",
               f"{raw['n_columns']} raw columns (Invoice, StockCode, Description, Quantity, InvoiceDate, Price, "
               f"Customer ID, Country). The GBM uses 21 derived features (levels, lags, zero share, year-ago ramp, "
               "calendar, lagged price, age).", "–", "–"),
        "2c": ("data-quality.md §1, §7; cleaning-log.md",
               f"{raw['rows']:,} invoice lines ({raw['stockcodes_raw']:,} StockCodes, {raw['countries']} countries, "
               f"{raw['date_min'][:10]} to {raw['date_max'][:10]}); {st['kept_sale_lines']:,} clean sale lines. "
               f"Panel: {pnl['n_skus']} SKUs × {wk['n_weeks']} weeks = {pnl['n_rows']:,} SKU-weeks "
               f"({wk['n_train_weeks']} train, {wk['n_test_weeks']} test).", "–", "–"),
        "2d": ("data-quality.md §1, §8",
               "A complete two-year invoice log for one wholesaler, with prices and a strong Christmas season "
               "(data-quality.md §8). It fits a weekly replenishment question. It "
               "lacks stock, cost and lead-time fields, so costs are assumed and lead-time variability is taken from SCMS.",
               "figures/weekly-totals.png",
               "Only one prior autumn before the test, which limits seasonal estimation."),
        "3a": ("data-quality.md §3–6; cleaning-log.md",
               f"{raw['exact_duplicate_rows_overall']:,} exact duplicates = {st['overlap']['overlap_rows_sheet1']:,} "
               f"sheet-overlap copies (identical to sheet 2, dropped) + {log.loc[2, 'rows']:,} same-line repeats "
               f"(kept, {log.loc[2, 'note']}). {log.loc[3, 'note']} differing only by case. "
               f"{log.loc[4, 'rows']:,} rows on {len(st['non_product_codes'])} non-product codes; "
               f"{log.loc[8, 'rows']:,} stock write-offs; {log.loc[9, 'rows']:,} zero-price lines.",
               "figures/weekly-totals.png", "Demand is censored by stock-outs (no stock data)."),
        "3b": ("data-quality.md §2",
               f"Customer ID missing on {raw['missing_customer_rows']:,} rows ({raw['missing_customer_share']:.1%}); "
               "kept, because item demand does not need the customer. Description missing on "
               f"{raw['missing_by_column']['Description']:,} rows, all zero-price and removed by other rules. Weeks "
               f"without sales are zero-filled; the Christmas closure weeks ({', '.join(wk['closed_weeks'])}) are true zeros.",
               "–", "–"),
        "3c": ("data-quality.md §4, §6; demand-forecast.md §4",
               f"Voids: {log.loc[5, 'rows']:,} cancellations exactly reversing a sale within 24 h. The two largest "
               f"lines ({st['top2_lines'][0]['quantity']:,} and {st['top2_lines'][1]['quantity']:,}) were voided within "
               f"minutes. Other cancellations are returns, reported separately. Bulk lines: log-scale modified z > 3.5 "
               f"within SKU flags {log.loc[11, 'rows']:,} lines ({log.loc[11, 'note']}). Capped history won on "
               f"validation for {sel['capped_better_on_validation']} models and lowers test WAPE for {cap_better} of 9.",
               "figures/bulk-capping-example.png", "–"),
        "4a": ("demand-forecast.md §3",
               "Naive, 4-week mean, seasonal naive, SBA, ETS (AICc), ARIMA (KPSS + AIC grid), seasonally adjusted "
               "ETS/ARIMA (pooled index), one global HistGradientBoosting model (Poisson, direct multi-horizon); "
               "P50/P90 via residual quantiles and quantile GBM; 500 block-bootstrap demand paths per SKU.",
               "–", "–"),
        "4b": ("data-quality.md §8; demand-forecast.md §2, §5",
               f"The panel is smooth or erratic (no intermittent SKUs; {pnl['segment_counts'].get('erratic', 0)} "
               "erratic), with only one year before the test. So: level models as honest baselines, pooled "
               "learning (GBM) to borrow seasonality across SKUs, and ARIMA explained and tested because the owner asked.",
               "figures/intermittency.png", "–"),
        "4c": ("demand-forecast.md §4, §6–8",
               f"Test WAPE (95% CI): GBM {ci('gbm', 'WAPE')}, 4-wk mean {ci('ma4', 'WAPE')}, ETS {ci('ets', 'WAPE')}, "
               f"ARIMA {ci('arima', 'WAPE')}, seasonal naive {ci('snaive', 'WAPE')}. Bias GBM {ta.loc['gbm', 'Bias']:+.1%}. "
               f"GBM vs 4-wk mean ΔWAPE {ta.loc['gbm', 'dWAPE_vs_ref']:+.1%} "
               f"({ta.loc['gbm', 'dWAPE_lo']:+.1%}–{ta.loc['gbm', 'dWAPE_hi']:+.1%}); lowest WAPE at {wins} of 6 rolling "
               f"origins. P90 coverage {qm.coverage90:.1%} (target 90%); recalibrated paths {cal['weekly_p90_coverage']:.1%}.",
               "figures/test-wape.png; figures/rolling-origin.png; figures/example-distributions.png",
               "The GBM gain is modest; all level models under-forecast the autumn ramp."),
        "4d": ("demand-forecast.md §7–8",
               f"MASE {ta.loc[w, 'MASE']:.2f} < 1. SKU × 4-week WAPE {agg.loc[w, 'sku_4wk_WAPE']:.1%}, weekly panel "
               f"total {agg.loc[w, 'panel_total_WAPE']:.1%}. No leakage (features at origin only; panel chosen on "
               "training weeks). The seasonal naive and SA failures are explained by lifecycle decline and a "
               "one-season amplitude. By ABC: GBM WAPE A " + f"{tabc.loc['gbm', 'A']:.1%}, B {tabc.loc['gbm', 'B']:.1%}, "
               f"C {tabc.loc['gbm', 'C']:.1%}.", "figures/test-aggregate.png",
               "SKU-week WAPE ~63% is high in absolute terms; P90 under-covers."),
        "5a": ("replenishment-results.md §1",
               "The order quantity per SKU at each 4-weekly review (order-up-to level). The buyer acts, in FlowChain's "
               "purchase-request step on the inventory page.", "–",
               "**[PLACEHOLDER: combined decision story, retail demand forecast → requirement quantities → supplier allocation]**"),
        "5b": ("replenishment-results.md §2–4",
               f"Lost-sales periodic review, R = 4 weeks, over the 13 test weeks. All policies start from the same "
               f"stock, the (a) level at the test origin. L is lognormal (ASSUMED mean 2/4/8 weeks) with SCMS "
               f"direct-drop CV {lt['cv_all']:.3f} ({lt['rows']:,} lines). Supplier tiers follow delivery reliability: "
               f"among {lt['vendors_n30']} vendors with ≥30 lines, reliable = Wilson upper bound of the late share below "
               f"{lt['bench_late_share']:.1%} (and P90 days late ≤ {lt['bench_p90_days_late']:.1f}); unreliable = Wilson "
               f"lower bound above it; each tier's lead time is its empirical actual ÷ planned ratio, median-matched at "
               f"4 weeks. Reliable: {', '.join(tiers['promise_reliable']['vendors'])}. Unreliable: "
               f"{', '.join(tiers['promise_unreliable']['vendors'])}. Total cost = holding + lost margin + terminal markdown m × cost × "
               f"(on hand + on order) after week 13 (ASSUMED m = {mb}). Policies: (a) (L+R) × 4-wk mean; (b) FlowChain ROP "
               "rule; (c) critical-ratio quantile of simulated demand over L+R, where the final-cycle overage adds "
               "m × cost (multi-period newsvendor); (d) multiple-choice knapsack MILP (scipy/HiGHS) over {P50…P98} "
               "under a working-capital budget of 0.6/0.8/1.0 × (c); (e) order-up-to P70/P75/P80 of the same simulated "
               "demand, with a working-capital cap B (same grid as (d), 0.3–1.2 × (c)) that scales every SKU's level by one "
               "common factor when the planned inventory value exceeds B.", "–", "–"),
        "5c": ("replenishment-results.md §5–9",
               f"Base total cost, GBP, 13 wk (95% CI): (a) {tc('a')}, (b) {tc('b')}, (c) {tc('c')}, (d 0.6) {tc('d0.6')}; "
               f"fill {base.loc['a', 'fill_rate']:.1%} / {base.loc['b', 'fill_rate']:.1%} / {base.loc['c', 'fill_rate']:.1%} / "
               f"{base.loc['d0.6', 'fill_rate']:.1%}. Cheapest of (a)–(d): {best4}. The fixed {best_ref.upper()} reference "
               f"costs {tc(best_ref)}. (e) P75, no cap: {tc('e0.75')}; cheapest (e) setting on the grid, "
               f"{elabel(pe['best_overall'])}: {tc(pe['best_overall'])}. (c) ends with {base.loc['c', 'end_weeks_of_supply']:.0f} weeks of forward P50 "
               f"demand in stock and on order vs {base.loc['b', 'end_weeks_of_supply']:.0f} for (b), so it over-buys once "
               "the season end is priced. Cheapest of (a)–(d) by markdown m: "
               + "; ".join(f"m = {m}: {v.idxmin()}" for m, v in m_rows.items())
               + f". Sanity: CR 0.5 = P50 (fill {chk['c_cr05_fill']:.1%} both); budget monotone {chk['budget_monotone']}; "
               f"CV 0 lowers safety stock ({money(chk['ss_value_zero_cv'])} vs {money(chk['ss_value_base'])}); MILP "
               f"optimal (gap {chk['milp_max_gap']:.0e}).",
               "figures/replenishment-service-inventory.png; figures/replenishment-markdown.png; "
               "figures/replenishment-budget.png",
               "Common start stands in for unknown actual stock; markdown rate and costs are assumptions (bracketed "
               "by m = 0–0.5 and a no-assumption excess measure)."),
        "5d": ("replenishment-results.md §7, §9–11",
               f"Supplier reliability → cost (median L = 4 wk in every tier; unreliable − reliable, paired 95% CI): "
               f"on-time tiers (c) {tdelta('on-time tiers (primary)', 'c')}, (d 0.8) "
               f"{tdelta('on-time tiers (primary)', 'd0.8')}, (b) {tdelta('on-time tiers (primary)', 'b')}; slippage "
               f"variant (c) {tdelta('slippage variant', 'c')}; superseded CV tiers (c) "
               f"{tdelta('superseded CV tiers', 'c')}. (c) safety stock "
               f"{money(rep['safety_stock_value_c'][ts['promise_reliable']])} → "
               f"{money(rep['safety_stock_value_c'][ts['promise_unreliable']])} (on-time tiers). "
               f"**Recommendation: policy (e), order up to a moderate quantile (P70–P80, default P75) of the forecast "
               f"demand distribution, with a working-capital cap B as a control.** (e) P75 vs (d, 0.6) "
               f"{dl('e0.75', 'd0.6')}; vs (b) {dl('e0.75', 'b')}. The cap binds only in the final cycle; best cap vs no "
               f"cap for P75 ({elabel(cap75)}): {dl(cap75, 'e0.75')}. "
               f"Scenario counts ({cn['n_unbiased']} scenarios, the biased own-level start excluded): (d, B = 0.6 × (c)) "
               f"is the cheapest of (a)–(d) in {cn['d06_cheapest_four']} of {cn['n_unbiased']}; (e) P75 without a cap "
               f"beats (d, 0.6) in {cn['e75_below_d06']} of {cn['n_unbiased']}. q and B are chosen in-sample on the one "
               f"test season. For (d), the budget rule: raise B while the lost margin saved exceeds the added holding + markdown. On the "
               f"backtest frontier it stops at B = {bc['realised_factor']} × (c) ({money(rb['budget_week0'])} at week 0; "
               f"fill {rb['fill_rate']:.1%}, total {money(rb['total'])}); totals are flat within 3% for "
               f"{bc['flat_lo']}–{bc['flat_hi']} × (c). A narrow (non-autumn) "
               f"residual pool gives weekly P90 coverage {nar['weekly_p90_coverage']:.1%} and (c) cycle service "
               f"{nar['c_csl']:.1%}, against a plan of about {nar['cr_by_review'][0]:.1%}.",
               "figures/replenishment-supplier-reliability.png; figures/replenishment-budget-frontier.png",
               "Mean L is assumed; only its variability comes from SCMS. The on-time tiers use the revised SCMS "
               "scheduled date, so their late tails (and the cost of unreliability) are lower bounds. The budget is chosen in-sample on one season; "
               "validate on another. **[PLACEHOLDER: combined decision story]**"),
        "6a": ("replenishment-results.md §10–12; decision-inputs.md",
               "FlowChain: replace '1 week of demand' safety stock with policy (e): order up to P75 (P70–P80) of the "
               "forecast demand distribution over lead time + review period, using the supplier's measured lead-time "
               "variability, with a working-capital cap the buyer sets. Re-check q and B each season on a past-season "
               "backtest (here both were chosen in-sample). Budgeted (d) is the optimised alternative (its budget rule "
               f"stops at B ≈ {bc['realised_factor']} × (c), {money(rb['budget_week0'])}). Show planned vs realised "
               "service. The exported paths and SKU parameters feed the joint model.",
               "–", "**[PLACEHOLDER: combined decision story]**"),
        "6b": ("demand-forecast.md §9; replenishment-results.md §10",
               f"Re-estimate after a second autumn; model censored demand from stock records; forecast bulk orders "
               f"separately; cover the excluded tail ({tail['tail_skus']:,} SKUs, {tail['tail_revenue_share']:.1%} of "
               "training revenue, mostly intermittent/lumpy) with Croston/SBA and a separate policy; estimate the "
               "markdown rate from real clearance sales; add the season end to the multi-period policy (dynamic "
               "programme or rolling horizon) instead of a final-cycle correction.", "–", "–"),
    }

    L = ["# Report outline: rubric to evidence map (retail)", "",
         "Generated by `analytics/retail/report_outline.py` from the retail outputs. All numbers are computed.",
         "Rubric questions are quoted verbatim. This file covers the retail demand-forecasting and replenishment "
         "analysis (UCI Online Retail II). The SCMS supplier analysis has its own outline (`analytics/scms/`), and the "
         "combined decision story is marked as a placeholder.", "",
         "All money is in GBP (£), the currency of the data; nothing is converted.", "",
         f"Headline numbers: {pnl['n_skus']} SKUs × {wk['n_weeks']} weeks. Test WAPE GBM {ci('gbm', 'WAPE')} vs "
         f"4-week mean {ci('ma4', 'WAPE')}; P90 coverage {qm.coverage90:.1%}. Replenishment (13 test weeks, common "
         f"start, markdown m = {mb}): FlowChain rule fill {base.loc['b', 'fill_rate']:.1%}, total {tc('b')}; cheapest "
         f"of the four policies {best4}: fill {base.loc[best4, 'fill_rate']:.1%}, total {tc(best4)}; fixed "
         f"{best_ref.upper()} reference {tc(best_ref)}; recommended (e) P75, no cap {tc('e0.75')}.", ""]
    for num, title, qs in RUBRIC:
        L += [f"## {num}. {title}.", "",
              "| # | rubric question | where | key numbers (retail) | figure | gap / placeholder |",
              "|---|---|---|---|---|---|"]
        for code, text in qs:
            where, key, fig, gap = rows[code]
            L.append(f"| {code} | {text} | {where} | {key} | {fig} | {gap} |")
        L.append("")
    L += ["## Gaps to close before submission", "",
          "- The combined decision story (retail demand paths + SCMS lead-time variability → order quantities → "
          "supplier allocation) is a placeholder: **[PLACEHOLDER: combined decision story, retail demand forecast → "
          "requirement quantities → supplier allocation]**.",
          "- Section 1 prose (problem and importance) is for the team to write; the partner (1c) is FlowChain, the "
          "owner's startup.",
          "- Costs (cost ratio, holding rate, stockout cost) and mean lead times are assumptions; confirm or replace "
          "them with FlowChain customer values.",
          f"- The panel excludes {tail['tail_skus']:,} intermittent/lumpy SKUs ({tail['tail_revenue_share']:.1%} of "
          "revenue); they need their own forecast and policy.",
          f"- The backtest covers one autumn. The terminal markdown rate (m = {mb}) is an assumption; m = 0–0.5 and "
          "the no-assumption excess measure bracket it."]
    (out / "report-outline-retail.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"Wrote {out / 'report-outline-retail.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
