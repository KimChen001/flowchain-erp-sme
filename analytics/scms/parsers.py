"""Parsers for the awkward SCMS columns.

The raw file mixes formats inside single columns:

* ``po sent to vendor date`` and ``pq first sent to client date`` use ``m/d/Y``
  (``11/13/2006``) plus text sentinels such as ``N/A - From RDC``.
* the delivery dates use ``d-b-y`` (``2-Jun-06``).
* ``weight (kilograms)`` and ``freight cost (usd)`` mix numbers, fixed text
  (``Weight Captured Separately``, ``Freight Included in Commodity Cost``,
  ``Invoiced Separately``) and references such as ``See ASN-93 (ID#:1281)``,
  which mean "the value for this shipment is recorded on row 1281".

These functions are pure and are covered by ``scms/tests/test_parsers.py``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable, Mapping

import numpy as np
import pandas as pd

MDY_FORMAT = "%m/%d/%Y"
DBY_FORMAT = "%d-%b-%y"

REFERENCE_PATTERN = re.compile(r"^\s*See\s+(?P<doc>\S+)\s+\(ID#:\s*(?P<id>\d+)\)\s*$")
NUMBER_PATTERN = re.compile(r"^\s*-?\d+(?:\.\d+)?\s*$")


def parse_date_column(values: pd.Series, fmt: str, sentinels: Iterable[str] = ()) -> tuple[pd.Series, pd.Series]:
    """Parse a date column with a fixed format.

    Returns ``(dates, status)``. ``status`` is ``"date"`` for parsed values, the
    sentinel text for known sentinels, ``"blank"`` for empty cells and
    ``"unparsed"`` for anything else (which is never silently coerced).
    """
    text = values.astype("string").str.strip()
    sentinels = tuple(sentinels)
    dates = pd.to_datetime(text.where(~text.isin(sentinels)), format=fmt, errors="coerce")
    status = pd.Series("unparsed", index=values.index, dtype="object")
    status[dates.notna()] = "date"
    for sentinel in sentinels:
        status[text == sentinel] = sentinel
    status[text.isna() | (text == "")] = "blank"
    return dates, status


def parse_number(text: object) -> float | None:
    """Return a float for a plain number, else ``None``."""
    if text is None or (isinstance(text, float) and math.isnan(text)):
        return None
    candidate = str(text).replace(",", "")
    if NUMBER_PATTERN.match(candidate):
        return float(candidate)
    return None


def parse_reference(text: object) -> tuple[str, int] | None:
    """Parse ``See ASN-93 (ID#:1281)`` into ``("ASN-93", 1281)``."""
    if text is None or (isinstance(text, float) and math.isnan(text)):
        return None
    match = REFERENCE_PATTERN.match(str(text))
    if not match:
        return None
    return match.group("doc"), int(match.group("id"))


@dataclass(frozen=True)
class Resolved:
    value: float | None  # numeric value found at the end of the chain
    status: str  # "number", a sentinel label, "blank", "cycle", "dangling" or "unparsed"
    source_id: int  # row id where the chain ended (own id if no reference)
    hops: int  # number of references followed
    referenced_doc: str | None  # ASN/DN named in the first reference, if any


def resolve_value(
    row_id: int,
    raw_by_id: Mapping[int, object],
    sentinels: Mapping[str, str],
    max_hops: int = 50,
) -> Resolved:
    """Follow ``See ... (ID#:n)`` references from ``row_id`` to a terminal value.

    ``sentinels`` maps raw text to a status label, for example
    ``{"Invoiced Separately": "freight_invoiced_separately"}``. Chains are
    followed recursively; revisiting a row is reported as ``"cycle"`` and a
    missing target as ``"dangling"``, so the function always terminates.
    """
    seen = {row_id}
    current = row_id
    hops = 0
    first_doc = None
    while True:
        raw = raw_by_id.get(current)
        if raw is None or (isinstance(raw, float) and math.isnan(raw)) or str(raw).strip() == "":
            return Resolved(None, "blank" if current in raw_by_id else "dangling", current, hops, first_doc)
        number = parse_number(raw)
        if number is not None:
            return Resolved(number, "number", current, hops, first_doc)
        text = str(raw).strip()
        if text in sentinels:
            return Resolved(None, sentinels[text], current, hops, first_doc)
        reference = parse_reference(text)
        if reference is None:
            return Resolved(None, "unparsed", current, hops, first_doc)
        doc, target = reference
        if first_doc is None:
            first_doc = doc
        if target not in raw_by_id:
            return Resolved(None, "dangling", target, hops + 1, first_doc)
        if target in seen or hops + 1 > max_hops:
            return Resolved(None, "cycle", target, hops + 1, first_doc)
        seen.add(target)
        current = target
        hops += 1


def resolve_column(ids: pd.Series, raw: pd.Series, sentinels: Mapping[str, str]) -> pd.DataFrame:
    """Resolve every row of a mixed numeric/text/reference column.

    Returns a frame indexed like ``ids`` with ``value``, ``status``,
    ``source_id``, ``hops`` and ``referenced_doc``.
    """
    raw_by_id = dict(zip(ids.astype(int), raw))
    records = [resolve_value(int(row_id), raw_by_id, sentinels) for row_id in ids]
    frame = pd.DataFrame(
        {
            "value": [r.value if r.value is not None else np.nan for r in records],
            "status": [r.status for r in records],
            "source_id": [r.source_id for r in records],
            "hops": [r.hops for r in records],
            "referenced_doc": [r.referenced_doc for r in records],
        },
        index=ids.index,
    )
    return frame


def allocate_shared_value(
    shared_value: pd.Series, group: pd.Series, weights: pd.Series
) -> pd.Series:
    """Split a value recorded once per group across the group's rows.

    A referenced freight cost or weight belongs to the whole shipment (every row
    of the group resolves to the same source row). Copying it to each line would
    count it several times, so it is split in proportion to ``weights`` (line
    item value). Groups whose weights sum to zero are split equally.
    """
    weights = weights.fillna(0).clip(lower=0)
    total = weights.groupby(group).transform("sum")
    size = weights.groupby(group).transform("size")
    share = np.where(total > 0, weights / total.replace(0, np.nan), 1.0 / size)
    return shared_value * pd.Series(share, index=shared_value.index)


def robust_z(values: pd.Series) -> pd.Series:
    """Robust z-score, 0.6745 * (x - median) / MAD (Iglewicz and Hoaglin).

    Returns NaN everywhere when the MAD is zero (the rule is undefined).
    """
    median = values.median()
    mad = (values - median).abs().median()
    if not mad or np.isnan(mad):
        return pd.Series(np.nan, index=values.index)
    return 0.6745 * (values - median) / mad


def iqr_bounds(values: pd.Series, k: float = 1.5) -> tuple[float, float]:
    q1, q3 = values.quantile([0.25, 0.75])
    iqr = q3 - q1
    return q1 - k * iqr, q3 + k * iqr
