"""Supplier allocation decision (rubric section 5), solved as a MILP.

Each test-period requirement (a direct-drop PO line sent in 2014–2015 whose
molecule/test type had at least two vendors up to 2013) is allocated to one
candidate vendor, minimising

    price + freight + lambda * line value * expected days late

subject to a vendor share cap per molecule and quarter and a vendor capacity
proxy. The model is solved with ``scipy.optimize.milp`` (HiGHS) and compared
with the actual choice, the cheapest vendor and the incumbent. All four policies
are scored with the same calibrated risk model.

Writes ``outputs/decision-results.md``, ``outputs/decision-sensitivity.csv``
(aggregates only), figures and ``outputs/key-numbers-decision.json``.

Usage (from ``analytics/``)::

    python -m scms.decision_results [--data-dir DIR]
"""

from __future__ import annotations

import math
import time
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import sparse
from scipy.optimize import Bounds, LinearConstraint, milp

from .dataset import TEST_FIRST_YEAR, VALIDATION_YEAR, load_clean, model_frame
from .delay_model import (
    PRIMARY_FS,
    build_features,
    days_late_given_late,
    fill_weight,
    run_feature_set,
    select_risk_model,
    CalibratedRisk,
)
from .paths import SEED, parse_args
from .quality_report import DICTIONARY_SOURCE, heaping_test, permutation_null
from .report import AQUA, BLUE, INK_2, ORANGE, VIOLET, md_table, pct, save_figure, style_axes, write_json, write_text

YELLOW = "#eda100"

# ---------------------------------------------------------------------------
# Parameters. Every one is an ASSUMPTION and is varied in the sensitivity runs.
LAMBDA_DEFAULT = 0.001  # lateness cost per day late, as a fraction of line value (0.1% per day)
LAMBDA_GRID = [0.0, 0.0005, 0.001, 0.0025, 0.005]
LAMBDA_EXTENDED = [0.01, 0.025, 0.05, 0.1]  # beyond the agreed grid, only to show the shift towards low-risk vendors
SHARE_CAP_DEFAULT = 0.6  # max share of a molecule's lines in a quarter going to one vendor
SHARE_CAP_GRID = [0.4, 0.6, 0.8, 1.0]
CAPACITY_MULT_DEFAULT = 1.2  # x the vendor's historical max quarterly line count
CAPACITY_MULT_GRID = [1.0, 1.2, 1.5, None]  # None = no capacity constraint
MIN_FREIGHT_CELL = 3  # lines needed before a freight cell is used
FREIGHT_INCLUDED_MAJORITY = 0.5  # cell with > 50% "freight included" lines gets 0 separate freight


def norm_text(series: pd.Series) -> pd.Series:
    return series.fillna("none").astype(str)


def price_tables(history: pd.DataFrame):
    """Reference unit price per (molecule, dosage, form) and each vendor's price index per molecule.

    Unit price = pack price / units per pack (exact, unlike the rounded `unit price`
    column). A vendor's index is the median ratio of its unit price to the
    reference for the same molecule/dosage/form, taken over its training lines of
    the molecule. That normalises across strengths and pack sizes.
    """
    h = history[(history["pack_price"] > 0) & (history["unit_of_measure_per_pack"] > 0)].copy()
    h["unit_cost"] = h["pack_price"] / h["unit_of_measure_per_pack"].astype(float)
    h["key"] = list(zip(h["molecule_test_type"], norm_text(h["dosage"]), h["dosage_form"]))
    ref = h.groupby("key")["unit_cost"].median()
    h["ratio"] = h["unit_cost"] / h["key"].map(ref)
    index = h.groupby(["molecule_test_type", "vendor"])["ratio"].median()
    return ref, index


def freight_lookup(history: pd.DataFrame):
    h = history.copy()
    h["mode"] = h["shipment_mode"].fillna("Not recorded")
    h["included"] = h["freight_included"].astype(bool)
    levels = [["vendor", "mode", "country"], ["vendor", "mode"], ["mode", "country"], ["mode"]]
    tables = []
    for keys in levels:
        g = h.groupby(keys)
        tables.append((keys, pd.DataFrame({
            "n": g.size(),
            "included_rate": g["included"].mean(),
            "median_share": g["freight_share_of_value"].median(),
            "n_numeric": g["freight_share_of_value"].count(),
        })))
    global_share = float(h["freight_share_of_value"].median())

    def lookup(vendor: str, mode: str, country: str) -> tuple[float, str]:
        values = {"vendor": vendor, "mode": mode, "country": country}
        for keys, table in tables:
            key = tuple(values[k] for k in keys) if len(keys) > 1 else values[keys[0]]
            if key in table.index:
                row = table.loc[key]
                if row["n"] < MIN_FREIGHT_CELL:
                    continue
                if row["included_rate"] > FREIGHT_INCLUDED_MAJORITY:
                    return 0.0, " × ".join(keys) + " (included in price)"
                if row["n_numeric"] >= 1:
                    return float(row["median_share"]), " × ".join(keys)
        return global_share, "global"

    return lookup


