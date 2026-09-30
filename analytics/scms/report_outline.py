"""Map each rubric question to the section, numbers and figure that answer it.

Reads the aggregate ``key-numbers-*.json`` files written by the other steps and
writes ``outputs/report-outline.md``. Every number comes from those files.

The rubric's own wording was not available to us. The question labels 1a–6b
below are our reading of the section structure in the brief (2 data, 3
quality, 4 model, 5 decision) and must be checked against the real rubric.

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

    rows = [
        ("1a", "What business problem is addressed, and for whom?", "README; decision-results.md §6",
         "FlowChain SME ERP: supplier scorecards, PO-time late risk, supplier allocation.", "–",
         "No written problem statement or stakeholder framing yet. Team to write it; the analytics only supports it."),
        ("1b", "What analytics questions follow, and why is analytics the right tool?", "data-quality.md §2.4",
         "Three questions: how do suppliers perform, can lateness be predicted at PO time, which supplier should get a requirement.", "–",
         "Motivation prose is thin; add FlowChain user evidence (interviews or usage) if the rubric asks."),
        ("2a", "Where does the data come from (source, licence)?", "data-quality.md §2.1; README",
         f"USAID SCMS dataset, CC BY-ND 4.0, {q['rows_total']:,} rows × {q['columns_raw']} columns, {q['countries']} countries.", "–", "–"),
        ("2b", "What are the features and what do they mean?", "data-quality.md §2.2",
         f"{q['columns_raw']} raw columns, with official portal descriptions quoted, plus derived fields.", "–", "–"),
        ("2c", "How many data points, and how many are usable per analysis?", "data-quality.md §2.3",
         f"direct drop {q['rows_direct_drop']:,}; scorecard {q['rows_scorecard']:,}; model {q['rows_model']:,} "
         f"(train {m['counts']['train']['rows']:,}/{m['counts']['train']['late']} late, val {m['counts']['validation']['rows']:,}/{m['counts']['validation']['late']}, "
         f"test {m['counts']['test']['rows']:,}/{m['counts']['test']['late']}); decision {d['requirements']:,} requirements.", "–", "–"),
        ("2d", "Why does the data fit the problem?", "data-quality.md §2.4",
         f"Real vendor names, promised vs actual dates, prices and freight at line level; {q['vendors_dd']} direct-drop vendors.", "–",
         "External validity to US SMEs is argued, not measured."),
        ("3a", "Missing values: how much, how handled, why?", "data-quality.md §3.1; cleaning-log.md",
         f"{q['missing_columns']} columns with blanks or sentinel text, each with its handling; {q['cleaning_rules']} logged rules.", "figures/missing-by-column.png", "–"),
        ("3b", "Outliers: detection and handling?", "data-quality.md §3.2; cleaning-log.md",
         "Robust z on log scale (flag, don't cap); impossible date sequences dropped; the IQR rule for late_days is degenerate and documented.", "–", "–"),
        ("3c", "Is the target trustworthy? (scheduled-date revision)", "data-quality.md §3.4",
         f"Exact match {pct(rev['exact_share'])}; {rev['heap']['ratio']:.0f}× the neighbouring days; shuffle null {pct(rev['perm']['null_mean'], 1)} vs {pct(rev['perm']['observed'])} observed; "
         f"by year {pct(rev['year_exact_min'])}–{pct(rev['year_exact_max'])}; dictionary: \"{q['dictionary_quote']}\".",
         "figures/late-days-heaping.png; figures/exact-share-by-year.png", "Which rows were revised cannot be determined."),
        ("3d", "Data limitations?", "data-quality.md §3.5",
         "No received quantity or rejections (no in-full or quality); right-censoring in 2015; publisher's caution on lead times and costs; health commodities.", "–", "–"),
        ("4a", "Target, prediction time and leakage audit?", "delay-model.md Problem, §1",
         f"is_late at PO time; every column audited; slip leak ROC AUC {leak_slip['ROC AUC']:.3f} vs {leak_clean['ROC AUC']:.3f} clean.", "–", "–"),
        ("4b", "Models chosen, with a baseline?", "delay-model.md §2",
         "Vendor-rate baseline → logistic regression → CART → gradient boosting; strict PO-time features primary.", "–", "–"),
        ("4c", "Evaluation: split, metrics, uncertainty?", "delay-model.md §3",
         "; ".join([model_line("baseline", base), model_line("logistic", lr), model_line("CART", tree), model_line("HGB", hgb)])
         + f". Rolling origin mean ROC AUC: logistic {roll['logistic ROC']:.3f} vs baseline {roll['baseline ROC']:.3f} (logistic wins {wins['logistic']} of {m['n_folds']}).",
         "figures/delay-model-curves.png; figures/delay-model-calibration.png", f"Only {m['counts']['test']['late']} test positives; wide CIs."),
        ("4d", "Interpretation: do the results make sense, and is complexity worth it?", "delay-model.md §4–5",
         f"Vendor and country dominate. The as-specified sensitivity does not beat the primary (logistic ROC AUC {sens['(1) logistic regression']['ROC AUC']:.3f} vs {lr['ROC AUC']:.3f}).", "–", "–"),
        ("5a", "Decision problem formulation?", "decision-proposal.md; decision-results.md §1–2",
         f"MILP over {d['requirements']:,} requirements and {d['pairs']:,} pairs; share cap, capacity proxy, λ·lateness.", "–", "–"),
        ("5b", "Parameters, and where they come from?", "decision-results.md §2",
         f"All from ≤2013 data; risk = {d['risk_model']}; estimated price for actual choice = {d['estimated_vs_observed_price_actual']:.2f}× observed.", "–",
         "Counterfactual prices are estimates, not quotes."),
        ("5c", "Results against baselines?", "decision-results.md §3",
         f"price+freight (USD M) actual {a['price + freight (USD M)']:.2f}, cheapest {b['price + freight (USD M)']:.2f}, incumbent {c['price + freight (USD M)']:.2f}, MILP {milp['price + freight (USD M)']:.2f}; "
         f"expected late days {a['expected late days']:.0f}/{b['expected late days']:.0f}/{c['expected late days']:.0f}/{milp['expected late days']:.0f}.", "–",
         "Realised lateness is only observable for the actual vendor."),
        ("5d", "Sensitivity analysis?", "decision-results.md §4–5",
         f"λ × share cap, capacity, days-late source, risk model; sanity checks (λ=0 equals cheapest: {'yes' if abs(d['sanity']['lam0_cost'] - d['sanity']['cheap_cost']) < 1 else 'no'}; monotone: {d['sanity']['monotone_late_days']}).",
         "figures/decision-frontier.png", "–"),
        ("6a", "Implications and recommendations?", "decision-results.md §6",
         f"Keep an immutable original promised date (on-time {pct(s['overall']['on_time_rate'])} is an upper bound). MILP saves {pct(d['saving_vs_actual'])} estimated cost at higher expected lateness.", "–",
         "No FlowChain product design or mock-up yet for the promised-date change."),
        ("6b", "Limitations and next steps?", "data-quality.md §3.5; delay-model.md §5; decision-results.md §3, §6", "Listed per section.", "–",
         "No consolidated limitations section and no validation against real RFQ quotes."),
    ]

    lines = [
        "# Report outline: rubric to evidence map",
        "",
        "Generated by `analytics/scms/report_outline.py` from the `key-numbers-*.json` files. All numbers are computed.",
        "",
        "**Caveat: the rubric's exact wording was not available to us.** The labels 1a–6b are our reading of the section",
        "structure (1 problem, 2 data, 3 data quality, 4 model, 5 decision, 6 implications). Check them against the real",
        "rubric before writing.",
        "",
        f"Headline numbers: scorecard on-time {pct(s['overall']['on_time_rate'])} (95% CI {pct(s['overall']['on_time_ci_low'])}–{pct(s['overall']['on_time_ci_high'])}), "
        f"grace {s['grace_days']} days. Top vendors: {top}. Bottom vendors: {bottom}.",
        "",
        "| # | question (our reading) | where | key numbers | figure | gap |",
        "|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(x).replace("|", "\\|") for x in row) + " |")
    lines += [
        "",
        "## Gaps to close before submission",
        "",
        "- Rubric wording: confirm the question list above.",
        "- Section 1 (problem and stakeholders) and the FlowChain product framing are not written. They are prose for the team.",
        "- The decision's counterfactual prices should be spot-checked against real quotes. Lateness for reallocated lines is model-based only.",
        f"- The late-risk model does not reliably beat the vendor baseline on ROC AUC in the pre-registered test ({m['counts']['test']['late']} positives).",
        "- In-full and quality cannot be measured from this dataset (no received quantity or rejections).",
        "- Branch history: the first commits of this branch contained a machine-specific path. Rewrite or squash before pushing.",
    ]
    write_text(paths.outputs_dir / "report-outline.md", "\n".join(lines) + "\n")
    print(f"Wrote {paths.outputs_dir / 'report-outline.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
