"""Clean Online Retail II invoice lines into weekly gross shipped demand per SKU.

    python -m retail.clean [--data-dir DIR]

Reads   derived/transactions.csv (both sheets stacked, see fetch.py)
Writes  derived/sale_lines.csv      cleaned sale lines with flags (row level, local only)
        derived/weekly_panel.csv    zero-filled weekly demand for the panel SKUs
        derived/weekly_totals.csv   weekly totals over all product SKUs
        derived/panel_skus.csv      one row per panel SKU (ABC, intermittency class)
        derived/clean_stats.json    counts used by quality_report.py
        outputs/cleaning-log.csv, outputs/cleaning-log.md

Rules are applied in order. Each excluded row is attributed to the first rule that
excludes it, so the "rows" column of the log adds up.
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd

from . import config as C
from .paths import COLUMNS, SHEETS, add_data_dir_arg, data_paths_from_args

KEY = list(COLUMNS)


def load(paths) -> pd.DataFrame:
    df = pd.read_csv(
        paths.transactions_csv,
        dtype={"Invoice": str, "StockCode": str, "Description": str, "Country": str,
               "Quantity": "int64", "Price": "float64", "Customer ID": "float64"},
    )
    expected = sum(n for _, n in SHEETS)
    if list(df.columns) != KEY or len(df) != expected:
        raise SystemExit(f"Unexpected transactions.csv shape {df.shape}; run python -m retail.fetch")
    df["InvoiceDate"] = pd.to_datetime(df["InvoiceDate"])
    n1 = SHEETS[0][1]
    df["sheet"] = np.where(np.arange(len(df)) < n1, 1, 2)
    df["row_id"] = np.arange(len(df))
    return df


def profile_raw(df: pd.DataFrame) -> dict:
    s1, s2 = df[df.sheet == 1], df[df.sheet == 2]
    return {
        "rows": len(df),
        "rows_by_sheet": {SHEETS[0][0]: len(s1), SHEETS[1][0]: len(s2)},
        "columns": KEY,
        "n_columns": len(KEY),
        "date_min": str(df.InvoiceDate.min()),
        "date_max": str(df.InvoiceDate.max()),
        "sheet1_date_range": [str(s1.InvoiceDate.min()), str(s1.InvoiceDate.max())],
        "sheet2_date_range": [str(s2.InvoiceDate.min()), str(s2.InvoiceDate.max())],
        "missing_by_column": {c: int(df[c].isna().sum()) for c in KEY},
        "exact_duplicate_rows_overall": int(df.duplicated(KEY).sum()),
        "invoices": int(df.Invoice.nunique()),
        "invoices_in_both_sheets": len(set(s1.Invoice) & set(s2.Invoice)),
        "cancellation_rows": int(df.Invoice.str.startswith("C").sum()),
        "qty_le_0_rows": int((df.Quantity <= 0).sum()),
        "price_le_0_rows": int((df.Price <= 0).sum()),
        "price_lt_0_rows": int((df.Price < 0).sum()),
        "missing_customer_rows": int(df["Customer ID"].isna().sum()),
        "missing_customer_share": float(df["Customer ID"].isna().mean()),
        "stockcodes_raw": int(df.StockCode.nunique()),
        "countries": int(df.Country.nunique()),
        "quantity_max": int(df.Quantity.max()),
        "quantity_min": int(df.Quantity.min()),
    }


def check_overlap(df: pd.DataFrame) -> dict:
    """Confirm the sheet-1 rows in the overlap window are an exact copy of sheet 2's."""
    win = (df.InvoiceDate >= C.OVERLAP_START) & (df.InvoiceDate < C.OVERLAP_END)
    a = df[win & (df.sheet == 1)][KEY].fillna({"Customer ID": -1, "Description": ""})
    b = df[win & (df.sheet == 2)][KEY].fillna({"Customer ID": -1, "Description": ""})
    ca, cb = a.value_counts(), b.value_counts()
    joined = pd.concat([ca.rename("a"), cb.rename("b")], axis=1).fillna(0)
    mismatched = int((joined.a != joined.b).sum())
    if mismatched:
        raise SystemExit(f"Overlap copies differ in {mismatched} distinct lines; review before dropping")
    dup_in_window = int(a.duplicated().sum())
    return {
        "overlap_rows_sheet1": len(a), "overlap_rows_sheet2": len(b),
        "overlap_invoices": int(df[win & (df.sheet == 1)].Invoice.nunique()),
        "overlap_multiset_identical": True,
        "within_sheet_dups_in_overlap_window": dup_in_window,
        "within_sheet_dups_sheet1": int(df[df.sheet == 1].duplicated(KEY).sum()),
        "within_sheet_dups_sheet2": int(df[df.sheet == 2].duplicated(KEY).sum()),
    }


