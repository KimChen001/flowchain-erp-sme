"""Data-quality report for the Online Retail II demand study.

    python -m retail.quality_report [--data-dir DIR]

Reads the outputs of clean.py and writes outputs/data-quality.md plus figures in
outputs/figures/. Every number in the report is computed here or in clean.py.
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd

from . import config as C
from . import plotting as P
from .metrics import naive_scale, per_sku, point_metrics
from .paths import CITATION, add_data_dir_arg, data_paths_from_args


def md_table(df: pd.DataFrame, fmt: dict | None = None) -> str:
    fmt = fmt or {}
    cols = list(df.columns)
    out = ["| " + " | ".join(cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for _, r in df.iterrows():
        cells = []
        for c in cols:
            v = r[c]
            f = fmt.get(c)
            cells.append(f.format(v) if f and pd.notna(v) else ("" if pd.isna(v) else str(v)))
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)


def quick_capping_check(panel: pd.DataFrame, skus: pd.DataFrame) -> pd.DataFrame:
    """Naive, 4-week mean and seasonal naive trained on raw vs capped history (13-week test)."""
    weeks = np.sort(panel.week.unique())
    t_idx = {w: i for i, w in enumerate(weeks)}
    rows = []
    for hist_col in ("units", "units_capped"):
        wide = panel.pivot(index="sku", columns="week", values=hist_col)
        act = panel.pivot(index="sku", columns="week", values="units")
        act_c = panel.pivot(index="sku", columns="week", values="units_capped")
        tr = wide.loc[:, wide.columns <= C.TRAIN_END].to_numpy(float)
        te_weeks = [w for w in weeks if w > np.datetime64(C.TRAIN_END)]
        n = len(te_weeks)
        preds = {
            "naive": np.repeat(tr[:, -1:], n, axis=1),
            "ma4": np.repeat(tr[:, -4:].mean(axis=1, keepdims=True), n, axis=1),
            "snaive": np.column_stack([wide[weeks[t_idx[w] - C.SEASON_LENGTH]].to_numpy(float) for w in te_weeks]),
        }
        scale = np.array([naive_scale(r) for r in act.loc[:, act.columns <= C.TRAIN_END].to_numpy(float)])
        for actual_name, a in (("raw", act), ("capped", act_c)):
            y = a[te_weeks].to_numpy(float)
            for m, yhat in preds.items():
                f = pd.DataFrame({"sku": np.repeat(wide.index.to_numpy(), n), "y": y.ravel(), "p": yhat.ravel(),
                                  "scale": np.repeat(scale, n)})
                pm = point_metrics(per_sku(f, "p"))
                rows.append({"model": m, "history": "raw" if hist_col == "units" else "capped",
                             "actuals": actual_name, **pm})
    return pd.DataFrame(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_data_dir_arg(parser)
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()
    P.setup()
    figs = paths.figures_dir

    st = json.loads((paths.derived_dir / "clean_stats.json").read_text(encoding="utf-8"))
    log = pd.read_csv(paths.outputs_dir / "cleaning-log.csv")
    totals = pd.read_csv(paths.derived_dir / "weekly_totals.csv", parse_dates=["week"])
    panel = pd.read_csv(paths.weekly_csv, parse_dates=["week"], dtype={"sku": str})
    skus = pd.read_csv(paths.sku_csv, dtype={"sku": str})
    lines = pd.read_csv(paths.lines_csv, parse_dates=["InvoiceDate", "week"], dtype={"sku": str, "Invoice": str})
    raw, ov = st["raw"], st["overlap"]
    inwin = lines[(lines.week >= C.FIRST_WEEK) & (lines.week <= C.LAST_WEEK)]

    # ---- derived numbers -------------------------------------------------
    sheet_dups = ov["within_sheet_dups_sheet1"] + ov["within_sheet_dups_sheet2"] - ov["within_sheet_dups_in_overlap_window"]
    panel_lines = inwin[inwin.sku.isin(skus.sku)]
    dup_share_panel = panel_lines.Quantity[panel_lines.dup_line].sum() / panel_lines.Quantity.sum()
    gross_units = int(inwin.Quantity.sum())
    ret_units = int(totals.returns_units.sum())
    panel_ret_rate = panel.returns_units.sum() / panel.units.sum()
    miss_cust_kept = int(lines["Customer ID"].isna().sum())
    raw_miss_cust = raw["missing_customer_rows"]
    log_by = {r.step: r for r in log.itertuples()}

    # bulk effect on the panel's weekly series
    ptr = panel[panel.split == "train"]
    affected = (ptr.units != ptr.units_capped)
    cv_raw = ptr.groupby("sku").units.agg(lambda s: s.std() / s.mean())
    cv_cap = ptr.groupby("sku").units_capped.agg(lambda s: s.std() / s.mean())
    bulk_panel_units = 1 - ptr.units_capped.sum() / ptr.units.sum()
    bulk_lines_all = lines.bulk.sum()
    top_bulk = (lines[lines.bulk].assign(ratio=lambda d: d.Quantity / d.bulk_threshold)
                .nlargest(8, "Quantity")[["InvoiceDate", "sku", "Description", "Quantity", "bulk_threshold", "Price"]])
    top_bulk["InvoiceDate"] = top_bulk.InvoiceDate.dt.date.astype(str)
    top_bulk = top_bulk.rename(columns={"InvoiceDate": "date", "Quantity": "qty", "bulk_threshold": "threshold"})

    # intermittency of all product SKUs, training weeks (from first sale), for context
    tr_lines = inwin[inwin.week <= C.TRAIN_END]
    wk_all = tr_lines.groupby(["sku", "week"]).Quantity.sum().unstack(fill_value=0)
    train_weeks = pd.date_range(C.FIRST_WEEK, C.TRAIN_END, freq="W-MON")
    wk_all = wk_all.reindex(columns=train_weeks, fill_value=0)
    recs = []
    for sku, row in wk_all.iterrows():
        y = row.to_numpy()
        y = y[np.argmax(y > 0):]
        nz = y[y > 0]
        if len(nz) < 2:
            continue
        adi = len(y) / len(nz)
        cv2 = (nz.std() / nz.mean()) ** 2
        recs.append({"sku": sku, "active": len(nz), "adi": adi, "cv2": cv2, "zero_share": (y == 0).mean()})
    allint = pd.DataFrame(recs)
    allint["segment"] = [("smooth" if c < C.CV2_CUT else "erratic") if a < C.ADI_CUT else
                         ("intermittent" if c < C.CV2_CUT else "lumpy") for a, c in zip(allint.adi, allint.cv2)]
    allint["in_panel"] = allint.sku.isin(skus.sku)
    bands = pd.cut(allint.active, [1, 12, 25, 51, 69, 91], labels=["2-12", "13-25", "26-51", "52-69", "70-91"])
    seg_tab = pd.crosstab(bands, allint.segment).reindex(columns=["smooth", "erratic", "intermittent", "lumpy"],
                                                         fill_value=0)
    seg_tab.index.name = "active training weeks"
    seg_tab = seg_tab.reset_index()

    # seasonality evidence from training data only
    early = skus[pd.to_datetime(skus.first_sale_week) <= pd.Timestamp("2010-02-01")].sku
    t2010 = ptr[ptr.sku.isin(early)]
    base = t2010[(t2010.week >= "2010-02-01") & (t2010.week <= "2010-08-30")].groupby("sku").units.mean()
    q4 = t2010[(t2010.week >= "2010-09-06") & (t2010.week <= "2010-11-29")].groupby("sku").units.mean()
    ratio = (q4 / base).replace([np.inf, -np.inf], np.nan).dropna()
    agg_ratio = q4.sum() / base.sum()

    abc = skus.groupby("abc").agg(skus=("sku", "size"), revenue=("train_revenue", "sum"), units=("train_units", "sum"),
                                  median_zero_share=("zero_share", "median"), median_cv2=("cv2", "median"))
    abc["revenue share"] = abc.revenue / abc.revenue.sum()
    abc = abc.reset_index()
    seg = skus.groupby("segment").agg(skus=("sku", "size"), median_adi=("adi", "median"),
                                      median_cv2=("cv2", "median"), median_zero_share=("zero_share", "median"),
                                      revenue=("train_revenue", "sum")).reset_index()

    cap_check = quick_capping_check(panel, skus)
    cap_check.to_csv(paths.outputs_dir / "capping-quick-check.csv", index=False)

    # ---- figures -----------------------------------------------------------
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(9, 3.4))
    ax.axvspan(C.TEST_START - pd.Timedelta(days=3), C.LAST_WEEK + pd.Timedelta(days=4), color=P.GRID, alpha=0.6, lw=0)
    ax.plot(totals.week, totals.units / 1e3, color=P.SERIES[0], label="gross shipped units")
    ax.plot(totals.week, totals.units_capped / 1e3, color=P.SERIES[2], lw=1.2, label="bulk lines capped")
    ax.plot(totals.week, totals.returns_units / 1e3, color=P.SERIES[1], lw=1.2, label="returns (separate)")
    ax.set_ylabel("thousand units per week")
    ax.set_title("Weekly demand, all product SKUs (test weeks shaded)")
    ax.legend(loc="upper left", ncol=3)
    P.save(fig, figs / "weekly-totals.png")

    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
    ax = axes[0]
    other = allint[~allint.in_panel]
    ax.scatter(other.adi, other.cv2, s=6, color=P.MUTED, alpha=0.35, lw=0, label="not in panel")
    ax.scatter(skus.adi, skus.cv2, s=8, color=P.SERIES[0], alpha=0.7, lw=0, label="panel")
    ax.axvline(C.ADI_CUT, color=P.TEXT2, lw=0.8, ls="--")
    ax.axhline(C.CV2_CUT, color=P.TEXT2, lw=0.8, ls="--")
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel("ADI (weeks between sales)"); ax.set_ylabel("CV² of non-zero weekly demand")
    ax.set_title("Demand classes (training weeks)")
    ax.legend(loc="upper right")
    ax = axes[1]
    ax.hist(skus.zero_share, bins=24, color=P.SERIES[0], edgecolor=P.SURFACE, lw=1)
    ax.set_xlabel("share of zero weeks (panel SKUs)"); ax.set_ylabel("SKUs")
    ax.set_title("Zero weeks in the panel")
    P.save(fig, figs / "intermittency.png")

    ex_sku = ptr.groupby("sku").apply(lambda g: (g.units - g.units_capped).max(), include_groups=False).idxmax()
    ex = panel[panel.sku == ex_sku]
    fig, ax = plt.subplots(figsize=(9, 3))
    ax.plot(ex.week, ex.units, color=P.SERIES[0], label="raw")
    ax.plot(ex.week, ex.units_capped, color=P.SERIES[2], label="bulk lines capped")
    ax.set_title(f"Largest capping effect in the panel: SKU {ex_sku} "
                 f"({skus.set_index('sku').description.get(ex_sku, '')})")
    ax.set_ylabel("units per week"); ax.legend(loc="upper left")
    P.save(fig, figs / "bulk-capping-example.png")

    # ---- report ------------------------------------------------------------
    np_codes = pd.DataFrame(st["non_product_codes"])
    np_codes["kind"] = np.select(
        [np_codes.sku.str.startswith("DCGS") | np_codes.sku.eq("SP1002"),
         np_codes.sku.str.startswith("GIFT"), np_codes.sku.str.startswith("TEST")],
        ["dotcom listing code", "gift voucher", "test"], "service / fee / adjustment")
    np_kind = np_codes.groupby("kind").agg(codes=("sku", "size"), rows=("rows", "sum")).reset_index()
    np_top = np_codes.head(14)[["sku", "description", "rows", "median_price", "net_units"]]
    mq = st["max_quantity_line"]
    wk = st["weeks"]
    sc = st["sku_counts"]
    pnl = st["panel"]
    capm = cap_check.pivot_table(index=["model", "actuals"], columns="history", values="WAPE").reset_index()
    capb = cap_check.pivot_table(index=["model", "actuals"], columns="history", values="Bias").reset_index()
    capm = capm.merge(capb, on=["model", "actuals"], suffixes=(" WAPE", " bias"))

    L = []
    a = L.append
    a("# Data quality: Online Retail II (demand forecasting, part 1)")
    a("")
    a(f"Data: {CITATION} All counts below come from `clean.py` and `quality_report.py`; the step-by-step "
      "table is in `cleaning-log.md`.")
    a("")
    a("## 1. Dataset")
    a("")
    a(f"- **Rows:** {raw['rows']:,} invoice lines in two sheets "
      f"({', '.join(f'{k}: {v:,}' for k, v in raw['rows_by_sheet'].items())}).")
    a(f"- **Period:** {raw['date_min'][:10]} to {raw['date_max'][:10]}; {raw['invoices']:,} invoice numbers, "
      f"{raw['stockcodes_raw']:,} raw StockCodes, {raw['countries']} countries.")
    a(f"- **Features ({raw['n_columns']}):** Invoice (6 digits; prefix C = cancellation, A = bad-debt adjustment), "
      "StockCode (item), Description, Quantity (units per line), InvoiceDate (minute), Price (GBP per unit), "
      "Customer ID, Country.")
    a("- **Why it fits:** it is a complete invoice-line log of one wholesaler (many customers are shops) over two "
      "years, so it gives weekly demand for hundreds of SKUs with prices and a strong Christmas season. That matches "
      "FlowChain's replenishment question: how much of each item to have on hand week by week.")
    a("- **What it lacks:** there are no stock levels, costs, supplier or lead-time fields. Sales are *shipped* demand; "
      "weeks when an item was out of stock look like low demand (censoring), and we cannot correct for that.")
    a("")
    a("## 2. Missing values")
    a("")
    miss = pd.DataFrame({"column": list(raw["missing_by_column"]), "missing rows": list(raw["missing_by_column"].values())})
    miss["share"] = miss["missing rows"] / raw["rows"]
    a(md_table(miss, {"missing rows": "{:,}", "share": "{:.2%}"}))
    a("")
    a(f"- **Customer ID** is missing on {raw_miss_cust:,} rows ({raw['missing_customer_share']:.1%}). After cleaning, "
      f"{miss_cust_kept:,} kept sale lines ({miss_cust_kept / st['kept_sale_lines']:.1%}) still have no customer. "
      "They are kept. Item-level demand sums units by SKU and week, and the customer is not part of that sum. "
      "These lines have real prices and positive quantities (zero-price and negative lines are removed by other rules). "
      "Dropping them would cut demand by about a fifth for no gain. The one place the customer matters is matching a "
      "cancellation to the order it voids; cancellations without a customer are therefore treated as returns.")
    rd = st["reconcile"]["missing Description"]
    a(f"- **Description** is missing on {raw['missing_by_column']['Description']:,} rows. All have price 0 "
      f"(checked: {st['missing_description_all_price_0']}) and are removed by other rules ("
      + ", ".join(f"{k} {v:,}" for k, v in rd.items()) +
      f"); {st['missing_description_rows_after_rules']} remain after cleaning. Descriptions are not model inputs.")
    a(f"- **Quantity ≤ 0** ({raw['qty_le_0_rows']:,} raw rows) ends up as: "
      + ", ".join(f"{k} {v:,}" for k, v in st["reconcile"]["quantity <= 0"].items()) + ".")
    a("")
    a("## 3. Duplicates and the sheet overlap")
    a("")
    a(f"There are {raw['exact_duplicate_rows_overall']:,} exact duplicate rows overall (all eight columns equal). "
      "They have two different causes:")
    a("")
    a(f"1. **Sheet overlap ({ov['overlap_rows_sheet1']:,} rows).** Sheet 1 runs to {raw['sheet1_date_range'][1][:10]} "
      f"and sheet 2 starts on {raw['sheet2_date_range'][0][:10]}. The {ov['overlap_invoices']:,} invoices dated "
      f"2010-12-01..09 appear in both sheets, and the two copies are identical as multisets "
      f"({ov['overlap_rows_sheet1']:,} rows each, same count of every distinct line). This is an artefact of how the "
      "file was assembled, so the sheet-1 copy is dropped.")
    a(f"2. **Same line repeated within one sheet ({sheet_dups:,} rows = {ov['within_sheet_dups_sheet1']:,} in sheet 1 + "
      f"{ov['within_sheet_dups_sheet2']:,} in sheet 2 − {ov['within_sheet_dups_in_overlap_window']} counted in both "
      "sheets because they fall in the overlap window).** The same invoice, item, quantity, price and minute appear "
      "twice. An invoice export cannot tell a double post from the same item keyed twice, and the invoice total "
      f"includes both lines. They are **kept and flagged** (`dup_line`). They are {log_by[2].note} overall and "
      f"{dup_share_panel:.2%} of panel units, so either choice changes little.")
    a("")
    a(f"Check: {ov['overlap_rows_sheet1']:,} + {sheet_dups:,} = {ov['overlap_rows_sheet1'] + sheet_dups:,} "
      f"(total exact duplicates {raw['exact_duplicate_rows_overall']:,}).")
    a("")
    a("A third quality issue: " + log_by[3].note + " that differ only by letter case (e.g. `15056bl` / `15056BL`, same "
      f"description). {log_by[3].rows:,} rows are merged into the upper-case code.")
    a("")
    a("## 4. Cancellations: gross shipped demand vs net of returns")
    a("")
    a(f"There are {raw['cancellation_rows']:,} cancellation rows in the raw file (invoice prefix C). After removing the overlap copy and "
      f"non-product codes, they split into:")
    a("")
    t2 = st["top2_lines"]
    a(f"- **Voids:** {log_by[5].rows:,} cancellation lines exactly reverse an earlier sale by the same customer "
      f"(same SKU and quantity) within {C.VOID_WINDOW_HOURS} h; the median gap is {st['voids']['median_gap_hours']:.1f} h. "
      f"The order was never shipped, so the sale line is removed as well ({log_by[6].units:,} units). The maximum "
      f"quantity in the file, {mq['quantity']:,} × {mq['description'].strip()} (invoice {mq['invoice']}, {mq['date']}), "
      f"is voided by {', '.join(mq['cancelled_by'])} {st['top2_void_gap_minutes'][0]:.0f} minutes later. The second "
      f"largest line ({t2[1]['quantity']:,} units of SKU {t2[1]['sku']}, {t2[1]['date'][:10]}) is also a void "
      f"(status `{t2[1]['status']}`, {st['top2_void_gap_minutes'][1]:.0f} minutes). "
      f"Together they hold {st['voids']['units_two_largest']:,} units.")
    a(f"- **Returns and credits:** the other {log_by[7].rows:,} cancellation lines ({log_by[7].units:,} units) are later "
      "returns, damages credits or price corrections.")
    lr = st["largest_return"]
    a(f"- The spike in the returns line (figure in section 7) is one credit note, {lr['invoice']} on {lr['date'][:10]}: "
      f"{lr['units']:,} units on {lr['lines']} lines. {lr['lines_matching_earlier_sale']} of the lines match an earlier "
      f"sale to the same customer, a median {lr['median_days_after_sale']:.0f} days before (sale weeks "
      f"{', '.join(lr['sale_weeks'])}). The goods shipped, so the original order stays in gross demand; "
      f"{lr['matched_sale_lines_flagged_bulk']} of the matched sale lines are flagged as bulk by the rule in section 6.")
    a("")
    rc = st["reconcile"]["cancellation rows"]
    a("Where the raw cancellation rows go: " + ", ".join(f"{k} {v:,}" for k, v in rc.items()) + ".")
    a("")
    a("**Recommendation: forecast gross shipped demand, and report returns separately.** Reasons:")
    a("")
    a("- Replenishment must cover what leaves the warehouse. Returns arrive weeks later, often damaged or as pure "
      "price credits, so they do not free stock in the week the sale is made.")
    a("- Netting creates negative or zero weeks that are not demand. That breaks MASE/WAPE scaling and "
      "the zero-filled panel.")
    a("- Voids are removed, so 'gross' is not inflated by orders that were keyed in and immediately cancelled.")
    a("")
    a(f"Over all product SKUs in the 104 full weeks, returns are {ret_units:,} units against {gross_units:,} gross shipped units "
      f"({ret_units / gross_units:.1%}); for panel SKUs the return rate is {panel_ret_rate:.1%}. "
      "Weekly returns are stored per SKU (`returns_units`) for the decision model.")
    a("")
    a("## 5. Non-product codes and price ≤ 0")
    a("")
    a(f"Non-product codes are found from the data: a product code is five digits plus an optional letter suffix. "
      f"{len(np_codes)} codes ({log_by[4].rows:,} rows) fail the pattern. Their descriptions in the data:")
    a("")
    a(md_table(np_kind, {"rows": "{:,}"}))
    a("")
    a(md_table(np_top, {"rows": "{:,}", "median_price": "{:,.2f}", "net_units": "{:,}"}))
    a("")
    a("The `DCGS…` codes look like real merchandise listed on the web shop under a separate code. They are "
      f"excluded too: none has rows in more than {st['dcgs_max_weeks_with_rows']} weeks, so none could enter the panel.")
    a("")
    rp = st["reconcile"]["price <= 0"]
    a(f"Price ≤ 0 ({raw['price_le_0_rows']:,} raw rows; by rule: " + ", ".join(f"{k} {v:,}" for k, v in rp.items()) + "):")
    a("")
    a(f"- {raw['price_lt_0_rows']} rows have a negative price. All are 'Adjust bad debt' (code B, invoice prefix A) and are "
      "removed with the non-product codes.")
    a(f"- {log_by[8].rows:,} non-cancellation lines have quantity ≤ 0 and price 0 ({log_by[8].units:,} units). None has a customer. "
      "Their descriptions are stock notes (" + ", ".join(f"'{k}' {v}" for k, v in list(st['stock_adjustment_top_descriptions'].items())[:6])
      + "), so they are write-offs, not demand. They are excluded.")
    a(f"- {log_by[9].rows:,} lines have quantity > 0 and price 0 ({log_by[9].note}), e.g. 'found', 'check', "
      "'adjustment' or free items. They are excluded; the few with a customer are free goods, not priced demand.")
    a("")
    a("## 6. Extreme orders (bulk one-off lines)")
    a("")
    a("Wholesale customers sometimes buy one item in bulk. A single such line can be larger than a normal month of "
      "demand. **Rule:** within each SKU, compute the median $m$ and MAD of log(quantity) over training-period "
      f"lines; flag a line when $(\\log q - m) / \\max(1.4826\\,\\text{{MAD}}, \\log 2) > {C.BULK_Z}$. This is the "
      "Iglewicz–Hoaglin modified z-score on a log scale. The floor exists because "
      "many SKUs sell mostly one pack size (MAD = 0); with the floor a line must be at least "
      f"2^{C.BULK_Z} ≈ {2 ** C.BULK_Z:.1f}× the median line. Thresholds use training weeks only, so the test period does not "
      "move them. Flagged lines stay in the data; the *capped* series caps them at the threshold.")
    a("")
    a(f"- {bulk_lines_all:,} lines are flagged ({bulk_lines_all / len(lines):.2%} of kept sale lines), but they carry "
      f"{log_by[11].units:,} units; {log_by[11].note}. In the panel's training weeks capping removes "
      f"{bulk_panel_units:.1%} of units and changes {affected.mean():.1%} of SKU-weeks.")
    a(f"- Capping lowers the median weekly coefficient of variation of panel SKUs from {cv_raw.median():.2f} to "
      f"{cv_cap.median():.2f}.")
    a("")
    a("Largest flagged lines (all remain in the raw series):")
    a("")
    a(md_table(top_bulk, {"qty": "{:,}", "threshold": "{:,.0f}", "Price": "{:.2f}"}))
    a("")
    a("![bulk capping example](figures/bulk-capping-example.png)")
    a("")
    a("**Effect on forecasting (quick check, simple baselines, 13-week test).** 'history' is the series the forecast is "
      "built from; 'actuals' is what it is scored against. `demand-forecast.md` repeats this for every model.")
    a("")
    a(md_table(capm.rename(columns={"raw WAPE": "WAPE raw hist", "capped WAPE": "WAPE capped hist",
                                    "raw bias": "bias raw hist", "capped bias": "bias capped hist"}),
               {"WAPE raw hist": "{:.1%}", "WAPE capped hist": "{:.1%}", "bias raw hist": "{:+.1%}",
                "bias capped hist": "{:+.1%}"}))
    a("")
    a("Against raw actuals, capped history lowers WAPE but pushes bias more negative: bulk orders are real shipped "
      "demand that a capped forecast will not cover. See `demand-forecast.md` for the decision.")
    a("")
    a("## 7. Weekly aggregation and panel selection")
    a("")
    a(f"- **Week:** {wk['definition']}. The raw data spans {wk['calendar_weeks_in_raw_data']} calendar weeks. The first "
      "(starts Tuesday 2009-12-01) and last (ends Friday 2011-12-09 at midday) are partial and are dropped, which leaves "
      f"**{wk['n_weeks']} full weeks, {wk['panel_first_week']} to {wk['panel_last_week']}** "
      f"({log_by[12].rows:,} lines and {log_by[12].units:,} units left out).")
    a(f"- **Train / test:** {wk['n_train_weeks']} training weeks to {wk['train_end']}; test = last {wk['n_test_weeks']} "
      f"weeks from {wk['test_start']}.")
    a(f"- **Zero-filling:** every panel SKU gets a row for every week, and weeks without a sale are 0. The weeks of "
      f"{' and '.join(wk['closed_weeks'])} have no sales at all (Christmas closure); these are true zeros.")
    a(f"- **Panel rule:** SKUs sold in at least {C.MIN_ACTIVE_TRAIN_WEEKS} of the {wk['n_train_weeks']} training weeks "
      f"(77%, the same rate as 80 of 104). It uses training weeks only, so the choice does not depend on test sales. "
      f"**{pnl['n_skus']} SKUs** qualify, {pnl['n_skus'] * wk['n_weeks']:,} SKU-weeks. They make up "
      f"{pnl['panel_share_of_train_units']:.1%} of training units and {pnl['panel_share_of_train_revenue']:.1%} of "
      f"training revenue.")
    a(f"- For comparison, after cleaning, {sc['active_ge_80_of_104']} SKUs sell in ≥ 80 of the 104 weeks "
      f"({sc['overlap_train_rule_and_80_of_104']} of them are also in the panel) and {sc['active_ge_52_of_104']} "
      f"in ≥ 52. Before cleaning, with raw codes, sale lines with quantity and price > 0 and weeks ending on Monday "
      f"(pandas `W-MON`), there are {st['pre_cleaning_counts_w_mon']['weeks_with_sales']} weeks with sales, "
      f"{st['pre_cleaning_counts_w_mon']['codes_ge_80']} codes sold in ≥ 80 of them and "
      f"{st['pre_cleaning_counts_w_mon']['codes_ge_52']} in ≥ 52. The small differences come from merging case variants, "
      "removing voids and dropping the partial weeks.")
    a("- **ABC class** by training revenue within the panel: A = first 80% of cumulative revenue, B = next 15%, C = rest.")
    a("")
    a(md_table(abc, {"revenue": "£{:,.0f}", "units": "{:,}", "revenue share": "{:.1%}", "median_zero_share": "{:.1%}",
                     "median_cv2": "{:.2f}"}))
    a("")
    a("![weekly totals](figures/weekly-totals.png)")
    a("")
    a("## 8. Intermittency and what it implies for the models")
    a("")
    a("For each SKU, over training weeks from its first sale: ADI = weeks / weeks with a sale, and CV² = squared "
      "coefficient of variation of the non-zero weekly quantities. The Syntetos–Boylan cut-offs "
      f"(ADI {C.ADI_CUT}, CV² {C.CV2_CUT}) give four classes.")
    a("")
    a(md_table(seg, {"median_adi": "{:.2f}", "median_cv2": "{:.2f}", "median_zero_share": "{:.1%}", "revenue": "£{:,.0f}"}))
    a("")
    a(f"Because the panel needs {C.MIN_ACTIVE_TRAIN_WEEKS}+ active weeks, every panel SKU has ADI < {C.ADI_CUT} "
      f"(median zero-week share {skus.zero_share.median():.1%}). The panel is **smooth or erratic**, with no "
      "intermittent or lumpy SKUs. Most SKUs are erratic: order sizes vary a lot (median CV² "
      f"{skus.cv2.median():.2f}), consistent with the wholesale order sizes in section 6. The tail outside the "
      "panel is mostly intermittent or lumpy:")
    a("")
    a(md_table(seg_tab))
    a("")
    a("Implications: for smooth and erratic series, level-based models (moving averages, exponential smoothing, "
      "ARIMA) and a pooled GBM are appropriate. Croston/SBA are built for intermittent and lumpy series. They are "
      "run as a check only, since the panel has none. The erratic class is why a robust treatment of "
      "bulk lines and a scale-free metric (MASE) matter.")
    a("")
    a("![intermittency](figures/intermittency.png)")
    a("")
    a("**Seasonality (training data only).** For panel SKUs sold since at least 2010-02, mean weekly units in "
      f"Sep–Nov 2010 are {agg_ratio:.2f}× the Feb–Aug 2010 mean in aggregate (median SKU ratio {ratio.median():.2f}; "
      f"{(ratio > 1).mean():.0%} of {len(ratio)} SKUs are higher in Q4). The test window (Sep–Nov 2011) is this ramp. "
      "A model without a seasonal signal will under-forecast it.")
    a("")
    (paths.outputs_dir / "data-quality.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"Wrote {paths.outputs_dir / 'data-quality.md'}")
    print(cap_check.to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main())