class Problem:
    """Requirements, candidate pairs and cost components."""

    def __init__(self, reqs: pd.DataFrame, pairs: pd.DataFrame, history: pd.DataFrame, others: pd.DataFrame):
        self.reqs, self.pairs, self.history, self.others = reqs, pairs, history, others

    def objective(self, lam: float) -> np.ndarray:
        p = self.pairs
        return (p["price_cost"] + p["freight_cost"] + lam * p["ref_value"] * p["exp_days"]).to_numpy()


def build_problem(data: pd.DataFrame, risk: CalibratedRisk, X: pd.DataFrame, days_source: str = "vendor") -> tuple[Problem, dict]:
    history = data[data["po_year"] <= VALIDATION_YEAR].copy()
    test = data[data["po_year"] >= TEST_FIRST_YEAR].copy()
    info = {"test_lines": len(test)}

    candidates = history.groupby("molecule_test_type")["vendor"].apply(lambda s: sorted(set(s)))
    test["candidates"] = test["molecule_test_type"].map(candidates)
    test["n_candidates"] = test["candidates"].map(lambda c: len(c) if isinstance(c, list) else 0)
    decision = test[test["n_candidates"] >= 2].copy()
    info["lines_multi_candidate"] = len(decision)

    ref, index = price_tables(history)
    decision["key"] = list(zip(decision["molecule_test_type"], norm_text(decision["dosage"]), decision["dosage_form"]))
    decision["ref_unit_cost"] = decision["key"].map(ref)
    decision["units"] = decision["line_item_quantity"].astype(float) * decision["unit_of_measure_per_pack"].astype(float)
    info["dropped_no_reference_price"] = int(decision["ref_unit_cost"].isna().sum())
    decision = decision[decision["ref_unit_cost"].notna() & (decision["units"] > 0)]
    actual_in = [v in c for v, c in zip(decision["vendor"], decision["candidates"])]
    info["dropped_actual_vendor_without_history"] = int((~np.array(actual_in)).sum())
    reqs = decision[np.array(actual_in)].copy()
    reqs["ref_value"] = reqs["units"] * reqs["ref_unit_cost"]
    reqs["quarter"] = reqs["po_sent_date"].dt.to_period("Q").astype(str)
    reqs["mode"] = reqs["shipment_mode"].fillna("Not recorded")
    reqs["r"] = np.arange(len(reqs))
    info["requirements"] = len(reqs)

    vendor_days, global_days, _ = days_late_given_late(history)
    freight = freight_lookup(history)
    rows = []
    for idx, r in reqs.iterrows():
        for v in r["candidates"]:
            price_index = index.get((r["molecule_test_type"], v), np.nan)
            share, freight_level = freight(v, r["mode"], r["country"])
            rows.append({"idx": idx, "r": r["r"], "vendor": v, "price_index": price_index, "freight_share": share, "freight_level": freight_level})
    pairs = pd.DataFrame(rows)
    pairs = pairs[pairs["price_index"].notna()].reset_index(drop=True)
    pairs = pairs.merge(reqs[["r", "units", "ref_unit_cost", "ref_value", "quarter", "molecule_test_type", "vendor"]].rename(columns={"vendor": "actual_vendor"}), on="r")
    pairs["price_cost"] = pairs["units"] * pairs["ref_unit_cost"] * pairs["price_index"]
    pairs["freight_cost"] = pairs["price_cost"] * pairs["freight_share"]

    # Same risk model for every (requirement, vendor) pair: swap the vendor, keep the rest of the line.
    Xp = X.loc[pairs["idx"]].copy().reset_index(drop=True)
    Xp["vendor"] = pairs["vendor"].to_numpy()
    pairs["p_late"] = risk.predict(Xp)
    if days_source == "vendor":
        pairs["days_if_late"] = pairs["vendor"].map(vendor_days).fillna(global_days)
    else:
        pairs["days_if_late"] = global_days
    pairs["exp_days"] = pairs["p_late"] * pairs["days_if_late"]
    pairs["is_actual"] = pairs["vendor"] == pairs["actual_vendor"]
    missing_actual = set(reqs["r"]) - set(pairs.loc[pairs["is_actual"], "r"])
    assert not missing_actual, "every requirement keeps its actual vendor as a candidate"

    # Capacity proxy: 1.2 x the vendor's max quarterly line count up to 2013,
    # minus the vendor's test-period lines outside the decision set in that quarter.
    hq = history.groupby(["vendor", history["po_sent_date"].dt.to_period("Q")]).size()
    info["capacity_base"] = hq.groupby("vendor").max().to_dict()
    other = test.drop(index=reqs.index, errors="ignore")
    other_q = other.groupby(["vendor", other["po_sent_date"].dt.to_period("Q").astype(str)]).size().to_dict()
    info["other_lines"] = other_q
    info["global_days"] = global_days
    return Problem(reqs, pairs, history, other), info