def match_voids(cancels: pd.DataFrame, sales: pd.DataFrame) -> pd.DataFrame:
    """One-to-one match of cancellation lines to earlier sale lines they exactly reverse."""
    c = cancels[cancels["Customer ID"].notna()][["row_id", "Customer ID", "sku", "Quantity", "InvoiceDate"]].copy()
    c["q"] = -c.Quantity
    s = sales[sales["Customer ID"].notna()][["row_id", "Customer ID", "sku", "Quantity", "InvoiceDate"]].copy()
    s["q"] = s.Quantity
    pairs = c.merge(s, on=["Customer ID", "sku", "q"], suffixes=("_c", "_s"))
    gap = (pairs.InvoiceDate_c - pairs.InvoiceDate_s).dt.total_seconds() / 3600
    pairs = pairs[(gap >= 0) & (gap <= C.VOID_WINDOW_HOURS)].assign(gap_h=gap)
    pairs = pairs.sort_values(["gap_h", "row_id_c", "row_id_s"])
    used_c, used_s, keep = set(), set(), []
    for rc, rs in zip(pairs.row_id_c.to_numpy(), pairs.row_id_s.to_numpy()):
        if rc in used_c or rs in used_s:
            continue
        used_c.add(rc)
        used_s.add(rs)
        keep.append((rc, rs))
    return pd.DataFrame(keep, columns=["cancel_row", "sale_row"]).merge(
        pairs[["row_id_c", "row_id_s", "gap_h", "q"]],
        left_on=["cancel_row", "sale_row"], right_on=["row_id_c", "row_id_s"],
    )[["cancel_row", "sale_row", "gap_h", "q"]]


def bulk_thresholds(sales: pd.DataFrame) -> pd.Series:
    train = sales[sales.InvoiceDate < C.TEST_START]
    lq = np.log(train.Quantity.astype(float))
    g = lq.groupby(train.sku)
    med = g.median()
    mad = (lq - train.sku.map(med)).abs().groupby(train.sku).median()
    scale = np.maximum(1.4826 * mad, C.BULK_LOG_SCALE_FLOOR)
    thr = np.exp(med + C.BULK_Z * scale)
    n = g.size()
    return thr[n >= C.BULK_MIN_TRAIN_LINES]


def week_start(ts: pd.Series) -> pd.Series:
    return ts.dt.to_period("W-SUN").dt.start_time.dt.normalize()


