"""Replenishment policy backtest on the 13 test weeks (rubric section 5, retail half).

    python -m retail.decision [--data-dir DIR] [--scms-csv FILE] [--paths 500] [--reuse-gbm]

Reads   derived/weekly_panel.csv, derived/panel_skus.csv, derived/weekly_totals.csv,
        outputs/sku-parameters.csv, outputs/forecast-selection.json,
        the SCMS cleaned CSV ($FLOWCHAIN_DATA_DIR/scms/derived/scms_clean.csv by default)
Writes  outputs/replenishment-results.md, outputs/replenishment-*.csv, figures,
        outputs/demand-paths-test.csv.gz, outputs/demand-paths-forward.csv.gz,
        outputs/key-numbers-replenishment.json

Setup (every number the report uses is computed here; assumptions are marked):
- Periodic review every R = 4 weeks, at test weeks 0, 4, 8 and 12. Each review uses only
  data up to the week before it. Lost sales, no backorders. An order placed at a review
  arrives at the start of week t + L, where L is drawn per order (common random numbers:
  the same draw for every policy and scenario).
- Starting inventory: the same for every policy. Base case = the rule-of-thumb (a) order-up-to
  level at the test origin, standing for current practice; sensitivity 0.5x and 1.5x of it. The
  SKU's historical weeks of cover cannot be estimated (the data has no stock levels). The old
  start at each policy's own level is kept only as a secondary table, biased toward high-stock
  policies.
- Demand = actual gross shipped units in the test weeks (raw, bulk lines included).
- Demand paths: GBM point forecasts (horizon 26, capped history, refitted at each review)
  plus scaled residual trajectories from three pre-test backtests, resampled as whole
  26-week blocks within ABC class, which keeps each SKU's week-to-week error correlation.
- Lead time: lognormal with an ASSUMED mean (2, 4 or 8 weeks) and the coefficient of
  variation of SCMS direct-drop actual lead times; rounded to whole weeks, minimum 1.
- Terminal inventory: the inventory position left after week 13 (on hand + on order, since
  orders placed at the last reviews are commitments that arrive into the post-season) is
  charged a markdown/obsolescence loss of m x unit cost per unit (ASSUMED m = 0.3; sensitivity
  0, 0.15, 0.5). An alternative with no cost assumption charges, at cost, only the stock beyond
  8 weeks of forward P50 demand.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.stats import lognorm
from sklearn.ensemble import HistGradientBoostingRegressor

from . import config as C
from . import models as M
from . import plotting as P
from .metrics import boot_weights
from .paths import ENV_VAR, SEED, add_data_dir_arg, data_paths_from_args

R = 4                                  # review period, weeks
REVIEW_WEEKS = (0, 4, 8, 12)           # test-week index of each review
H = 26                                 # forecast horizon for the paths
CAL_ORIGINS = (38, 51, 64)             # pre-test backtests for residual trajectories
QUANTILE_GRID = (0.50, 0.70, 0.80, 0.90, 0.95, 0.98)
BUDGET_FACTORS = (0.6, 0.8, 1.0)
EXTRA_BUDGET = 1.2                     # only for the monotonicity check
BASE = dict(mean_L=4.0, cv="all", cost_ratio=0.50, holding=0.25, stockout_mult=1.0, start="a", markdown=0.30)
T_WINDOW = 13                          # test weeks
EXCESS_WEEKS = 8                       # "true excess" = stock beyond this many weeks of forward P50 demand
START_LABELS = {"a": "common start = (a) level", "a0.5": "common start = 0.5 x (a) level",
                "a1.5": "common start = 1.5 x (a) level",
                "own": "own order-up-to level (BIASED toward high-stock policies)"}
POLICY_LABELS = {
    "p50": "(ref) fixed P50 order-up-to level",
    "p70": "(ref) fixed P70 order-up-to level",
    "p80": "(ref) fixed P80 order-up-to level",
    "p90": "(ref) fixed P90 order-up-to level",
    "a": "(a) rule of thumb: (L+R) x 4-week mean",
    "b": "(b) FlowChain rule: ROP = dL + 1 week, target = ROP + dR",
    "c": "(c) forecast + service level (critical-ratio quantile)",
    "d0.6": "(d) budgeted MILP, B = 0.6 x (c)",
    "d0.8": "(d) budgeted MILP, B = 0.8 x (c)",
    "d1.0": "(d) budgeted MILP, B = 1.0 x (c)",
}


# ----------------------------------------------------------------------------- lead time
def scms_lead_time_cvs(csv_path: Path) -> dict:
    """CV of direct-drop actual lead times (SCMS 'usable for lead time' subset) and vendor tiers."""
    d = pd.read_csv(csv_path, low_memory=False,
                    usecols=["fulfill_via", "usable_model", "lead_days_actual", "vendor"])
    x = d[(d.fulfill_via == "Direct Drop") & d.usable_model.astype(bool) & d.lead_days_actual.notna()].copy()
    lt = x.lead_days_actual
    g = x.groupby("vendor").lead_days_actual.agg(["size", "mean", "std"])
    g["cv"] = g["std"] / g["mean"]
    v = g[g["size"] >= 30].sort_values("cv")
    k = len(v) // 3
    x["ratio"] = x.lead_days_actual / x.vendor.map(g["mean"])
    low, high = v.index[:k], v.index[-k:]
    return {
        "file": str(csv_path), "rows": len(x), "median_days": float(lt.median()), "mean_days": float(lt.mean()),
        "cv_all": float(lt.std() / lt.mean()),
        "cv_within_vendor": float(x.ratio.std()),
        "vendors_n30": len(v), "tier_size": k,
        "cv_low_tier": float(x[x.vendor.isin(low)].ratio.std()),
        "cv_high_tier": float(x[x.vendor.isin(high)].ratio.std()),
        "low_tier_vendors": [f"{n} (CV {v.loc[n, 'cv']:.2f}, n={int(v.loc[n, 'size'])})" for n in low],
        "high_tier_vendors": [f"{n} (CV {v.loc[n, 'cv']:.2f}, n={int(v.loc[n, 'size'])})" for n in high],
    }


def lead_weeks(u: np.ndarray, mean_L: float, cv: float, match: str = "mean") -> np.ndarray:
    """Inverse-CDF lognormal lead time (weeks) with the given CV; rounded, >= 1.

    ``match="mean"`` sets the mean to ``mean_L``; ``match="median"`` sets the median to it instead
    (then the mean grows with the CV). A lognormal cannot hold both fixed while the CV changes.
    """
    if cv <= 0:
        return np.full(u.shape, max(1, int(round(mean_L))), dtype=int)
    s2 = np.log1p(cv ** 2)
    scale = mean_L if match == "median" else np.exp(np.log(mean_L) - s2 / 2)
    x = lognorm.ppf(u, s=np.sqrt(s2), scale=scale)
    return np.maximum(1, np.rint(x)).astype(int)


# ----------------------------------------------------------------------------- demand paths
def gbm_point(Yh, price_ff, price_med, total, first, ext, o):
    X, y, _ = M.gbm_training_set(Yh, price_ff, price_med, total, first, ext, o, H)
    keep = ~np.all(np.isnan(X), axis=0)  # early origins have no year-ago features at all
    model = HistGradientBoostingRegressor(**M.gbm_params(SEED, "poisson")).fit(X[:, keep], y)
    return np.maximum(np.column_stack([
        model.predict(M.gbm_features(Yh, price_ff, price_med, total, first, ext, o, h)[:, keep])
        for h in range(1, H + 1)]), 0)


def level_at(Yraw, o):
    return np.maximum(Yraw[:, o - 12:o + 1].mean(axis=1), 1.0)


def build_paths(point, level, abc, pools, n_paths, seed):
    rng = np.random.default_rng(seed)
    n = point.shape[0]
    D = np.empty((n, n_paths, H), dtype=np.float32)
    for c, pool in pools.items():
        rows = np.flatnonzero(abc == c)
        idx = rng.integers(0, len(pool), size=(len(rows), n_paths))
        D[rows] = np.maximum(point[rows, None, :] + pool[idx] * level[rows, None, None], 0)
    return D


def demand_over(D, L):
    """Demand over L + R weeks per path; beyond the horizon, extend at the path's mean of weeks 14-26."""
    n, p, _ = D.shape
    need = L + R
    cum = np.cumsum(D, axis=2, dtype=np.float64)
    k = np.minimum(need, H) - 1
    out = np.take_along_axis(cum, k[:, :, None], axis=2)[:, :, 0]
    extra = np.maximum(need - H, 0)
    if extra.any():
        tail = D[:, :, 13:].mean(axis=2)
        out = out + extra * tail
    return out


def row_quantile(sorted_x, q):
    """Per-row quantile (linear interpolation) of an already sorted (n, p) array; q is (n,)."""
    p = sorted_x.shape[1]
    pos = q * (p - 1)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, p - 1)
    w = pos - lo
    r = np.arange(sorted_x.shape[0])
    return sorted_x[r, lo] * (1 - w) + sorted_x[r, hi] * w


