"""Tests for the tricky SCMS parsers.

Written as plain ``unittest`` so they run with ``python -m unittest`` from the
``analytics/`` folder (pytest also collects them if it is available).
"""

import unittest

import numpy as np
import pandas as pd

from scms.parsers import (
    DBY_FORMAT,
    MDY_FORMAT,
    allocate_shared_value,
    iqr_bounds,
    parse_date_column,
    parse_number,
    parse_reference,
    resolve_column,
    resolve_value,
    robust_z,
)

FREIGHT_SENTINELS = {
    "Freight Included in Commodity Cost": "freight_included",
    "Invoiced Separately": "freight_invoiced_separately",
}


class DateParsingTests(unittest.TestCase):
    def test_mdy_dates_and_sentinels(self):
        raw = pd.Series(["11/13/2006", "N/A - From RDC", "Date Not Captured", "", "13/13/2006", "2/29/2012"])
        dates, status = parse_date_column(raw, MDY_FORMAT, ["N/A - From RDC", "Date Not Captured"])
        self.assertEqual(dates.iloc[0], pd.Timestamp("2006-11-13"))
        self.assertEqual(dates.iloc[5], pd.Timestamp("2012-02-29"))
        self.assertEqual(
            list(status), ["date", "N/A - From RDC", "Date Not Captured", "blank", "unparsed", "date"]
        )
        self.assertTrue(dates.iloc[1:5].isna().all())

    def test_dby_two_digit_years_land_in_2000s(self):
        raw = pd.Series(["2-Jun-06", "31-Dec-15", "29-Feb-08", "1-Jun-2006"])
        dates, status = parse_date_column(raw, DBY_FORMAT)
        self.assertEqual(dates.iloc[0], pd.Timestamp("2006-06-02"))
        self.assertEqual(dates.iloc[1], pd.Timestamp("2015-12-31"))
        self.assertEqual(dates.iloc[2], pd.Timestamp("2008-02-29"))
        # A four-digit year does not match %y and must not be silently accepted.
        self.assertEqual(status.iloc[3], "unparsed")

    def test_mdy_is_not_confused_with_dmy(self):
        dates, _ = parse_date_column(pd.Series(["3/4/2010"]), MDY_FORMAT)
        self.assertEqual(dates.iloc[0], pd.Timestamp("2010-03-04"))


class NumberAndReferenceParsingTests(unittest.TestCase):
    def test_parse_number(self):
        self.assertEqual(parse_number("9736.1"), 9736.1)
        self.assertEqual(parse_number(" 13 "), 13.0)
        self.assertEqual(parse_number("1,234.5"), 1234.5)
        self.assertIsNone(parse_number("Weight Captured Separately"))
        self.assertIsNone(parse_number("See ASN-93 (ID#:1281)"))
        self.assertIsNone(parse_number(None))
        self.assertIsNone(parse_number(float("nan")))

    def test_parse_reference(self):
        self.assertEqual(parse_reference("See ASN-93 (ID#:1281)"), ("ASN-93", 1281))
        self.assertEqual(parse_reference("See DN-304 (ID#:10589)"), ("DN-304", 10589))
        self.assertIsNone(parse_reference("See ASN-93"))
        self.assertIsNone(parse_reference("Invoiced Separately"))