def classify(adi: float, cv2: float) -> str:
    if adi < C.ADI_CUT:
        return "smooth" if cv2 < C.CV2_CUT else "erratic"
    return "intermittent" if cv2 < C.CV2_CUT else "lumpy"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_data_dir_arg(parser)
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()

    df = load(paths)
    stats: dict = {"raw": profile_raw(df)}
    stats["overlap"] = check_overlap(df)
    log: list[dict] = []

    def add_log(rule, rows, units, action, note=""):
        log.append({"step": len(log) + 1, "rule": rule, "rows": int(rows), "units": int(units),
                    "action": action, "note": note})

    df["status"] = "kept"
    is_c = df.Invoice.str.startswith("C")

    # 1. Sheet overlap.
    m = (df.sheet == 1) & (df.InvoiceDate >= C.OVERLAP_START)
    df.loc[m, "status"] = "overlap_copy"
    add_log("Sheet-1 rows dated 2010-12-01..09 (copy of sheet 2)", m.sum(), df.Quantity[m].abs().sum(),
            "drop; keep the sheet-2 copy", "multisets of the two copies are identical")

    live = df.status == "kept"
    # 2. Exact duplicates within one sheet (after removing the overlap copy).
    dup = live &df.loc[live, KEY].duplicated(keep="first").reindex(df.index, fill_value=False)
    df["dup_line"] = dup
    pos_units = df.Quantity[live & (df.Quantity > 0)].sum()
    add_log("Exact duplicate line within one sheet", dup.sum(), df.Quantity[dup].abs().sum(),
            "keep, flag dup_line", f"{df.Quantity[dup & (df.Quantity > 0)].sum() / pos_units:.2%} of positive units")

    # 3. StockCode normalisation.
    df["sku"] = df.StockCode.str.strip().str.upper()
    changed = live & (df.sku != df.StockCode)
    merged_codes = int(df.loc[live].groupby("sku").StockCode.nunique().gt(1).sum())
    add_log("StockCode differs only by case or whitespace", changed.sum(), df.Quantity[changed].abs().sum(),
            "normalise to trimmed upper case", f"{merged_codes} codes had two spellings")

    # 4. Non-product codes.
    nonprod = live & ~df.sku.str.fullmatch(C.PRODUCT_CODE_REGEX)
    df.loc[nonprod, "status"] = "non_product"
    np_table = (df[nonprod].groupby("sku")
                .agg(rows=("Quantity", "size"),
                     description=("Description", lambda s: s.dropna().mode().iloc[0] if s.notna().any() else ""),
                     median_price=("Price", "median"), net_units=("Quantity", "sum"))
                .sort_values("rows", ascending=False))
    stats["non_product_codes"] = np_table.reset_index().to_dict(orient="records")
    add_log("StockCode not 5 digits + optional letters (postage, fees, manual, discounts, vouchers, tests)",
            nonprod.sum(), df.Quantity[nonprod].abs().sum(), "exclude from demand",
            f"{len(np_table)} codes; includes all 'A' bad-debt invoices")

    live = df.status == "kept"
    # 5-6. Cancellations: voids vs returns.
    cancels = df[live & is_c]
    sales_cand = df[live & ~is_c & (df.Quantity > 0) & (df.Price > 0)]
    voids = match_voids(cancels, sales_cand)
    void_c = df.row_id.isin(voids.cancel_row)
    void_s = df.row_id.isin(voids.sale_row)
    df.loc[live & is_c & void_c, "status"] = "cancel_void"
    df.loc[live & is_c & ~void_c, "status"] = "cancel_return"
    df.loc[void_s, "status"] = "voided_sale"
    qty_pos_on_c = int((live & is_c & (df.Quantity > 0)).sum())
    add_log(f"Cancellation line that exactly reverses a sale by the same customer within {C.VOID_WINDOW_HOURS} h",
            void_c.sum(), df.Quantity[void_c].abs().sum(), "exclude (order voided, never shipped)")
    add_log("Sale line voided by the cancellation above", void_s.sum(), df.Quantity[void_s].sum(),
            "exclude from gross demand")
    ret = df.status == "cancel_return"
    add_log("Other cancellation lines (returns, credits, price adjustments)", ret.sum(),
            df.Quantity[ret].abs().sum(), "exclude from demand; report as returns",
            f"{qty_pos_on_c} cancellation line(s) with quantity > 0")

    live = df.status == "kept"
    # 7. Non-cancellation lines with quantity <= 0 (stock write-offs).
    wo = live & (df.Quantity <= 0)
    df.loc[wo, "status"] = "stock_adjustment"
    stats["stock_adjustment_top_descriptions"] = df[wo].Description.fillna("(missing)").value_counts().head(12).to_dict()
    add_log("Non-cancellation line with quantity <= 0", wo.sum(), df.Quantity[wo].abs().sum(),
            "exclude (stock write-off, e.g. damaged, missing)",
            f"all have price 0; {int(df[wo]['Customer ID'].notna().sum())} have a customer")

    live = df.status == "kept"
    # 8. Price <= 0 with quantity > 0.
    p0 = live & (df.Price <= 0)
    df.loc[p0, "status"] = "zero_price"
    add_log("Quantity > 0 but price <= 0", p0.sum(), df.Quantity[p0].sum(),
            "exclude (stock found, free items, adjustments)",
            f"{int(df[p0]['Customer ID'].notna().sum())} have a customer ID")

    live = df.status == "kept"
    stats["missing_description_rows_after_rules"] = int(df[live].Description.isna().sum())
    miss_c = live & df["Customer ID"].isna()
    add_log("Customer ID missing", miss_c.sum(), df.Quantity[miss_c].sum(),
            "keep (item demand does not need the customer)",
            f"{miss_c.sum() / live.sum():.1%} of kept sale lines")

    # Sale lines to aggregate.
    sales = df[live].copy()
    thr = bulk_thresholds(sales)
    sales["bulk_threshold"] = sales.sku.map(thr)
    sales["bulk"] = sales.Quantity > sales.bulk_threshold
    sales["qty_capped"] = np.where(sales.bulk, np.floor(sales.bulk_threshold), sales.Quantity).astype("int64")
    add_log(f"Bulk one-off line (robust z of log qty > {C.BULK_Z} within SKU, training lines)",
            sales.bulk.sum(), sales.Quantity[sales.bulk].sum(),
            "keep; capped at the SKU threshold in the capped series",
            f"capping removes {(sales.Quantity - sales.qty_capped).sum() / sales.Quantity.sum():.2%} of units")

    sales["week"] = week_start(sales.InvoiceDate)
    sales["revenue"] = sales.Quantity * sales.Price
    edge = (sales.week < C.FIRST_WEEK) | (sales.week > C.LAST_WEEK)
    add_log("Sale lines in the partial first/last calendar weeks", edge.sum(), sales.Quantity[edge].sum(),
            "exclude from the weekly panel", "weeks of 2009-11-30 and 2011-12-05")

    returns = df[df.status == "cancel_return"].copy()
    returns["week"] = week_start(returns.InvoiceDate)

    top = df.loc[df.Quantity.idxmax()]
    rev = df[(df.status == "cancel_void") & (df.sku == top.sku) & (df.Quantity == -top.Quantity)]
    stats["max_quantity_line"] = {
        "invoice": top.Invoice, "sku": top.sku, "description": top.Description, "quantity": int(top.Quantity),
        "date": str(top.InvoiceDate), "status": top.status,
        "cancelled_by": rev.Invoice.tolist(), "cancel_date": [str(x) for x in rev.InvoiceDate],
    }
    stats["voids"] = {"matched": len(voids), "median_gap_hours": float(voids.gap_h.median()),
                      "units": int(voids.q.sum()),
                      "units_two_largest": int(voids.q.nlargest(2).sum())}
    stats["status_rows"] = df.status.value_counts().to_dict()
    # Where each raw anomaly ended up (reconciles the brief's raw counts with the rules).
    conds = {"cancellation rows": is_c, "quantity <= 0": df.Quantity <= 0, "price <= 0": df.Price <= 0,
             "missing Description": df.Description.isna(), "missing Customer ID": df["Customer ID"].isna()}
    stats["reconcile"] = {k: df[v].status.value_counts().to_dict() for k, v in conds.items()}
    stats["missing_description_all_price_0"] = bool((df.loc[df.Description.isna(), "Price"] == 0).all())
    top2 = df.nlargest(2, "Quantity")
    stats["top2_lines"] = [{"invoice": r.Invoice, "sku": r.sku, "quantity": int(r.Quantity), "date": str(r.InvoiceDate),
                            "status": r.status} for r in top2.itertuples()]
    # Largest single return (credit note) and how long after the matching sales it came.
    rets = df[df.status == "cancel_return"]
    big_inv = rets.groupby("Invoice").Quantity.sum().idxmin()
    big = rets[rets.Invoice == big_inv]
    earlier = df[(df.status == "kept") & (df["Customer ID"] == big["Customer ID"].iloc[0])]
    mt = big.assign(q=-big.Quantity).merge(earlier, left_on=["sku", "q"], right_on=["sku", "Quantity"],
                                            suffixes=("_c", "_s"))
    mt = mt[mt.InvoiceDate_s < mt.InvoiceDate_c]
    stats["largest_return"] = {
        "invoice": big_inv, "date": str(big.InvoiceDate.iloc[0]), "units": int(-big.Quantity.sum()),
        "lines": len(big), "lines_matching_earlier_sale": int(mt.row_id_c.nunique()),
        "median_days_after_sale": float((mt.InvoiceDate_c - mt.InvoiceDate_s).dt.total_seconds().median() / 86400)
        if len(mt) else None,
        "sale_weeks": sorted({str(w.date()) for w in week_start(mt.InvoiceDate_s)}),
        "matched_sale_lines_flagged_bulk": int(sales[sales.row_id.isin(mt.row_id_s)].bulk.sum()),
    }
    gaps = voids.set_index("sale_row").gap_h
    stats["top2_void_gap_minutes"] = [round(float(gaps[r]) * 60, 1) if r in gaps.index else None
                                      for r in top2.row_id]
    dc = df[df.sku.str.startswith("DCGS")]
    stats["dcgs_max_weeks_with_rows"] = int(week_start(dc.InvoiceDate).groupby(dc.sku).nunique().max())
    # The brief's pre-cleaning counts: weeks ending Monday (pandas W-MON), raw StockCode,
    # non-cancellation lines with quantity > 0 and price > 0.
    pos = df[~is_c & (df.Quantity > 0) & (df.Price > 0)]
    wmon = pos.InvoiceDate.dt.to_period("W-MON")
    per_code = pd.DataFrame({"c": pos.StockCode, "w": wmon}).drop_duplicates().groupby("c").size()
    stats["pre_cleaning_counts_w_mon"] = {"weeks_with_sales": int(wmon.nunique()),
                                          "codes_ge_80": int((per_code >= 80).sum()),
                                          "codes_ge_52": int((per_code >= 52).sum())}

    sales_out = sales[["Invoice", "sku", "Description", "InvoiceDate", "week", "Quantity", "qty_capped", "Price",
                       "Customer ID", "Country", "dup_line", "bulk", "bulk_threshold", "sheet"]]
    sales_out.to_csv(paths.lines_csv, index=False)

    # Weekly aggregation over the full-week window.
    weeks = pd.date_range(C.FIRST_WEEK, C.LAST_WEEK, freq="W-MON")
    inwin = sales[~edge]
    wk = inwin.groupby(["sku", "week"]).agg(
        units=("Quantity", "sum"), units_capped=("qty_capped", "sum"), revenue=("revenue", "sum"),
        n_lines=("Quantity", "size"), n_bulk=("bulk", "sum"))
    ret_wk = returns[(returns.week >= C.FIRST_WEEK) & (returns.week <= C.LAST_WEEK)].groupby(
        ["sku", "week"]).Quantity.sum().abs().rename("returns_units")

    totals = inwin.groupby("week").agg(units=("Quantity", "sum"), units_capped=("qty_capped", "sum"),
                                       revenue=("revenue", "sum"), n_lines=("Quantity", "size"),
                                       n_skus=("sku", "nunique"))
    totals = totals.reindex(weeks, fill_value=0)
    totals["returns_units"] = returns.groupby("week").Quantity.sum().abs().reindex(weeks, fill_value=0)
    totals.index.name = "week"
    totals.to_csv(paths.derived_dir / "weekly_totals.csv")
    closed = [str(w.date()) for w in weeks if totals.loc[w, "n_lines"] == 0]

    train_weeks = weeks[weeks <= C.TRAIN_END]
    active = wk.reset_index()
    active = active[active.units > 0]
    act_train = active[active.week <= C.TRAIN_END].groupby("sku").size()
    act_all = active.groupby("sku").size()
    stats["weeks"] = {
        "definition": "Monday-start ISO weeks labelled by Monday",
        "panel_first_week": str(C.FIRST_WEEK.date()), "panel_last_week": str(C.LAST_WEEK.date()),
        "n_weeks": len(weeks), "n_train_weeks": len(train_weeks), "n_test_weeks": C.TEST_WEEKS,
        "test_start": str(C.TEST_START.date()), "train_end": str(C.TRAIN_END.date()),
        "closed_weeks": closed,
        "calendar_weeks_in_raw_data": len(pd.date_range(week_start(df.InvoiceDate).min(),
                                                         week_start(df.InvoiceDate).max(), freq="W-MON")),
    }
    stats["sku_counts"] = {
        "product_skus_with_sales": int(sales.sku.nunique()),
        "active_ge_80_of_104": int((act_all >= 80).sum()),
        "active_ge_52_of_104": int((act_all >= 52).sum()),
        "active_ge_70_of_91_train": int((act_train >= C.MIN_ACTIVE_TRAIN_WEEKS).sum()),
        "overlap_train_rule_and_80_of_104": int(len(set(act_train[act_train >= C.MIN_ACTIVE_TRAIN_WEEKS].index)
                                                    & set(act_all[act_all >= 80].index))),
    }

    panel_skus = sorted(act_train[act_train >= C.MIN_ACTIVE_TRAIN_WEEKS].index)
    idx = pd.MultiIndex.from_product([panel_skus, weeks], names=["sku", "week"])
    panel = wk.reindex(idx).join(ret_wk, how="left")
    fill0 = ["units", "units_capped", "revenue", "n_lines", "n_bulk", "returns_units"]
    panel[fill0] = panel[fill0].fillna(0)
    panel["avg_price"] = np.where(panel.units > 0, panel.revenue / panel.units.where(panel.units > 0), np.nan)
    panel = panel.reset_index()
    panel["split"] = np.where(panel.week <= C.TRAIN_END, "train", "test")
    for col in ["units", "units_capped", "n_lines", "n_bulk", "returns_units"]:
        panel[col] = panel[col].astype("int64")
    panel.to_csv(paths.weekly_csv, index=False)

    # Per-SKU attributes from training weeks only.
    tr = panel[panel.split == "train"]
    rows = []
    for sku, g in tr.groupby("sku", sort=True):
        y = g.units.to_numpy()
        first = int(np.argmax(y > 0))
        y = y[first:]
        nz = y[y > 0]
        adi = len(y) / len(nz)
        cv2 = float((nz.std(ddof=0) / nz.mean()) ** 2)
        rows.append({"sku": sku, "train_units": int(g.units.sum()), "train_revenue": float(g.revenue.sum()),
                     "active_train_weeks": int((g.units > 0).sum()), "zero_share": float((y == 0).mean()),
                     "adi": adi, "cv2": cv2, "segment": classify(adi, cv2),
                     "first_sale_week": str(g.week.iloc[first].date()),
                     "bulk_lines_train": int(g.n_bulk.sum()),
                     "returns_units_train": int(g.returns_units.sum())})
    skus = pd.DataFrame(rows).sort_values("train_revenue", ascending=False)
    share = skus.train_revenue.cumsum() / skus.train_revenue.sum()
    skus["abc"] = np.select([share <= C.ABC_CUTS[0], share <= C.ABC_CUTS[1]], ["A", "B"], "C")
    desc = sales[sales.sku.isin(panel_skus)].groupby("sku").Description.agg(
        lambda s: s.dropna().str.strip().mode().iloc[0] if s.notna().any() else "")
    skus["description"] = skus.sku.map(desc)
    skus["bulk_threshold"] = skus.sku.map(thr)
    skus.sort_values("sku").to_csv(paths.sku_csv, index=False)

    stats["panel"] = {"n_skus": len(panel_skus), "n_rows": len(panel),
                      "abc_counts": skus.abc.value_counts().sort_index().to_dict(),
                      "segment_counts": skus.segment.value_counts().to_dict(),
                      "panel_share_of_train_units": float(skus.train_units.sum() / totals.loc[train_weeks, "units"].sum()),
                      "panel_share_of_train_revenue": float(skus.train_revenue.sum() / totals.loc[train_weeks, "revenue"].sum())}

    add_log(f"SKU active in < {C.MIN_ACTIVE_TRAIN_WEEKS} of {len(train_weeks)} training weeks",
            (~inwin.sku.isin(panel_skus)).sum(), inwin.Quantity[~inwin.sku.isin(panel_skus)].sum(),
            "keep in totals, leave out of the forecasting panel",
            f"panel keeps {len(panel_skus)} of {sales.sku.nunique()} product SKUs")

    log_df = pd.DataFrame(log)
    log_df.to_csv(paths.outputs_dir / "cleaning-log.csv", index=False)
    md = ["# Cleaning log", "", "Rules are applied in order; each row is counted under the first rule that "
          "excludes it. Units are absolute quantities.", "",
          "| # | Rule | Rows | Units | Action | Note |", "|---|---|---:|---:|---|---|"]
    for r in log:
        md.append(f"| {r['step']} | {r['rule']} | {r['rows']:,} | {r['units']:,} | {r['action']} | {r['note']} |")
    md += ["", f"Input rows: {len(df):,}. Kept sale lines: {len(sales):,} "
           f"({len(sales) - int(edge.sum()):,} inside the weekly panel window)."]
    (paths.outputs_dir / "cleaning-log.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    stats["kept_sale_lines"] = len(sales)
    stats["kept_sale_lines_in_window"] = int((~edge).sum())
    stats["log"] = log
    (paths.derived_dir / "clean_stats.json").write_text(json.dumps(stats, indent=2, default=str), encoding="utf-8")
    print("\n".join(md))
    print(f"\nPanel: {len(panel_skus)} SKUs x {len(weeks)} weeks; segments {stats['panel']['segment_counts']}; "
          f"ABC {stats['panel']['abc_counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