def solve(problem: Problem, lam: float, share_cap: float | None, capacity_mult: float | None, info: dict) -> tuple[np.ndarray, dict]:
    pairs = problem.pairs
    n = len(pairs)
    c = problem.objective(lam)
    rows_eq = sparse.csr_matrix((np.ones(n), (pairs["r"].to_numpy(), np.arange(n))), shape=(pairs["r"].max() + 1, n))
    constraints = [LinearConstraint(rows_eq, 1, 1)]
    ub_blocks, ub_rhs, slack_labels = [], [], []

    if share_cap is not None and share_cap < 1.0:
        group_size = problem.reqs.groupby(["molecule_test_type", "quarter"]).size()
        for (mol, q, v), sub in pairs.groupby(["molecule_test_type", "quarter", "vendor"]):
            limit = math.ceil(share_cap * group_size[(mol, q)])
            if len(sub) <= limit:
                continue
            ub_blocks.append(sub.index.to_numpy())
            ub_rhs.append(limit)
            slack_labels.append(("share", mol, q, v))
    if capacity_mult is not None:
        base = info["capacity_base"]
        for (v, q), sub in pairs.groupby(["vendor", "quarter"]):
            limit = max(math.floor(capacity_mult * base.get(v, 0)) - info["other_lines"].get((v, q), 0), 0)
            if len(sub) <= limit:
                continue
            ub_blocks.append(sub.index.to_numpy())
            ub_rhs.append(limit)
            slack_labels.append(("capacity", v, q))

    m = len(ub_blocks)
    penalty = 1e3 * float(np.max(np.abs(c)) + 1.0)  # soft constraints: violations only if unavoidable
    c_full = np.concatenate([c, np.full(m, penalty)])
    if m:
        rows = np.concatenate([np.full(len(b), i) for i, b in enumerate(ub_blocks)])
        cols = np.concatenate(ub_blocks)
        A = sparse.csr_matrix((np.ones(len(cols)), (rows, cols)), shape=(m, n))
        A = sparse.hstack([A, -sparse.identity(m)], format="csr")
        constraints = [LinearConstraint(sparse.hstack([rows_eq, sparse.csr_matrix((rows_eq.shape[0], m))], format="csr"), 1, 1),
                       LinearConstraint(A, -np.inf, np.array(ub_rhs, dtype=float))]
    integrality = np.concatenate([np.ones(n), np.zeros(m)])
    bounds = Bounds(np.zeros(n + m), np.concatenate([np.ones(n), np.full(m, np.inf)]))
    start = time.perf_counter()
    res = milp(c_full, constraints=constraints, integrality=integrality, bounds=bounds, options={"time_limit": 120, "mip_rel_gap": 1e-6})
    elapsed = time.perf_counter() - start
    if res.x is None:
        raise RuntimeError(f"MILP failed: {res.message}")
    x = np.round(res.x[:n]).astype(bool)
    slack = res.x[n:]
    status = {
        "status": res.message,
        "seconds": elapsed,
        "constraints_share": sum(1 for s in slack_labels if s[0] == "share"),
        "constraints_capacity": sum(1 for s in slack_labels if s[0] == "capacity"),
        "share_violation_lines": float(sum(v for s, v in zip(slack_labels, slack) if s[0] == "share")),
        "capacity_violation_lines": float(sum(v for s, v in zip(slack_labels, slack) if s[0] == "capacity")),
        "mip_gap": getattr(res, "mip_gap", np.nan),
    }
    return x, status


def violations(problem: Problem, x: np.ndarray, share_cap: float | None, capacity_mult: float | None, info: dict) -> tuple[int, int]:
    chosen = problem.pairs[x]
    share_v = cap_v = 0
    if share_cap is not None:
        group_size = problem.reqs.groupby(["molecule_test_type", "quarter"]).size()
        counts = chosen.groupby(["molecule_test_type", "quarter", "vendor"]).size()
        for (mol, q, v), k in counts.items():
            share_v += max(k - math.ceil(share_cap * group_size[(mol, q)]), 0)
    if capacity_mult is not None:
        counts = chosen.groupby(["vendor", "quarter"]).size()
        for (v, q), k in counts.items():
            limit = max(math.floor(capacity_mult * info["capacity_base"].get(v, 0)) - info["other_lines"].get((v, q), 0), 0)
            cap_v += max(k - limit, 0)
    return share_v, cap_v


def evaluate_policy(name: str, problem: Problem, x: np.ndarray, lam: float, share_cap, capacity_mult, info: dict) -> dict:
    chosen = problem.pairs[x]
    assert chosen["r"].is_unique and len(chosen) == len(problem.reqs), f"{name}: one vendor per requirement"
    reqs = problem.reqs.set_index("r")
    same = chosen[chosen["is_actual"]]
    realised = reqs.loc[same["r"], "is_late"].astype(bool)
    share_v, cap_v = violations(problem, x, share_cap, capacity_mult, info)
    return {
        "policy": name,
        "price (USD M)": chosen["price_cost"].sum() / 1e6,
        "freight (USD M)": chosen["freight_cost"].sum() / 1e6,
        "price + freight (USD M)": (chosen["price_cost"].sum() + chosen["freight_cost"].sum()) / 1e6,
        "expected late shipments": chosen["p_late"].sum(),
        "expected late days": chosen["exp_days"].sum(),
        "lateness cost at default λ (USD M)": (LAMBDA_DEFAULT * chosen["ref_value"] * chosen["exp_days"]).sum() / 1e6,
        "vendors used": chosen["vendor"].nunique(),
        "lines changed vs actual": int((~chosen["is_actual"]).sum()),
        "share-cap excess lines": share_v,
        "capacity excess lines": cap_v,
        "lines with realised outcome": len(same),
        "realised late rate on those": realised.mean() if len(same) else np.nan,
        "mean P(late) on those": same["p_late"].mean() if len(same) else np.nan,
    }


