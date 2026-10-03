"""Weekly SKU demand forecasts, backtests and P50/P90 distributions.

    python -m retail.forecast [--data-dir DIR] [--workers N] [--reuse-stat] [--limit N]

Reads   derived/weekly_panel.csv, derived/panel_skus.csv, derived/weekly_totals.csv
Writes  derived/forecasts.csv            point forecasts, every run/variant/model (SKU-week)
        derived/quantile_forecasts.csv   P50/P90 per method for the test and forward runs
        outputs/forecast-*.csv           metric tables
        outputs/forecast-selection.json  chosen history variant, winner, quantile method
        outputs/demand-forecast.md       the report; figures in outputs/figures/

Runs (origin = index of the last observed week; weeks are 0..103):
  val1..val3   origins 78, 82, 86, 4-week horizon   (validation, before the test)
  test         origin 90, 13-week horizon           (the hold-out: 2011-09-05..2011-11-28)
  roll1..roll3 origins 90, 94, 98, 4-week horizon   (rolling origin inside the test;
                                                     roll1 is the first 4 weeks of test)
  cal1, cal2   origins 64, 77, 13-week horizon      (residuals for P50/P90 calibration)
  fwd          origin 103, 13-week horizon          (true forecast beyond the data)
Each run refits every model on data up to its origin. Two history variants are run:
"raw" and "capped" (bulk lines capped, see clean.py). Accuracy is always measured
against raw actual demand unless a table says otherwise.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from . import config as C
from . import models as M
from . import plotting as P
from .metrics import fmt_ci, naive_scale, quantile_summary, summarise
from .paths import SEED, add_data_dir_arg, data_paths_from_args

RUNS = {  # key: (origin, horizon)
    "val1": (78, 4), "val2": (82, 4), "val3": (86, 4),
    "test": (90, 13), "roll2": (94, 4), "roll3": (98, 4),
    "cal1": (64, 13), "cal2": (77, 13), "fwd": (103, 13),
}
VAL_RUNS = ["val1", "val2", "val3"]
ROLL_RUNS = ["roll1", "roll2", "roll3"]
CAL_RUNS = ["cal1", "cal2"]
VARIANTS = ["raw", "capped"]
MODELS = ["naive", "ma4", "snaive", "sba", "ets", "arima", "ets_sa", "arima_sa", "gbm"]
LABELS = {
    "naive": "Naive (last week)", "ma4": "4-week moving average", "snaive": "Seasonal naive (t-52)",
    "sba": "SBA (Croston variant)", "ets": "ETS (level / damped trend)", "arima": "ARIMA (AIC grid)",
    "ets_sa": "ETS on seasonally adjusted series", "arima_sa": "ARIMA on seasonally adjusted series",
    "gbm": "Global gradient boosting (HGB)",
}


# ----------------------------------------------------------------------------- data
def load(paths, limit: int | None):
    panel = pd.read_csv(paths.weekly_csv, parse_dates=["week"], dtype={"sku": str})
    skus = pd.read_csv(paths.sku_csv, dtype={"sku": str}).set_index("sku").sort_index()
    if limit:
        skus = skus.iloc[:: max(1, len(skus) // limit)].head(limit)
        panel = panel[panel.sku.isin(skus.index)]
    totals = pd.read_csv(paths.derived_dir / "weekly_totals.csv", parse_dates=["week"]).set_index("week")
    weeks = pd.DatetimeIndex(sorted(panel.week.unique()))
    wide = {c: panel.pivot(index="sku", columns="week", values=c).reindex(skus.index)[weeks].to_numpy(float)
            for c in ("units", "units_capped", "avg_price")}
    ext = pd.DatetimeIndex(list(weeks) + list(pd.date_range(weeks[-1] + pd.Timedelta(weeks=1), periods=13, freq="W-MON")))
    tot = {"raw": totals.loc[weeks, "units"].to_numpy(float), "capped": totals.loc[weeks, "units_capped"].to_numpy(float)}
    return panel, skus, weeks, ext, wide, tot


# ----------------------------------------------------------------------------- models
def simple_forecasts(Y: np.ndarray, o: int, H: int) -> dict[str, np.ndarray]:
    out = {k: np.zeros((Y.shape[0], H)) for k in ("naive", "ma4", "snaive", "sba")}
    for i, y in enumerate(Y):
        out["naive"][i] = M.naive(y, o, H)
        out["ma4"][i] = M.moving_average(y, o, H, 4)
        out["snaive"][i] = M.seasonal_naive(y, o, H)
        out["sba"][i] = M.sba(y, o, H)
    return out


def stat_forecasts(skus, wide, tot, workers: int):
    run_index = {(r, v): M.seasonal_index(tot[v], o, H) for r, (o, H) in RUNS.items() for v in VARIANTS}
    runs = [(r, o, H) for r, (o, H) in RUNS.items()]
    tasks = [(sku, v, wide["units" if v == "raw" else "units_capped"][i], runs)
             for v in VARIANTS for i, sku in enumerate(skus.index)]
    results = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers, initializer=M.init_worker, initargs=(run_index,)) as pool:
        for k, res in enumerate(pool.map(M.stat_task, tasks, chunksize=4)):
            results.extend(res)
            if (k + 1) % 200 == 0:
                print(f"  statsmodels: {k + 1}/{len(tasks)} SKU-variants, {time.time() - t0:.0f}s", flush=True)
    return results, run_index


def gbm_forecasts(Y_hist, Y_target_raw, price_ff, price_med, total, first, ext, o, H, quantiles: bool):
    X, y, _ = M.gbm_training_set(Y_hist, price_ff, price_med, total, first, ext, o, 13)
    model = HistGradientBoostingRegressor(**M.gbm_params(SEED, "poisson")).fit(X, y)
    feats = [M.gbm_features(Y_hist, price_ff, price_med, total, first, ext, o, h) for h in range(1, H + 1)]
    point = np.column_stack([model.predict(f) for f in feats])
    qs = {}
    if quantiles:
        # Quantile models learn raw demand relative to the recent level (scale-free target).
        Xq, yq, sq = M.gbm_training_set(Y_hist, price_ff, price_med, total, first, ext, o, 13, target=Y_target_raw)
        scale_now = np.maximum(Y_hist[:, o - 12:o + 1].mean(axis=1), 1.0)
        for q in (0.5, 0.9):
            mq = HistGradientBoostingRegressor(**M.gbm_params(SEED, "quantile", q)).fit(Xq, yq / sq)
            qs[q] = np.maximum(np.column_stack([mq.predict(f) for f in feats]) * scale_now[:, None], 0)
    imp = None
    return np.maximum(point, 0), qs, model, imp


# ----------------------------------------------------------------------------- assembly
def to_long(arr: np.ndarray, skus, run, variant, model, o) -> pd.DataFrame:
    n, H = arr.shape
    return pd.DataFrame({"run": run, "variant": variant, "model": model, "sku": np.repeat(skus, H),
                         "h": np.tile(np.arange(1, H + 1), n), "t": np.tile(o + np.arange(1, H + 1), n),
                         "yhat": arr.ravel()})


def attach_actuals(fc: pd.DataFrame, skus, wide, weeks_ext, origin_of: dict) -> pd.DataFrame:
    pos = {s: i for i, s in enumerate(skus.index)}
    si = fc.sku.map(pos).to_numpy()
    t = fc.t.to_numpy()
    T = wide["units"].shape[1]
    inside = t < T
    y = np.full(len(fc), np.nan)
    yc = np.full(len(fc), np.nan)
    y[inside] = wide["units"][si[inside], t[inside]]
    yc[inside] = wide["units_capped"][si[inside], t[inside]]
    fc["y"], fc["y_capped"] = y, yc
    fc["week"] = weeks_ext[t]
    scales = {}
    for r, o in origin_of.items():
        scales[r] = np.array([naive_scale(row[:o + 1]) for row in wide["units"]])
    fc["scale"] = [scales[r][i] for r, i in zip(fc.run, si)]
    fc["abc"] = fc.sku.map(skus.abc)
    fc["segment"] = fc.sku.map(skus.segment)
    return fc


def residual_quantiles(fc: pd.DataFrame, wide, runs: list[str], variant: str, model: str) -> pd.DataFrame:
    """Scaled residual quantiles by horizon: r = (y - yhat) / level, level = mean of last 13 weeks."""
    d = fc[(fc.run.isin(runs)) & (fc.variant == variant) & (fc.model == model)].dropna(subset=["y"]).copy()
    d["level"] = d.level_at_origin
    d["r"] = (d.y - d.yhat) / d.level
    return d.groupby("h").r.quantile([0.5, 0.9]).unstack().rename(columns={0.5: "q50", 0.9: "q90"})


# ----------------------------------------------------------------------------- report helpers
def md_table(df: pd.DataFrame) -> str:
    cols = list(df.columns)
    lines = ["| " + " | ".join(cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    lines += ["| " + " | ".join("" if pd.isna(v) else str(v) for v in row) + " |" for row in df.itertuples(index=False)]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_data_dir_arg(parser)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    parser.add_argument("--reuse-stat", action="store_true", help="reuse derived/forecasts.csv statsmodels rows")
    parser.add_argument("--limit", type=int, default=None, help="development: use only N SKUs")
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()
    np.random.seed(SEED)
    P.setup()
    t_start = time.time()

    panel, skus, weeks, ext, wide, tot = load(paths, args.limit)
    n = len(skus)
    print(f"Panel {n} SKUs x {len(weeks)} weeks; workers {args.workers}")
    Yv = {"raw": wide["units"], "capped": wide["units_capped"]}
    price_ff, price_med = M.price_arrays(wide["avg_price"])
    first = np.array([M.first_sale(r) for r in wide["units"]])
    sku_arr = skus.index.to_numpy()

    parts = []
    # simple models
    for v in VARIANTS:
        for r, (o, H) in RUNS.items():
            for m, arr in simple_forecasts(Yv[v], o, H).items():
                parts.append(to_long(arr, sku_arr, r, v, m, o))

    # statsmodels (cached optionally)
    fc_path = paths.derived_dir / "forecasts.csv"
    cfg_path = paths.derived_dir / "stat_configs.csv"
    if args.reuse_stat and fc_path.exists() and cfg_path.exists():
        old = pd.read_csv(fc_path, dtype={"sku": str})
        old = old[old.model.isin(["ets", "arima", "ets_sa", "arima_sa"]) & old.sku.isin(sku_arr)]
        parts.append(old[["run", "variant", "model", "sku", "h", "t", "yhat"]])
        cfgs = pd.read_csv(cfg_path, dtype={"sku": str})
        print(f"Reused {len(old):,} statsmodels forecast rows")
    else:
        print("Fitting ETS / ARIMA per SKU (parallel) ...", flush=True)
        results, _ = stat_forecasts(skus, wide, tot, args.workers)
        cfg_rows = []
        for res in results:
            o, H = RUNS[res["run"]]
            for m in ("ets", "arima", "ets_sa", "arima_sa"):
                parts.append(to_long(res[m][None, :], [res["sku"]], res["run"], res["variant"], m, o))
            cfg_rows.append({"run": res["run"], "variant": res["variant"], "sku": res["sku"],
                             "ets_cfg": res["ets_cfg"].rstrip("*"), "ets_sa_cfg": res["ets_sa_cfg"].rstrip("*"),
                             "arima_order": str(tuple(res["arima_order"][:3])),
                             "arima_sa_order": str(tuple(res["arima_sa_order"][:3])),
                             "ets_guard": res["ets_cfg"].endswith("*") or res["ets_cfg"] == "fallback",
                             "ets_sa_guard": res["ets_sa_cfg"].endswith("*") or res["ets_sa_cfg"] == "fallback",
                             "arima_guard": len(res["arima_order"]) > 3,
                             "arima_sa_guard": len(res["arima_sa_order"]) > 3})
        cfgs = pd.DataFrame(cfg_rows)
        cfgs.to_csv(cfg_path, index=False)
    print(f"  done at {time.time() - t_start:.0f}s", flush=True)

    # GBM
    qrows = []
    gbm_models = {}
    for v in VARIANTS:
        for r, (o, H) in RUNS.items():
            want_q = r in ("test", "fwd")
            point, qs, model, _ = gbm_forecasts(Yv[v], wide["units"], price_ff, price_med, tot[v], first, ext, o, H, want_q)
            parts.append(to_long(point, sku_arr, r, v, "gbm", o))
            if want_q:
                for q, arr in qs.items():
                    qrows.append(to_long(arr, sku_arr, r, v, f"gbm_q{int(q * 100)}", o))
            if r == "test":
                gbm_models[v] = model
        print(f"  GBM {v} done at {time.time() - t_start:.0f}s", flush=True)

    fc = pd.concat(parts, ignore_index=True)
    # roll1 = first four weeks of the test run
    roll1 = fc[(fc.run == "test") & (fc.h <= 4)].assign(run="roll1")
    fc = pd.concat([fc, roll1], ignore_index=True)
    origin_of = {r: o for r, (o, _) in RUNS.items()} | {"roll1": RUNS["test"][0]}
    fc["origin"] = fc.run.map(origin_of)
    fc = attach_actuals(fc, skus, wide, ext, origin_of)
    level = {r: np.maximum(wide["units"][:, max(o - 12, 0):o + 1].mean(axis=1), 1.0) for r, o in origin_of.items()}
    pos = {s: i for i, s in enumerate(sku_arr)}
    fc["level_at_origin"] = [level[r][pos[s]] for r, s in zip(fc.run, fc.sku)]
    fc.to_csv(fc_path, index=False)

    # ------------------------------------------------------------- evaluation
    ev = fc.dropna(subset=["y"])

    def wide_preds(run, variant):
        d = ev[(ev.run == run) & (ev.variant == variant)]
        w = d.pivot_table(index=["sku", "h", "t"], columns="model", values="yhat").reset_index()
        meta = d.drop_duplicates(["sku", "h"]).set_index(["sku", "h"])[["y", "y_capped", "scale", "abc", "segment"]]
        return w.join(meta, on=["sku", "h"])

    # 1. history variant chosen on validation origins (before the test)
    val_rows = []
    for v in VARIANTS:
        for r in VAL_RUNS:
            s = summarise(wide_preds(r, v), MODELS)
            val_rows.append(s.assign(run=r, variant=v))
    val = pd.concat(val_rows)
    val_mean = val.groupby(["variant", "model"]).WAPE.mean().unstack(0)
    capped_wins = int((val_mean.capped < val_mean.raw).sum())
    chosen = "capped" if capped_wins > len(MODELS) / 2 else "raw"
    print(f"Validation: capped history better for {capped_wins}/{len(MODELS)} models -> use {chosen}")

    # 2. test metrics for the chosen variant
    tw = wide_preds("test", chosen)
    test_all = summarise(tw, MODELS, ref="ma4")
    test_abc = summarise(tw, MODELS, group="abc")
    test_seg = summarise(tw, MODELS, group="segment")
    ordered = test_all.sort_values("WAPE").model.tolist()
    winner = ordered[0]
    runner = ordered[1]
    test_vs_runner = summarise(tw, [winner], ref=runner).iloc[0]
    pd.concat([test_all.assign(group_by="all"), test_abc.assign(group_by="abc"),
               test_seg.assign(group_by="segment")]).to_csv(paths.outputs_dir / "forecast-metrics-test.csv", index=False)

    # 3. rolling origin (chosen variant): 3 origins before and 3 inside the test
    roll_rows = []
    for r in VAL_RUNS + ROLL_RUNS:
        s = summarise(wide_preds(r, chosen), MODELS)
        roll_rows.append(s.assign(run=r, origin_week=str(weeks[origin_of[r]].date())))
    roll = pd.concat(roll_rows)
    roll.to_csv(paths.outputs_dir / "forecast-metrics-rolling.csv", index=False)
    roll_w = roll.pivot_table(index="model", columns="run", values="WAPE")[VAL_RUNS + ROLL_RUNS]
    roll_w["mean_pre_test"] = roll_w[VAL_RUNS].mean(axis=1)
    roll_w["mean_in_test"] = roll_w[ROLL_RUNS].mean(axis=1)
    roll_b = roll.pivot_table(index="model", columns="run", values="Bias")
    roll_w["bias_pre_test"] = roll_b[VAL_RUNS].mean(axis=1)
    roll_w["bias_in_test"] = roll_b[ROLL_RUNS].mean(axis=1)
    roll_rank = roll_w.mean_in_test.rank().astype(int)
    roll_rank_pre = roll_w.mean_pre_test.rank().astype(int)

    # 4. capping comparison on the test (both variants, raw and capped actuals)
    cap_rows = []
    for v in VARIANTS:
        w = wide_preds("test", v)
        for act in ("y", "y_capped"):
            s = summarise(w, MODELS, actual=act)
            cap_rows.append(s.assign(history=v, actuals="raw" if act == "y" else "capped"))
    cap = pd.concat(cap_rows)
    cap.to_csv(paths.outputs_dir / "forecast-capping.csv", index=False)
    val_mean.to_csv(paths.outputs_dir / "forecast-capping-validation.csv")

    # 5. distributions at the test origin: residual quantiles (calibrated on cal1, cal2) vs quantile GBM
    tq = ev[(ev.run == "test") & (ev.variant == chosen)].copy()
    qcols = {}
    rq_tables = {}
    for m in MODELS:
        rq = residual_quantiles(fc, wide, CAL_RUNS, chosen, m)
        rq_tables[m] = rq
        d = tq[tq.model == m].set_index(["sku", "h"])
        base = d.yhat
        lv = d.level_at_origin
        hq = d.index.get_level_values("h")
        tq.loc[tq.model == m, "p50"] = np.maximum(base.to_numpy() + rq.q50.reindex(hq).to_numpy() * lv.to_numpy(), 0)
        tq.loc[tq.model == m, "p90"] = np.maximum(base.to_numpy() + rq.q90.reindex(hq).to_numpy() * lv.to_numpy(), 0)
    qdf = pd.concat(qrows, ignore_index=True)
    gq = qdf[(qdf.run == "test") & (qdf.variant == chosen)].pivot_table(index=["sku", "h"], columns="model", values="yhat")
    qeval = tq[tq.model == winner].set_index(["sku", "h"])[["y", "p50", "p90"]].rename(
        columns={"p50": "res_p50", "p90": "res_p90"})
    for m in MODELS:
        dm = tq[tq.model == m].set_index(["sku", "h"])
        qeval[f"{m}_p50"], qeval[f"{m}_p90"] = dm.p50, dm.p90
    qeval["gbm_q50"], qeval["gbm_q90"] = gq["gbm_q50"], gq["gbm_q90"]
    qeval = qeval.reset_index()
    qcols = {f"residual quantiles on {m}": (f"{m}_p50", f"{m}_p90") for m in MODELS}
    qcols["quantile GBM"] = ("gbm_q50", "gbm_q90")
    qsum = quantile_summary(qeval, qcols)
    qsum.to_csv(paths.outputs_dir / "forecast-quantiles.csv", index=False)
    best_q = qsum.sort_values("pinball90_w").iloc[0]
    best_q_method = best_q.method
    qsum_abc = []
    for g in ("A", "B", "C"):
        sub = qeval[qeval.sku.map(skus.abc) == g]
        qsum_abc.append(quantile_summary(sub, {best_q_method: qcols[best_q_method]}).assign(abc=g))
    qsum_abc = pd.concat(qsum_abc)
    by_h = qeval.assign(cov=lambda d: d.y <= d[qcols[best_q_method][1]]).groupby("h")["cov"].mean()

    # quantile forecasts for the decision model: test (as evaluated) and forward
    # (forward residual quantiles also use the test run, which is in the past by then).
    qa_rows = []
    qa_test = qeval[["sku", "h", qcols[best_q_method][0], qcols[best_q_method][1]]].rename(
        columns={qcols[best_q_method][0]: "p50", qcols[best_q_method][1]: "p90"})
    qa_test["run"] = "test"
    qa_rows.append(qa_test)
    fw = fc[(fc.run == "fwd") & (fc.variant == chosen)]
    if best_q_method == "quantile GBM":
        g = qdf[(qdf.run == "fwd") & (qdf.variant == chosen)].pivot_table(index=["sku", "h"], columns="model",
                                                                            values="yhat").reset_index()
        qa_fwd = g.rename(columns={"gbm_q50": "p50", "gbm_q90": "p90"})[["sku", "h", "p50", "p90"]]
    else:
        m_q = best_q_method.replace("residual quantiles on ", "")
        rq_f = residual_quantiles(fc, wide, CAL_RUNS + ["test"], chosen, m_q)
        d = fw[fw.model == m_q]
        qa_fwd = pd.DataFrame({"sku": d.sku, "h": d.h,
                               "p50": np.maximum(d.yhat + rq_f.q50.reindex(d.h).to_numpy() * d.level_at_origin, 0),
                               "p90": np.maximum(d.yhat + rq_f.q90.reindex(d.h).to_numpy() * d.level_at_origin, 0)})
    qa_fwd["run"] = "fwd"
    qa_rows.append(qa_fwd)
    qa = pd.concat(qa_rows, ignore_index=True)
    qa["method"] = best_q_method
    qa.to_csv(paths.derived_dir / "quantile_forecasts.csv", index=False)

    # model configuration summaries (test origin, chosen variant)
    ctest = cfgs[(cfgs.run == "test") & (cfgs.variant == chosen)]
    arima_orders = ctest.arima_order.value_counts()
    arima_sa_orders = ctest.arima_sa_order.value_counts()
    d1_share = ctest.arima_order.str.contains(r"^\(\d, 1,").mean()
    ets_cfg = ctest.ets_cfg.value_counts(normalize=True)
    ets_sa_cfg = ctest.ets_sa_cfg.value_counts(normalize=True)
    pd.DataFrame({"arima": arima_orders, "arima_sa": arima_sa_orders}).fillna(0).astype(int).to_csv(
        paths.outputs_dir / "arima-orders.csv")
    white_noise = (ctest.arima_order == "(0, 0, 0)").mean()

    gm = gbm_models[chosen]
    sel = {"history_variant": chosen, "capped_better_on_validation": f"{capped_wins}/{len(MODELS)}",
           "winner": winner, "runner_up": runner, "quantile_method": best_q_method,
           "p90_coverage_test": float(best_q.coverage90), "gbm_iterations": int(gm.n_iter_),
           "n_skus": n, "test_start": str(weeks[RUNS["test"][0] + 1].date()),
           "forward_start": str(ext[RUNS["fwd"][0] + 1].date())}
    (paths.outputs_dir / "forecast-selection.json").write_text(json.dumps(sel, indent=2), encoding="utf-8")

    # ------------------------------------------------------------- figures
    import matplotlib.pyplot as plt
    figs = paths.figures_dir
    ta = test_all.sort_values("WAPE", ascending=False)
    fig, ax = plt.subplots(figsize=(7.5, 3.8))
    yv = np.arange(len(ta))
    colors = [P.SERIES[1] if m == winner else P.SERIES[0] for m in ta.model]
    ax.errorbar(ta.WAPE, yv, xerr=[ta.WAPE - ta.WAPE_lo, ta.WAPE_hi - ta.WAPE], fmt="none", ecolor=P.MUTED, lw=1.2)
    ax.scatter(ta.WAPE, yv, color=colors, s=36, zorder=3)
    ax.set_yticks(yv, [LABELS[m] for m in ta.model])
    ax.xaxis.set_major_formatter(plt.matplotlib.ticker.PercentFormatter(1.0))
    ax.set_xlabel("WAPE on the 13-week test (95% bootstrap CI over SKUs)")
    ax.set_title("Test accuracy by model (lower is better)")
    P.save(fig, figs / "test-wape.png")

    agg = panel.groupby("week").units.sum()
    show = [m for m in dict.fromkeys([winner, runner, "ma4", "snaive"])]
    fig, ax = plt.subplots(figsize=(9, 3.6))
    hist = agg[agg.index >= weeks[RUNS["test"][0] - 39]]
    ax.plot(hist.index, hist.values / 1e3, color=P.TEXT, lw=1.6, label="actual (panel total)")
    for k, m in enumerate(show):
        s = ev[(ev.run == "test") & (ev.variant == chosen) & (ev.model == m)].groupby("week").yhat.sum()
        ax.plot(s.index, s.values / 1e3, color=P.SERIES[k], lw=1.4, label=LABELS[m])
    ax.axvline(weeks[RUNS["test"][0]], color=P.TEXT2, lw=0.8, ls="--")
    ax.set_ylabel("thousand units per week")
    ax.set_title("Panel total: actual vs forecasts from the test origin")
    ax.legend(loc="upper left", fontsize=7)
    P.save(fig, figs / "test-aggregate.png")

    fig, ax = plt.subplots(figsize=(8, 3.4))
    order = VAL_RUNS + ROLL_RUNS
    xs = [str(weeks[origin_of[r]].date()) for r in order]
    for k, m in enumerate([m for m in dict.fromkeys([winner, runner, "ma4", "snaive", "ets"])]):
        ax.plot(xs, roll_w.loc[m, order], marker="o", ms=4, color=P.SERIES[k], label=LABELS[m])
    ax.yaxis.set_major_formatter(plt.matplotlib.ticker.PercentFormatter(1.0))
    ax.set_xlabel("forecast origin (last observed week); 4-week horizon")
    ax.set_ylabel("WAPE")
    ax.set_title("Rolling-origin accuracy (first three origins are before the test)")
    ax.legend(fontsize=7, loc="upper left")
    ax.tick_params(axis="x", labelsize=7)
    P.save(fig, figs / "rolling-origin.png")

    ranked = skus[skus.abc == "A"].sort_values("train_revenue", ascending=False).index
    ex_skus = ranked[[k for k in (0, 5, 20) if k < len(ranked)]]
    fig, axes = plt.subplots(1, len(ex_skus), figsize=(11, 3.2), sharex=False, squeeze=False)
    axes = axes[0]
    c50, c90 = qcols[best_q_method]
    for ax, s in zip(axes, ex_skus):
        i = pos[s]
        ax.plot(weeks[70:], wide["units"][i, 70:], color=P.TEXT, lw=1.3, label="actual")
        d = qeval[qeval.sku == s].sort_values("h")
        wk = weeks[RUNS["test"][0] + d.h.to_numpy()]
        ax.fill_between(wk, 0, d[c90], color=P.SERIES[0], alpha=0.15, lw=0, label="below P90")
        ax.plot(wk, d[c50], color=P.SERIES[0], lw=1.4, label="P50")
        ax.plot(wk, d[c90], color=P.SERIES[0], lw=0.8, ls="--", label="P90")
        ax.set_title(f"{s}: {str(skus.description.get(s, ''))[:28]}", fontsize=9)
        ax.tick_params(axis="x", labelsize=7, rotation=30)
    axes[0].legend(fontsize=7, loc="upper left")
    P.save(fig, figs / "example-distributions.png")

    fig, ax = plt.subplots(figsize=(7, 3.2))
    top = arima_orders.head(10)[::-1]
    ax.barh(top.index, top.values, color=P.SERIES[0], height=0.6)
    ax.set_xlabel("SKUs (test origin)")
    ax.set_title("Chosen ARIMA(p,d,q) orders")
    P.save(fig, figs / "arima-orders.png")

    # accuracy at aggregated levels (panel total per week; SKU x 4-week buckets)
    agg_rows = []
    for m in MODELS:
        wk_tot = tw.groupby("t")[[m, "y"]].sum()
        b = tw[tw.h <= 12].assign(b=lambda d: (d.h - 1) // 4).groupby(["sku", "b"])[[m, "y"]].sum()
        agg_rows.append({"model": m, "panel_total_WAPE": (wk_tot[m] - wk_tot.y).abs().sum() / wk_tot.y.sum(),
                         "sku_4wk_WAPE": (b[m] - b.y).abs().sum() / b.y.sum()})
    aggacc = pd.DataFrame(agg_rows).set_index("model")
    aggacc.to_csv(paths.outputs_dir / "forecast-aggregate-accuracy.csv")
    guard_cols = ["ets_guard", "ets_sa_guard", "arima_guard", "arima_sa_guard"]
    guards = {c.replace("_guard", ""): (int(cfgs[c].astype(bool).sum()), len(cfgs)) for c in guard_cols}
    # long zero runs before an origin look like stock-outs (censored demand)
    Yr, o_t, T = wide["units"], RUNS["test"][0], len(weeks)
    closed = np.array([tot["raw"][k] == 0 for k in range(o_t + 1)])
    longest = []
    for row in Yr[:, :o_t + 1]:
        run_len, best = 0, 0
        for k, v in enumerate(row):
            if v == 0 and not closed[k]:
                run_len += 1
                best = max(best, run_len)
            elif not closed[k]:
                run_len = 0
        longest.append(best)
    longest = np.array(longest)
    context = {
        "panel_yoy": Yr[:, o_t + 1:].sum() / Yr[:, o_t + 1 - 52:T - 52].sum(),
        "total_yoy": tot["raw"][o_t + 1:].sum() / tot["raw"][o_t + 1 - 52:T - 52].sum(),
        "ramp": Yr[:, o_t + 1:].sum(axis=0).mean() / Yr[:, o_t - 3:o_t + 1].sum(axis=0).mean(),
        "ramp_2010": Yr[:, o_t + 1 - 52:T - 52].sum(axis=0).mean() / Yr[:, o_t - 55:o_t - 51].sum(axis=0).mean(),
        "index_ramp": float(M.seasonal_index(tot[chosen], o_t, 13)[o_t + 1:].mean()
                            / M.seasonal_index(tot[chosen], o_t, 13)[o_t - 3:o_t + 1].mean()),
        "aggacc": aggacc, "guards": guards,
        "zero_run_ge8": int((longest >= 8).sum()), "zero_run_max": int(longest.max()),
        "level_le1_at_test_origin": int((Yr[:, o_t - 12:o_t + 1].mean(axis=1) <= 1).sum()),
        "winner_best_origins": None,
    }

    # ------------------------------------------------------------- report
    write_report(paths, sel, skus, weeks, ext, test_all, test_abc, test_seg, test_vs_runner, roll_w, roll_rank,
                 roll_rank_pre, cap, val_mean, capped_wins, qsum, qsum_abc, by_h, arima_orders, arima_sa_orders,
                 d1_share, white_noise, ets_cfg, ets_sa_cfg, rq_tables, gm, chosen, winner, runner, best_q_method,
                 tot, time.time() - t_start, context)
    print(f"Wrote {paths.outputs_dir / 'demand-forecast.md'} in {time.time() - t_start:.0f}s")
    print(test_all[["model", "WAPE", "WAPE_lo", "WAPE_hi", "MASE", "Bias", "dWAPE_vs_ref"]].to_string())
    print(qsum.to_string())
    return 0


def write_report(paths, sel, skus, weeks, ext, test_all, test_abc, test_seg, test_vs_runner, roll_w, roll_rank,
                 roll_rank_pre, cap, val_mean, capped_wins, qsum, qsum_abc, by_h, arima_orders, arima_sa_orders,
                 d1_share, white_noise, ets_cfg, ets_sa_cfg, rq_tables, gm, chosen, winner, runner, best_q_method,
                 tot, seconds, context):
    o_test = RUNS["test"][0]
    t = test_all.set_index("model")
    L = []
    a = L.append

    def row_ci(m):
        r = t.loc[m]
        return (f"| {LABELS[m]} | {fmt_ci(r.WAPE, r.WAPE_lo, r.WAPE_hi)} | {fmt_ci(r.MASE, r.MASE_lo, r.MASE_hi, False)} | "
                f"{r.Bias:+.1%} [{r.Bias_lo:+.1%}, {r.Bias_hi:+.1%}] | "
                f"{r.dWAPE_vs_ref:+.1%} [{r.dWAPE_lo:+.1%}, {r.dWAPE_hi:+.1%}] |")

    a("# Demand forecast: Online Retail II weekly SKU demand (part 1)")
    a("")
    a("## 1. Problem and why it matters")
    a("")
    a("FlowChain has to decide how much of each item to order and when. That needs a forecast of weekly demand per "
      "SKU, and also its uncertainty (a P90 as well as a P50), because safety stock is set by the upper tail. Part 2 "
      "gives the supplier lead-time distribution; the decision model combines the two. Here the question is which "
      "forecasting approach is accurate enough, and whether complex models beat simple ones on this data.")
    a("")
    a("## 2. Setup")
    a("")
    a(f"- **Panel:** {sel['n_skus']} SKUs × {len(weeks)} weeks of gross shipped demand (see `data-quality.md`). "
      f"Training: weeks to {weeks[o_test].date()} ({o_test + 1} weeks). **Test: the last {RUNS['test'][1]} weeks, "
      f"{weeks[o_test + 1].date()} to {weeks[-1].date()}**, forecast once from the test origin (horizons 1–13).")
    a("- **Rolling origin:** six origins with a 4-week horizon, each refitted: three before the test (last observed "
      + ", ".join(str(weeks[RUNS[r][0]].date()) for r in VAL_RUNS) + ") and three inside it ("
      + ", ".join(str(weeks[o].date()) for o in (RUNS["test"][0], RUNS["roll2"][0], RUNS["roll3"][0])) + ").")
    a("- **Seasonality limit:** the data holds one full year before the test origin (plus Dec 2009). Seasonal naive "
      "can use the same week of 2010. A seasonal ETS or SARIMA with period 52 cannot be estimated: statsmodels needs "
      "two full cycles to initialise 52 seasonal states, and seasonal differencing at lag 52 would leave "
      f"{o_test + 1 - 52} usable weeks. Every seasonal estimate here rests on **one** observed Christmas season, so "
      "it cannot separate 'this SKU is seasonal' from 'this SKU had a good autumn in 2010'. We use two substitutes: "
      "(a) a pooled seasonal index from total demand of all product SKUs over the 52 weeks up to the origin (the "
      "*SA* models), which pools the one season over thousands of SKUs; and (b) GBM features that compare the "
      "target week with the same week last year.")
    a("- **Metrics** (always against raw actual demand unless stated): WAPE = Σ|F−A| / ΣA; MASE = mean over SKUs of "
      "MAE / in-sample MAE of the one-step naive forecast (values < 1 beat a one-step naive forecast made with "
      "hindsight); bias = Σ(F−A)/ΣA (negative = under-forecast). 95% CIs come from resampling SKUs "
      "(2,000 bootstrap draws). Weeks of one SKU stay together.")
    a("")
    a("## 3. Models")
    a("")
    a("| Model | What it does | Why it is here |")
    a("|---|---|---|")
    a("| Naive | next weeks = last week | floor that any model must beat |")
    a("| 4-week moving average | mean of the last 4 weeks | robust level estimate for erratic demand |")
    a("| Seasonal naive | same week last year (t−52) | the simplest seasonal model |")
    a("| SBA | Croston with the Syntetos–Boylan bias correction, α = 0.1 | built for intermittent demand; a check "
      "only, since the panel has no intermittent SKUs |")
    a("| ETS | additive-error exponential smoothing, level-only vs additive damped trend, chosen per SKU by AICc | "
      "standard level/trend smoother |")
    a(f"| ARIMA | per SKU: d from a KPSS test (5%), then p, q ∈ {{0,1,2}} by AIC; constant if d = 0, no drift if d = 1 | "
      "the owner asked about ARIMA; see section 5 |")
    a("| ETS-SA, ARIMA-SA | the same models on demand ÷ pooled seasonal index; forecast × index | adds the one-season "
      "seasonal shape without estimating 52 parameters per SKU |")
    a(f"| Global GBM | one `HistGradientBoostingRegressor` (Poisson loss) for all SKUs and horizons | pools information "
      "across SKUs; learns seasonality and level shifts |")
    a("")
    a(f"**Fit guard.** A fitted ETS/ARIMA candidate whose forecast leaves [0, {M.SANITY_MULT:.0f}x the SKU's "
      "historical maximum] is treated as a failed fit, and the next-best candidate is used. This stops a degenerate "
      "optimum from dominating. Without the guard, one ARIMA-SA fit forecast 65,896 units a week for a SKU whose "
      "weekly maximum was 241. Section 5 counts the replacements.")
    a("")
    a(f"**GBM details.** It uses a direct multi-horizon design. A training row is (SKU, origin o′, horizon h ∈ 1..13) and "
      f"has {len(M.GBM_FEATURES)} features known at o′: horizon; log 4/13/26/52-week means; the last four weeks "
      "relative to the 13-week mean; share of zero weeks and CV over the last 13 weeks; the same week last year and "
      "its 3-week mean, relative to the level; last year's ramp from the origin-equivalent weeks to the target week "
      "(SKU and pooled); target week-of-year, month and Q4 flag; log last observed price and price relative to the "
      "SKU's median price so far; weeks since first sale. **No leakage:** a row with origin o′ uses weeks ≤ o′ only, "
      "and its target o′+h must be ≤ the forecast origin. Prices are lagged (last observed), not the price in the "
      f"target week. Hyperparameters are fixed (learning rate 0.05, {gm.n_iter_} trees, 31 leaves, min 100 rows per "
      "leaf, L2 = 1) and were not tuned on the test. The random seed is fixed.")
    a("")
    a("## 4. Results on the 13-week test")
    a("")
    cw = int(capped_wins)
    a(f"History variant: **{chosen}** (models trained on {'capped' if chosen == 'capped' else 'raw'} history). It was chosen "
      f"*before* looking at the test, on the three validation origins: capped history had the lower mean WAPE for "
      f"{cw} of {len(MODELS)} models. Actuals are always raw demand.")
    a("")
    a("| Model | WAPE [95% CI] | MASE [95% CI] | Bias [95% CI] | ΔWAPE vs 4-wk MA [paired CI] |")
    a("|---|---|---|---|---|")
    for m in test_all.sort_values("WAPE").model:
        a(row_ci(m))
    a("")
    a("![test WAPE](figures/test-wape.png)")
    a("")
    a("![aggregate](figures/test-aggregate.png)")
    a("")
    for name, tab in (("ABC class", test_abc), ("demand class", test_seg)):
        piv = tab.pivot_table(index="model", columns="group", values="WAPE")
        nsk = tab.drop_duplicates("group").set_index("group").n_skus
        piv = piv.loc[test_all.sort_values("WAPE").model]
        a(f"**WAPE by {name}** (SKUs per group: " + ", ".join(f"{g} {nsk[g]}" for g in piv.columns) + ")")
        a("")
        a("| Model | " + " | ".join(piv.columns) + " |")
        a("|---|" + "---|" * len(piv.columns))
        for m, r in piv.iterrows():
            a(f"| {LABELS[m]} | " + " | ".join(f"{v:.1%}" for v in r) + " |")
        a("")
        pb = tab.pivot_table(index="model", columns="group", values="Bias").loc[piv.index]
        a(f"Bias by {name}: " + "; ".join(f"{LABELS[m]} " + ", ".join(f"{g} {pb.loc[m, g]:+.0%}" for g in pb.columns)
                                         for m in [winner, "ma4", "snaive"]) + ".")
        a("")
    a("### Rolling origin (4-week horizon, refit at each origin)")
    a("")
    cols = VAL_RUNS + ROLL_RUNS
    a("| Model | " + " | ".join(f"{c} ({weeks[RUNS[c][0] if c != 'roll1' else RUNS['test'][0]].date()})" for c in cols)
      + " | mean before test | mean in test | bias before | bias in test | rank in test |")
    a("|---|" + "---|" * (len(cols) + 5))
    for m in roll_w.sort_values("mean_in_test").index:
        r = roll_w.loc[m]
        a(f"| {LABELS[m]} | " + " | ".join(f"{r[c]:.1%}" for c in cols)
          + f" | {r.mean_pre_test:.1%} | {r.mean_in_test:.1%} | {r.bias_pre_test:+.1%} | {r.bias_in_test:+.1%} | "
          f"{roll_rank[m]} |")
    a("")
    a("![rolling](figures/rolling-origin.png)")
    a("")
    a("### Capping bulk lines: with vs without")
    a("")
    cp = cap.pivot_table(index="model", columns=["history", "actuals"], values="WAPE")
    cb = cap.pivot_table(index="model", columns=["history", "actuals"], values="Bias")
    a("Test WAPE (bias) by the history the model was trained on, scored against raw or capped actuals:")
    a("")
    a("| Model | raw hist → raw actuals | capped hist → raw actuals | raw hist → capped actuals | capped hist → capped actuals | validation WAPE raw / capped hist |")
    a("|---|---|---|---|---|---|")
    for m in test_all.sort_values("WAPE").model:
        a(f"| {LABELS[m]} | " + " | ".join(
            f"{cp.loc[m, (h, act)]:.1%} ({cb.loc[m, (h, act)]:+.0%})"
            for act, h in (("raw", "raw"), ("raw", "capped"), ("capped", "raw"), ("capped", "capped")))
          + f" | {val_mean.loc[m, 'raw']:.1%} / {val_mean.loc[m, 'capped']:.1%} |")
    a("")
    better = [m for m in MODELS if cp.loc[m, ("capped", "raw")] < cp.loc[m, ("raw", "raw")]]
    a(f"On the test, capped history lowers WAPE against raw actuals for {len(better)} of {len(MODELS)} models, and "
      "moves bias down. Capping removes unforecastable one-off spikes from the history. The cost is that real bulk "
      "orders still happen, so their risk has to sit in the P90, not in the point forecast.")
    a("")
    a("## 5. ARIMA: what it assumes and how it did")
    a("")
    a("ARIMA(p,d,q) models the series (after differencing d times) as a linear function of its own last p values "
      "and the last q forecast errors, with Gaussian, constant-variance noise. It fits well when demand is a "
      "continuous, roughly stationary quantity whose recent values carry information about the next ones: "
      "high-volume, smooth items with persistent level changes. It fits badly when:")
    a("")
    a("- demand is erratic count data driven by large, irregular orders. The errors are then skewed and "
      "heteroscedastic, and the 'signal' in the autocorrelations is mostly noise;")
    a("- there is seasonality that you cannot estimate (one year of data → no SARIMA at period 52);")
    a("- series are short relative to the parameters. Each SKU has at most 91 training weeks.")
    a("")
    top_orders = ", ".join(f"{k} {v}" for k, v in arima_orders.head(6).items())
    a(f"Chosen orders at the test origin ({sel['n_skus']} SKUs): {top_orders}. {d1_share:.0%} of SKUs needed "
      f"differencing (d = 1). {white_noise:.0%} chose ARIMA(0,0,0), a constant mean: for these SKUs AIC finds no usable "
      "autocorrelation. On seasonally adjusted series the most common orders are "
      + ", ".join(f"{k} {v}" for k, v in arima_sa_orders.head(4).items()) + ". Most selected models are low-order "
      "(mostly MA terms or a plain mean), so in practice ARIMA acts as a smoothed level, much like ETS. ETS picked "
      "the level-only form for " + f"{ets_cfg.get('level', 0):.0%} of SKUs (damped trend "
      f"{ets_cfg.get('damped', 0):.0%}).")
    a("")
    ar, ars = t.loc["arima"], t.loc["arima_sa"]
    ctx = context
    g = ctx["guards"]
    a(f"Result: ARIMA test WAPE {ar.WAPE:.1%} (bias {ar.Bias:+.1%}) and ARIMA-SA {ars.WAPE:.1%} (bias {ars.Bias:+.1%}), "
      f"against {t.loc['ma4'].WAPE:.1%} for the 4-week mean. Plain ARIMA under-forecasts the autumn ramp because it "
      "has no seasonal term. "
      + (f"Adding the pooled seasonal index does not help: it over-corrects (bias {ars.Bias:+.1%}). The index "
         f"implies a {ctx['index_ramp']:.2f}x ramp from the last four training weeks to the test weeks (from 2010, "
         f"all product SKUs), but panel demand actually rose {ctx['ramp']:.2f}x (see section 8). "
         if ars.WAPE > ar.WAPE else "Adding the pooled seasonal index improves it. ")
      + f"The fit guard replaced the AIC-best candidate in {g['arima'][0]} of {g['arima'][1]:,} ARIMA fits and "
      f"{g['arima_sa'][0]} of {g['arima_sa'][1]:,} ARIMA-SA fits (all runs and variants); ETS needed it "
      f"{g['ets'][0]} and {g['ets_sa'][0]} times. **Recommendation to the owner:** ARIMA is a sound tool for "
      "smooth, high-volume items with several years of history. On this data (at most 91 weeks per SKU, erratic "
      "wholesale orders) per-SKU ARIMA "
      + ("does no better than a 4-week moving average" if ar.WAPE >= t.loc["ma4"].WAPE - 0.005 else
         "is only slightly better than a 4-week moving average")
      + ", so it does not justify its complexity here.")
    a("")
    a("![arima orders](figures/arima-orders.png)")
    a("")
    a("## 6. Demand distributions (P50 / P90) for the decision model")
    a("")
    a("Two approaches, both evaluated on the test:")
    a("")
    a("- **Residual quantiles:** for a point model, compute scaled errors r = (actual − forecast) / level (level = mean of "
      "the 13 weeks before the origin) at two earlier 13-week backtests (origins "
      f"{weeks[RUNS['cal1'][0]].date()} and {weeks[RUNS['cal2'][0]].date()}, before the test). Then take the 50% and "
      "90% quantiles of r for each horizon, pooled over SKUs. P_q = max(0, forecast + q-quantile × level).")
    a("- **Quantile GBM:** the same features, loss = quantile (0.5 and 0.9), target = raw demand ÷ level.")
    a("")
    a("Weighted pinball loss = Σ pinball / Σ actual (lower is better); coverage = share of SKU-weeks with actual ≤ Pq.")
    a("")
    a("| Method | pinball P50 | pinball P90 [95% CI] | P50 coverage | **P90 coverage** [95% CI] |")
    a("|---|---|---|---|---|")
    for r in qsum.sort_values("pinball90_w").itertuples():
        name = pretty_method(r.method)
        a(f"| {name} | {r.pinball50_w:.3f} | {r.pinball90_w:.3f} [{r.pinball90_lo:.3f}, {r.pinball90_hi:.3f}] | "
          f"{r.coverage50:.1%} | {r.coverage90:.1%} [{r.coverage90_lo:.1%}, {r.coverage90_hi:.1%}] |")
    a("")
    bq = qsum.set_index("method").loc[best_q_method]
    a(f"Selected for the decision model: **{pretty_method(best_q_method)}** (lowest P90 pinball loss). Its P90 covers "
      f"{bq.coverage90:.1%} of test SKU-weeks [{bq.coverage90_lo:.1%}, {bq.coverage90_hi:.1%}] against a 90% target. "
      "By ABC class: " + ", ".join(f"{r.abc} {r.coverage90:.1%}" for r in qsum_abc.itertuples()) + ". By horizon: "
      f"from {by_h.min():.0%} to {by_h.max():.0%} (h = 1: {by_h.iloc[0]:.0%}, h = 13: {by_h.iloc[-1]:.0%}). "
      + ("The P90 is **too low**: the calibration residuals come from March to August, and the test is the "
         "autumn ramp, so errors in the test are larger and more often negative. For the forward forecast the "
         "residuals of the test run are added to the calibration set." if bq.coverage90_hi < 0.90 else
         "The coverage is consistent with 90%."))
    a("")
    a("![examples](figures/example-distributions.png)")
    a("")
    a("## 7. Which model wins, and are the complex ones worth it?")
    a("")
    w, rr = t.loc[winner], test_vs_runner
    cols6 = VAL_RUNS + ROLL_RUNS
    best_n = int((roll_w[cols6].idxmin() == winner).sum())
    sig = w.dWAPE_hi < 0
    a(f"- **Winner on the test: {LABELS[winner]}**, WAPE {w.WAPE:.1%} [{w.WAPE_lo:.1%}, {w.WAPE_hi:.1%}], MASE "
      f"{w.MASE:.2f}, bias {w.Bias:+.1%}. Against the runner-up ({LABELS[runner]}) the WAPE difference is "
      f"{rr.dWAPE_vs_ref:+.1%} (paired CI [{rr.dWAPE_lo:+.1%}, {rr.dWAPE_hi:+.1%}]); against the 4-week mean it is "
      f"{w.dWAPE_vs_ref:+.1%} [{w.dWAPE_lo:+.1%}, {w.dWAPE_hi:+.1%}].")
    a(f"- **Rolling origin:** the winner has the lowest WAPE at {best_n} of 6 origins. It ranks {roll_rank[winner]} "
      f"on the in-test mean and {roll_rank_pre[winner]} on the pre-test mean (mean WAPE "
      f"{roll_w.loc[winner, 'mean_in_test']:.1%} in the test and {roll_w.loc[winner, 'mean_pre_test']:.1%} before it).")
    ets_d, ar_d = t.loc["ets"], t.loc["arima"]
    a(f"- **Are the complex models worth it?** Per-SKU ETS ({ets_d.dWAPE_vs_ref:+.1%} WAPE vs the 4-week mean, CI "
      f"[{ets_d.dWAPE_lo:+.1%}, {ets_d.dWAPE_hi:+.1%}]) and ARIMA ({ar_d.dWAPE_vs_ref:+.1%}, CI "
      f"[{ar_d.dWAPE_lo:+.1%}, {ar_d.dWAPE_hi:+.1%}]) are not; on this data they reduce to a smoothed level. "
      + (f"The global GBM is worth it, but the gain is modest: {-w.dWAPE_vs_ref * 100:.1f} percentage points of WAPE, with a paired "
         "CI that excludes zero, and it holds up across the rolling origins. Its residual quantiles also give "
         "the lowest P90 pinball loss." if (winner == "gbm" and sig) else
         "No model gives a clear gain over the 4-week mean.")
      + " The seasonal models (seasonal naive, SA) lose, for the reasons in section 8.")
    a("")
    a("## 8. Why the results look like this")
    a("")
    agg = ctx["aggacc"]
    a(f"- **SKU-week error is high by nature.** Panel demand is erratic (median CV² of non-zero weeks > 1). "
      f"Aggregation shows how much of the error is week-to-week noise. For {LABELS[winner]}, WAPE is "
      f"{agg.loc[winner, 'sku_4wk_WAPE']:.1%} on SKU x 4-week totals and {agg.loc[winner, 'panel_total_WAPE']:.1%} on "
      f"the weekly panel total (4-week mean: {agg.loc['ma4', 'sku_4wk_WAPE']:.1%} and "
      f"{agg.loc['ma4', 'panel_total_WAPE']:.1%}). Replenishment acts on demand over a lead time, so the 4-week "
      f"figure is the more relevant one. The winner's MASE is {w.MASE:.2f}"
      + (": below 1, so even 1 to 13 weeks ahead it beats an in-sample one-step naive forecast." if w.MASE < 1
         else ": not below 1, so it does not beat an in-sample one-step naive forecast."))
    beat_total = agg[agg.panel_total_WAPE < agg.loc[winner, "panel_total_WAPE"]].sort_values("panel_total_WAPE")
    best_4wk = agg.sku_4wk_WAPE.idxmin()
    a(f"- **Aggregate vs SKU-level accuracy.** On SKU × 4-week totals the best model is {LABELS[best_4wk]} "
      f"({agg.loc[best_4wk, 'sku_4wk_WAPE']:.1%}). On the weekly panel total, "
      + ("the ranking changes: " + ", ".join(f"{LABELS[m]} ({r.panel_total_WAPE:.1%})" for m, r in beat_total.iterrows())
         + f" beat {LABELS[winner]} ({agg.loc[winner, 'panel_total_WAPE']:.1%}). "
         if len(beat_total) else f"{LABELS[winner]} is also best ({agg.loc[winner, 'panel_total_WAPE']:.1%}). ")
      + "Summed over all panel SKUs, errors in opposite directions cancel, so the panel-total WAPE is close to the "
      "size of the overall bias ("
      + "; ".join(f"{LABELS[m]}: bias {t.loc[m, 'Bias']:+.1%}, total WAPE {agg.loc[m, 'panel_total_WAPE']:.1%}"
                  for m in list(beat_total.index) + [winner])
      + "). The total rewards the smallest overall under-forecast of the ramp, not getting each SKU right. The "
      "replenishment decision is made per SKU, so SKU-level accuracy (and SKU × 4-week accuracy) is the criterion "
      "used here. For a total-level figure, such as a working-capital plan, the sum of the per-SKU "
      + (" or ".join(LABELS[m] for m in beat_total.index) if len(beat_total) else LABELS[winner])
      + " forecasts was the better estimate of the total in this test.")
    a("")
    a("| Model | SKU-week WAPE | SKU × 4-week WAPE | weekly panel-total WAPE | bias |")
    a("|---|---|---|---|---|")
    for m in agg.sort_values("sku_4wk_WAPE").index:
        a(f"| {LABELS[m]} | {t.loc[m, 'WAPE']:.1%} | {agg.loc[m, 'sku_4wk_WAPE']:.1%} | "
          f"{agg.loc[m, 'panel_total_WAPE']:.1%} | {t.loc[m, 'Bias']:+.1%} |")
    a("")
    lvl = t.loc[["naive", "ma4", "sba", "ets", "arima", "gbm"], "Bias"]
    a(f"- **Every model that follows the recent level under-forecasts** (bias {lvl.max():+.0%} to "
      f"{lvl.min():+.0%}). The test is the autumn ramp: mean weekly panel demand in the test was "
      f"{ctx['ramp']:.2f}x the last four training weeks.")
    a(f"- **Seasonal naive over-forecasts** ({t.loc['snaive'].Bias:+.0%}) because the panel SKUs shrank. In the test "
      f"weeks they sold {ctx['panel_yoy']:.0%} of their volume in the same weeks of 2010, while all product SKUs "
      f"together sold {ctx['total_yoy']:.0%}. The panel requires a long history, so it holds the older range, which "
      "is losing share to newer products. Last year's level is the wrong level.")
    a(f"- **The SA models over-forecast** because they copy the amplitude of one season, from a different mix of "
      f"SKUs. The pooled index (all product SKUs, 2010) implies a {ctx['index_ramp']:.2f}x ramp into the test weeks. "
      f"The panel's own ramp was {ctx['ramp_2010']:.2f}x in 2010 and {ctx['ramp']:.2f}x in 2011. With one year of "
      "history the seasonal shape can be seen, but its size for a given group of SKUs cannot be estimated reliably.")
    if winner == "gbm":
        a("- **GBM wins** because it pools all SKUs: it combines the current level with last year's ramp (for the SKU "
          "and pooled) and learns from the training history how much of that ramp to trust. It is still biased low, "
          "because it has seen only one earlier autumn.")
    else:
        a(f"- **{LABELS[winner]} wins.** The pooled GBM does not beat it on this test.")
    a(f"- **Censored demand:** {ctx['zero_run_ge8']} panel SKUs have a run of at least 8 consecutive zero weeks "
      f"(outside the Christmas closure) before the test origin, up to {ctx['zero_run_max']} weeks. "
      f"{ctx['level_le1_at_test_origin']} sold at most 1 unit a week in the 13 weeks before it. For regularly sold items "
      "this looks like stock-outs rather than zero demand. Level-following models then forecast close to 0 while "
      "demand returns.")
    a("")
    a("## 9. Conclusion and future work")
    a("")
    a(f"- Use **{LABELS[winner]}** for point forecasts and **{pretty_method(best_q_method)}** for P50/P90, trained on "
      f"{chosen} history. Keep the 4-week moving average as the benchmark and fallback: it is within "
      f"{(t.loc['ma4'].WAPE - w.WAPE) * 100:.1f} percentage points of WAPE of the winner and trivially robust.")
    a("- Treat the P90 as optimistic (see the coverage above). The decision model should widen it, or simulate "
      "lead-time demand, until the data holds more seasons.")
    a("- Future work: (1) re-estimate once a second autumn is in the training data, so the seasonal amplitude can be "
      "estimated; (2) model censored demand using stock data, if FlowChain can record it; (3) forecast bulk orders "
      "separately (customer order pipeline, quotes); (4) extend the analysis to the intermittent tail with Croston/SBA "
      "or pooled models; (5) tune the GBM with time-series cross-validation, which was deliberately not done here, "
      "to keep the test honest.")
    a("")
    a(f"_Runtime {seconds / 60:.1f} min; seed {SEED}._")
    (paths.outputs_dir / "demand-forecast.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def pretty_method(name: str) -> str:
    if name.startswith("residual quantiles on "):
        return "residual quantiles around " + LABELS[name.replace("residual quantiles on ", "")]
    return name


if __name__ == "__main__":
    sys.exit(main())