# ----------------------------------------------------------------------------- policies
class _quiet_fd1:
    """Silence C-level stdout (HiGHS prints progress notes at tight gaps); Python output is unaffected."""

    def __enter__(self):
        sys.stdout.flush()
        self.saved = os.dup(1)
        self.null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(self.null, 1)

    def __exit__(self, *exc):
        os.dup2(self.saved, 1)
        os.close(self.null)
        os.close(self.saved)


def plan_levels(D, L_plan, cr, cost, h_week, cu, term):
    """Order-up-to levels for (c) and the (d) candidate table at one review.

    ``term`` is the per-unit loss on stock left over at the end of the protection interval:
    0 in intermediate cycles (leftovers carry to the next cycle and cost only holding), and
    markdown x unit cost in the final cycle, whose leftovers remain at the end of the window.
    """
    dlr = np.sort(demand_over(D, L_plan), axis=1)
    d_r = D[:, :, :R].sum(axis=2).mean(axis=1)
    s_c = row_quantile(dlr, cr)

    def plan(S):
        short = np.maximum(dlr - S[:, None], 0).mean(axis=1)
        over = np.maximum(S[:, None] - dlr, 0).mean(axis=1)
        onhand = over + d_r / 2
        return cu * short + h_week * R * onhand + term * over, cost * onhand

    cand = {q: row_quantile(dlr, np.full(len(cr), q)) for q in QUANTILE_GRID}
    table = {q: (cand[q],) + plan(cand[q]) for q in QUANTILE_GRID}
    c_cost, c_val = plan(s_c)
    return s_c, c_val, table, dlr


def solve_budget(table, budget):
    """Multiple-choice knapsack as a MILP (HiGHS): one quantile level per SKU, total value <= budget."""
    qs = list(QUANTILE_GRID)
    n = len(table[qs[0]][0])
    k = len(qs)
    cost = np.column_stack([table[q][1] for q in qs]).ravel()
    val = np.column_stack([table[q][2] for q in qs]).ravel()
    A_eq = sparse.kron(sparse.eye(n), np.ones((1, k)), format="csr")
    min_val = np.column_stack([table[q][2] for q in qs]).min(axis=1).sum()
    feasible = min_val <= budget
    b = budget if feasible else min_val
    with _quiet_fd1():
        res = milp(cost, constraints=[LinearConstraint(A_eq, 1, 1), LinearConstraint(val[None, :], -np.inf, b)],
                   integrality=np.ones(n * k), bounds=Bounds(0, 1), options={"mip_rel_gap": 1e-9})
    x = np.rint(res.x).reshape(n, k)
    choice = x.argmax(axis=1)
    S = np.column_stack([table[q][0] for q in qs])[np.arange(n), choice]
    lp = milp(cost, constraints=[LinearConstraint(A_eq, 1, 1), LinearConstraint(val[None, :], -np.inf, b)],
              bounds=Bounds(0, 1))
    return S, {"status": int(res.status), "message": res.message, "mip_gap": float(getattr(res, "mip_gap", np.nan)),
               "objective": float(res.fun), "lp_bound": float(lp.fun), "budget": float(budget),
               "feasible_budget": bool(feasible), "choice_counts": {str(qs[j]): int((choice == j).sum()) for j in range(k)},
               "value_used": float(val @ x.ravel())}


def simulate(start, levels, demand, L_orders, pack, cost, h_week, margin, stock_mult, markdown, fwd_p50,
             rop=None):
    """Lost-sales periodic review. levels[:, r] is the order-up-to level at review r.

    With ``rop`` given (FlowChain rule), an order is placed only when IP <= rop[:, r].
    The inventory position left after the last week (on hand + on order) is charged markdown x
    cost per unit (terminal cost), and separately measured against ``fwd_p50`` (units of forward
    P50 demand over EXCESS_WEEKS).
    """
    n, T = demand.shape
    on = start.astype(float).copy()
    arrivals = np.zeros((n, T + 200))
    sales = np.zeros(n)
    lost = np.zeros(n)
    onhand_sum = np.zeros(n)
    orders = np.zeros(n, dtype=int)
    cyc_ok = np.zeros(n)
    cyc_lost = np.zeros(n)
    for t in range(T):
        on += arrivals[:, t]
        if t in REVIEW_WEEKS:
            r = REVIEW_WEEKS.index(t)
            if t > 0:
                cyc_ok += (cyc_lost == 0)
                cyc_lost[:] = 0
            ip = on + arrivals[:, t + 1:].sum(axis=1)
            trigger = np.ones(n, bool) if rop is None else ip <= rop[:, r]
            q = np.where(trigger, np.maximum(levels[:, r] - ip, 0), 0)
            q = np.where(q > 0, np.ceil(q / pack) * pack, 0)
            arr = np.minimum(t + L_orders[:, r], T + 199)
            np.add.at(arrivals, (np.arange(n), arr), q)
            orders += q > 0
        s = np.minimum(on, demand[:, t])
        sales += s
        lost += demand[:, t] - s
        cyc_lost += demand[:, t] - s
        on -= s
        onhand_sum += on
    cyc_ok += (cyc_lost == 0)
    avg_on = onhand_sum / T
    on_order = arrivals[:, T:].sum(axis=1)
    left = on + on_order
    excess = np.maximum(left - fwd_p50, 0)
    return pd.DataFrame({
        "demand": demand.sum(axis=1), "sales": sales, "lost": lost, "lost_margin": lost * margin,
        "stockout_cost": lost * margin * stock_mult, "holding": onhand_sum * cost * h_week,
        "avg_onhand": avg_on, "avg_inv_value": avg_on * cost, "end_onhand": left, "end_inv_value": left * cost,
        "end_on_order_value": on_order * cost,
        "terminal": markdown * cost * left, "excess_value": excess * cost, "fwd_p50": fwd_p50,
        "orders": orders, "cycles_ok": cyc_ok, "cycles": np.full(n, len(REVIEW_WEEKS)),
    })


def aggregate(df: pd.DataFrame, w: np.ndarray | None = None, ref: pd.DataFrame | None = None) -> dict:
    """Totals and ratios; total cost = holding + stockout + terminal markdown.

    ``alt_total`` = holding + stockout + excess value (stock beyond 8 weeks of forward P50 demand
    valued at cost), which needs no markdown assumption.
    """
    tot = df.sum()
    out = {"fill_rate": tot.sales / tot.demand, "csl": tot.cycles_ok / tot.cycles, "lost_units": tot.lost,
           "lost_margin": tot.lost_margin, "stockout_cost": tot.stockout_cost, "avg_inv_value": tot.avg_inv_value,
           "weeks_of_supply": tot.avg_onhand / (tot.demand / T_WINDOW), "holding": tot.holding,
           "terminal": tot.terminal, "total_cost": tot.holding + tot.stockout_cost + tot.terminal,
           "excess_value": tot.excess_value, "alt_total": tot.holding + tot.stockout_cost + tot.excess_value,
           "end_inv_value": tot.end_inv_value, "end_on_order_value": tot.end_on_order_value,
           "end_weeks_of_supply": tot.end_onhand / (tot.fwd_p50 / EXCESS_WEEKS), "orders": int(tot.orders)}
    if w is not None:
        cols = {c: i for i, c in enumerate(df.columns)}
        s = w @ df.to_numpy()

        def col(x, k):
            return x[:, cols[k]]

        fill = col(s, "sales") / col(s, "demand")
        csl = col(s, "cycles_ok") / col(s, "cycles")
        tc = col(s, "holding") + col(s, "stockout_cost") + col(s, "terminal")
        alt = col(s, "holding") + col(s, "stockout_cost") + col(s, "excess_value")
        inv = col(s, "avg_inv_value")
        for k, v in (("fill_rate", fill), ("csl", csl), ("total_cost", tc), ("avg_inv_value", inv), ("alt_total", alt)):
            out[f"{k}_lo"], out[f"{k}_hi"] = np.percentile(v, [2.5, 97.5])
        if ref is not None:
            rs = w @ ref.to_numpy()
            d = tc - (col(rs, "holding") + col(rs, "stockout_cost") + col(rs, "terminal"))
            out["d_total_vs_b"] = out["total_cost"] - (ref.holding.sum() + ref.stockout_cost.sum() + ref.terminal.sum())
            out["d_total_vs_b_lo"], out["d_total_vs_b_hi"] = np.percentile(d, [2.5, 97.5])
    return out


