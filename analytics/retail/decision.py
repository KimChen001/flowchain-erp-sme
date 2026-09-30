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
- Starting inventory of each SKU = that policy's order-up-to level at week 0 (no pipeline).
- Demand = actual gross shipped units in the test weeks (raw, bulk lines included).
- Demand paths: GBM point forecasts (horizon 26, capped history, refitted at each review)
  plus scaled residual trajectories from three pre-test backtests, resampled as whole
  26-week blocks within ABC class, which keeps each SKU's week-to-week error correlation.
- Lead time: lognormal with an ASSUMED mean (2, 4 or 8 weeks) and the coefficient of
  variation of SCMS direct-drop actual lead times; rounded to whole weeks, minimum 1.
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
BASE = dict(mean_L=4.0, cv="all", cost_ratio=0.50, holding=0.25, stockout_mult=1.0)
POLICY_LABELS = {
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


def lead_weeks(u: np.ndarray, mean_L: float, cv: float) -> np.ndarray:
    """Inverse-CDF lognormal lead time (weeks) with the given mean and CV; rounded, >= 1."""
    if cv <= 0:
        return np.full(u.shape, max(1, int(round(mean_L))), dtype=int)
    s2 = np.log1p(cv ** 2)
    x = lognorm.ppf(u, s=np.sqrt(s2), scale=np.exp(np.log(mean_L) - s2 / 2))
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


def plan_levels(D, L_plan, cr, cost, h_week, cu, mean_L):
    """Order-up-to levels for (c) and the (d) candidate table at one review."""
    dlr = np.sort(demand_over(D, L_plan), axis=1)
    d_r = D[:, :, :R].sum(axis=2).mean(axis=1)
    s_c = row_quantile(dlr, cr)

    def plan(S):
        short = np.maximum(dlr - S[:, None], 0).mean(axis=1)
        over = np.maximum(S[:, None] - dlr, 0).mean(axis=1)
        onhand = over + d_r / 2
        return cu * short + h_week * R * onhand, cost * onhand

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


def simulate(start, levels, demand, L_orders, pack, cost, h_week, margin, stock_mult, rop=None):
    """Lost-sales periodic review. levels[:, r] is the order-up-to level at review r.

    With ``rop`` given (FlowChain rule), an order is placed only when IP <= rop[:, r].
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
    return pd.DataFrame({
        "demand": demand.sum(axis=1), "sales": sales, "lost": lost, "lost_margin": lost * margin,
        "stockout_cost": lost * margin * stock_mult, "holding": onhand_sum * cost * h_week,
        "avg_onhand": avg_on, "avg_inv_value": avg_on * cost, "end_inv_value": on * cost, "orders": orders,
        "cycles_ok": cyc_ok, "cycles": np.full(n, len(REVIEW_WEEKS)),
    })


def aggregate(df: pd.DataFrame, w: np.ndarray | None = None, ref: pd.DataFrame | None = None) -> dict:
    tot = df.sum()
    out = {"fill_rate": tot.sales / tot.demand, "csl": tot.cycles_ok / tot.cycles, "lost_units": tot.lost,
           "lost_margin": tot.lost_margin, "stockout_cost": tot.stockout_cost, "avg_inv_value": tot.avg_inv_value,
           "weeks_of_supply": tot.avg_onhand / (tot.demand / 13), "holding": tot.holding,
           "total_cost": tot.holding + tot.stockout_cost, "orders": int(tot.orders),
           "end_inv_value": tot.end_inv_value}
    if w is not None:
        a = df.to_numpy()
        cols = {c: i for i, c in enumerate(df.columns)}
        s = w @ a
        fill = s[:, cols["sales"]] / s[:, cols["demand"]]
        csl = s[:, cols["cycles_ok"]] / s[:, cols["cycles"]]
        tc = s[:, cols["holding"]] + s[:, cols["stockout_cost"]]
        inv = s[:, cols["avg_inv_value"]]
        for k, v in (("fill_rate", fill), ("csl", csl), ("total_cost", tc), ("avg_inv_value", inv)):
            out[f"{k}_lo"], out[f"{k}_hi"] = np.percentile(v, [2.5, 97.5])
        if ref is not None:
            rs = w @ ref.to_numpy()
            d = tc - (rs[:, cols["holding"]] + rs[:, cols["stockout_cost"]])
            out["d_total_vs_b"] = out["total_cost"] - (ref.holding.sum() + ref.stockout_cost.sum())
            out["d_total_vs_b_lo"], out["d_total_vs_b_hi"] = np.percentile(d, [2.5, 97.5])
    return out


# ----------------------------------------------------------------------------- scenario
def run_scenario(sc, ctx, extra_checks=False):
    n = ctx["n"]
    cv = {"all": ctx["lt"]["cv_all"], "low": ctx["lt"]["cv_low_tier"], "high": ctx["lt"]["cv_high_tier"],
          "zero": 0.0}[sc["cv"]]
    L_plan = lead_weeks(ctx["U_plan"], sc["mean_L"], cv)
    L_orders = lead_weeks(ctx["U_orders"], sc["mean_L"], cv)
    EL_draws = lead_weeks(ctx["U_EL"], sc["mean_L"], cv)
    EL = float(EL_draws.mean())
    price = ctx["price"]
    cost = sc["cost_ratio"] * price
    margin = price - cost
    h_week = sc["holding"] / 52
    cu = sc["stockout_mult"] * margin
    co = h_week * cost * (EL + R)
    cr = cu / (cu + co)
    Yraw = ctx["Yraw"]
    lv = {}
    for pol in ("a", "b_rop", "b_target", "c", "c50", "p50", *[f"d{f}" for f in BUDGET_FACTORS + (EXTRA_BUDGET,)]):
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
        s_c, c_val, table, dlr = plan_levels(D, L_plan, cr, cost, h_week * cost, cu, EL)
        lv["c"][:, r] = s_c
        mean_dlr = dlr.mean(axis=1)
        ss_value.append(float(((s_c - mean_dlr) * cost).sum()))
        if extra_checks:
            lv["c50"][:, r] = row_quantile(dlr, np.full(n, 0.5))
            lv["p50"][:, r] = table[0.5][0]
        for f in BUDGET_FACTORS + ((EXTRA_BUDGET,) if extra_checks else ()):
            S, info = solve_budget(table, f * c_val.sum())
            lv[f"d{f}"][:, r] = S
            milp_info.append({"review": t, "factor": f, **info})
    demand = ctx["actual"]
    common = dict(demand=demand, L_orders=L_orders, pack=ctx["pack"], cost=cost, h_week=h_week, margin=margin,
                  stock_mult=sc["stockout_mult"])
    res = {"a": simulate(lv["a"][:, 0], lv["a"], **common),
           "b": simulate(lv["b_target"][:, 0], lv["b_target"], rop=lv["b_rop"], **common),
           "c": simulate(lv["c"][:, 0], lv["c"], **common)}
    for f in BUDGET_FACTORS + ((EXTRA_BUDGET,) if extra_checks else ()):
        res[f"d{f}"] = simulate(lv[f"d{f}"][:, 0], lv[f"d{f}"], **common)
    if extra_checks:
        res["c50"] = simulate(lv["c50"][:, 0], lv["c50"], **common)
        res["p50"] = simulate(lv["p50"][:, 0], lv["p50"], **common)
    meta = {"cv": cv, "EL": EL, "median_L": float(np.median(EL_draws)), "median_cr": float(np.median(cr)), "safety_stock_value_c": float(np.mean(ss_value)),
            "milp": milp_info, "levels": lv}
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

    rng = np.random.default_rng(SEED)
    ctx = {"n": n, "lt": lt, "Yraw": Yraw, "paths": paths_by_origin, "t0": t0_idx,
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
        "no lead-time variability": {**BASE, "cv": "zero"},
        "cost ratio 0.35": {**BASE, "cost_ratio": 0.35}, "cost ratio 0.65": {**BASE, "cost_ratio": 0.65},
        "holding 15%/yr": {**BASE, "holding": 0.15}, "holding 35%/yr": {**BASE, "holding": 0.35},
        "stockout = 0.5 x margin": {**BASE, "stockout_mult": 0.5},
        "stockout = 2 x margin": {**BASE, "stockout_mult": 2.0},
    }
    rows, metas, base_res = [], {}, None
    res_n, meta_n = run_scenario(dict(BASE), {**ctx, "paths": paths_n})
    agg_n = aggregate(res_n["c"], n_boot_w)
    narrow.update({"c_fill": agg_n["fill_rate"], "c_csl": agg_n["csl"], "c_total": agg_n["total_cost"],
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
           "tail": tail_numbers(paths, skus), "narrow_pool": narrow}
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
    return f"£{v:,.0f}"


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
      "stockout = lost margin (price − cost) per unit, with no backorders. Sensitivity: cost ratio 0.35 and 0.65, holding "
      "15% and 35%, stockout 0.5× and 2× margin.")
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
      f"unit, c_o = holding over E[L] + R weeks. Median CR in the base case is {bm['median_cr']:.3f}.")
    a("  - (d) per review, choose one level per SKU from {P50, P70, P80, P90, P95, P98} of the same distribution. "
      "Minimise Σ c_u·E[shortage over L+R] + holding·R·E[on hand], subject to Σ cost·E[on hand] ≤ B, "
      "E[on hand] ≈ E[(S − D_{L+R})⁺] + E[D_R]/2, and B = 0.6, 0.8, 1.0 × the same planned inventory "
      "value of (c). HiGHS proves optimality (see section 6).")
    a("")
    a("## 3. Backtest set-up")
    a("")
    a(f"- **Window:** the 13 test weeks, {key['n_skus']} panel SKUs, with actual gross shipped demand (raw, bulk "
      "lines included). **Starting inventory** of each SKU = that policy's order-up-to level at week 0, with an "
      "empty pipeline. This is an assumption: every policy starts 'fully stocked' by its own standard, so the "
      "first orders go out at week 4.")
    a("- **Lost sales, no backorders:** unmet demand in a week is lost. Holding is charged on end-of-week stock. "
      "L is drawn per order, with the same random numbers for every policy and scenario, so differences come from "
      "the policies, not from luck.")
    a("- **Metrics:** fill rate = units served ÷ demand; cycle service level = share of SKU × 4-week cycles "
      "without a lost sale (weeks 0–3, 4–7, 8–11, 12); lost units and lost margin; average inventory value "
      "(cost basis) and weeks of supply; holding cost; total cost = holding + stockout cost; number of orders. "
      "95% CIs resample SKUs (2,000 draws).")
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
      "weeks of supply | holding | total cost [CI] | Δ total vs (b) [paired CI] | orders | inventory left at week 13 |")
    a("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for p in ("a", "b", "c", "d0.6", "d0.8", "d1.0"):
        r = s_base.loc[p]
        a(f"| {POLICY_LABELS[p]} | {r.fill_rate:.1%} [{r.fill_rate_lo:.1%}, {r.fill_rate_hi:.1%}] | "
          f"{r.csl:.1%} [{r.csl_lo:.1%}, {r.csl_hi:.1%}] | {r.lost_units:,.0f} | {fmt_money(r.lost_margin)} | "
          f"{fmt_money(r.avg_inv_value)} [{fmt_money(r.avg_inv_value_lo)}, {fmt_money(r.avg_inv_value_hi)}] | "
          f"{r.weeks_of_supply:.1f} | {fmt_money(r.holding)} | {fmt_money(r.total_cost)} "
          f"[{fmt_money(r.total_cost_lo)}, {fmt_money(r.total_cost_hi)}] | "
          + ("–" if p == "b" else f"{fmt_money(r.d_total_vs_b)} [{fmt_money(r.d_total_vs_b_lo)}, "
             f"{fmt_money(r.d_total_vs_b_hi)}]") + f" | {int(r.orders):,} | {fmt_money(r.end_inv_value)} |")
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
    a(f"| Lead time without variability (CV 0) | lower safety stock | (c) safety stock value (S − E[D over L+R], "
      f"at cost, mean over reviews) {fmt_money(checks['ss_value_zero_cv'])} vs {fmt_money(checks['ss_value_base'])} "
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
    mr, mu = metas["reliable supplier (low-CV tier)"], metas["unreliable supplier (high-CV tier)"]
    a(f"**In money:** with mean L = 4 weeks, moving from an unreliable (CV {lt['cv_high_tier']:.2f}) to a reliable "
      f"(CV {lt['cv_low_tier']:.2f}) supplier changes the 13-week total cost of policy (c) from "
      f"{fmt_money(unr.loc['c', 'total_cost'])} to {fmt_money(rel.loc['c', 'total_cost'])} "
      f"({fmt_money(unr.loc['c', 'total_cost'] - rel.loc['c', 'total_cost'])} over {key['n_skus']} SKUs). Its "
      f"safety stock value falls from {fmt_money(mu['safety_stock_value_c'])} to "
      f"{fmt_money(mr['safety_stock_value_c'])} "
      f"({fmt_money(mu['safety_stock_value_c'] - mr['safety_stock_value_c'])} less working capital), and average "
      f"inventory falls from {fmt_money(unr.loc['c', 'avg_inv_value'])} to {fmt_money(rel.loc['c', 'avg_inv_value'])}. "
      "This is the link to part 2: the variability that the SCMS lead-time scorecard measures sets safety stock and "
      "cost here.")
    a("")
    a(f"FlowChain's current rule (b) ignores variability and shows the opposite: total "
      f"{fmt_money(unr.loc['b', 'total_cost'])} with the unreliable supplier against "
      f"{fmt_money(rel.loc['b', 'total_cost'])} with the reliable one (fill {unr.loc['b', 'fill_rate']:.1%} vs "
      f"{rel.loc['b', 'fill_rate']:.1%}). That is not a benefit of unreliability. At the same mean, a lognormal lead "
      f"time with CV {lt['cv_high_tier']:.2f} has a median of {mu['median_L']:.0f} weeks, against "
      f"{mr['median_L']:.0f} for CV {lt['cv_low_tier']:.2f}. Most orders arrive early and a few very late, and the "
      "chronically under-stocked rule (b) gains from the early ones. A contrast at a fixed mean mixes spread with "
      "shape. Policy (c), which prices the whole distribution, moves in the expected direction.")
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
    write_discussion(a, lt, key, summary, s_base, metas, checks, tail)
    a("")
    a(f"_Runtime {seconds / 60:.1f} min._")
    (paths.outputs_dir / "replenishment-results.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def write_discussion(a, lt, key, summary, s_base, metas, checks, tail):
    b, c, aa = s_base.loc["b"], s_base.loc["c"], s_base.loc["a"]
    main = s_base.loc[["a", "b", "c", "d0.6", "d0.8", "d1.0"]]
    best = main.total_cost.idxmin()
    diag, nar = key["calibration"], key["narrow_pool"]
    cr = metas["base"]["median_cr"]
    a("## 9. Do the decisions make sense?")
    a("")
    a(f"- **Lowest total cost in the base case: {POLICY_LABELS[best]}** ({fmt_money(main.loc[best, 'total_cost'])}). "
      f"Policy (c) against FlowChain's rule (b): fill {c.fill_rate:.1%} vs {b.fill_rate:.1%}; average inventory "
      f"{fmt_money(c.avg_inv_value)} vs {fmt_money(b.avg_inv_value)} ({c.avg_inv_value / b.avg_inv_value:.1f}x); "
      f"total cost {fmt_money(c.total_cost)} vs {fmt_money(b.total_cost)} (paired Δ {fmt_money(c.d_total_vs_b)}, "
      f"CI [{fmt_money(c.d_total_vs_b_lo)}, {fmt_money(c.d_total_vs_b_hi)}]). The rule of thumb (a) behaves like (b) "
      f"(fill {aa.fill_rate:.1%}, total {fmt_money(aa.total_cost)}).")
    a(f"- **Why (a) and (b) lose.** They set stock from recent averages, with no term for the autumn ramp or for "
      f"lead-time variability, so they run short when demand rises. Under the assumed costs a lost unit costs the "
      f"whole margin ({1 - BASE['cost_ratio']:.0%} of price), while a week of holding costs "
      f"{BASE['holding'] / 52 * BASE['cost_ratio']:.2%} of price. Lost margin dominates their cost "
      f"({fmt_money(b.lost_margin)} of {fmt_money(b.total_cost)} for (b)).")
    a(f"- **Why (c) over-buys.** The critical ratio is high (median {cr:.3f}), and the recalibrated distribution is "
      f"wide, so (c) holds {c.weeks_of_supply:.0f} weeks of supply and ends the window with "
      f"{fmt_money(c.end_inv_value)} of stock, against {fmt_money(b.end_inv_value)} for (b). In the 13-week cost "
      "this is cheap, because holding is only 25% a year and nothing is charged for stock left at the end. For "
      "Christmas gift-ware carried into January that is optimistic: markdown and obsolescence risk are not in the "
      "holding rate.")
    a(f"- **Where (d) wins.** A budget cap cuts the over-buying where it costs least in service. At 0.6 x (c): fill "
      f"{s_base.loc['d0.6', 'fill_rate']:.1%}, inventory {fmt_money(s_base.loc['d0.6', 'avg_inv_value'])} "
      f"({s_base.loc['d0.6', 'avg_inv_value'] / c.avg_inv_value:.0%} of (c)), total "
      f"{fmt_money(s_base.loc['d0.6', 'total_cost'])}. At 1.0 x (c) the MILP only reallocates on a coarse grid of "
      f"quantiles (total {fmt_money(s_base.loc['d1.0', 'total_cost'])}). That the budgeted policy beats (c) on "
      "realised cost says the planning distribution is wider than the test turned out to be. This is the "
      "working-capital trade-off a small business actually faces.")
    a(f"- **P90 under-coverage → realised service.** With the recalibrated (wide) pool, the weekly P90 covers "
      f"{diag['weekly_p90_coverage']:.1%}. (c) plans a cycle service of about its critical ratio ({cr:.1%} median) "
      f"and realises {c.csl:.1%}. Built instead on a narrow pool that leaves out autumn 2010 "
      f"({'; '.join(nar['origins'])}), the weekly P90 covers only {nar['weekly_p90_coverage']:.1%}. The same policy "
      f"then realises {nar['c_csl']:.1%} cycle service [{nar['c_csl_lo']:.1%}, {nar['c_csl_hi']:.1%}] and "
      f"{nar['c_fill']:.1%} fill, with inventory {fmt_money(nar['c_inv'])} and total {fmt_money(nar['c_total'])}. "
      + (f"So the narrower distribution costs {c.csl - nar['c_csl']:.1%} points of cycle service against the wide "
         "pool and falls below its plan: a distribution calibrated outside the peak season delivers less service "
         "than it promises." if nar["c_csl"] < nar["median_cr"] else
         f"So the narrower distribution costs {c.csl - nar['c_csl']:.1%} points of cycle service against the wide pool "
         "but, in this window, still meets its plan. Under-coverage here shows up as less headroom rather than a "
         "missed target."))
    lvl = summary[summary.scenario.isin(["L=2", "base", "L=8"])]
    cL = lvl[lvl.policy == "c"].set_index("scenario")
    bL = lvl[lvl.policy == "b"].set_index("scenario")
    a(f"- **Lead-time mean.** (b) fill at mean L = 2 / 4 / 8 weeks: {bL.loc['L=2', 'fill_rate']:.1%} / "
      f"{bL.loc['base', 'fill_rate']:.1%} / {bL.loc['L=8', 'fill_rate']:.1%}; (c): {cL.loc['L=2', 'fill_rate']:.1%} / "
      f"{cL.loc['base', 'fill_rate']:.1%} / {cL.loc['L=8', 'fill_rate']:.1%}; (c) total cost "
      f"{fmt_money(cL.loc['L=2', 'total_cost'])} / {fmt_money(cL.loc['base', 'total_cost'])} / "
      f"{fmt_money(cL.loc['L=8', 'total_cost'])}. Longer lead times raise the stock and cost of (c). For (b) the "
      "fill even rises with L, which is an artefact of the set-up: the starting stock equals each policy's level, "
      "which includes L weeks of demand, and in a 13-week window most demand is served from it.")
    a("")
    a("## 10. Implications and limitations")
    a("")
    a("- **For FlowChain:** replace the fixed '1 week of demand' safety stock with a service-level rule that uses "
      "the forecast distribution and the supplier's measured lead-time variability (from an SCMS-style scorecard). "
      "Offer the budgeted version, with a working-capital cap, as the default for small businesses, since it "
      "was cheapest here. Show the planned vs realised service so users see when the forecast is too narrow.")
    a(f"- **Excluded tail:** the panel covers {key['n_skus']} of {tail['product_skus']:,} product SKUs. The other "
      f"{tail['tail_skus']:,} SKUs ({tail['tail_revenue_share']:.1%} of training revenue, "
      f"{tail['tail_units_share']:.1%} of units) are mostly intermittent or lumpy and are not in this backtest. "
      "They need Croston/SBA-type forecasts and a separate policy (for example, min–max or make-to-order).")
    a("- **Other limits:** one test season; starting inventory at each policy's own level; a 13-week window with "
      "no value on leftover stock; assumed costs and lead-time means (only the variability comes from SCMS); "
      "lognormal lead times; censored demand in the history. Treat the money figures as a comparison between "
      "policies, not as a forecast of profit.")


if __name__ == "__main__":
    sys.exit(main())
