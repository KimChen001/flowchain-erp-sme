"""Study design constants. Every rule the reports mention is parameterised here."""

from __future__ import annotations

import math

import pandas as pd

# Sheet overlap: sheet 1 ("Year 2009-2010") runs to 2010-12-09 and sheet 2 starts on
# 2010-12-01. Rows of sheet 1 dated in this window are a second copy of sheet 2 rows.
OVERLAP_START = pd.Timestamp("2010-12-01")
OVERLAP_END = pd.Timestamp("2010-12-10")  # exclusive

# A product StockCode is five digits plus an optional letter suffix (after upper-casing).
PRODUCT_CODE_REGEX = r"\d{5}[A-Z]{0,3}"

# A cancellation line "voids" a sale line when it has the same customer, SKU and
# quantity, and comes no more than this many hours after the sale.
VOID_WINDOW_HOURS = 24

# Bulk one-off line: modified z-score of log(quantity) above BULK_Z within the SKU,
# using the median and MAD of the SKU's training-period lines. The robust scale is
# floored at log(2) because many SKUs sell mostly one pack size (MAD = 0).
BULK_Z = 3.5
BULK_LOG_SCALE_FLOOR = math.log(2)
BULK_MIN_TRAIN_LINES = 10

# Weeks start on Monday (ISO weeks) and are labelled by their Monday.
# The first (starts Tue 2009-12-01) and last (ends Fri 2011-12-09 midday) calendar
# weeks are partial and are left out of the weekly panel.
FIRST_WEEK = pd.Timestamp("2009-12-07")
LAST_WEEK = pd.Timestamp("2011-11-28")
TEST_WEEKS = 13
TEST_START = LAST_WEEK - pd.Timedelta(weeks=TEST_WEEKS - 1)  # 2011-09-05
TRAIN_END = TEST_START - pd.Timedelta(weeks=1)                # 2011-08-29

# Panel: SKUs sold in at least this many of the 91 training weeks (77%, the same
# rate as 80 of 104 weeks). Selection uses training weeks only, so it cannot peek
# at the test period.
MIN_ACTIVE_TRAIN_WEEKS = 70

# ABC by training-period revenue within the panel (cumulative revenue share cut-offs).
ABC_CUTS = (0.80, 0.95)

# Syntetos-Boylan-Croston demand classes.
ADI_CUT = 1.32
CV2_CUT = 0.49

SEASON_LENGTH = 52
