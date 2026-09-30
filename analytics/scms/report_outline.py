"""Map each rubric question to the section, numbers and figure that answer it.

Reads the aggregate ``key-numbers-*.json`` files written by the other steps and
writes ``outputs/report-outline.md``. Every number comes from those files.

The rubric questions (1a–6b) are quoted verbatim. The retail
demand-forecasting part, built on another branch, and the combined decision
story are marked as placeholders.

Usage (from ``analytics/``)::

    python -m scms.report_outline [--data-dir DIR]
"""

from __future__ import annotations

import json

from .paths import parse_args
from .report import pct, write_text


def load(paths, name):
    path = paths.outputs_dir / f"key-numbers-{name}.json"
    if not path.exists():
        raise SystemExit(f"{path} is missing. Run the {name} step first (python -m scms.run_all).")
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    _, paths = parse_args(__doc__.splitlines()[0])
    paths.ensure()
    q, s, m, d = (load(paths, n) for n in ("quality", "scorecard", "delay", "decision"))
    rev = q["revision"]
    prim = m["test"][m["primary_feature_set"]]
    sens = m["test"]["as specified"]
    base = prim["(0) vendor late-rate baseline"]
    lr = prim["(1) logistic regression"]
    tree = prim["(2) CART decision tree"]
    hgb = prim["(3) gradient boosting (HGB)"]
    comp = {row["policy"]: row for row in d["comparison"]}
    a, b, c, milp = (comp[k] for k in ("(a) actual choice", "(b) cheapest vendor", "(c) incumbent", "(d) MILP (defaults)"))
    leak_slip = next(v for k, v in m["leak"].items() if "slip" in k)
    leak_clean = next(v for k, v in m["leak"].items() if k.startswith("logistic") and "no leak" in k)
    roll = m["rolling_mean_roc"][m["primary_feature_set"]]
    wins = m["rolling_wins"][m["primary_feature_set"]]

    def model_line(name, r):
        return f"{name}: ROC AUC {r['ROC AUC']:.3f} ({r['ROC AUC 95% CI']}; Δ vs baseline {r['ΔROC vs baseline 95% CI']}), PR AUC {r['PR AUC']:.3f} ({r['PR AUC 95% CI']}; Δ {r['ΔPR vs baseline 95% CI']})"

    top = "; ".join(f"{v['vendor']} {pct(v['on_time'])} (n={v['n']}, exact {pct(v['exact'])})" for v in s["top"])
    bottom = "; ".join(f"{v['vendor']} {pct(v['on_time'])} (CI {pct(v['ci'][0])}–{pct(v['ci'][1])}, n={v['n']})" for v in s["bottom"])

    fu = {(r["risk model"], r["scenario"]): r for r in d["followup"]}
    risk_names = list(dict.fromkeys(r["risk model"] for r in d["followup"]))
    scen_default = "defaults (cap 60%, capacity ×1.2)"
    fu_def = fu[(risk_names[0], scen_default)]
    fu_def_alt = fu[(risk_names[1], scen_default)]
    n_dom = sum(1 for r in d["followup"] if r["_dominates"])
    n_fu = len(d["followup"])

    def lam_txt(r):
        v = r["_revealed"]
        return "none reaches actual" if v is None or v != v else f"{v * 100:.3g}%/day"

    RETAIL = "**[PLACEHOLDER: retail demand forecasting, UCI Online Retail II, `analytics/retail/`, built on another branch]**"
    COMBINED = "**[PLACEHOLDER: combined decision story, retail demand forecast → requirement quantities → supplier allocation]**"

    sections = [
        ("1. Problem description and its importance.", [
            ("1a", "What is your problem?", "README; decision-results.md §7",
             "For FlowChain's users: can a small or medium business trust its supplier on-time figures, predict late POs when they are sent, and decide which supplier gets each requirement?",
             "–", f"Problem statement prose not written. {COMBINED}"),
            ("1b", "Why is this problem important?", "data-quality.md §3.4; decision-results.md §6–7",
             f"Recorded on-time {pct(s['overall']['on_time_rate'])} is an upper bound ({pct(rev['exact_share'])} exact matches, {rev['heap']['ratio']:.0f}× the neighbouring days). "
             f"A plan with no more expected late days than the actual choice is {fu_def['saving vs actual']} cheaper on estimates.",
             "figures/late-days-heaping.png", "Needs SME-context evidence (cost of late supply); none in this dataset."),
            ("1c", "If you are partnering with a company, who is your company and what do they do?", "README (repo)",
             "FlowChain, the team's ERP for small and medium manufacturers and distributors. The SCMS data is public (USAID), not a partner's.",
             "–", "Confirm the partner framing with the owner."),
        ]),
        ("2. Description of the dataset.", [
            ("2a", "Where did you acquire the data?", "data-quality.md §2.1; README",
             f"USAID Development Data Library, SCMS Supply Chain Shipment Pricing Dataset (Internet Archive snapshot), CC BY-ND 4.0; sha256 verified.", "–", RETAIL),
            ("2b", "What features did you have access to? How many features did you have access to?", "data-quality.md §2.2",
             f"{q['columns_raw']} raw columns, with official portal descriptions quoted, plus derived fields (late_days, is_late, lead times, freight share).", "–", RETAIL),
            ("2c", "How many data points did you have?", "data-quality.md §2.3",
             f"{q['rows_total']:,} rows; direct drop {q['rows_direct_drop']:,}; scorecard {q['rows_scorecard']:,}; model {q['rows_model']:,} "
             f"(train {m['counts']['train']['rows']:,}/{m['counts']['train']['late']} late, validation {m['counts']['validation']['rows']:,}/{m['counts']['validation']['late']}, "
             f"test {m['counts']['test']['rows']:,}/{m['counts']['test']['late']}); decision {d['requirements']:,} requirements.", "–", RETAIL),
            ("2d", "Why do you think this was a good dataset to address the problem of interest?", "data-quality.md §2.4",
             f"Real vendor names, PO, scheduled and delivered dates, prices and freight at line level; {q['vendors_dd']} direct-drop vendors; {q['countries']} countries.", "–",
             f"External validity to US SMEs is argued, not measured. {RETAIL}"),
        ]),
        ("3. Discussion on data quality, missing values, and outliers.", [
            ("3a", "How was the quality of your data?", "data-quality.md §3.4–3.5",
             f"The scheduled date is the \"{q['dictionary_quote']}\" (data dictionary). Exact match {pct(rev['exact_share'])}; {rev['heap']['ratio']:.0f}× neighbours; "
             f"shuffle null {pct(rev['perm']['null_mean'], 1)} vs {pct(rev['perm']['observed'])}; by year {pct(rev['year_exact_min'])}–{pct(rev['year_exact_max'])}. No received quantity or rejections; 2015 censored.",
             "figures/late-days-heaping.png; figures/exact-share-by-year.png", f"Which rows were revised cannot be determined. {RETAIL}"),
            ("3b", "How did you deal with missing values?", "data-quality.md §3.1; cleaning-log.md",
             f"{q['missing_columns']} columns with blanks or sentinel text, each with its handling and rationale. Shipment-level references resolved and split by value.",
             "figures/missing-by-column.png", RETAIL),
            ("3c", "How did you deal with outliers?", "data-quality.md §3.2; cleaning-log.md",
             f"{q['cleaning_rules']} logged rules: robust z on the log scale (flag, don't cap); impossible date sequences dropped; the IQR rule for late_days is degenerate and documented.", "–", RETAIL),
        ]),
        ("4. Discussion on the predictive model and the analytics tools used.", [
            ("4a", "What predictive model(s) did you use and implement?", "delay-model.md §1–2",
             "Vendor-rate baseline, L2 logistic regression, depth-limited CART, histogram gradient boosting; strict PO-time features primary, after a leakage audit.", "–", RETAIL),
            ("4b", "Why do you think the model(s) were the right tool to use?", "delay-model.md §2, §5",
             "Binary PO-time risk with a rare positive class. The interpretable, calibratable models feed the allocation MILP; a baseline is always reported.", "–", RETAIL),
            ("4c", "What results did you obtain? Present a discussion on your results.", "delay-model.md §3, §5",
             "; ".join([model_line("baseline", base), model_line("logistic", lr), model_line("CART", tree), model_line("HGB", hgb)])
             + f". Rolling origin mean ROC AUC: logistic {roll['logistic ROC']:.3f} vs baseline {roll['baseline ROC']:.3f} (logistic wins {wins['logistic']} of {m['n_folds']}).",
             "figures/delay-model-curves.png; figures/delay-model-calibration.png", f"Only {m['counts']['test']['late']} test positives; wide CIs. {RETAIL}"),
            ("4d", "Why do you believe the obtained model makes sense and is accurate?", "delay-model.md §1, §4–6",
             f"Leakage demo (slip feature ROC AUC {leak_slip['ROC AUC']:.3f} vs {leak_clean['ROC AUC']:.3f} clean); effects match the scorecard; "
             f"as-specified sensitivity no better ({sens['(1) logistic regression']['ROC AUC']:.3f}); calibrated risk chosen by out-of-fold Brier ({m['risk_model']}).",
             "figures/delay-model-calibration.png", f"Not accurate enough to beat the baseline on ROC AUC; poor calibration-in-the-large. {RETAIL}"),
        ]),
        ("5. Discussion of the decision problem and the methods used.", [
            ("5a", "What decision does your analysis actually drive? Who acts on it?", "decision-proposal.md; decision-results.md §1",
             f"Which vendor gets each requirement ({d['requirements']:,} test-period lines). The buyer or category manager acts, in FlowChain's RFQ award step.", "–", COMBINED),
            ("5b", "What formulation did you use?", "decision-results.md §2",
             f"MILP (scipy milp / HiGHS): {d['pairs']:,} binary pairs; price + freight + λ·value·E[days late]; soft share cap per molecule and quarter; capacity proxy; ε-constraint variant.", "–", COMBINED),
            ("5c", "Did the resulting decisions make sense? Why or why not?", "decision-results.md §3–6",
             f"Defaults: price+freight (USD M) actual {a['price + freight (USD M)']:.2f}, cheapest {b['price + freight (USD M)']:.2f}, incumbent {c['price + freight (USD M)']:.2f}, MILP {milp['price + freight (USD M)']:.2f}; "
             f"expected late days {a['expected late days']:.0f}/{b['expected late days']:.0f}/{c['expected late days']:.0f}/{milp['expected late days']:.0f}. "
             f"Sanity: λ=0 equals cheapest ({'yes' if abs(d['sanity']['lam0_cost'] - d['sanity']['cheap_cost']) < 1 else 'no'}), monotone in λ ({d['sanity']['monotone_late_days']}), no vendor without history ({d['sanity']['no_history_pick']} picks). "
             f"Dominating plan found in {n_dom} of {n_fu} scenario × risk-model runs; defaults: {fu_def['cheapest plan with late days ≤ actual']}.",
             "figures/decision-frontier.png; figures/decision-frontiers-scenarios.png",
             "Counterfactual: realised lateness is observable only for the actual vendor; prices for other vendors are estimates, not quotes."),
            ("5d", "What are the implications of your results in the context of your problem?", "decision-results.md §6–7",
             f"Revealed λ to match SCMS reliability: {lam_txt(fu_def)} (alternative risk model {lam_txt(fu_def_alt)}), implausibly high, so unmodelled constraints likely drove the choices. "
             "Use the ε-constraint 'cheapest plan no later than today'. Keep an immutable original promised date.",
             "figures/decision-frontiers-scenarios.png", COMBINED),
        ]),
        ("6. Conclusion.", [
            ("6a", "How can companies use your results?", "decision-results.md §7; supplier-scorecard.md",
             "FlowChain: an immutable original promised date plus change history; on-time against the original promise; an exact-match data-quality warning; an ε-constraint award suggestion in RFQ.", "–", COMBINED),
            ("6b", "What future work/research could be done on this problem? What are the future directions?", "delay-model.md §5; decision-results.md §3, §7",
             "Validate counterfactual prices against real quotes; model eligibility constraints; add in-full and quality once receipts record quantities; retrain on FlowChain data measured against original promises.", "–", COMBINED),
        ]),
    ]

    lines = [
        "# Report outline: rubric to evidence map",
        "",
        "Generated by `analytics/scms/report_outline.py` from the `key-numbers-*.json` files. All numbers are computed.",
        "Rubric questions are quoted verbatim. This file covers the SCMS supplier analysis. The retail demand-forecasting",
        "part (`analytics/retail/`, another branch) and the combined decision story are marked as placeholders.",
        "",
        f"Headline numbers: scorecard on-time {pct(s['overall']['on_time_rate'])} (95% CI {pct(s['overall']['on_time_ci_low'])}–{pct(s['overall']['on_time_ci_high'])}), "
        f"grace {s['grace_days']} days. Top vendors: {top}. Bottom vendors: {bottom}.",
        "",
    ]
    for title, rows in sections:
        lines += [f"## {title}", "", "| # | rubric question | where | key numbers (SCMS) | figure | gap / placeholder |", "|---|---|---|---|---|---|"]
        for row in rows:
            lines.append("| " + " | ".join(str(x).replace("|", "\\|") for x in row) + " |")
        lines.append("")
    lines += [
        "## Gaps to close before submission",
        "",
        f"- Retail sections 2–4 and the combined decision story: {RETAIL}; {COMBINED}.",
        "- Section 1 prose (problem, importance, partner) is for the team to write.",
        "- The decision's counterfactual prices should be spot-checked against real quotes. Lateness for reallocated lines is model-based only.",
        f"- The late-risk model does not reliably beat the vendor baseline on ROC AUC in the pre-registered test ({m['counts']['test']['late']} positives).",
        "- In-full and quality cannot be measured from this dataset (no received quantity or rejections).",
    ]
    write_text(paths.outputs_dir / "report-outline.md", "\n".join(lines) + "\n")
    print(f"Wrote {paths.outputs_dir / 'report-outline.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