def baseline_choice(problem: Problem, rule: str) -> np.ndarray:
    pairs = problem.pairs
    if rule == "actual":
        return pairs["is_actual"].to_numpy()
    if rule == "cheapest":
        cost = pairs["price_cost"] + pairs["freight_cost"]
        pick = cost.groupby(pairs["r"]).idxmin()
    elif rule == "incumbent":
        counts = problem.history.groupby(["molecule_test_type", "vendor"]).size()
        score = pd.Series([counts.get((m, v), 0) for m, v in zip(pairs["molecule_test_type"], pairs["vendor"])], index=pairs.index)
        # Most training shipments of the molecule; ties go to the cheaper vendor.
        tmp = pd.DataFrame({"r": pairs["r"], "score": score, "cost": pairs["price_cost"] + pairs["freight_cost"]})
        pick = tmp.sort_values(["r", "score", "cost"], ascending=[True, False, True]).groupby("r").head(1).index
        pick = pd.Series(pick)
    else:
        raise ValueError(rule)
    x = np.zeros(len(pairs), dtype=bool)
    x[np.asarray(pick)] = True
    return x


def frontier_figure(sens: pd.DataFrame, baselines: pd.DataFrame, path) -> str:
    fig, ax = plt.subplots(figsize=(8, 4.6))
    colors = {0.4: VIOLET, 0.6: BLUE, 0.8: AQUA, 1.0: ORANGE}
    for cap, sub in sens[sens["capacity multiplier"] == str(CAPACITY_MULT_DEFAULT)].groupby("share cap"):
        sub = sub.sort_values("λ")
        ax.plot(sub["expected late days"], sub["price + freight (USD M)"], "o-", color=colors.get(cap, INK_2), linewidth=2, markersize=5,
                label=f"MILP, share cap {int(cap * 100)}%")
    markers = {"(a) actual choice": "s", "(b) cheapest vendor": "^", "(c) incumbent": "D"}
    for _, row in baselines.iterrows():
        if row["policy"] in markers:
            ax.plot(row["expected late days"], row["price + freight (USD M)"], markers[row["policy"]], color=INK_2, markersize=9, label=row["policy"])
    ax.set_xlabel("Expected late days (sum over requirements, same risk model)")
    ax.set_ylabel("Estimated price + freight (USD M)")
    ax.set_title("Cost vs expected lateness; λ rises from right to left along each line", loc="left", fontsize=11)
    ax.legend(frameon=False, fontsize=8)
    style_axes(ax)
    return save_figure(fig, path)


