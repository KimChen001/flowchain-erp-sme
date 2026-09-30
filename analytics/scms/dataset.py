"""Load the cleaned SCMS table written by ``clean.py`` with its types restored."""

from __future__ import annotations

import pandas as pd

from .paths import DataPaths

DATE_COLUMNS = [
    "pq_first_sent_date",
    "po_sent_date",
    "scheduled_date",
    "delivered_date",
    "delivery_recorded_date",
]

BOOL_COLUMNS = [
    "direct_drop",
    "first_line_designation",
    "freight_included",
    "freight_invoiced_separately",
    "weight_captured_separately",
    "weight_resolved_from_reference",
    "freight_resolved_from_reference",
    "resolved_from_reference",
    "is_late",
    "is_early",
    "is_exact_on_schedule",
    "usable_scorecard",
    "usable_model",
]

CATEGORY_COLUMNS = [
    "country",
    "vendor",
    "shipment_mode",
    "product_group",
    "sub_classification",
    "vendor_inco_term",
    "fulfill_via",
]


def load_clean(paths: DataPaths) -> pd.DataFrame:
    if not paths.clean_csv.exists():
        raise SystemExit(f"{paths.clean_csv} is missing. Run `python -m scms.clean` first.")
    frame = pd.read_csv(paths.clean_csv, parse_dates=DATE_COLUMNS, low_memory=False)
    for column in BOOL_COLUMNS:
        if column in frame:
            frame[column] = frame[column].map({True: True, False: False, "True": True, "False": False}).astype("boolean")
    flag_columns = [c for c in frame.columns if c.startswith("flag_")]
    for column in flag_columns:
        frame[column] = frame[column].astype(bool)
    return frame


def direct_drop(frame: pd.DataFrame) -> pd.DataFrame:
    return frame[frame["direct_drop"].fillna(False).astype(bool)].copy()