# ----------------------------------------------------------------------------- scenario
def run_scenario(sc, ctx, extra_checks=False):
    n = ctx["n"]
    cv = {"all": ctx["lt"]["cv_all"], "low": ctx["lt"]["cv_low_tier"], "high": ctx["lt"]["cv_high_tier"],
          "zero": 0.0}[sc["cv"]]
    match = sc.get("match", "mean")
    L_plan = lead_weeks(ctx["U_plan"], sc["mean_L"], cv, match)
    L_orders = lead_weeks(ctx["U_orders"], sc["mean_L"], cv, match)
    EL_draws = lead_weeks(ctx["U_EL"], sc["mean_L"], cv, match)
    EL = float(EL_draws.mean())
    price = ctx["price"]
    cost = sc["cost_ratio"] * price
    margin = price - cost
    h_week = sc["holding"] / 52
    cu = sc["stockout_mult"] * margin
    markdown = sc.get("markdown", BASE["markdown"])
    Yraw = ctx["Yraw"]
    cr_by_review, final_flags = [], []
    lv = {}
    for pol in ("a", "b_rop", "b_target", "c", "c50", "p50", "p70", "p80", "p90",
                *[f"d{f}" for f in BUDGET_FACTORS + (EXTRA_BUDGET,)]):
        lv[pol] = np.zeros((n, len(REVIEW_WEEKS)))
    milp_info, ss_value = [], []
    for r, t in enumerate(REVIEW_WEEKS):
        o = ctx["t0"] + t - 1
        ma4 = Yraw[:, o - 3:o + 1].mean(axis=1)
        d13 = Yraw[:, o - 12:o + 1].mean(axis=1)
        lv["a"][:, r] = (EL + R) * ma4
        lv["b_rop"][:, r] = d13 * EL + d13 * 1.0
        lv["b_target"][:, r] = lv["b_rop"][:, r] + d13 * R
        D = ctx["paths"][o]
        # Multi-period newsvendor: leftovers of an intermittent cycle carry over and cost holding over the
        # protection interval; in the final cycle (protection interval past the window end) they also
        # face the terminal markdown.
        final = (t + EL + R) > T_WINDOW
        term = markdown * cost if final else np.zeros(n)
        co = h_week * cost * (EL + R) + term
        cr = cu / (cu + co)
        cr_by_review.append(float(np.median(cr)))
        final_flags.append(bool(final))
        s_c, c_val, table, dlr = plan_levels(D, L_plan, cr, cost, h_week * cost, cu, term)
        lv["c"][:, r] = s_c
        mean_dlr = dlr.mean(axis=1)
        ss_value.append(float(((s_c - mean_dlr) * cost).sum()))
        if extra_checks:
            lv["c50"][:, r] = row_quantile(dlr, np.full(n, 0.5))
            for qq in (0.5, 0.7, 0.8, 0.9):
                lv[f"p{int(qq * 100)}"][:, r] = table[qq][0]
        for f in BUDGET_FACTORS + ((EXTRA_BUDGET,) if extra_checks else ()):
            S, info = solve_budget(table, f * c_val.sum())
            lv[f"d{f}"][:, r] = S
            milp_info.append({"review": t, "factor": f, **info})
    demand = ctx["actual"]
    common = dict(demand=demand, L_orders=L_orders, pack=ctx["pack"], cost=cost, h_week=h_week, margin=margin,
                  stock_mult=sc["stockout_mult"], markdown=markdown, fwd_p50=ctx["fwd_p50"])
    s_a0 = lv["a"][:, 0]
    mode = sc.get("start", "a")

    def start(own):
        if mode == "own":
            return own
        return {"a": 1.0, "a0.5": 0.5, "a1.5": 1.5}[mode] * s_a0

    res = {"a": simulate(start(lv["a"][:, 0]), lv["a"], **common),
           "b": simulate(start(lv["b_target"][:, 0]), lv["b_target"], rop=lv["b_rop"], **common),
           "c": simulate(start(lv["c"][:, 0]), lv["c"], **common)}
    for f in BUDGET_FACTORS + ((EXTRA_BUDGET,) if extra_checks else ()):
        res[f"d{f}"] = simulate(start(lv[f"d{f}"][:, 0]), lv[f"d{f}"], **common)
    if extra_checks:
        res["c50"] = simulate(start(lv["c50"][:, 0]), lv["c50"], **common)
        for pq in ("p50", "p70", "p80", "p90"):
            res[pq] = simulate(start(lv[pq][:, 0]), lv[pq], **common)
    meta = {"cv": cv, "EL": EL, "median_L": float(np.median(EL_draws)), "median_cr": cr_by_review[0],
            "cr_by_review": cr_by_review, "final_reviews": [t for t, fl in zip(REVIEW_WEEKS, final_flags) if fl],
            "markdown": markdown,
            # safety stock of (c) at the week-0 review (S - E[demand over L+R], at cost); later reviews are
            # left out because the final-cycle markdown lowers their critical ratio
            "safety_stock_value_c": float(ss_value[0]), "milp": milp_info, "levels": lv}
    return res, meta