def main() -> int:
    _, paths = parse_args(__doc__.splitlines()[0])
    paths.ensure()
    warnings.filterwarnings("ignore", category=UserWarning)
    clean = load_clean(paths)
    data = model_frame(clean)
    y = data["is_late"].astype(int)
    split = data["split"]
    X = fill_weight(build_features(data), split.eq("train"))

    primary = run_feature_set(PRIMARY_FS, X, y, split, n_boot=50)
    risk, risk_table = select_risk_model(X, y, split, primary)
    problem, info = build_problem(data, risk, X)
    reqs, pairs = problem.reqs, problem.pairs

    # --- Four policies at the default parameters ---------------------------------
    x_milp, status = solve(problem, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info)
    policies = {
        "(a) actual choice": baseline_choice(problem, "actual"),
        "(b) cheapest vendor": baseline_choice(problem, "cheapest"),
        "(c) incumbent": baseline_choice(problem, "incumbent"),
        "(d) MILP (defaults)": x_milp,
    }
    comparison = pd.DataFrame([evaluate_policy(k, problem, v, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info) for k, v in policies.items()])

    # --- Sanity checks -------------------------------------------------------------
    chosen_milp = pairs[x_milp]
    no_history_pick = int((~chosen_milp["vendor"].isin([v for v in chosen_milp["vendor"]])).sum())
    hist_pairs = set(zip(problem.history["molecule_test_type"], problem.history["vendor"]))
    no_history_pick = int(sum((m, v) not in hist_pairs for m, v in zip(chosen_milp["molecule_test_type"], chosen_milp["vendor"])))
    x0, st0 = solve(problem, 0.0, None, None, info)
    x_cheap = policies["(b) cheapest vendor"]
    cost = pairs["price_cost"] + pairs["freight_cost"]
    lam0_cost, cheap_cost = float(cost[x0].sum()), float(cost[x_cheap].sum())
    x0caps, _ = solve(problem, 0.0, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info)
    lam0caps_cost = float(cost[x0caps].sum())

    # --- Sensitivity ---------------------------------------------------------------
    sens_rows = []
    for cap in SHARE_CAP_GRID:
        for lam in LAMBDA_GRID + LAMBDA_EXTENDED:
            x, st = solve(problem, lam, cap, CAPACITY_MULT_DEFAULT, info)
            row = evaluate_policy("MILP", problem, x, lam, cap, CAPACITY_MULT_DEFAULT, info)
            row.update({"λ": lam, "share cap": cap, "capacity multiplier": str(CAPACITY_MULT_DEFAULT), "grid": "agreed" if lam in LAMBDA_GRID else "extended",
                        "mean P(late) of chosen": float(pairs.loc[x, "p_late"].mean()), "solve s": st["seconds"],
                        "soft-constraint excess (lines)": st["share_violation_lines"] + st["capacity_violation_lines"]})
            sens_rows.append(row)
    for mult in CAPACITY_MULT_GRID:
        if mult == CAPACITY_MULT_DEFAULT:
            continue
        x, st = solve(problem, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, mult, info)
        row = evaluate_policy("MILP", problem, x, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, mult, info)
        row.update({"λ": LAMBDA_DEFAULT, "share cap": SHARE_CAP_DEFAULT, "capacity multiplier": str(mult), "grid": "capacity",
                    "mean P(late) of chosen": float(pairs.loc[x, "p_late"].mean()), "solve s": st["seconds"],
                    "soft-constraint excess (lines)": st["share_violation_lines"] + st["capacity_violation_lines"]})
        sens_rows.append(row)
    sens = pd.DataFrame(sens_rows)
    sens.to_csv(paths.outputs_dir / "decision-sensitivity.csv", index=False, float_format="%.6g")

    default_cap = sens[(sens["share cap"] == SHARE_CAP_DEFAULT) & (sens["capacity multiplier"] == str(CAPACITY_MULT_DEFAULT))].sort_values("λ")
    monotone = bool(np.all(np.diff(default_cap["expected late days"].to_numpy()) <= 1e-6))
    cost_monotone = bool(np.all(np.diff(default_cap["price + freight (USD M)"].to_numpy()) >= -1e-9))

    # Days-late and risk-model sensitivity at default parameters.
    alt_rows = []
    problem_g, info_g = build_problem(data, risk, X, days_source="global")
    xg, _ = solve(problem_g, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info_g)
    alt_rows.append({"variant": "E[days late | late] = global mean for all vendors",
                     **{k: v for k, v in evaluate_policy("MILP", problem_g, xg, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info_g).items() if k != "policy"}})
    alt_risk = CalibratedRisk("vendor-rate baseline (isotonic)", primary["models"]["baseline"], primary["cols"], "isotonic").fit_calibration(X[split.eq("validation")], y[split.eq("validation")].to_numpy())
    problem_r, info_r = build_problem(data, alt_risk, X)
    xr, _ = solve(problem_r, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info_r)
    alt_rows.append({"variant": "risk model = vendor-rate baseline, isotonic on 2013",
                     **{k: v for k, v in evaluate_policy("MILP", problem_r, xr, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, info_r).items() if k != "policy"}})
    for label, prob, inf in [("E[days late | late] = global mean for all vendors", problem_g, info_g),
                             ("risk model = vendor-rate baseline, isotonic on 2013", problem_r, info_r)]:
        xa = baseline_choice(prob, "actual")
        alt_rows.append({"variant": f"(a) actual choice under: {label}",
                         **{k: v for k, v in evaluate_policy("actual", prob, xa, LAMBDA_DEFAULT, SHARE_CAP_DEFAULT, CAPACITY_MULT_DEFAULT, inf).items() if k != "policy"}})
    alt = pd.DataFrame(alt_rows)

    # --- Implication evidence (recomputed here) -----------------------------------------
    sc = clean[clean["usable_scorecard"].fillna(False).astype(bool)]
    heap = heaping_test(sc["late_days"])
    perm = permutation_null(data)
    exact_share = float(sc["is_exact_on_schedule"].astype(bool).mean())
    sc_on_time = float((sc["late_days"] <= 0).mean())

    baselines = comparison.copy()
    fig = frontier_figure(sens[sens["grid"].isin(["agreed", "extended"])], baselines, paths.figures_dir / "decision-frontier.png")

    comp = comparison.set_index("policy")
    a, b, c_, d = (comp.loc[k] for k in comp.index)
    freight_levels = pairs["freight_level"].str.replace(r" \(included in price\)", " (included)", regex=True).value_counts()

    def money(v):
        return f"{v:,.2f}"

    comp_view = comparison.copy()
    for col in ["price (USD M)", "freight (USD M)", "price + freight (USD M)", "lateness cost at default λ (USD M)"]:
        comp_view[col] = comp_view[col].map(money)
    for col in ["expected late shipments", "expected late days"]:
        comp_view[col] = comp_view[col].map(lambda v: f"{v:,.1f}")
    comp_view["realised late rate on those"] = comp_view["realised late rate on those"].map(pct)
    comp_view["mean P(late) on those"] = comp_view["mean P(late) on those"].map(pct)

    sens_view = sens[sens["grid"] != "capacity"][["grid", "share cap", "λ", "price + freight (USD M)", "expected late shipments", "expected late days",
                                                 "mean P(late) of chosen", "vendors used", "lines changed vs actual", "soft-constraint excess (lines)"]].copy()
    sens_view["share cap"] = sens_view["share cap"].map(lambda v: f"{int(v * 100)}%")
    sens_view["λ"] = sens_view["λ"].map(lambda v: f"{v * 100:g}%/day")
    sens_view["price + freight (USD M)"] = sens_view["price + freight (USD M)"].map(money)
    sens_view["mean P(late) of chosen"] = sens_view["mean P(late) of chosen"].map(lambda v: pct(v, 2))
    for col in ["expected late shipments", "expected late days", "soft-constraint excess (lines)"]:
        sens_view[col] = sens_view[col].map(lambda v: f"{v:,.1f}")
    cap_view = sens[sens["grid"] == "capacity"][["capacity multiplier", "price + freight (USD M)", "expected late days", "vendors used", "soft-constraint excess (lines)"]].copy()
    cap_default = default_cap[default_cap["λ"] == LAMBDA_DEFAULT][["capacity multiplier", "price + freight (USD M)", "expected late days", "vendors used", "soft-constraint excess (lines)"]]
    cap_view = pd.concat([cap_default, cap_view]).replace({"None": "no capacity limit"})
    alt_view = alt[["variant", "price + freight (USD M)", "expected late shipments", "expected late days", "lines changed vs actual"]].copy()
    alt_view.loc[len(alt_view)] = ["default (vendor E[days | late], chosen risk model)", d["price + freight (USD M)"], d["expected late shipments"], d["expected late days"], d["lines changed vs actual"]]

    saving = (a["price + freight (USD M)"] - d["price + freight (USD M)"]) / a["price + freight (USD M)"]
    est_vs_obs = float(pairs.loc[pairs["is_actual"], "price_cost"].sum() / reqs["line_item_value"].sum())

    lam_ext = default_cap.set_index("λ")
    top_lambda = max(LAMBDA_GRID + LAMBDA_EXTENDED)

    report = f"""# Supplier allocation decision: results (rubric section 5)

Generated by `analytics/scms/decision_results.py`. Solver: `scipy.optimize.milp`
(HiGHS). The proposal is in `decision-proposal.md`. **Every parameter below
is an assumption** and is varied in section 4.

## 1. Decision set

- Test-period direct-drop lines (PO sent {TEST_FIRST_YEAR}–2015): {info['test_lines']:,}.
- With ≥2 candidate vendors for their molecule/test type (vendors that
  supplied it in POs up to {VALIDATION_YEAR}; no lookahead): {info['lines_multi_candidate']:,}.
- Dropped: {info['dropped_no_reference_price']} with no training reference price for their molecule,
  dosage and form; {info['dropped_actual_vendor_without_history']} whose actual vendor had no training history for the
  molecule, since policy (a) could not be costed on the same basis.
- **Requirements optimised: {len(reqs):,}**, over {reqs['quarter'].nunique()} quarters and
  {reqs['molecule_test_type'].nunique()} molecules/test types, with {len(pairs):,} (requirement, vendor) pairs.
  The mean number of candidates per requirement is {pairs.groupby('r').size().mean():.1f}.

## 2. Model

**Variables.** x[r,v] ∈ {{0,1}} for each candidate pair, plus non-negative
slack on each soft constraint.

**Objective.** min Σ x[r,v] · ( price[r,v] + freight[r,v] + λ · value_r · E[days late][r,v] )
+ M · Σ slack.

**Constraints.**
1. Σ_v x[r,v] = 1 for every requirement: one vendor, no split lines.
2. **Share cap** (ASSUMPTION, default {int(SHARE_CAP_DEFAULT * 100)}%): within each molecule and
   quarter, a vendor gets at most ⌈cap × n⌉ of the n requirements. This is
   count-based, because single large lines make value shares infeasible.
3. **Capacity proxy** (ASSUMPTION): per vendor and quarter, at most
   ⌊{CAPACITY_MULT_DEFAULT} × the vendor's maximum quarterly line count up to {VALIDATION_YEAR}⌋, minus that
   vendor's test-period lines outside the decision set in the same quarter.
4. Constraints 2 and 3 are *soft*, with penalty M = 1000 × the largest cost
   coefficient. A violation happens only when no feasible allocation exists,
   and it is reported.

**Parameters (all ASSUMPTIONS, all from data up to {VALIDATION_YEAR}):**

| parameter | definition | source |
|---|---|---|
| price[r,v] | units_r × ref_unit_cost(molecule, dosage, form) × index[v, molecule] | Unit cost = pack price ÷ units per pack. The reference is the median over all vendors of that exact molecule/dosage/form. index[v, molecule] is the vendor's median ratio to the reference over its lines of the molecule, which normalises strength and pack size. |
| freight[r,v] | price[r,v] × median freight share of value | Cell vendor × mode × country, then vendor × mode, mode × country, mode, global. A cell needs ≥{MIN_FREIGHT_CELL} lines. A cell where >{int(FREIGHT_INCLUDED_MAJORITY * 100)}% of lines have freight included in the price gets 0 separate freight. Pairs by level: {', '.join(f'{k} {v:,}' for k, v in freight_levels.items())}. |
| P(late)[r,v] | calibrated late risk with vendor = v and the rest of line r unchanged | `delay-model.md` §6: **{risk.name}**, chosen by out-of-fold validation Brier |
| E[days late][r,v] | P(late) × E[days late given late, v] | Vendor mean among late POs up to {VALIDATION_YEAR} if ≥5 late, else the global {info['global_days']:.1f} days |
| λ | lateness cost per day late, as a fraction of line value | default {LAMBDA_DEFAULT * 100:g}% per day; grid {', '.join(f'{v * 100:g}%' for v in LAMBDA_GRID)} |
| value_r | units_r × reference unit cost (vendor-neutral) | so that the lateness penalty does not favour cheaper vendors twice |

Price check: the estimated price of the *actual* choice is {est_vs_obs:.2f}× the observed
line value of those requirements. This measures the error in the price model,
not a saving.

## 3. Four policies on the test period (defaults: λ = {LAMBDA_DEFAULT * 100:g}%/day, cap {int(SHARE_CAP_DEFAULT * 100)}%, capacity ×{CAPACITY_MULT_DEFAULT})

All four are scored with the **same** price, freight and risk model, so the
comparison is like for like.

{md_table(comp_view)}

Reading the table:

- The MILP's estimated price + freight is {money(d['price + freight (USD M)'])} M against {money(a['price + freight (USD M)'])} M for the actual
  choice ({pct(saving)} lower). The cheapest-vendor rule reaches {money(b['price + freight (USD M)'])} M but breaks
  the share cap on {int(b['share-cap excess lines'])} lines and the capacity proxy on {int(b['capacity excess lines'])}.
- Expected late shipments: actual {a['expected late shipments']:.1f}, cheapest {b['expected late shipments']:.1f},
  incumbent {c_['expected late shipments']:.1f}, MILP {d['expected late shipments']:.1f}. Expected late days: {a['expected late days']:.0f} /
  {b['expected late days']:.0f} / {c_['expected late days']:.0f} / {d['expected late days']:.0f}.
- **The actual choice has the lowest expected lateness** of the four
  policies. The MILP saves {pct(saving)} of estimated price + freight, but adds
  {d['expected late days'] - a['expected late days']:,.0f} expected late days
  ({d['expected late shipments'] - a['expected late shipments']:+.1f} expected late shipments). Even at the largest λ tried
  ({top_lambda * 100:g}%/day), expected late days stay at {lam_ext.loc[top_lambda, 'expected late days']:,.0f}, against {a['expected late days']:,.0f} for the actual
  choice. SCMS may have been buying reliability, or it faced eligibility
  constraints (registration, framework contracts) that the model does not see.
- **The proxies are tighter than reality.** The actual choice itself exceeds
  the {int(SHARE_CAP_DEFAULT * 100)}% share cap on {int(a['share-cap excess lines'])} lines and the capacity proxy on {int(a['capacity excess lines'])}.
  The caps are policy choices, not descriptions of how SCMS bought.
- The lateness cost at the default λ is {money(d['lateness cost at default λ (USD M)'])} M for the MILP, against a
  price + freight gap of {money(a['price + freight (USD M)'] - d['price + freight (USD M)'])} M to the actual choice. That is why price dominates.
- MILP solve: {status['status']} in {status['seconds']:.2f} s, with {status['constraints_share']} active share-cap and
  {status['constraints_capacity']} capacity constraints, and soft-constraint excess of
  {status['share_violation_lines'] + status['capacity_violation_lines']:.1f} lines.

**The counterfactual limitation.** A realised outcome exists only for the
vendor that was actually used. "Lines with realised outcome" counts the
requirements where a policy picks the actual vendor. The realised late rate is
measured on those lines only, which is a different subset for each policy, so
realised rates are **not comparable across policies**. For the actual choice,
the realised late rate ({pct(a['realised late rate on those'])}) against the
model's mean P(late) ({pct(a['mean P(late) on those'])}) checks calibration on
this decision set. Every "expected" column for a reallocated line is a model
prediction for a vendor that did not ship it. It inherits the model's weak
test discrimination (`delay-model.md`) and the scheduled-date caveat.

## 4. Sensitivity

![Frontier]({'figures/' + fig})

λ × share cap (capacity ×{CAPACITY_MULT_DEFAULT}). "Extended" λ values go beyond the agreed grid
and are there only to show the direction of the trade-off:

{md_table(sens_view)}

Capacity multiplier (λ = {LAMBDA_DEFAULT * 100:g}%/day, cap {int(SHARE_CAP_DEFAULT * 100)}%):

{md_table(cap_view, digits=2)}

Days-late and risk-model variants (defaults otherwise):

{md_table(alt_view, digits=2)}

## 5. Does it make sense? (sanity checks)

- **No vendor without history:** the MILP picks a vendor with no training
  history for the molecule on {no_history_pick} lines. Candidates are built from history, so this should be 0.
- **λ = 0 without caps equals cheapest:** MILP cost {lam0_cost:,.0f} USD vs cheapest {cheap_cost:,.0f} USD
  ({'equal' if abs(lam0_cost - cheap_cost) <= 1e-6 * cheap_cost else 'NOT equal'}). With caps and capacity at λ = 0, cost is {lam0caps_cost:,.0f} USD
  ({'≥ cheapest, as it must be' if lam0caps_cost >= cheap_cost - 1e-6 else 'BELOW cheapest: error'}).
- **As λ grows, expected lateness falls:** at the default cap, expected late days
  are non-increasing across λ: {'yes' if monotone else 'NO'}; price + freight non-decreasing: {'yes' if cost_monotone else 'NO'}. From λ = 0 to λ = {top_lambda * 100:g}%/day, the mean P(late) of the chosen vendors
  moves from {pct(lam_ext.loc[0.0, 'mean P(late) of chosen'], 2)} to {pct(lam_ext.loc[top_lambda, 'mean P(late) of chosen'], 2)}, and expected late days from
  {lam_ext.loc[0.0, 'expected late days']:.1f} to {lam_ext.loc[top_lambda, 'expected late days']:.1f}.
- **Magnitude check:** within the agreed λ grid (up to {max(LAMBDA_GRID) * 100:g}%/day), expected late
  days change from {lam_ext.loc[0.0, 'expected late days']:.1f} to {lam_ext.loc[max(LAMBDA_GRID), 'expected late days']:.1f}. With late-risk of a few percent and
  E[days late] of weeks, the lateness term is small next to price differences
  between vendors, so price drives the allocation unless lateness is very costly.

## 6. Implications

**For FlowChain, the biggest lesson is a product one, not the MILP: a PO line
must keep an immutable "original promised date", separate from the current
expected date.** Evidence from this dataset:

- The data dictionary defines `scheduled delivery date` as "Current
  anticipated delivery date" (source: {DICTIONARY_SOURCE}). The original promise is not kept anywhere in the file.
- {pct(exact_share)} of usable direct-drop shipments arrived exactly on the "scheduled"
  day. That is {heap['ratio']:.0f}× the count on the neighbouring ±1..±{heap['window']} days,
  which a genuine forecast error distribution would not produce.
- The shuffle test: if actual lead times are permuted within vendor, planned
  and actual lead time match on {pct(perm['null_mean'], 1)} of lines on average (max
  {pct(perm['null_max'], 1)} in {perm['n_perm']:,} permutations), against {pct(perm['observed'])} observed.
- Consequence: the measured on-time rate ({pct(sc_on_time)}) is an upper bound
  on performance against the original promise, and we cannot tell how loose it
  is. A scorecard, a late-risk model, and the λ term of this MILP all inherit
  the bias.

What FlowChain should do:

1. Store `original_promised_date` on each PO line when the PO is confirmed,
   and never overwrite it. Keep `current_expected_date` as a separate field,
   with a change history (who, when, why).
2. Compute supplier on-time against the original promise. Optionally show a
   second, "against latest re-promise" figure, labelled as such.
3. Record received quantity and rejections per receipt, so in-full and quality
   can be scored. This dataset cannot do that.
4. Treat a high exact-match share (arrived = promised to the day) as a data
   quality warning on the scorecard.

For the decision itself:

- At the agreed lateness costs, allocation is driven by price. The MILP mainly
  enforces diversification (share caps) and capacity while buying cheaper.
  Reliability only moves the choice at much higher λ.
- The price model is the weakest link: counterfactual prices come from other
  lines, not from quotes. Before acting on the estimated saving, validate it
  against actual RFQ quotes for a sample of requirements.
- The same MILP transfers to FlowChain's RFQ award step. There, prices are
  real quotes and the risk term can come from FlowChain's own on-time history,
  once it is measured against original promises.
"""
    write_text(paths.outputs_dir / "decision-results.md", report)
    write_json(paths.outputs_dir / "key-numbers-decision.json", {
        "info": {k: v for k, v in info.items() if k not in ("capacity_base", "other_lines")},
        "requirements": len(reqs), "pairs": len(pairs), "risk_model": risk.name,
        "comparison": comparison.to_dict(orient="records"),
        "sanity": {"no_history_pick": no_history_pick, "lam0_cost": lam0_cost, "cheap_cost": cheap_cost, "lam0caps_cost": lam0caps_cost,
                   "monotone_late_days": monotone, "monotone_cost": cost_monotone},
        "saving_vs_actual": saving, "estimated_vs_observed_price_actual": est_vs_obs,
        "evidence": {"exact_share": exact_share, "heap_ratio": heap["ratio"], "perm_null_mean": perm["null_mean"], "perm_observed": perm["observed"]},
    })
    print(f"Wrote {paths.outputs_dir / 'decision-results.md'}")
    with pd.option_context("display.width", 250, "display.max_columns", 30):
        print(comparison.to_string(index=False))
        print(default_cap[["λ", "price + freight (USD M)", "expected late days", "mean P(late) of chosen", "lines changed vs actual"]].to_string(index=False))
        print("sanity", no_history_pick, lam0_cost, cheap_cost, lam0caps_cost, monotone, cost_monotone, status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
