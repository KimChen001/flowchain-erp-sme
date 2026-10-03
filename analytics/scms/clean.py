"""Clean the raw SCMS file into a typed table plus a cleaning log.

Outputs (local data dir only, never git):

* ``derived/scms_clean.csv``: one row per raw row, typed, with flags and derived fields.
* ``outputs/cleaning-log.csv`` and ``outputs/cleaning-log.md``: rule, scope, rows
  affected, action and rationale for every cleaning or outlier rule.

Usage (from ``analytics/``)::

    python -m scms.clean [--data-dir DIR]
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .fetch import verify
from .parsers import (
    DBY_FORMAT,
    MDY_FORMAT,
    allocate_shared_value,
    iqr_bounds,
    parse_date_column,
    resolve_column,
    robust_z,
)
from .paths import GRACE_DAYS, parse_args
from .report import md_table, write_text

RENAME = {
    "id": "id",
    "project code": "project_code",
    "pq #": "pq_number",
    "po / so #": "po_so_number",
    "asn/dn #": "asn_dn_number",
    "country": "country",
    "managed by": "managed_by",
    "fulfill via": "fulfill_via",
    "vendor inco term": "vendor_inco_term",
    "shipment mode": "shipment_mode",
    "pq first sent to client date": "pq_first_sent_raw",
    "po sent to vendor date": "po_sent_raw",
    "scheduled delivery date": "scheduled_raw",
    "delivered to client date": "delivered_raw",
    "delivery recorded date": "delivery_recorded_raw",
    "product group": "product_group",
    "sub classification": "sub_classification",
    "vendor": "vendor",
    "item description": "item_description",
    "molecule/test type": "molecule_test_type",
    "brand": "brand",
    "dosage": "dosage",
    "dosage form": "dosage_form",
    "unit of measure (per pack)": "unit_of_measure_per_pack",
    "line item quantity": "line_item_quantity",
    "line item value": "line_item_value",
    "pack price": "pack_price",
    "unit price": "unit_price",
    "manufacturing site": "manufacturing_site",
    "first line designation": "first_line_designation",
    "weight (kilograms)": "weight_raw",
    "freight cost (usd)": "freight_raw",
    "line item insurance (usd)": "line_item_insurance_usd",
}

WEIGHT_SENTINELS = {"Weight Captured Separately": "weight_captured_separately"}
FREIGHT_SENTINELS = {
    "Freight Included in Commodity Cost": "freight_included",
    "Invoiced Separately": "freight_invoiced_separately",
}

# Dataset window: the USAID description covers 2006–2015. Anything outside is impossible.
WINDOW_START = pd.Timestamp("2006-01-01")
WINDOW_END = pd.Timestamp("2015-12-31")
ROBUST_Z_LIMIT = 3.5  # Iglewicz and Hoaglin's recommended cut-off


class CleaningLog:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, rule: str, scope: str, mask_or_count, action: str, rationale: str) -> None:
        count = int(mask_or_count.sum()) if hasattr(mask_or_count, "sum") else int(mask_or_count)
        self.rows.append(
            {"rule": rule, "scope": scope, "rows_affected": count, "action": action, "rationale": rationale}
        )

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows)


def read_raw(path) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8")
    missing = set(RENAME) - set(raw.columns)
    if missing:
        raise SystemExit(f"Raw file is missing expected columns: {sorted(missing)}")
    return raw.rename(columns=RENAME)


def to_number(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series.replace("", np.nan), errors="raise")


def clean(raw: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    log = CleaningLog()
    df = raw.copy()
    n = len(df)
    dd = df["fulfill_via"].eq("Direct Drop")

    # --- Types -----------------------------------------------------------------
    df["id"] = df["id"].astype(int)
    for column in ["unit_of_measure_per_pack", "line_item_quantity"]:
        df[column] = to_number(df[column]).astype("Int64")
    for column in ["line_item_value", "pack_price", "unit_price", "line_item_insurance_usd"]:
        df[column] = to_number(df[column])
    df["first_line_designation"] = df["first_line_designation"].map({"true": True, "false": False})
    df["direct_drop"] = dd
    for column in ["shipment_mode", "dosage"]:
        df[column] = df[column].replace("", np.nan)

    log.add(
        "Blank shipment mode", "all rows", df["shipment_mode"].isna(), "keep; category 'Not recorded' in breakdowns and models",
        "Mode is not recoverable from other columns; dropping would bias towards documented shipments.",
    )
    log.add(
        "Blank shipment mode (direct drop)", "direct drop", df["shipment_mode"].isna() & dd, "keep; category 'Not recorded'",
        "Same rule; count shown for the analysis subset.",
    )
    log.add(
        "Blank dosage", "all rows", df["dosage"].isna(), "keep as missing",
        "Structural: test kits have no dosage. Not used in analyses.",
    )
    log.add(
        "Blank line item insurance", "all rows", df["line_item_insurance_usd"].isna(), "keep as missing",
        "Only 2006–2007 scheduled deliveries; insurance is not used in analyses.",
    )

    # --- Dates -----------------------------------------------------------------
    df["pq_first_sent_date"], df["pq_status"] = parse_date_column(
        df["pq_first_sent_raw"], MDY_FORMAT, ["Pre-PQ Process", "Date Not Captured"]
    )
    df["po_sent_date"], df["po_status"] = parse_date_column(
        df["po_sent_raw"], MDY_FORMAT, ["N/A - From RDC", "Date Not Captured"]
    )
    for stem in ["scheduled", "delivered", "delivery_recorded"]:
        df[f"{stem}_date"], df[f"{stem}_status"] = parse_date_column(df[f"{stem}_raw"], DBY_FORMAT)
    unparsed = sum(
        (df[f"{c}_status"] == "unparsed").sum() for c in ["pq", "po", "scheduled", "delivered", "delivery_recorded"]
    )
    if unparsed:
        raise SystemExit(f"{unparsed} date cells did not parse; update the parser before continuing.")
    log.add("PO date 'N/A - From RDC'", "all rows", df["po_status"].eq("N/A - From RDC"), "keep; NaT",
            "Warehouse (RDC) shipments have no vendor PO; they are excluded from vendor analyses.")
    log.add("PO date 'Date Not Captured'", "direct drop", df["po_status"].eq("Date Not Captured") & dd,
            "keep for scorecard; exclude from lead-time and model",
            "On-time needs only scheduled and delivered dates; lead time and the PO-time model need the PO date.")
    log.add("PQ date 'Pre-PQ Process' or 'Date Not Captured'", "all rows", df["pq_first_sent_date"].isna(),
            "keep; NaT", "The price quote date is descriptive only and is not used as a model feature.")

    # --- Weight and freight with reference resolution ---------------------------
    weight = resolve_column(df["id"], df["weight_raw"], WEIGHT_SENTINELS)
    freight = resolve_column(df["id"], df["freight_raw"], FREIGHT_SENTINELS)
    for name, resolved in [("weight", weight), ("freight", freight)]:
        bad = resolved["status"].isin(["cycle", "dangling", "unparsed", "blank"])
        if bad.any():
            raise SystemExit(f"{name}: {int(bad.sum())} values could not be resolved: {resolved.loc[bad, 'status'].value_counts().to_dict()}")
    df["weight_status"] = weight["status"]
    df["weight_source_id"] = weight["source_id"]
    df["weight_kg_shipment"] = weight["value"]
    df["weight_resolved_from_reference"] = weight["hops"] > 0
    df["weight_captured_separately"] = weight["status"].eq("weight_captured_separately")
    df["freight_status"] = freight["status"]
    df["freight_source_id"] = freight["source_id"]
    df["freight_usd_shipment"] = freight["value"]
    df["freight_resolved_from_reference"] = freight["hops"] > 0
    df["freight_included"] = freight["status"].eq("freight_included")
    df["freight_invoiced_separately"] = freight["status"].eq("freight_invoiced_separately")
    df["resolved_from_reference"] = df["weight_resolved_from_reference"] | df["freight_resolved_from_reference"]

    # A referenced value is recorded once per shipment (ASN/DN); every referencing
    # row names the same ASN/DN as its target row. Allocate it by line item value
    # rather than copying, so a shipment's freight is not counted once per line.
    same_doc = (weight["referenced_doc"].isna()) | (weight["referenced_doc"] == df["asn_dn_number"])
    if not same_doc.all():
        raise SystemExit("Some references point to a different ASN/DN than the row's own; review before allocating.")
    df["weight_kg"] = allocate_shared_value(df["weight_kg_shipment"], df["weight_source_id"], df["line_item_value"])
    df["freight_usd"] = allocate_shared_value(df["freight_usd_shipment"], df["freight_source_id"], df["line_item_value"])
    df.loc[df["weight_kg_shipment"].isna(), "weight_kg"] = np.nan
    df.loc[df["freight_usd_shipment"].isna(), "freight_usd"] = np.nan
    group_size = df.groupby("freight_source_id")["id"].transform("size")

    log.add("Weight 'See ... (ID#:n)' reference", "all rows", df["weight_resolved_from_reference"],
            "resolve recursively (cycle-protected); allocate by line value share",
            "The target row holds the whole shipment's weight; copying would double count.")
    log.add("Freight 'See ... (ID#:n)' reference", "all rows", df["freight_resolved_from_reference"],
            "resolve recursively (cycle-protected); allocate by line value share",
            "Same as weight. ASSUMPTION: freight is split in proportion to line item value.")
    log.add("Rows sharing a referenced shipment freight", "all rows", group_size > 1,
            "allocated freight", "Rows in multi-line shipments (referencing rows plus their target rows).")
    # Sentinel counts are AFTER resolving references: a row whose "See ... (ID#:n)" reference leads to a sentinel
    # row takes that status too. The rationale also gives the raw-text count (the text in the row's own cell), which
    # is what data-quality.md section 3.1 counts, so the two reports can be reconciled.
    def sentinel_note(raw_col: str, text: str, flag: pd.Series) -> str:
        in_cell = df[raw_col].astype(str).str.strip().eq(text)
        return (f"Counted after resolving references: {int(in_cell.sum()):,} rows hold the text in their own cell and "
                f"{int((flag & ~in_cell).sum()):,} more reference such a row.")

    log.add("Weight Captured Separately (after resolving references)", "all rows", df["weight_captured_separately"],
            "NaN weight + flag", "Weight is not in the file; no defensible imputation. "
            + sentinel_note("weight_raw", "Weight Captured Separately", df["weight_captured_separately"]))
    log.add("Freight Included in Commodity Cost (after resolving references)", "all rows", df["freight_included"],
            "NaN freight + flag",
            "Freight is embedded in the price; it cannot be separated, so freight share is undefined (not zero). "
            + sentinel_note("freight_raw", "Freight Included in Commodity Cost", df["freight_included"]))
    log.add("Freight Invoiced Separately (after resolving references)", "all rows", df["freight_invoiced_separately"],
            "NaN freight + flag", "Freight exists but is not in the file. "
            + sentinel_note("freight_raw", "Invoiced Separately", df["freight_invoiced_separately"]))
    zero_weight = df["weight_kg_shipment"].eq(0)
    log.add("Weight recorded as 0 kg", "all rows", zero_weight, "set to NaN + flag",
            "Physical goods cannot weigh 0 kg; treated as not captured.")
    df["flag_zero_weight"] = zero_weight
    df.loc[zero_weight, ["weight_kg", "weight_kg_shipment"]] = np.nan

    # --- Date validity rules -----------------------------------------------------
    date_cols = ["pq_first_sent_date", "po_sent_date", "scheduled_date", "delivered_date", "delivery_recorded_date"]
    outside = pd.Series(False, index=df.index)
    for column in date_cols:
        outside |= df[column].notna() & ((df[column] < WINDOW_START) | (df[column] > WINDOW_END))
    df["flag_date_outside_window"] = outside
    log.add("Any date outside 2006-01-01..2015-12-31", "all rows", outside, "flag",
            "Checks two-digit-year parsing; the dataset covers 2006–2015.")

    delivered_before_po = df["delivered_date"] < df["po_sent_date"]
    scheduled_before_po = df["scheduled_date"] < df["po_sent_date"]
    df["flag_delivered_before_po"] = delivered_before_po
    df["flag_scheduled_before_po"] = scheduled_before_po
    log.add("Delivered before PO sent to vendor", "direct drop", delivered_before_po, "exclude from delivery analyses",
            "Impossible sequence; at least one date is wrong and we cannot tell which, so on-time and lead time are unreliable.")
    log.add("Scheduled delivery before PO sent", "direct drop", scheduled_before_po, "exclude from delivery analyses",
            "Impossible plan; same reasoning.")
    recorded_before_delivered = df["delivery_recorded_date"] < df["delivered_date"]
    df["flag_recorded_before_delivered"] = recorded_before_delivered
    log.add("Delivery recorded before delivered", "all rows", recorded_before_delivered, "flag only",
            "The recorded date is used only in the revision test, not in metrics.")
    pq_after_po = df["pq_first_sent_date"] > df["po_sent_date"]
    df["flag_pq_after_po"] = pq_after_po
    log.add("PQ first sent after PO sent", "direct drop", pq_after_po, "flag only",
            "Odd sequence, but the PQ date is not used in metrics or models.")

    # --- Duplicates ----------------------------------------------------------------
    content_cols = [c for c in raw.columns if c != "id"]
    dup = raw.duplicated(subset=content_cols, keep=False)
    df["flag_duplicate_content"] = dup
    log.add("Identical content with different id", "all rows", dup, "flag only, keep",
            "Separate ids suggest separate line items with identical terms; no evidence they are errors.")

    # --- Derived fields -----------------------------------------------------------
    df["late_days"] = (df["delivered_date"] - df["scheduled_date"]).dt.days
    df["is_late"] = (df["late_days"] > GRACE_DAYS).astype("boolean")
    df["is_early"] = (df["late_days"] < 0).astype("boolean")
    df["is_exact_on_schedule"] = (df["late_days"] == 0).astype("boolean")
    df["lead_days_actual"] = (df["delivered_date"] - df["po_sent_date"]).dt.days
    df["lead_days_planned"] = (df["scheduled_date"] - df["po_sent_date"]).dt.days
    value_ok = df["line_item_value"] > 0
    df["freight_share_of_value"] = np.where(value_ok, df["freight_usd"] / df["line_item_value"].where(value_ok), np.nan)
    basis = np.where(df["po_sent_date"].notna(), "po_sent_date", "scheduled_date")
    anchor = df["po_sent_date"].fillna(df["scheduled_date"])
    df["year_basis"] = basis
    df["year"] = anchor.dt.year.astype("Int64")
    df["quarter"] = anchor.dt.quarter.astype("Int64")
    df["year_quarter"] = anchor.dt.to_period("Q").astype(str).where(anchor.notna())
    df["scheduled_year"] = df["scheduled_date"].dt.year.astype("Int64")

    zero_value = ~value_ok
    df["flag_zero_value"] = zero_value
    log.add("Line item value 0", "all rows", zero_value, "keep; freight share NaN",
            "Probably donated or replacement goods; a share of zero value is undefined.")

    # --- Outliers on heavy-tailed amounts: robust z on log scale ---------------------
    def flag_extreme(column: str, label: str, scope_mask: pd.Series, scope: str, action: str, rationale: str) -> None:
        values = df.loc[scope_mask & (df[column] > 0), column]
        z = robust_z(np.log(values))
        mask = pd.Series(False, index=df.index)
        mask.loc[z.index] = z.abs() > ROBUST_Z_LIMIT
        df[f"flag_extreme_{column}"] = mask
        log.add(f"{label}: |robust z of log| > {ROBUST_Z_LIMIT}", scope, mask, action, rationale)

    keep_reason = "Heavy-tailed but plausible (large tenders, small top-ups). Analyses use medians, ratios of sums, or log features, so no capping is needed."
    flag_extreme("line_item_value", "Line item value", pd.Series(True, index=df.index), "all rows", "flag only", keep_reason)
    flag_extreme("weight_kg", "Allocated weight", pd.Series(True, index=df.index), "all rows", "flag only", keep_reason)
    flag_extreme("freight_usd", "Allocated freight", pd.Series(True, index=df.index), "all rows", "flag only", keep_reason)

    share_over_one = df["freight_share_of_value"] > 1
    df["flag_freight_exceeds_value"] = share_over_one
    log.add("Freight share of value > 100%", "all rows", share_over_one, "flag only",
            "Possible for small or low-value lines by air. Scorecards report total freight / total value and the median, which limit their influence.")

    # --- Outliers on delivery timing ------------------------------------------------
    usable_dates = dd & df["scheduled_date"].notna() & df["delivered_date"].notna() & ~delivered_before_po & ~scheduled_before_po
    late = df.loc[usable_dates, "late_days"]
    lo, hi = iqr_bounds(late)
    iqr_mask = usable_dates & ((df["late_days"] < lo) | (df["late_days"] > hi))
    log.add(f"late_days outside IQR fences [{lo:g}, {hi:g}]", "direct drop", iqr_mask, "rule NOT applied",
            "Degenerate: most rows have late_days = 0, so the IQR is 0 and the fence flags every early or late row, which is the signal itself.")
    rz = robust_z(late)
    log.add("late_days robust z", "direct drop", int(rz.notna().sum()), "rule NOT applied",
            "Degenerate: the median absolute deviation is 0, so the robust z is undefined.")
    implausible = usable_dates & (df["late_days"].abs() > 365)
    df["flag_late_days_over_365"] = implausible
    log.add("|late_days| > 365", "direct drop", implausible, "flag only, keep",
            "A plausibility bound instead of a statistical fence. Values up to a year early or late are possible.")
    lead = df.loc[usable_dates & df["lead_days_actual"].notna(), "lead_days_actual"]
    z_lead = robust_z(np.log1p(lead.clip(lower=0)))
    lead_mask = pd.Series(False, index=df.index)
    lead_mask.loc[z_lead.index] = z_lead.abs() > ROBUST_Z_LIMIT
    df["flag_extreme_lead_days_actual"] = lead_mask
    flagged = df.loc[lead_mask]
    low_tail = int((flagged["lead_days_actual"] < lead.median()).sum())
    za_truck = int((flagged["country"].eq("South Africa") & flagged["shipment_mode"].isin(["Truck"])).sum())
    log.add(f"Actual lead time: |robust z of log1p| > {ROBUST_Z_LIMIT}", "direct drop", lead_mask, "flag only",
            f"{low_tail} of {len(flagged)} flags are the lower tail (max {flagged['lead_days_actual'].max():.0f} days); "
            f"{za_truck} are South African deliveries by truck, i.e. local distributors. "
            "Plausible, so kept. Scorecards use medians; the model target is lateness, not lead time.")

    # --- Analysis subsets -----------------------------------------------------------
    df["usable_scorecard"] = usable_dates
    df["usable_model"] = usable_dates & df["po_sent_date"].notna()
    log.add("Usable for scorecard", "direct drop", df["usable_scorecard"], "subset",
            "Direct drop with scheduled and delivered dates and no impossible sequence.")
    log.add("Usable for PO-time model and lead time", "direct drop", df["usable_model"], "subset",
            "Scorecard subset with a captured PO sent date.")

    # Keep raw text columns only where they carry information not in the typed columns.
    df = df.drop(columns=["pq_first_sent_raw", "po_sent_raw", "scheduled_raw", "delivered_raw", "delivery_recorded_raw",
                          "scheduled_status", "delivered_status", "delivery_recorded_status"])
    assert len(df) == n
    return df, log.frame()


def main() -> int:
    _, paths = parse_args(__doc__.splitlines()[0])
    paths.ensure()
    problems = verify(paths.raw_csv)
    if problems:
        raise SystemExit("Raw file failed verification: " + "; ".join(problems))
    raw = read_raw(paths.raw_csv)
    cleaned, log = clean(raw)
    cleaned.to_csv(paths.clean_csv, index=False)
    log.to_csv(paths.outputs_dir / "cleaning-log.csv", index=False)
    header = (
        "# SCMS cleaning log\n\n"
        f"Generated by `analytics/scms/clean.py` from the verified raw file ({len(raw):,} rows). "
        "Each rule lists how many rows it affects and what was done. \"Flag only\" keeps the row and adds a `flag_*` column.\n\n"
    )
    write_text(paths.outputs_dir / "cleaning-log.md", header + md_table(log) + "\n")
    print(f"Wrote {paths.clean_csv} ({len(cleaned):,} rows, {cleaned.shape[1]} columns)")
    print(log[["rule", "rows_affected", "action"]].to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
