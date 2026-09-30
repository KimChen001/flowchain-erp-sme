"""Supplier scorecard for direct-drop shipments (rubric: descriptive analytics).

Writes ``outputs/supplier-scorecard.md``, aggregate CSVs
(``supplier-scorecard-{vendor,mode,country,product-group}.csv``) and a figure.
The CSVs contain group-level aggregates only, never row-level data.

Definitions follow FlowChain's business rules:

* **on-time** = delivered <= scheduled + grace, with grace = 0 days by default
  (``--grace-days``). Early deliveries count as on time, as in FlowChain's
  receiving walkthrough, which classifies arrived < promised as early,
  arrived = promised as on time, and arrived > promised as late.
* **early** = delivered < scheduled.
* **days late** = delivered − scheduled, among late shipments only.
* **lead time** = delivered − PO sent (actual), scheduled − PO sent (planned).
* **freight share** = allocated freight / line item value, over lines whose
  freight is a number (not "included in commodity cost" or "invoiced separately").

Groups with fewer than 30 shipments are reported as "insufficient sample".

Usage (from ``analytics/``)::

    python -m scms.supplier_scorecard [--data-dir DIR] [--grace-days N]
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from statsmodels.stats.proportion import proportion_confint

from .dataset import load_clean
from .paths import GRACE_DAYS, parse_args
from .report import BLUE, INK_2, ORANGE, md_table, pct, save_figure, style_axes, write_text

MIN_SHIPMENTS = 30


def wilson(successes: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (np.nan, np.nan)
    low, high = proportion_confint(successes, n, alpha=0.05, method="wilson")
    return float(low), float(high)


def summarise(group: pd.DataFrame, grace: int) -> pd.Series:
    n = len(group)
    late_mask = group["late_days"] > grace
    on_time = int((~late_mask).sum())
    low, high = wilson(on_time, n)
    late_days = group.loc[late_mask, "late_days"]
    lead = group[group["lead_days_actual"].notna()]
    freight = group[group["freight_share_of_value"].notna()]
    freight_value = freight["line_item_value"].sum()
    return pd.Series(
        {
            "shipments": n,
            "on_time": on_time,
            "on_time_rate": on_time / n if n else np.nan,
            "on_time_ci_low": low,
            "on_time_ci_high": high,
            "early_rate": (group["late_days"] < 0).mean() if n else np.nan,
            "exact_on_schedule_rate": (group["late_days"] == 0).mean() if n else np.nan,
            "late_shipments": int(late_mask.sum()),
            "mean_days_late_if_late": late_days.mean() if len(late_days) else np.nan,
            "p90_days_late_if_late": late_days.quantile(0.9) if len(late_days) else np.nan,
            "lead_time_rows": len(lead),
            "median_lead_actual_days": lead["lead_days_actual"].median() if len(lead) else np.nan,
            "median_lead_planned_days": lead["lead_days_planned"].median() if len(lead) else np.nan,
            "freight_rows": len(freight),
            "freight_share_total": freight["freight_usd"].sum() / freight_value if freight_value > 0 else np.nan,
            "freight_share_median": freight["freight_share_of_value"].median() if len(freight) else np.nan,
            "freight_included_rate": group["freight_included"].astype(bool).mean() if n else np.nan,
            "sample_status": "ok" if n >= MIN_SHIPMENTS else "insufficient sample",
        }
    )


def scorecard(frame: pd.DataFrame, by: str, grace: int) -> pd.DataFrame:
    rows = {key: summarise(group, grace) for key, group in frame.groupby(by, observed=True)}
    table = pd.DataFrame(rows).T
    table.index.name = by
    numeric = [c for c in table.columns if c != "sample_status"]
    table[numeric] = table[numeric].apply(pd.to_numeric)
    table["_ok"] = table["sample_status"].eq("ok")
    table = table.sort_values(["_ok", "on_time_rate", "shipments"], ascending=[False, False, False])
    return table.drop(columns="_ok")


def display(table: pd.DataFrame, label: str, compact_small: bool = False) -> pd.DataFrame:
    """Markdown view: small groups show only their size."""
    if compact_small:
        table = table[table["sample_status"].eq("ok")]
    out = pd.DataFrame(index=table.index)
    ok = table["sample_status"].eq("ok")
    out["shipments"] = table["shipments"].astype(int)
    out["on-time (95% Wilson CI)"] = [
        f"{pct(r.on_time_rate)} ({pct(r.on_time_ci_low)}–{pct(r.on_time_ci_high)})" if good else "insufficient sample"
        for good, r in zip(ok, table.itertuples())
    ]
    out["early"] = [pct(v) if good else "" for good, v in zip(ok, table["early_rate"])]
    out["exact = sched."] = [pct(v) if good else "" for good, v in zip(ok, table["exact_on_schedule_rate"])]
    out["late n"] = [str(int(v)) if good else "" for good, v in zip(ok, table["late_shipments"])]
    out["mean / P90 days late"] = [
        (f"{r.mean_days_late_if_late:.1f} / {r.p90_days_late_if_late:.1f}" if r.late_shipments else "no late")
        if good else ""
        for good, r in zip(ok, table.itertuples())
    ]
    out["median lead actual / planned (d)"] = [
        (f"{r.median_lead_actual_days:.0f} / {r.median_lead_planned_days:.0f}" if r.lead_time_rows else "no PO dates")
        if good else ""
        for good, r in zip(ok, table.itertuples())
    ]
    out["freight share total / median"] = [
        (f"{pct(r.freight_share_total)} / {pct(r.freight_share_median)}" if r.freight_rows else "no freight data")
        if good else ""
        for good, r in zip(ok, table.itertuples())
    ]
    out["freight in price"] = [pct(v) if good else "" for good, v in zip(ok, table["freight_included_rate"])]
    out.index.name = label
    return out.reset_index()


def forest_plot(table: pd.DataFrame, path) -> str:
    ok = table[table["sample_status"].eq("ok")].sort_values("on_time_rate")
    fig, ax = plt.subplots(figsize=(8, 0.32 * len(ok) + 1.2))
    y = np.arange(len(ok))
    ax.hlines(y, ok["on_time_ci_low"] * 100, ok["on_time_ci_high"] * 100, color=BLUE, linewidth=2)
    ax.plot(ok["on_time_rate"] * 100, y, "o", color=BLUE, markersize=6)
    overall = table.attrs.get("overall_rate")
    if overall is not None:
        ax.axvline(overall * 100, color=ORANGE, linewidth=1, linestyle="--")
        ax.text(overall * 100, len(ok) - 0.3, f" all direct drop {overall * 100:.1f}%", color=INK_2, fontsize=8)
    labels = [f"{name[:42]} (n={int(n)})" for name, n in zip(ok.index, ok["shipments"])]
    ax.set_yticks(y, labels, fontsize=8)
    ax.set_xlabel("On-time rate, delivered <= scheduled (%), with 95% Wilson interval")
    ax.set_title("Direct-drop vendors with at least 30 shipments", loc="left", fontsize=11)
    style_axes(ax)
    ax.grid(axis="x", color="#e4e3df", linewidth=0.6)
    ax.grid(axis="y", visible=False)
    return save_figure(fig, path)


def main() -> int:
    def extra(parser):
        parser.add_argument("--grace-days", type=int, default=GRACE_DAYS, help="Grace period in days (default 0)")

    args, paths = parse_args(__doc__.splitlines()[0], extra)
    paths.ensure()
    grace = args.grace_days
    clean = load_clean(paths)
    sc = clean[clean["usable_scorecard"].fillna(False).astype(bool)].copy()
    sc["shipment_mode"] = sc["shipment_mode"].fillna("Not recorded")

    overall = summarise(sc, grace)
    vendor = scorecard(sc, "vendor", grace)
    vendor.attrs["overall_rate"] = overall["on_time_rate"]
    mode = scorecard(sc, "shipment_mode", grace)
    country = scorecard(sc, "country", grace)
    product = scorecard(sc, "product_group", grace)

    for table, name in [(vendor, "vendor"), (mode, "mode"), (country, "country"), (product, "product-group")]:
        table.to_csv(paths.outputs_dir / f"supplier-scorecard-{name}.csv", float_format="%.6g")
    fig = forest_plot(vendor, paths.figures_dir / "vendor-on-time.png")

    ok = vendor[vendor["sample_status"].eq("ok")]
    top = ok.sort_values(["on_time_rate", "on_time_ci_low"], ascending=False).head(3)
    bottom = ok.sort_values(["on_time_rate", "on_time_ci_high"]).head(3)
    small = vendor[vendor["sample_status"].ne("ok")]
    grace_sensitivity = pd.DataFrame(
        [
            {"grace (days)": g, "on-time rate": pct(((sc["late_days"] <= g).mean())), "late shipments": int((sc["late_days"] > g).sum())}
            for g in (0, 3, 7, 14)
        ]
    )
    local = top[top["median_lead_actual_days"] <= 7]
    top_lead_note = (
        f"{', '.join(local.index)} has a median actual lead time of "
        f"{', '.join(f'{v:.0f}' for v in local['median_lead_actual_days'])} days, consistent with a local distributor rather than an international supplier."
        if len(local) else ""
    )
    # Do top/bottom intervals overlap?
    separated = top["on_time_ci_low"].min() > bottom["on_time_ci_high"].max()

    def names(frame):
        return "; ".join(
            f"{name} ({pct(r.on_time_rate)}, CI {pct(r.on_time_ci_low)}–{pct(r.on_time_ci_high)}, n={int(r.shipments)})"
            for name, r in zip(frame.index, frame.itertuples())
        )

    report = f"""# Supplier scorecard: SCMS direct-drop shipments

