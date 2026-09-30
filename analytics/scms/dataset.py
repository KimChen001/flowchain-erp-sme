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


# Time split for the PO-time model, by the year the PO was sent to the vendor.
# The last PO in the file is from August 2015, so the test window is the last
# ~20 months of POs; 2013 is held out for threshold and hyper-parameter choices.
TRAIN_LAST_YEAR = 2012
VALIDATION_YEAR = 2013
TEST_FIRST_YEAR = 2014


def assign_split(year: pd.Series) -> pd.Series:
    split = pd.Series(pd.NA, index=year.index, dtype="object")
    split[year <= TRAIN_LAST_YEAR] = "train"
    split[year == VALIDATION_YEAR] = "validation"
    split[year >= TEST_FIRST_YEAR] = "test"
    return split


def model_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Direct-drop rows usable for the PO-time model, with the time split."""
    usable = frame[frame["usable_model"].fillna(False).astype(bool)].copy()
    usable["po_year"] = usable["po_sent_date"].dt.year
    usable["split"] = assign_split(usable["po_year"])
    usable["is_late"] = usable["is_late"].astype(bool)
    return usable