# ----------------------------------------------------------------------------- main
def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_data_dir_arg(parser)
    parser.add_argument("--scms-csv", default=None,
                        help=f"SCMS cleaned CSV (default: ${ENV_VAR}/scms/derived/scms_clean.csv, "
                             "else ~/flowchain-data/scms/derived/scms_clean.csv)")
    parser.add_argument("--paths", type=int, default=500)
    parser.add_argument("--reuse-gbm", action="store_true", help="reuse derived/decision_gbm_points.npz")
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()
    t0 = time.time()
    P.setup()
    if args.scms_csv:
        scms_csv = Path(args.scms_csv)
    else:
        root = Path(os.environ[ENV_VAR]).expanduser() if os.environ.get(ENV_VAR) else Path.home() / "flowchain-data"
        scms_csv = root / "scms" / "derived" / "scms_clean.csv"
    lt = scms_lead_time_cvs(scms_csv)
    print(f"SCMS lead-time CVs from {scms_csv}: all {lt['cv_all']:.3f}, low tier {lt['cv_low_tier']:.3f}, "
          f"high tier {lt['cv_high_tier']:.3f}")

    sel = json.loads((paths.outputs_dir / "forecast-selection.json").read_text(encoding="utf-8"))
    variant = sel["history_variant"]
    panel = pd.read_csv(paths.weekly_csv, parse_dates=["week"], dtype={"sku": str})
    skus = pd.read_csv(paths.sku_csv, dtype={"sku": str}).set_index("sku").sort_index()
    par = pd.read_csv(paths.outputs_dir / "sku-parameters.csv", dtype={"sku": str}).set_index("sku").reindex(skus.index)
    totals = pd.read_csv(paths.derived_dir / "weekly_totals.csv", parse_dates=["week"]).set_index("week")
    weeks = pd.DatetimeIndex(sorted(panel.week.unique()))
    wide = {c: panel.pivot(index="sku", columns="week", values=c).reindex(skus.index)[weeks].to_numpy(float)
            for c in ("units", "units_capped", "avg_price")}
    ext = pd.DatetimeIndex(list(weeks) + list(pd.date_range(weeks[-1] + pd.Timedelta(weeks=1), periods=H + 4,
                                                            freq="W-MON")))
    tot = totals.loc[weeks, "units" if variant == "raw" else "units_capped"].to_numpy(float)
    Yraw = wide["units"]
    Yh = wide["units"] if variant == "raw" else wide["units_capped"]
    price_ff, price_med = M.price_arrays(wide["avg_price"])
    first = np.array([M.first_sale(r) for r in Yraw])
    n = len(skus)
    t0_idx = int(np.flatnonzero(weeks == C.TEST_START)[0])  # first test week (index 91)
    review_origins = [t0_idx + t - 1 for t in REVIEW_WEEKS]
    fwd_origin = len(weeks) - 1
    all_origins = list(CAL_ORIGINS) + review_origins + [fwd_origin]

    npz = paths.derived_dir / "decision_gbm_points.npz"
    if args.reuse_gbm and npz.exists():
        store = np.load(npz)
        points = {o: store[f"o{o}"] for o in all_origins}
        print("Reused GBM points")
    else:
        points = {}
        for o in all_origins:
            points[o] = gbm_point(Yh, price_ff, price_med, tot, first, ext, o)
            print(f"  GBM origin {o} ({weeks[o].date()}) done at {time.time() - t0:.0f}s", flush=True)
        np.savez_compressed(npz, **{f"o{o}": v for o, v in points.items()})

    # residual trajectories (26 weeks) from the pre-test backtests, pooled by ABC class
    abc = skus.abc.to_numpy()
    pools_by_origin = {}
    traj, traj_abc = [], []
    for o in CAL_ORIGINS:
        ok = (o - first) >= 13
        r = (Yraw[:, o + 1:o + 1 + H] - points[o]) / level_at(Yraw, o)[:, None]
        traj.append(r[ok])
        traj_abc.append(abc[ok])
        pools_by_origin[o] = int(ok.sum())
    traj = np.vstack(traj).astype(np.float32)
    traj_abc = np.concatenate(traj_abc)
    pools = {c: traj[traj_abc == c] for c in ("A", "B", "C")}
    cal_windows = {o: f"{weeks[o + 1].date()} to {weeks[o + H].date()}" for o in CAL_ORIGINS}

    paths_by_origin = {}
    for o in review_origins + [fwd_origin]:
        paths_by_origin[o] = build_paths(points[o], level_at(Yraw, o), abc, pools, args.paths, SEED + o)

    # calibration diagnostics at the test origin (weekly P90 coverage; 4-week total coverage)
    o90 = review_origins[0]
    Dt = paths_by_origin[o90][:, :, :13]
    act = Yraw[:, o90 + 1:o90 + 14]
    p90w = np.quantile(Dt, 0.9, axis=1)
    p50w = np.quantile(Dt, 0.5, axis=1)
    diag = {"weekly_p90_coverage": float((act <= p90w).mean()), "weekly_p50_coverage": float((act <= p50w).mean())}
    for lo in (0, 4, 8):
        s = Dt[:, :, lo:lo + 4].sum(axis=2)
        diag[f"sum4_p90_coverage_h{lo + 1}"] = float((act[:, lo:lo + 4].sum(axis=1) <= np.quantile(s, 0.9, axis=1)).mean())

    # export paths (test origin and forward origin), wide format, aggregates of simulated demand only
    for name, o in (("test", o90), ("forward", fwd_origin)):
        D = paths_by_origin[o]
        cols = {f"w{h:02d}": D[:, :, h - 1].ravel().round(1) for h in range(1, H + 1)}
        out = pd.DataFrame({"sku": np.repeat(skus.index.to_numpy(), args.paths),
                            "path": np.tile(np.arange(args.paths), n), **cols})
        out.insert(1, "origin_week", str(weeks[o].date()))
        out.to_csv(paths.outputs_dir / f"demand-paths-{name}.csv.gz", index=False, compression="gzip")
    print(f"  paths exported at {time.time() - t0:.0f}s", flush=True)

    fwd_p50 = np.median(paths_by_origin[fwd_origin][:, :, :EXCESS_WEEKS], axis=1).sum(axis=1)
    rng = np.random.default_rng(SEED)
    ctx = {"fwd_p50": fwd_p50, "n": n, "lt": lt, "Yraw": Yraw, "paths": paths_by_origin, "t0": t0_idx,
           "U_plan": rng.random((n, args.paths)), "U_orders": rng.random((n, len(REVIEW_WEEKS))),
           "U_EL": rng.random(200_000),
           "price": par.median_price.to_numpy(float), "pack": par.pack_size_proxy.to_numpy(float),
           "actual": Yraw[:, t0_idx:t0_idx + 13]}
    n_boot_w = boot_weights(n)

    # Implication of under-coverage: the same policy (c) built on a narrow residual pool that
    # leaves out the autumn-2010 backtest (only the two most recent pre-test windows).
    narrow_origins = CAL_ORIGINS[1:]
    ok_n = [((o - first) >= 13) for o in narrow_origins]
    tr_n = np.vstack([((Yraw[:, o + 1:o + 1 + H] - points[o]) / level_at(Yraw, o)[:, None])[k]
                      for o, k in zip(narrow_origins, ok_n)]).astype(np.float32)
    ab_n = np.concatenate([abc[k] for k in ok_n])
    pools_n = {c: tr_n[ab_n == c] for c in ("A", "B", "C")}
    paths_n = {o: build_paths(points[o], level_at(Yraw, o), abc, pools_n, args.paths, SEED + o)
               for o in review_origins}
    p90n = np.quantile(paths_n[o90][:, :, :13], 0.9, axis=1)
    narrow = {"origins": [f"{weeks[o + 1].date()} to {weeks[o + H].date()}" for o in narrow_origins],
              "weekly_p90_coverage": float((act <= p90n).mean())}

    scenarios = {
        "base": dict(BASE),
        "L=2": {**BASE, "mean_L": 2.0}, "L=8": {**BASE, "mean_L": 8.0},
        "reliable supplier (low-CV tier)": {**BASE, "cv": "low"},
        "unreliable supplier (high-CV tier)": {**BASE, "cv": "high"},
        "reliable supplier, median = 4 wk": {**BASE, "cv": "low", "match": "median"},
        "unreliable supplier, median = 4 wk": {**BASE, "cv": "high", "match": "median"},
        "no lead-time variability": {**BASE, "cv": "zero"},
        "cost ratio 0.35": {**BASE, "cost_ratio": 0.35}, "cost ratio 0.65": {**BASE, "cost_ratio": 0.65},
        "holding 15%/yr": {**BASE, "holding": 0.15}, "holding 35%/yr": {**BASE, "holding": 0.35},
        "stockout = 0.5 x margin": {**BASE, "stockout_mult": 0.5},
        "stockout = 2 x margin": {**BASE, "stockout_mult": 2.0},
        "start = 0.5 x (a)": {**BASE, "start": "a0.5"}, "start = 1.5 x (a)": {**BASE, "start": "a1.5"},
        "start = own level (biased)": {**BASE, "start": "own"},
        "markdown m = 0": {**BASE, "markdown": 0.0}, "markdown m = 0.15": {**BASE, "markdown": 0.15},
        "markdown m = 0.5": {**BASE, "markdown": 0.5},
    }
    rows, metas, base_res = [], {}, None
    res_n, meta_n = run_scenario(dict(BASE), {**ctx, "paths": paths_n})
    agg_n = aggregate(res_n["c"], n_boot_w)
    narrow.update({"c_fill": agg_n["fill_rate"], "c_csl": agg_n["csl"], "c_total": agg_n["total_cost"],
                   "cr_by_review": meta_n["cr_by_review"],
                   "c_inv": agg_n["avg_inv_value"], "median_cr": meta_n["median_cr"],
                   "c_csl_lo": agg_n["csl_lo"], "c_csl_hi": agg_n["csl_hi"]})
    for name, sc in scenarios.items():
        res, meta = run_scenario(sc, ctx, extra_checks=(name == "base"))
        metas[name] = meta
        if name == "base":
            base_res = res
        for pol, df in res.items():
            agg = aggregate(df, n_boot_w, ref=res["b"])
            rows.append({"scenario": name, "policy": pol, "mean_L": sc["mean_L"], "cv": meta["cv"],
                         "E_L": meta["EL"], "median_L": meta["median_L"], **agg})
        print(f"  scenario {name} done at {time.time() - t0:.0f}s", flush=True)
    summary = pd.DataFrame(rows)
    summary.to_csv(paths.outputs_dir / "replenishment-scenarios.csv", index=False)

    # ABC breakdown (base)
    abc_rows = []
    for pol in ("a", "b", "c", "d0.6", "d0.8", "d1.0"):
        df = base_res[pol]
        for g in ("A", "B", "C"):
            sub = df[abc == g].reset_index(drop=True)
            agg = aggregate(sub, boot_weights(len(sub)))
            abc_rows.append({"policy": pol, "abc": g, "skus": len(sub), **agg})
    abc_tab = pd.DataFrame(abc_rows)
    abc_tab.to_csv(paths.outputs_dir / "replenishment-abc.csv", index=False)

    # sanity checks (base)
    bm = metas["base"]
    s_base = summary[summary.scenario == "base"].set_index("policy")
    budget_fill = [s_base.loc[f"d{f}", "fill_rate"] for f in BUDGET_FACTORS + (EXTRA_BUDGET,)]
    ss_base = metas["base"]["safety_stock_value_c"]
    ss_zero = metas["no lead-time variability"]["safety_stock_value_c"]
    checks = {
        "c_cr05_fill": float(s_base.loc["c50", "fill_rate"]), "p50_fill": float(s_base.loc["p50", "fill_rate"]),
        "c_cr05_csl": float(s_base.loc["c50", "csl"]), "c_csl": float(s_base.loc["c", "csl"]),
        "c_cr05_inv": float(s_base.loc["c50", "avg_inv_value"]), "p50_inv": float(s_base.loc["p50", "avg_inv_value"]),
        "budget_factors": list(BUDGET_FACTORS + (EXTRA_BUDGET,)), "budget_fill": [float(x) for x in budget_fill],
        "budget_monotone": bool(np.all(np.diff(budget_fill) >= -1e-12)),
        "ss_value_base": ss_base, "ss_value_zero_cv": ss_zero, "ss_lower_without_variability": bool(ss_zero < ss_base),
        "milp_all_optimal": bool(all(m["status"] == 0 for m in bm["milp"])),
        "milp_max_gap": float(np.nanmax([m["mip_gap"] for m in bm["milp"]])),
        "milp_max_lp_gap": float(max((m["objective"] - m["lp_bound"]) / abs(m["objective"]) for m in bm["milp"])),
        "milp_count": len(bm["milp"]),
        "milp_infeasible_budgets": int(sum(not m["feasible_budget"] for m in bm["milp"])),
    }
    planned_csl_c = float(np.median(metas["base"]["median_cr"]))

    # planned vs realised service of (c): plan from the paths at each review
    key = {"lead_time": lt, "calibration": {"origins": {str(k): v for k, v in cal_windows.items()},
                                            "trajectories": {c: int(len(p)) for c, p in pools.items()}, **diag},
           "checks": checks, "base": s_base.drop(columns=["scenario"]).reset_index().to_dict(orient="records"),
           "median_cr_base": planned_csl_c, "E_L_base": bm["EL"], "n_skus": n, "paths": args.paths,
           "review_weeks": [str(weeks[t0_idx + t].date()) for t in REVIEW_WEEKS], "variant": variant,
           "tail": tail_numbers(paths, skus), "narrow_pool": narrow,
           "safety_stock_value_c": {k: v["safety_stock_value_c"] for k, v in metas.items()}}
    (paths.outputs_dir / "key-numbers-replenishment.json").write_text(json.dumps(key, indent=2, default=float),
                                                                       encoding="utf-8")
    figures(paths, summary, s_base, checks)
    write_report(paths, lt, key, summary, s_base, abc_tab, checks, metas, cal_windows, time.time() - t0)
    print(f"Wrote replenishment-results.md in {time.time() - t0:.0f}s")
    print(s_base[["fill_rate", "csl", "avg_inv_value", "holding", "lost_margin", "total_cost", "orders"]].round(3))
    return 0