Generated by `analytics/scms/supplier_scorecard.py`. Scope: {len(sc):,}
direct-drop shipments usable for the scorecard, from {sc['vendor'].nunique()}
vendors. Warehouse (RDC) shipments are excluded because they are not vendor
deliveries. The aggregate tables are also in `supplier-scorecard-*.csv`.

## Definitions (FlowChain business rules)

- **On-time**: delivered ≤ scheduled + grace, with **grace = {grace} days**
  (FlowChain default). Early deliveries count as on time. This matches the
  FlowChain receiving walkthrough (arrived < promised = early, arrived =
  promised = on time, arrived > promised = late) and the open-PO report (overdue
  when days past the promised date > 0). The interval is a Wilson 95% score
  interval.
- **Early**: delivered < scheduled. **Exact = sched.**: delivered on the
  scheduled day (shown because of the revision finding below).
- **Days late**: delivered − scheduled, among late shipments only (mean and 90th percentile).
- **Lead time**: delivered − PO sent (actual) against scheduled − PO sent
  (planned), medians, over rows with a captured PO date.
- **Freight share**: allocated freight ÷ line item value. "Total" is Σ freight
  ÷ Σ value, and "median" is the median line share. Both use only lines with a
  numeric freight cost. "Freight in price" is the share of lines whose freight
  is included in the commodity cost, which makes freight invisible for them.