class ReferenceResolutionTests(unittest.TestCase):
    def test_direct_reference(self):
        raw = {1: "See ASN-1 (ID#:2)", 2: "100.5"}
        result = resolve_value(1, raw, FREIGHT_SENTINELS)
        self.assertEqual(result.value, 100.5)
        self.assertEqual(result.status, "number")
        self.assertEqual(result.source_id, 2)
        self.assertEqual(result.hops, 1)
        self.assertEqual(result.referenced_doc, "ASN-1")

    def test_chained_reference_is_followed_recursively(self):
        raw = {1: "See ASN-1 (ID#:2)", 2: "See ASN-1 (ID#:3)", 3: "See ASN-1 (ID#:4)", 4: "7"}
        result = resolve_value(1, raw, FREIGHT_SENTINELS)
        self.assertEqual((result.value, result.source_id, result.hops), (7.0, 4, 3))

    def test_reference_to_sentinel_keeps_the_sentinel_status(self):
        raw = {1: "See ASN-1 (ID#:2)", 2: "Invoiced Separately"}
        result = resolve_value(1, raw, FREIGHT_SENTINELS)
        self.assertIsNone(result.value)
        self.assertEqual(result.status, "freight_invoiced_separately")
        self.assertEqual(result.hops, 1)

    def test_cycles_terminate(self):
        raw = {1: "See ASN-1 (ID#:2)", 2: "See ASN-1 (ID#:1)"}
        self.assertEqual(resolve_value(1, raw, FREIGHT_SENTINELS).status, "cycle")
        self_loop = {5: "See ASN-5 (ID#:5)"}
        self.assertEqual(resolve_value(5, self_loop, FREIGHT_SENTINELS).status, "cycle")

    def test_dangling_reference(self):
        raw = {1: "See ASN-1 (ID#:99)"}
        result = resolve_value(1, raw, FREIGHT_SENTINELS)
        self.assertEqual(result.status, "dangling")
        self.assertEqual(result.source_id, 99)

    def test_unknown_text_is_unparsed_not_zero(self):
        result = resolve_value(1, {1: "about 12 kg"}, FREIGHT_SENTINELS)
        self.assertEqual(result.status, "unparsed")
        self.assertIsNone(result.value)

    def test_resolve_column(self):
        ids = pd.Series([10, 11, 12, 13])
        raw = pd.Series(["50", "See ASN-7 (ID#:10)", "Freight Included in Commodity Cost", "See ASN-8 (ID#:12)"])
        frame = resolve_column(ids, raw, FREIGHT_SENTINELS)
        self.assertEqual(list(frame["status"]), ["number", "number", "freight_included", "freight_included"])
        self.assertEqual(list(frame["source_id"]), [10, 10, 12, 12])
        self.assertEqual(frame["value"].iloc[1], 50.0)
        self.assertTrue(np.isnan(frame["value"].iloc[2]))


class AllocationAndOutlierTests(unittest.TestCase):
    def test_shared_value_is_split_not_duplicated(self):
        shared = pd.Series([90.0, 90.0, 90.0, 10.0])
        group = pd.Series([1, 1, 1, 2])
        weights = pd.Series([100.0, 200.0, 0.0, 5.0])
        allocated = allocate_shared_value(shared, group, weights)
        self.assertAlmostEqual(allocated.iloc[0], 30.0)
        self.assertAlmostEqual(allocated.iloc[1], 60.0)
        self.assertAlmostEqual(allocated.iloc[2], 0.0)
        self.assertAlmostEqual(allocated[group == 1].sum(), 90.0)
        self.assertAlmostEqual(allocated.iloc[3], 10.0)

    def test_zero_weight_group_splits_equally(self):
        allocated = allocate_shared_value(pd.Series([8.0, 8.0]), pd.Series([3, 3]), pd.Series([0.0, 0.0]))
        self.assertEqual(list(allocated), [4.0, 4.0])

    def test_robust_z_and_degenerate_mad(self):
        z = robust_z(pd.Series([1.0, 2.0, 3.0, 4.0, 100.0]))
        self.assertGreater(z.iloc[-1], 3.5)
        self.assertLess(abs(z.iloc[2]), 1e-12)
        self.assertTrue(robust_z(pd.Series([0.0, 0.0, 0.0, 5.0])).isna().all())

    def test_iqr_bounds(self):
        low, high = iqr_bounds(pd.Series([1.0, 2.0, 3.0, 4.0, 5.0]))
        self.assertEqual((low, high), (-1.0, 7.0))


if __name__ == "__main__":
    unittest.main()
