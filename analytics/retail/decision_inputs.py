"""Demand inputs for the decision model (part 1 -> decision model).

    python -m retail.decision_inputs [--data-dir DIR] [--cost-ratio 0.5] [--holding-rate 0.25]

Reads   derived/forecasts.csv, derived/quantile_forecasts.csv, derived/sale_lines.csv,
        derived/panel_skus.csv, outputs/forecast-selection.json
Writes  outputs/demand-distribution.csv  per SKU per week: point, P50, P90 (+ actual in the test)
        outputs/sku-parameters.csv       per SKU cost, holding, stockout and pack proxies
        outputs/decision-inputs.md       what the columns mean and which values are assumptions

All outputs are weekly or per-SKU aggregates; no invoice lines are written.
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd

from . import config as C
from .paths import add_data_dir_arg, data_paths_from_args

# ASSUMPTIONS (not in the data). Change them on the command line.
COST_RATIO = 0.50        # unit cost = COST_RATIO x median selling price
HOLDING_RATE = 0.25      # holding cost per year as a share of unit cost
PACK_CANDIDATES = (2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 25, 30, 32, 36, 40, 48, 50, 60, 72, 96, 100, 120, 144)
PACK_SHARE = 0.80        # a pack size must divide at least this share of the SKU's order lines
Z90 = 1.2815515655446004  # standard normal 90% quantile


def pack_proxy(q: np.ndarray) -> tuple[int, float]:
    best, share = 1, 1.0
    for d in PACK_CANDIDATES:
        s = float(np.mean(q % d == 0))
        if s >= PACK_SHARE:
            best, share = d, s
    return best, share


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_data_dir_arg(parser)
    parser.add_argument("--cost-ratio", type=float, default=COST_RATIO)
    parser.add_argument("--holding-rate", type=float, default=HOLDING_RATE)
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()

    sel = json.loads((paths.outputs_dir / "forecast-selection.json").read_text(encoding="utf-8"))
    winner, variant, qmethod = sel["winner"], sel["history_variant"], sel["quantile_method"]
    fc = pd.read_csv(paths.derived_dir / "forecasts.csv", dtype={"sku": str}, parse_dates=["week"])
    qf = pd.read_csv(paths.derived_dir / "quantile_forecasts.csv", dtype={"sku": str})
    skus = pd.read_csv(paths.sku_csv, dtype={"sku": str}).set_index("sku")
    lines = pd.read_csv(paths.lines_csv, dtype={"sku": str}, parse_dates=["InvoiceDate", "week"],
                        usecols=["sku", "InvoiceDate", "week", "Quantity", "Price"])

    # ---- demand distribution -------------------------------------------------
    pt = fc[(fc.model == winner) & (fc.variant == variant) & fc.run.isin(["test", "fwd"])]
    dist = pt.merge(qf, on=["run", "sku", "h"], how="left")
    dist["split"] = dist.run.map({"test": "test", "fwd": "forward"})
    dist["origin_week"] = dist.week - pd.to_timedelta(dist.h * 7, unit="D")
    dist = dist.assign(point_forecast=dist.yhat.round(2), p50=dist.p50.round(2), p90=dist.p90.round(2),
                       actual_units=dist.y, point_model=winner, quantile_method=qmethod, history=variant,
                       abc=dist.sku.map(skus.abc), segment=dist.sku.map(skus.segment))
    # P90 should never sit below P50.
    dist["p90"] = np.maximum(dist.p90, dist.p50)
    out_cols = ["sku", "split", "origin_week", "week", "h", "point_forecast", "p50", "p90", "actual_units",
                "abc", "segment", "point_model", "quantile_method", "history"]
    dist = dist.sort_values(["split", "sku", "h"])[out_cols].rename(columns={"h": "horizon_weeks"})
    dist["week"] = dist.week.dt.date
    dist["origin_week"] = dist.origin_week.dt.date
    dist.to_csv(paths.outputs_dir / "demand-distribution.csv", index=False)

    # ---- per-SKU parameters (training period only) ------------------------------
    tr = lines[(lines.week >= C.FIRST_WEEK) & (lines.week <= C.TRAIN_END) & lines.sku.isin(skus.index)]
    rows = []
    for sku, g in tr.groupby("sku"):
        q = g.Quantity.to_numpy()
        pk, share = pack_proxy(q)
        rows.append({"sku": sku, "median_price": float(g.Price.median()),
                     "unit_weighted_price": float((g.Price * g.Quantity).sum() / g.Quantity.sum()),
                     "median_line_qty": float(np.median(q)), "p10_line_qty": float(np.percentile(q, 10)),
                     "pack_size_proxy": pk, "pack_share_of_lines": share, "train_lines": len(g)})
    par = pd.DataFrame(rows).set_index("sku").join(skus[["abc", "segment", "description", "train_units",
                                                         "returns_units_train", "bulk_threshold"]])
    n_train_weeks = len(pd.date_range(C.FIRST_WEEK, C.TRAIN_END, freq="W-MON"))
    par["mean_weekly_units_train"] = par.train_units / n_train_weeks
    par["return_rate_units"] = par.returns_units_train / par.train_units
    par["cost_ratio_assumed"] = args.cost_ratio
    par["unit_cost_proxy"] = par.median_price * args.cost_ratio
    par["holding_rate_per_year_assumed"] = args.holding_rate
    par["holding_cost_per_unit_week"] = par.unit_cost_proxy * args.holding_rate / 52
    par["stockout_cost_per_unit"] = par.median_price - par.unit_cost_proxy
    par = par.reset_index()
    num = par.select_dtypes("number").columns
    par[num] = par[num].round(4)
    par.to_csv(paths.outputs_dir / "sku-parameters.csv", index=False)

    # ---- checks for the decision model ------------------------------------------
    te = dist[dist.split == "test"].copy()
    cov90 = float((te.actual_units <= te.p90).mean())
    # Lead-time demand: weekly quantiles do not add. Compare two ways to get a P90 of a
    # 4-week total on the test (h = 1..4 and h = 5..8 windows).
    agg_rows = []
    for lo in (1, 5, 9):
        wv = te[(te.horizon_weeks >= lo) & (te.horizon_weeks < lo + 4)]
        g = wv.groupby("sku").agg(actual=("actual_units", "sum"), p50=("p50", "sum"), p90=("p90", "sum"))
        sig = ((wv.p90 - wv.p50) / Z90) ** 2
        g["indep_p90"] = g.p50 + Z90 * np.sqrt(sig.groupby(wv.sku).sum())
        agg_rows.append({"weeks": f"h {lo}-{lo + 3}", "sum_of_weekly_p90_coverage": float((g.actual <= g.p90).mean()),
                         "independent_normal_p90_coverage": float((g.actual <= g.indep_p90).mean()),
                         "sum_of_weekly_p50_coverage": float((g.actual <= g.p50).mean())})
    agg = pd.DataFrame(agg_rows)
    h4 = par.holding_cost_per_unit_week * 4
    cr4 = (par.stockout_cost_per_unit / (par.stockout_cost_per_unit + h4)).median()
    cr13 = (par.stockout_cost_per_unit / (par.stockout_cost_per_unit + par.holding_cost_per_unit_week * 13)).median()
    pack_dist = par.pack_size_proxy.value_counts().head(8)

    L = []
    a = L.append
    a("# Decision-model inputs from the demand forecast (part 1)")
    a("")
    a(f"Point forecasts come from **{winner}** trained on **{variant}** history; P50/P90 come from **{qmethod}**. "
      "The choices and their evidence are in `demand-forecast.md`. Everything here is aggregated per SKU and week, "
      "with no invoice lines.")
    a("")
    a("## The decision these inputs feed")
    a("")
    a("A weekly replenishment decision per SKU: how much to order now. This is a proposed formulation for the joint "
      "model, with lead time L from part 2 (SCMS) and review period R:")
    a("")
    a("- Periodic review with an order-up-to level: each review, order S − (on hand + on order), with "
      "S = the CR-quantile of demand over L + R weeks.")
    a("- Critical ratio CR = c_u / (c_u + c_o), with c_u = stockout cost per unit and c_o = holding cost over the "
      "cycle (from `sku-parameters.csv`). Orders are rounded up to the pack-size proxy.")
    a("- Demand over L + R comes from the weekly distributions below, and L itself is random (part 2). The sum "
      "should be simulated, not built from added quantiles; see the check below.")
    a("")
    a("## `demand-distribution.csv`")
    a("")
    nt, nf = int((dist.split == "test").sum()), int((dist.split == "forward").sum())
    a(f"{len(dist):,} rows = {dist.sku.nunique()} SKUs × 13 weeks × 2 splits ({nt:,} test rows, {nf:,} forward rows).")
    a("")
    a("| Column | Meaning |")
    a("|---|---|")
    a("| sku | normalised StockCode (upper case) |")
    a(f"| split | `test`: forecast from origin {dist[dist.split == 'test'].origin_week.iloc[0]} for the 13 test weeks, "
      f"with actuals, for back-testing the decision; `forward`: forecast from the last full week "
      f"{dist[dist.split == 'forward'].origin_week.iloc[0]} for the 13 weeks after the data ends (no actuals) |")
    a("| origin_week, week | Monday of the last observed week, and of the forecast week |")
    a("| horizon_weeks | weeks ahead (1–13) |")
    a("| point_forecast | mean-type forecast from the winning model (units/week) |")
    a("| p50, p90 | weekly demand quantiles (units/week); p90 ≥ p50 enforced |")
    a("| actual_units | gross shipped units in that week (test only) |")
    a("| abc, segment | revenue class and Syntetos–Boylan demand class (training weeks) |")
    a("")
    a(f"Test P90 coverage in this file: {cov90:.1%} of SKU-weeks.")
    a("")
    a("**Weekly quantiles do not add up.** Lead-time demand is a sum over weeks. On the test, three 4-week windows "
      "compare two ways to build a P90 for the 4-week total:")
    a("")
    a("| Window | Σ weekly P90 covers | independent-normal P90 covers | Σ weekly P50 covers |")
    a("|---|---|---|---|")
    for r in agg.itertuples():
        a(f"| {r.weeks} | {r.sum_of_weekly_p90_coverage:.1%} | {r.independent_normal_p90_coverage:.1%} | "
          f"{r.sum_of_weekly_p50_coverage:.1%} |")
    a("")
    a("Here the independent-normal P90 is ΣP50 + 1.2816·√Σσ², with σ = (P90 − P50)/1.2816 for each week. Summing "
      "weekly P90s assumes perfectly correlated errors, and the normal version assumes independent errors. The truth "
      "lies between them, because forecast errors of one SKU are positively correlated across weeks. The decision model "
      "should therefore simulate the lead-time total. Draw each SKU's lead time from part 2 and add weekly demand "
      "draws, or scale the weekly spread with a correlation checked against these windows.")
    a("")
    a("## `sku-parameters.csv`")
    a("")
    a("All values come from training weeks only (to 2011-08-29).")
    a("")
    a("| Column | Source | Status |")
    a("|---|---|---|")
    a("| median_price | median selling price per unit over the SKU's sale lines (GBP) | data |")
    a("| unit_weighted_price | revenue ÷ units; lower than the median because bulk lines get lower prices | data |")
    a(f"| unit_cost_proxy | median_price × cost ratio {args.cost_ratio:.2f} | **ASSUMPTION**: the data has no costs |")
    a(f"| holding_cost_per_unit_week | unit_cost_proxy × {args.holding_rate:.0%} per year ÷ 52 | **ASSUMPTION** |")
    a("| stockout_cost_per_unit | median_price − unit_cost_proxy, i.e. the lost margin of a lost sale, with no "
      "goodwill penalty and no backorders | **ASSUMPTION** |")
    a(f"| pack_size_proxy | largest of {', '.join(map(str, PACK_CANDIDATES[:8]))}, … that divides ≥ {PACK_SHARE:.0%} "
      "of the SKU's order-line quantities (1 if none) | **PROXY**: customer order multiples, not supplier packs |")
    a("| median_line_qty, p10_line_qty | typical customer order-line size | data |")
    a("| mean_weekly_units_train, return_rate_units | training demand level; returned ÷ shipped units | data |")
    a("| bulk_threshold | line size above which a line is treated as a bulk one-off (clean.py) | rule |")
    a("")
    a(f"Summary over {len(par)} SKUs: median unit cost proxy £{par.unit_cost_proxy.median():.2f} "
      f"(IQR £{par.unit_cost_proxy.quantile(.25):.2f}–£{par.unit_cost_proxy.quantile(.75):.2f}); median holding cost "
      f"£{par.holding_cost_per_unit_week.median():.4f} per unit-week; median stockout cost £"
      f"{par.stockout_cost_per_unit.median():.2f} per unit; median return rate {par.return_rate_units.median():.1%}.")
    a("")
    a("Pack-size proxy distribution (SKUs): " + ", ".join(f"{k}: {v}" for k, v in pack_dist.items()) + ". "
      f"{(par.pack_size_proxy > 1).mean():.0%} of SKUs have a pack multiple > 1. A MOQ cannot be inferred: the data "
      "shows what customers ordered, not what the supplier requires. The decision model should treat MOQ as an "
      "input to vary, for example 1 or 2 packs.")
    a("")
    a("**What the assumptions imply.** Under these assumptions a lost unit costs far more than holding it for a few "
      f"weeks. The median newsvendor critical ratio is {cr4:.3f} for a 4-week review cycle and {cr13:.3f} for a "
      "13-week one. So the cost-optimal service level is well above 90%, and a P90 alone is not enough: the "
      "decision model needs the upper tail beyond P90, such as a distribution fitted through P50 and P90 or "
      "simulated demand. That conclusion depends on the cost ratio and the no-backorder assumption; with backorders "
      "the stockout cost would be much lower.")
    a("")
    (paths.outputs_dir / "decision-inputs.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"Wrote demand-distribution.csv ({len(dist):,} rows), sku-parameters.csv ({len(par)}), decision-inputs.md")
    print(agg.to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main())