- Groups with fewer than {MIN_SHIPMENTS} shipments are shown as **insufficient sample**.

**Caveat.** {pct(overall['exact_on_schedule_rate'])} of these shipments arrived
on exactly the scheduled day. `data-quality.md` §3.4 shows that the scheduled
date probably reflects later revisions, so these on-time rates are upper bounds
on performance against the original promise. Differences *between* vendors
also mix delivery performance with differences in how their schedules were
recorded.

## Overall

- On-time: **{pct(overall['on_time_rate'])}** (95% CI {pct(overall['on_time_ci_low'])}–{pct(overall['on_time_ci_high'])}), early {pct(overall['early_rate'])}, late shipments {int(overall['late_shipments']):,}.
- Among late shipments: mean {overall['mean_days_late_if_late']:.1f} days late, P90 {overall['p90_days_late_if_late']:.1f} days.
- Median lead time: actual {overall['median_lead_actual_days']:.0f} days vs planned {overall['median_lead_planned_days']:.0f} days ({int(overall['lead_time_rows']):,} rows with PO date).
- Freight share: total {pct(overall['freight_share_total'])}, median {pct(overall['freight_share_median'])} ({int(overall['freight_rows']):,} lines with numeric freight). Freight is included in the price for {pct(overall['freight_included_rate'])} of lines.

Sensitivity of the overall on-time rate to the grace period:

{md_table(grace_sensitivity)}

## Vendors

{len(ok)} vendors have at least {MIN_SHIPMENTS} shipments ({int(ok['shipments'].sum()):,} shipments,
{pct(ok['shipments'].sum() / len(sc))} of the scope). {len(small)} vendors with
{int(small['shipments'].sum()):,} shipments in total have an insufficient sample.

- **Highest on-time** (≥{MIN_SHIPMENTS} shipments): {names(top)}.
- **Lowest on-time**: {names(bottom)}.
- The top three and bottom three 95% intervals {'do not overlap' if separated else 'overlap'}.
- The top three delivered on exactly the scheduled day in
  {', '.join(pct(v) for v in top['exact_on_schedule_rate'])} of shipments. That
  is the pattern `data-quality.md` §3.4 flags, so their perfect scores more
  likely reflect how their schedules were recorded than exceptional delivery.
  {top_lead_note}
- The bottom three account for {int(bottom['late_shipments'].sum())} of the
  {int(overall['late_shipments'])} late shipments ({pct(bottom['late_shipments'].sum() / overall['late_shipments'])}).
  They are also large vendors ({int(bottom['shipments'].sum()):,} shipments), so
  their intervals are narrow.

![Vendor on-time rates]({'figures/' + fig})

{md_table(display(vendor, 'vendor', compact_small=True))}

Vendors with an insufficient sample (shipments): {'; '.join(f"{name} ({int(n)})" for name, n in small['shipments'].sort_values(ascending=False).items())}.

## By shipment mode

{md_table(display(mode, 'shipment mode'))}

## By product group

{md_table(display(product, 'product group'))}

## By destination country

{md_table(display(country, 'country'))}

## Reading the scorecard

- Late shipments are rare, so the on-time rate is high for most vendors. The
  late count and the days-late columns show where lateness is concentrated.
- Differences in the median planned lead time are large. Comparing actual with
  planned lead time shows slippage, but it inherits the revision caveat: where
  the schedule was revised, actual and planned match by construction.
- Freight share is comparable only among vendors that invoice freight.
  Vendors quoting delivered prices (DDP, "freight included") show no freight
  share. Their freight cost is hidden in the price, not absent.
- The scorecard measures timeliness and cost only. The data has no received
  quantity or rejections, so FlowChain's in-full and quality components cannot
  be scored from it.
"""
    write_text(paths.outputs_dir / "supplier-scorecard.md", report)
    print(f"Wrote {paths.outputs_dir / 'supplier-scorecard.md'}")
    print("top:", names(top))
    print("bottom:", names(bottom))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