def tail_numbers(paths, skus) -> dict:
    st = json.loads((paths.derived_dir / "clean_stats.json").read_text(encoding="utf-8"))
    return {"product_skus": st["sku_counts"]["product_skus_with_sales"], "panel_skus": st["panel"]["n_skus"],
            "tail_skus": st["sku_counts"]["product_skus_with_sales"] - st["panel"]["n_skus"],
            "tail_revenue_share": 1 - st["panel"]["panel_share_of_train_revenue"],
            "tail_units_share": 1 - st["panel"]["panel_share_of_train_units"]}


# ----------------------------------------------------------------------------- output
def figures(paths, summary, s_base, checks):
    import matplotlib.pyplot as plt
    figs = paths.figures_dir
    pols = ["a", "b", "c", "d0.6", "d0.8", "d1.0"]
    fig, ax = plt.subplots(figsize=(7.5, 4))
    for k, p in enumerate(pols):
        r = s_base.loc[p]
        ax.scatter(r.avg_inv_value / 1e3, r.fill_rate, s=44 if p in ("a", "c") else 36, color=P.SERIES[k], zorder=3,
                   marker="o" if p in ("a", "c", "d0.6") else "s", edgecolor=P.SURFACE, linewidth=1.5,
                   label=POLICY_LABELS[p])
    ax.legend(loc="lower right", fontsize=7)
    ax.set_xlabel("average inventory value (£ thousand, cost basis)")
    ax.set_ylabel("fill rate (units served / demand)")
    ax.yaxis.set_major_formatter(plt.matplotlib.ticker.PercentFormatter(1.0))
    ax.set_title("Base case: service vs inventory by policy (13 test weeks)")
    P.save(fig, figs / "replenishment-service-inventory.png")

    fig, ax = plt.subplots(figsize=(7.5, 3.6))
    sc = ["reliable supplier (low-CV tier)", "base", "unreliable supplier (high-CV tier)"]
    x = np.arange(len(sc))
    for k, p in enumerate(["b", "c", "d0.8"]):
        vals = [summary[(summary.scenario == s) & (summary.policy == p)].total_cost.iloc[0] / 1e3 for s in sc]
        ax.bar(x + (k - 1) * 0.26, vals, width=0.24, color=P.SERIES[k], label=POLICY_LABELS[p][:60])
    ax.set_xticks(x, ["reliable (low CV)", "SCMS all direct drop", "unreliable (high CV)"])
    ax.set_ylabel("total cost, £ thousand (13 weeks)")
    ax.set_title("Supplier reliability: holding + lost margin, mean L = 4 weeks")
    ax.legend(fontsize=7)
    P.save(fig, figs / "replenishment-supplier-reliability.png")

    fig, ax = plt.subplots(figsize=(6.5, 3.4))
    f = checks["budget_factors"]
    inv = [s_base.loc[f"d{b}", "avg_inv_value"] / 1e3 for b in f]
    ax.plot(inv, checks["budget_fill"], marker="o", color=P.SERIES[0])
    for b, xi, yi in zip(f, inv, checks["budget_fill"]):
        ax.annotate(f"B = {b} x (c)", (xi, yi), textcoords="offset points", xytext=(5, -10), fontsize=7, color=P.TEXT2)
    ax.yaxis.set_major_formatter(plt.matplotlib.ticker.PercentFormatter(1.0))
    ax.set_xlabel("realised average inventory value (£ thousand)")
    ax.set_ylabel("fill rate")
    ax.set_title("Budgeted policy (d): fill rate vs budget")
    P.save(fig, figs / "replenishment-budget.png")


def fmt_money(v):
    return f"−£{abs(v):,.0f}" if v < 0 else f"£{v:,.0f}"


def write_report(paths, lt, key, summary, s_base, abc_tab, checks, metas, cal_windows, seconds):
    L = []
    a = L.append
    bm = metas["base"]
    diag = key["calibration"]
    tail = key["tail"]
    a("# Replenishment policy backtest (retail half, rubric section 5)")
    a("")
    a("All numbers are computed by `analytics/retail/decision.py`. Money is in **GBP (£)**, the currency of the "
      "Online Retail II data, and valued at the assumed unit cost. The seed is fixed.")
    a("")
    a("## 1. The decision and who acts on it")
    a("")
    a("Every four weeks the buyer decides, per SKU, how much to order from the supplier. In FlowChain this is the "
      "purchase-request step on the inventory page. The analysis sets the order-up-to level for each SKU from the "
      "demand forecast, the supplier's lead-time variability (part 2, SCMS) and the cost of stock versus lost sales.")
    a("")
    a("## 2. Formulation")
    a("")
    a(f"- **Review:** periodic review every R = {R} weeks, at the starts of test weeks "
      + ", ".join(key["review_weeks"]) + ". An order raises the inventory position (on hand + on order) to the "
      "order-up-to level S, rounded up to the SKU's pack-size proxy. Each review uses only data up to the week before.")
    a(f"- **Lead time L (ASSUMED mean, SCMS variability):** lognormal with mean 2, 4 or 8 weeks. The coefficient of "
      f"variation comes from SCMS direct-drop actual lead times (`{Path(lt['file']).name}`, 'usable for lead time' "
      f"subset: {lt['rows']:,} lines, median {lt['median_days']:.0f} days, **CV {lt['cv_all']:.3f}**). L is rounded to "
      f"whole weeks with a minimum of 1 (assumption). At mean 4 the realised E[L] is {bm['EL']:.2f} weeks. SCMS absolute "
      "lead times (air/ocean to about 40 countries) do not fit a UK gift wholesaler, so only the variability is used.")
    a(f"- **Supplier tiers:** among the {lt['vendors_n30']} SCMS vendors with at least 30 lines, the "
      f"{lt['tier_size']} with the lowest CV form the *reliable* tier (pooled within-vendor CV "
      f"{lt['cv_low_tier']:.3f}) and the {lt['tier_size']} with the highest CV the *unreliable* tier "
      f"({lt['cv_high_tier']:.3f}). Within-vendor CV = SD of lead time ÷ that vendor's mean.")
    a("- **Costs (ASSUMPTIONS, base case):** unit cost = 0.5 × median selling price; holding 25% of cost per year; "
      "stockout = lost margin (price − cost) per unit, with no backorders; **terminal markdown/obsolescence** "
      f"m = {BASE['markdown']} × unit cost per unit of inventory position (on hand + on order) left after week 13, "
      "i.e. gift-ware left after Christmas. "
      "Sensitivity: cost ratio 0.35 and 0.65; holding 15% and 35%; stockout 0.5× and 2× margin; m = 0, 0.15, 0.5.")
    a("- **Policies** (same information at each review):")
    for p in ("a", "b", "c"):
        a(f"  - {POLICY_LABELS[p]}")
    a("  - (d) the same demand distribution as (c), under a working-capital budget: a multiple-choice knapsack "
      "solved as a MILP (`scipy.optimize.milp`, HiGHS).")
    a("")
    a("  Detail of the rules:")
    a("  - (a) S = (E[L] + R) × mean of the last 4 weeks.")
    a("  - (b) d = mean of the last 13 weeks (≈ 90 days); ROP = d·E[L] + 1 week of d; target = ROP + d·R; order "
      "up to target only when IP ≤ ROP. This implements the rule as given in the brief. The repository stores "
      "reorder point and safety stock as item parameters (`server/domain/inventory-allocation-read-model.mjs` flags "
      "available < reorder point or ≤ 7 days of cover); no document with this exact formula was found.")
    a("  - (c) S = the CR-quantile of simulated demand over L + R, CR = c_u / (c_u + c_o), c_u = stockout cost per "
      "unit. This is the multi-period newsvendor logic. In an intermediate cycle, a unit left over is not lost: it "
      "carries to the next cycle, so its overage cost is holding over E[L] + R weeks. In the final cycle, where "
      "the protection interval t + E[L] + R runs past week 13, a leftover unit also takes the terminal markdown: "
      "c_o = holding + m × unit cost. In the base case the final-cycle reviews are weeks "
      + ", ".join(str(t) for t in bm["final_reviews"]) + ". Median CR by review: "
      + " / ".join(f"{x:.3f}" for x in bm["cr_by_review"]) + ".")
    a("  - (d) per review, choose one level per SKU from {P50, P70, P80, P90, P95, P98} of the same distribution. "
      "Minimise Σ c_u·E[shortage over L+R] + holding·R·E[on hand] (+ m·cost·E[leftover] in the final cycle), "
      "subject to Σ cost·E[on hand] ≤ B, "
      "E[on hand] ≈ E[(S − D_{L+R})⁺] + E[D_R]/2, and B = 0.6, 0.8, 1.0 × the same planned inventory "
      "value of (c). HiGHS proves optimality (see section 6).")
    a("")
    a("## 3. Backtest set-up")
    a("")
    a(f"- **Window:** the 13 test weeks, {key['n_skus']} panel SKUs, with actual gross shipped demand (raw, bulk "
      "lines included). **Starting inventory is the same for every policy:** the rule-of-thumb (a) order-up-to "
      "level at the test origin, standing for current practice, with an empty pipeline. Policies that want more "
      "stock order it at week 0 and wait for the lead time. Sensitivity: 0.5x and 1.5x that level (section 8). "
      "A start from the SKU's historical weeks of cover would be better, but the data has no stock levels, so it "
      "cannot be estimated. The earlier set-up, where each policy starts at its own level, is kept only as a "
      "secondary table because it is biased toward high-stock policies.")
    a("- **Lost sales, no backorders:** unmet demand in a week is lost. Holding is charged on end-of-week stock. "
      "L is drawn per order, with the same random numbers for every policy and scenario, so differences come from "
      "the policies, not from luck.")
    a("- **Metrics:** fill rate = units served ÷ demand; cycle service level = share of SKU × 4-week cycles "
      "without a lost sale (weeks 0–3, 4–7, 8–11, 12); lost units and lost margin; average inventory value "
      "(cost basis) and weeks of supply; holding cost; **terminal cost** = m × unit cost × inventory position "
      "(on hand + on order) left after week 13. Orders placed at the last reviews are commitments that arrive "
      "into the post-season, so leaving them out would reward late ordering. "
      "**total cost = holding + stockout cost + terminal cost**; number of orders. Alternative without a markdown "
      f"assumption: charge at cost only the stock beyond {EXCESS_WEEKS} weeks of forward P50 demand (from the "
      "forward demand paths), which is true excess. **Ending weeks of supply** = units left ÷ forward P50 weekly "
      "demand. 95% CIs resample SKUs (2,000 draws).")
    a("")
    a("## 4. Demand paths and recalibration")
    a("")
    a(f"- A GBM with horizon {H} (same features and settings as in `demand-forecast.md`, {key['variant']} "
      "history) is refitted at each review. Paths = point forecast + a scaled residual trajectory "
      "(residual ÷ the SKU's 13-week level), drawn as a whole 26-week block from SKUs in the same ABC class. "
      f"There are {key['paths']} paths per SKU. Whole blocks keep the week-to-week correlation of a SKU's errors, "
      "which `decision-inputs.md` showed is strong.")
    a("- **Recalibration:** the earlier P50/P90 were calibrated on March–August 2011 and **missed the autumn "
      "ramp**. The residual pool now comes from three backtests whose windows are "
      + "; ".join(f"{v}" for v in cal_windows.values())
      + ". The first covers autumn 2010, the most recent comparable season. Its GBM had only about 25 weeks of "
      "training origins and no year-ago features, so its errors are larger than today's model's. The pool is "
      "therefore conservative (wide).")
    a(f"- On the test origin, the path P90 covers **{diag['weekly_p90_coverage']:.1%}** of SKU-weeks (before: "
      f"85.6%) and the P50 {diag['weekly_p50_coverage']:.1%}. The P90 of 4-week totals covers "
      + ", ".join(f"{diag[f'sum4_p90_coverage_h{h}']:.1%}" for h in (1, 5, 9))
      + " for weeks 1–4, 5–8 and 9–12. This is a diagnostic only; the pool was fixed before looking at it.")
    a("- Exported for the joint decision model: `demand-paths-test.csv.gz` (origin = the test origin) and "
      "`demand-paths-forward.csv.gz` (origin = the last full week). Each has one row per SKU × path, weekly "
      "simulated units w01–w26.")
    a("")
    a("## 5. Results, base case (mean L = 4 weeks, SCMS CV)")
    a("")
    a("| Policy | fill rate [95% CI] | cycle service [CI] | lost units | lost margin | avg inventory value [CI] | "
      "weeks of supply | holding | terminal markdown | **total cost [95% CI]** | Δ total vs (b) [paired CI] | orders | "
      "stock left after week 13 (of which on order) | ending weeks of supply |")
    a("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for p in ("a", "b", "c", "d0.6", "d0.8", "d1.0", "p50", "p70", "p80", "p90"):
        r = s_base.loc[p]
        a(f"| {POLICY_LABELS[p]} | {r.fill_rate:.1%} [{r.fill_rate_lo:.1%}, {r.fill_rate_hi:.1%}] | "
          f"{r.csl:.1%} [{r.csl_lo:.1%}, {r.csl_hi:.1%}] | {r.lost_units:,.0f} | {fmt_money(r.lost_margin)} | "
          f"{fmt_money(r.avg_inv_value)} [{fmt_money(r.avg_inv_value_lo)}, {fmt_money(r.avg_inv_value_hi)}] | "
          f"{r.weeks_of_supply:.1f} | {fmt_money(r.holding)} | {fmt_money(r.terminal)} | **{fmt_money(r.total_cost)}** "
          f"[{fmt_money(r.total_cost_lo)}, {fmt_money(r.total_cost_hi)}] | "
          + ("–" if p == "b" else f"{fmt_money(r.d_total_vs_b)} [{fmt_money(r.d_total_vs_b_lo)}, "
             f"{fmt_money(r.d_total_vs_b_hi)}]") + f" | {int(r.orders):,} | {fmt_money(r.end_inv_value)} "
          f"({fmt_money(r.end_on_order_value)}) | "
          f"{r.end_weeks_of_supply:.1f} |")
    a("")
    a("The reference rows use a fixed quantile (P50–P90) of the same simulated demand for every SKU. They check "
      "whether less protection than (c) would do better.")
    a("")
    a(f"**Without a markdown assumption** (only the stock and orders beyond {EXCESS_WEEKS} weeks of forward P50 "
      "demand are charged, at full unit cost, as true excess; same simulated runs as the base case):")
    a("")
    a("| Policy | true excess at week 13 | holding + stockout + excess [95% CI] | ending weeks of supply |")
    a("|---|---|---|---|")
    for p in ("a", "b", "c", "d0.6", "d0.8", "d1.0", "p50", "p70", "p80", "p90"):
        r = s_base.loc[p]
        a(f"| {POLICY_LABELS[p]} | {fmt_money(r.excess_value)} | {fmt_money(r.alt_total)} "
          f"[{fmt_money(r.alt_total_lo)}, {fmt_money(r.alt_total_hi)}] | {r.end_weeks_of_supply:.1f} |")
    a("")
    a("![service vs inventory](figures/replenishment-service-inventory.png)")
    a("")
    a("**By ABC class** (fill rate / average inventory value / total cost):")
    a("")
    a("| Policy | A | B | C |")
    a("|---|---|---|---|")
    for p in ("a", "b", "c", "d0.6", "d0.8", "d1.0"):
        cells = []
        for g in ("A", "B", "C"):
            r = abc_tab[(abc_tab.policy == p) & (abc_tab.abc == g)].iloc[0]
            cells.append(f"{r.fill_rate:.1%} [{r.fill_rate_lo:.1%}, {r.fill_rate_hi:.1%}] / "
                         f"{fmt_money(r.avg_inv_value)} / {fmt_money(r.total_cost)}")
        a(f"| {p} | " + " | ".join(cells) + " |")
    a("")
    a("## 6. Sanity checks")
    a("")
    a("| Check | Expected | Result | Pass |")
    a("|---|---|---|---|")
    a(f"| (c) with CR forced to 0.5 vs a fixed P50 order-up-to level | same behaviour; far lower service than "
      f"(c) at its CR | fill {checks['c_cr05_fill']:.1%} vs {checks['p50_fill']:.1%}; inventory "
      f"{fmt_money(checks['c_cr05_inv'])} vs {fmt_money(checks['p50_inv'])}; cycle service "
      f"{checks['c_cr05_csl']:.1%} vs {checks['c_csl']:.1%} for (c) | "
      f"{'yes' if abs(checks['c_cr05_fill'] - checks['p50_fill']) < 0.005 else 'no'} |")
    a(f"| (d) budget 0.6 → 0.8 → 1.0 → 1.2 × (c) | fill rate rises monotonically | "
      + " → ".join(f"{x:.1%}" for x in checks["budget_fill"]) + f" | {'yes' if checks['budget_monotone'] else 'no'} |")
    a(f"| Lead time without variability (CV 0) | lower safety stock | (c) safety stock (S − E[D over L+R], "
      f"at cost, week-0 review) {fmt_money(checks['ss_value_zero_cv'])} vs {fmt_money(checks['ss_value_base'])} "
      f"| {'yes' if checks['ss_lower_without_variability'] else 'no'} |")
    a(f"| MILP solved to proven optimality (HiGHS, relative gap tolerance 1e-9) | status 0, gap ≈ 0 | "
      f"{checks['milp_count']} solves, all optimal: {checks['milp_all_optimal']}; largest MIP gap "
      f"{checks['milp_max_gap']:.1e}; largest distance to the LP-relaxation bound {checks['milp_max_lp_gap']:.1e} "
      f"(a multiple-choice knapsack has at most two fractional variables in its LP); infeasible budgets "
      f"{checks['milp_infeasible_budgets']} | "
      f"{'yes' if checks['milp_all_optimal'] else 'no'} |")
    a("")
    a("![budget](figures/replenishment-budget.png)")
    a("")
    a("## 7. Supplier reliability and lead time: the bridge to part 2")
    a("")
    sc_names = ["reliable supplier (low-CV tier)", "base", "unreliable supplier (high-CV tier)",
                "reliable supplier, median = 4 wk", "unreliable supplier, median = 4 wk",
                "no lead-time variability", "L=2", "L=8"]
    a("| Scenario | CV of L | E[L] | median L | policy | fill rate | avg inventory value | total cost |")
    a("|---|---|---|---|---|---|---|---|")
    for s in sc_names:
        for p in ("b", "c", "d0.8"):
            r = summary[(summary.scenario == s) & (summary.policy == p)].iloc[0]
            a(f"| {s} | {r.cv:.2f} | {r.E_L:.2f} | {r.median_L:.0f} | {p} | {r.fill_rate:.1%} | "
              f"{fmt_money(r.avg_inv_value)} | "
              f"{fmt_money(r.total_cost)} |")
    a("")
    rel = summary[(summary.scenario == "reliable supplier (low-CV tier)")].set_index("policy")
    unr = summary[(summary.scenario == "unreliable supplier (high-CV tier)")].set_index("policy")
    a("Two versions of the contrast, because a lognormal cannot hold both the mean and the median fixed while "
      "its dispersion changes: **mean-matched** (mean 4 weeks for both tiers; the high-CV tier then has a much lower "
      "median) and **median-matched** (median 4 weeks for both; the high-CV tier then has a higher mean, i.e. a "
      "long tail of late orders).")
    a("")
    a("| Version | tier | CV | E[L] | median L | (b) total | (c) total [95% CI] | (d, 0.8) total | (c) safety stock at week 0 |")
    a("|---|---|---|---|---|---|---|---|---|")
    for ver, rel_name, unr_name in (("mean-matched", "reliable supplier (low-CV tier)", "unreliable supplier (high-CV tier)"),
                                    ("median-matched", "reliable supplier, median = 4 wk",
                                     "unreliable supplier, median = 4 wk")):
        for tier, nm in (("reliable", rel_name), ("unreliable", unr_name)):
            d = summary[summary.scenario == nm].set_index("policy")
            mt = metas[nm]
            a(f"| {ver} | {tier} | {mt['cv']:.2f} | {mt['EL']:.2f} | {mt['median_L']:.0f} | "
              f"{fmt_money(d.loc['b', 'total_cost'])} | {fmt_money(d.loc['c', 'total_cost'])} "
              f"[{fmt_money(d.loc['c', 'total_cost_lo'])}, {fmt_money(d.loc['c', 'total_cost_hi'])}] | "
              f"{fmt_money(d.loc['d0.8', 'total_cost'])} | {fmt_money(mt['safety_stock_value_c'])} |")
    a("")
    for ver, rel_name, unr_name in (("Mean-matched", "reliable supplier (low-CV tier)", "unreliable supplier (high-CV tier)"),
                                    ("Median-matched", "reliable supplier, median = 4 wk",
                                     "unreliable supplier, median = 4 wk")):
        r_, u_ = (summary[summary.scenario == x].set_index("policy") for x in (rel_name, unr_name))
        mr, mu = metas[rel_name], metas[unr_name]
        parts = []
        for p in ("b", "c", "d0.8"):
            dlt = u_.loc[p, "total_cost"] - r_.loc[p, "total_cost"]
            parts.append(f"{p} {'+' if dlt >= 0 else '−'}{fmt_money(abs(dlt))}")
        a(f"**{ver}, in money (GBP, 13 weeks, {key['n_skus']} SKUs):** going from the reliable to the unreliable tier "
          f"changes total cost by " + ", ".join(parts) + f". The safety stock of (c) at the week-0 review goes from "
          f"{fmt_money(mr['safety_stock_value_c'])} to {fmt_money(mu['safety_stock_value_c'])} "
          f"({fmt_money(mu['safety_stock_value_c'] - mr['safety_stock_value_c'])}). Median L is "
          f"{mr['median_L']:.0f} vs {mu['median_L']:.0f} weeks, and E[L] {mr['EL']:.2f} vs {mu['EL']:.2f}.")
        a("")
    a("How to read it: in the mean-matched version the high-CV tier has a shorter median lead time, so most "
      "orders arrive early. A rule that ignores variability can then look no worse, or even better, with the "
      "unreliable supplier, which is an artefact of the shape rather than a benefit of unreliability. The "
      "median-matched version removes that artefact: typical orders take the same 4 weeks, and the unreliable "
      "tier only adds late orders. The difference between the tiers in that version is the cost of lead-time "
      "unreliability that the SCMS scorecard measures (part 2).")
    a("")
    a("![supplier reliability](figures/replenishment-supplier-reliability.png)")
    a("")
    a("## 8. Cost sensitivity (mean L = 4, SCMS CV)")
    a("")
    a("| Scenario | median CR | (a) total | (b) total | (c) total | (d, 0.8) total | (c) fill | cheapest policy |")
    a("|---|---|---|---|---|---|---|---|")
    for s in ["base", "cost ratio 0.35", "cost ratio 0.65", "holding 15%/yr", "holding 35%/yr",
              "stockout = 0.5 x margin", "stockout = 2 x margin"]:
        d = summary[summary.scenario == s].set_index("policy")
        main = d.loc[["a", "b", "c", "d0.6", "d0.8", "d1.0"]]
        a(f"| {s} | {metas[s]['median_cr']:.3f} | {fmt_money(d.loc['a', 'total_cost'])} | "
          f"{fmt_money(d.loc['b', 'total_cost'])} | {fmt_money(d.loc['c', 'total_cost'])} | "
          f"{fmt_money(d.loc['d0.8', 'total_cost'])} | {d.loc['c', 'fill_rate']:.1%} | {main.total_cost.idxmin()} |")
    a("")
    a("### Terminal markdown m")
    a("")
    a("(c) and (d) re-plan for each m (the final-cycle overage cost changes); (a) and (b) do not use m.")
    a("")
    a("| m | (a) total | (b) total | (c) total [95% CI] | (d, 0.6) total | (d, 0.8) total | (c) fill | cheapest policy |")
    a("|---|---|---|---|---|---|---|---|")
    for s_, m in (("markdown m = 0", 0.0), ("markdown m = 0.15", 0.15), ("base", BASE["markdown"]),
                  ("markdown m = 0.5", 0.5)):
        d = summary[summary.scenario == s_].set_index("policy")
        main = d.loc[["a", "b", "c", "d0.6", "d0.8", "d1.0"]]
        a(f"| {m}{' (base)' if s_ == 'base' else ''} | {fmt_money(d.loc['a', 'total_cost'])} | "
          f"{fmt_money(d.loc['b', 'total_cost'])} | {fmt_money(d.loc['c', 'total_cost'])} "
          f"[{fmt_money(d.loc['c', 'total_cost_lo'])}, {fmt_money(d.loc['c', 'total_cost_hi'])}] | "
          f"{fmt_money(d.loc['d0.6', 'total_cost'])} | {fmt_money(d.loc['d0.8', 'total_cost'])} | "
          f"{d.loc['c', 'fill_rate']:.1%} | {main.total_cost.idxmin()} |")
    a("")
    a("### Starting inventory")
    a("")
    a("| Start (all policies alike) | (a) total | (b) total | (c) total | (d, 0.6) total | (d, 0.8) total | "
      "(c) fill | cheapest policy |")
    a("|---|---|---|---|---|---|---|---|")
    for s, lab in (("start = 0.5 x (a)", "0.5 x (a) level"), ("base", "(a) level (base)"),
                   ("start = 1.5 x (a)", "1.5 x (a) level")):
        d = summary[summary.scenario == s].set_index("policy")
        main = d.loc[["a", "b", "c", "d0.6", "d0.8", "d1.0"]]
        a(f"| {lab} | {fmt_money(d.loc['a', 'total_cost'])} | {fmt_money(d.loc['b', 'total_cost'])} | "
          f"{fmt_money(d.loc['c', 'total_cost'])} | {fmt_money(d.loc['d0.6', 'total_cost'])} | "
          f"{fmt_money(d.loc['d0.8', 'total_cost'])} | {d.loc['c', 'fill_rate']:.1%} | {main.total_cost.idxmin()} |")
    a("")
    a("**Secondary table, BIASED toward high-stock policies:** each policy starts at its own order-up-to level "
      "(the first version of this backtest). A policy with a higher level then gets that stock for free at week 0.")
    a("")
    a("| Policy | fill rate | avg inventory value | total cost |")
    a("|---|---|---|---|")
    d = summary[summary.scenario == "start = own level (biased)"].set_index("policy")
    for p in ("a", "b", "c", "d0.6", "d0.8", "d1.0"):
        a(f"| {POLICY_LABELS[p]} | {d.loc[p, 'fill_rate']:.1%} | {fmt_money(d.loc[p, 'avg_inv_value'])} | "
          f"{fmt_money(d.loc[p, 'total_cost'])} |")
    a("")
    write_discussion(a, lt, key, summary, s_base, metas, checks, tail)
    a("")
    a(f"_Runtime {seconds / 60:.1f} min._")
    (paths.outputs_dir / "replenishment-results.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def write_discussion(a, lt, key, summary, s_base, metas, checks, tail):
    b, c, aa = s_base.loc["b"], s_base.loc["c"], s_base.loc["a"]
    main = s_base.loc[["a", "b", "c", "d0.6", "d0.8", "d1.0"]]
    best = main.total_cost.idxmin()
    best_alt = main.alt_total.idxmin()
    diag, nar = key["calibration"], key["narrow_pool"]
    cr = metas["base"]["cr_by_review"]
    refs = s_base.loc[["p50", "p70", "p80", "p90"]]
    best_ref = refs.total_cost.idxmin()
    p50 = s_base.loc[best_ref]
    a("## 9. Do the decisions make sense?")
    a("")
    a(f"- **Lowest total cost in the base case: {POLICY_LABELS[best]}**, {fmt_money(main.loc[best, 'total_cost'])} "
      f"[{fmt_money(main.loc[best, 'total_cost_lo'])}, {fmt_money(main.loc[best, 'total_cost_hi'])}], including the "
      f"terminal markdown. Without a markdown assumption (true excess only) the cheapest is {POLICY_LABELS[best_alt]}. "
      f"Policy (c) against FlowChain's rule (b): fill {c.fill_rate:.1%} vs {b.fill_rate:.1%}; average inventory "
      f"{fmt_money(c.avg_inv_value)} vs {fmt_money(b.avg_inv_value)}; total {fmt_money(c.total_cost)} vs "
      f"{fmt_money(b.total_cost)} (paired Δ {fmt_money(c.d_total_vs_b)}, CI [{fmt_money(c.d_total_vs_b_lo)}, "
      f"{fmt_money(c.d_total_vs_b_hi)}]). The rule of thumb (a) is close to (b) (fill {aa.fill_rate:.1%}, total "
      f"{fmt_money(aa.total_cost)}). Among the fixed-quantile references the cheapest is "
      f"{POLICY_LABELS[best_ref]}: fill {p50.fill_rate:.1%}, total {fmt_money(p50.total_cost)} "
      f"[{fmt_money(p50.total_cost_lo)}, {fmt_money(p50.total_cost_hi)}], "
      + ("so less protection than (c) does not pay." if p50.total_cost > c.total_cost else
         ("so a lower quantile beats (c)" + (" and every policy (a)–(d) here." if p50.total_cost < main.total_cost.min()
                                              else " here."))))
    a(f"- **Why (a) and (b) lose.** They set stock from recent averages, with no term for the autumn ramp or for "
      f"lead-time variability, so they run short when demand rises. A lost unit costs the whole margin "
      f"({1 - BASE['cost_ratio']:.0%} of price) and a week of holding {BASE['holding'] / 52 * BASE['cost_ratio']:.2%} of "
      f"price, so lost margin dominates their cost ({fmt_money(b.lost_margin)} of {fmt_money(b.total_cost)} for (b)).")
    a(f"- **What the terminal charge does to (c).** (c) holds {c.weeks_of_supply:.0f} weeks of supply on average and "
      f"ends with {c.end_weeks_of_supply:.1f} weeks of forward P50 demand in stock and on order "
      f"({fmt_money(c.end_inv_value)}, of which {fmt_money(c.end_on_order_value)} on order), against "
      f"{b.end_weeks_of_supply:.1f} weeks for (b). At m = {BASE['markdown']} that leftover costs {fmt_money(c.terminal)}; "
      f"the true excess beyond {EXCESS_WEEKS} weeks is {fmt_money(c.excess_value)}. The final-cycle critical ratio "
      "includes the markdown (median " + " / ".join(f"{x:.3f}" for x in cr) + " by review), so (c) orders less "
      "at the last reviews. But the multi-period logic still prices leftovers from the early cycles at holding "
      "cost only, as if they would sell later. With a 13-week season ending at Christmas, much of that early "
      "stock is still there at the end and takes the markdown too. Together with a wide demand distribution, "
      "this is why (c) over-buys once the end of season is priced.")
    dn = {f: s_base.loc[f"d{f}"] for f in (0.6, 0.8, 1.0)}
    a(f"- **Budgeted (d).** At 0.6 × (c): fill {dn[0.6].fill_rate:.1%}, inventory {fmt_money(dn[0.6].avg_inv_value)} "
      f"({dn[0.6].avg_inv_value / c.avg_inv_value:.0%} of (c)), total {fmt_money(dn[0.6].total_cost)}; at 0.8: "
      f"{fmt_money(dn[0.8].total_cost)}; at 1.0: {fmt_money(dn[1.0].total_cost)}. "
      + (f"A tighter budget lowers realised cost, so the planning distribution is wider than the test turned out and "
         "(c) over-protects. A working-capital cap is the better default for a small business."
         if dn[0.6].total_cost < c.total_cost else
         "The budget cap does not lower realised cost here, so (c)'s extra stock is worth its cost."))
    m_of = {"markdown m = 0": 0.0, "markdown m = 0.15": 0.15, "base": BASE["markdown"], "markdown m = 0.5": 0.5}
    parts = []
    for sname, m in sorted(m_of.items(), key=lambda kv: kv[1]):
        d = summary[(summary.scenario == sname) & summary.policy.isin(["a", "b", "c", "d0.6", "d0.8", "d1.0"])]
        d = d.set_index("policy")
        parts.append(f"m = {m}: {d.total_cost.idxmin()} ({fmt_money(d.total_cost.min())}; (c) "
                     f"{fmt_money(d.loc['c', 'total_cost'])}, (b) {fmt_money(d.loc['b', 'total_cost'])})")
    a("- **Markdown sensitivity** (cheapest of (a)–(d)): " + "; ".join(parts) + ".")
    a(f"- **P90 under-coverage → realised service.** (c) plans a cycle service of about its critical ratio "
      f"({cr[0]:.1%} at the first reviews, {cr[-1]:.1%} in the final cycle). With the recalibrated (wide) pool, "
      f"whose weekly P90 covers {diag['weekly_p90_coverage']:.1%}, it realises {c.csl:.1%} "
      f"[{c.csl_lo:.1%}, {c.csl_hi:.1%}]. Built on a narrow pool that leaves out autumn 2010 "
      f"({'; '.join(nar['origins'])}; weekly P90 coverage {nar['weekly_p90_coverage']:.1%}), the same policy realises "
      f"{nar['c_csl']:.1%} [{nar['c_csl_lo']:.1%}, {nar['c_csl_hi']:.1%}], with {nar['c_fill']:.1%} fill and total "
      f"{fmt_money(nar['c_total'])}. "
      + ("Both fall short of the plan, and the narrow pool falls further. Quantiles that under-cover in the peak "
         "season deliver less service than they promise, so planned service levels should be read as upper bounds."
         if max(c.csl, nar["c_csl"]) < cr[0] else
         "The narrow pool loses service against the wide one."))
    lvl = summary[summary.scenario.isin(["L=2", "base", "L=8"])]
    cL = lvl[lvl.policy == "c"].set_index("scenario")
    bL = lvl[lvl.policy == "b"].set_index("scenario")
    a(f"- **Lead-time mean.** (b) fill at mean L = 2 / 4 / 8 weeks: {bL.loc['L=2', 'fill_rate']:.1%} / "
      f"{bL.loc['base', 'fill_rate']:.1%} / {bL.loc['L=8', 'fill_rate']:.1%}; (c): {cL.loc['L=2', 'fill_rate']:.1%} / "
      f"{cL.loc['base', 'fill_rate']:.1%} / {cL.loc['L=8', 'fill_rate']:.1%}; (c) total "
      f"{fmt_money(cL.loc['L=2', 'total_cost'])} / {fmt_money(cL.loc['base', 'total_cost'])} / "
      f"{fmt_money(cL.loc['L=8', 'total_cost'])}. All policies start from the same stock. With a long lead time, an "
      "order placed at week 0 arrives late in the window, so the common starting stock carries more of the demand.")
    a("")
    a("## 10. Implications and limitations")
    a("")
    a("- **For FlowChain:** replace the fixed '1 week of demand' safety stock with a service-level rule that uses "
      "the forecast distribution, the supplier's measured lead-time variability (from an SCMS-style scorecard) and an "
      "end-of-season markdown for seasonal items. Offer a working-capital cap, and show planned vs realised service "
      "so users see when the forecast is too narrow.")
    a(f"- **Excluded tail:** the panel covers {key['n_skus']} of {tail['product_skus']:,} product SKUs. The other "
      f"{tail['tail_skus']:,} SKUs ({tail['tail_revenue_share']:.1%} of training revenue, "
      f"{tail['tail_units_share']:.1%} of units) are mostly intermittent or lumpy and are not in this backtest. "
      "They need Croston/SBA-type forecasts and a separate policy (for example, min–max or make-to-order).")
    a("- **Other limits:** one test season; a common starting stock that stands in for unknown actual stock; an "
      "assumed markdown rate (bracketed by m = 0–0.5 and the no-assumption excess measure); assumed costs and "
      "lead-time means (only the variability comes from SCMS); lognormal lead times; censored demand in the "
      "history. Treat the money figures as a comparison between policies, not as a forecast of profit.")


if __name__ == "__main__":
    sys.exit(main())
