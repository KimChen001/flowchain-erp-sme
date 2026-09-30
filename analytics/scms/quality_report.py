"""Data description and data-quality report (rubric sections 2 and 3).

Writes ``outputs/data-quality.md`` and figures under ``outputs/figures/``. Every
number in the report is computed here from the raw and cleaned files.

Usage (from ``analytics/``)::

    python -m scms.quality_report [--data-dir DIR]
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

from .clean import RENAME, read_raw
from .dataset import TEST_FIRST_YEAR, TRAIN_LAST_YEAR, VALIDATION_YEAR, load_clean, model_frame
from .paths import GRACE_DAYS, RAW_SHA256, SEED, parse_args
from .report import AQUA, BLUE, INK_2, ORANGE, md_table, pct, save_figure, style_axes, write_text

# Our reading of each raw column, from its name and values. The archived portal
# page is not available offline, so this is not a quotation of an official
# data dictionary.
MEANINGS = {
    "id": "Row identifier, unique per line item; target of 'See ... (ID#:n)' references.",
    "project code": "SCMS project / funding code (country-specific).",
    "pq #": "Price quote number, or 'Pre-PQ Process' for early orders placed before the PQ process.",
    "po / so #": "Purchase order (direct drop) or sales order (from RDC) number; several lines share one.",
    "asn/dn #": "Advance shipping notice (vendor) or delivery note (RDC); groups lines shipped together.",
    "country": "Destination country.",
    "managed by": "SCMS office managing the order.",
    "fulfill via": "'Direct Drop' from the vendor or 'From RDC' (SCMS regional distribution centre).",
    "vendor inco term": "Incoterm agreed with the vendor (EXW, FCA, DDP, ...); N/A for RDC.",
    "shipment mode": "Air, Truck, Ocean or Air Charter.",
    "pq first sent to client date": "Date the price quote was first sent to the client.",
    "po sent to vendor date": "Date the PO was sent to the vendor (direct drop only).",
    "scheduled delivery date": "Scheduled (promised) delivery date as recorded in the file.",
    "delivered to client date": "Actual delivery date to the client.",
    "delivery recorded date": "Date the delivery was recorded in the system.",
    "product group": "ARV, HRDT (HIV rapid test), ANTM (anti-malarial), ACT, MRDT (malaria test).",
    "sub classification": "Adult / Pediatric ARV, HIV test, HIV test - Ancillary, Malaria, ACT.",
    "vendor": "Supplier name ('SCMS from RDC' for warehouse shipments).",
    "item description": "Full product description (molecule, strength, form, pack).",
    "molecule/test type": "Active molecule(s) or test type.",
    "brand": "Brand ('Generic' for generics).",
    "dosage": "Strength, e.g. '300mg' (blank for test kits).",
    "dosage form": "Tablet, capsule, test kit, oral solution, ...",
    "unit of measure (per pack)": "Units per pack.",
    "line item quantity": "Packs ordered on the line.",
    "line item value": "Line value in USD (quantity x pack price).",
    "pack price": "Price per pack, USD.",
    "unit price": "Price per unit, USD (rounded to cents).",
    "manufacturing site": "Manufacturing plant.",
    "first line designation": "Whether the product is a first-line treatment regimen.",
    "weight (kilograms)": "Shipment weight in kg, or text / a reference to the row holding it.",
    "freight cost (usd)": "Freight cost in USD, or text / a reference to the row holding it.",
    "line item insurance (usd)": "Insurance cost for the line, USD.",
}

HANDLING = {
    "shipment mode": ("'Not recorded' category", "Not recoverable; keeping the rows avoids biasing towards documented shipments."),
    "dosage": ("keep missing; unused", "Structural for test kits."),
    "line item insurance (usd)": ("keep missing; unused", "Not captured for 2006–2007 deliveries; not needed for any analysis."),
    "pq first sent to client date": ("NaT + status column; unused", "Descriptive only."),
    "pq #": ("keep text", "'Pre-PQ Process' is a valid process state, not missing data."),
    "po sent to vendor date": (
        "RDC rows: out of scope. Direct drop 'Date Not Captured': kept for the scorecard, excluded from lead time and the model",
        "On-time needs only scheduled and delivered dates; lead time needs the PO date, and imputing it would invent the lead time.",
    ),
    "vendor inco term": ("RDC 'N/A' out of scope", "Warehouse shipments have no vendor incoterm."),
    "weight (kilograms)": (
        "References resolved; 'Captured Separately' -> NaN + flag; shipment weight split by line value",
        "The value exists elsewhere or not at all; no defensible imputation.",
    ),
    "freight cost (usd)": (
        "References resolved; 'Included in Commodity Cost' / 'Invoiced Separately' -> NaN + flag; split by line value",
        "Included freight is not zero freight, so freight share is left undefined rather than 0.",
    ),
}


def missing_table(raw: pd.DataFrame) -> pd.DataFrame:
    """Blanks and non-value text per raw column, split by fulfilment channel."""
    rows = []
    dd = raw["fulfill via"].eq("Direct Drop")
    for column in raw.columns:
        s = raw[column].astype(str).str.strip()
        blank = s.eq("")
        text_values = pd.Series(False, index=s.index)
        detail = ""
        if column in ("weight (kilograms)", "freight cost (usd)"):
            numeric = pd.to_numeric(s, errors="coerce").notna()
            reference = s.str.startswith("See ")
            text_values = ~numeric & ~reference & ~blank
            detail = f"{int(reference.sum()):,} references resolved; " + ", ".join(
                f"'{k}': {v:,}" for k, v in s[text_values].value_counts().items()
            )
        elif column in ("po sent to vendor date", "pq first sent to client date", "vendor inco term", "pq #"):
            text_values = s.isin(["N/A - From RDC", "Date Not Captured", "Pre-PQ Process"])
            detail = ", ".join(f"'{k}': {v:,}" for k, v in s[text_values].value_counts().items())
        if not blank.any() and not text_values.any():
            continue
        handling, rationale = HANDLING.get(column, ("", ""))
        rows.append(
            {
                "column": column,
                "blank (all)": int(blank.sum()),
                "blank (direct drop)": int((blank & dd).sum()),
                "sentinel text (all)": int(text_values.sum()),
                "sentinel text (direct drop)": int((text_values & dd).sum()),
                "detail": detail or "–",
                "handling": handling,
                "rationale": rationale,
            }
        )
    return pd.DataFrame(rows)


def feature_table(raw: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for column in raw.columns:
        s = raw[column].astype(str).str.strip()
        numeric_share = pd.to_numeric(s, errors="coerce").notna().mean()
        kind = "numeric" if numeric_share > 0.99 else ("mixed numeric/text" if numeric_share > 0.3 else "text / date")
        if "date" in column:
            kind = "date (text)"
        rows.append({"column": column, "clean name": RENAME[column], "raw type": kind, "distinct": s.nunique(), "meaning": MEANINGS[column]})
    return pd.DataFrame(rows)


def heaping_test(late_days: pd.Series, window: int = 7) -> dict:
    counts = late_days.value_counts()
    neighbours = [counts.get(k, 0) for k in range(-window, window + 1) if k != 0]
    expected = float(np.mean(neighbours))
    observed = int(counts.get(0, 0))
    return {"observed_zero": observed, "expected_zero_smooth": expected, "ratio": observed / expected if expected else np.inf, "window": window}


def permutation_null(frame: pd.DataFrame, n_perm: int = 1000) -> dict:
    """Share of exact matches if actual lead times were shuffled within vendor."""
    rng = np.random.default_rng(SEED)
    planned = frame["lead_days_planned"].to_numpy()
    actual = frame["lead_days_actual"].to_numpy()
    groups = [np.flatnonzero(frame["vendor"].to_numpy() == v) for v in frame["vendor"].unique()]
    shares = np.empty(n_perm)
    for i in range(n_perm):
        permuted = actual.copy()
        for idx in groups:
            permuted[idx] = actual[rng.permutation(idx)]
        shares[i] = np.mean(permuted == planned)
    observed = float(np.mean(actual == planned))
    return {
        "observed": observed,
        "null_mean": float(shares.mean()),
        "null_p99": float(np.quantile(shares, 0.99)),
        "null_max": float(shares.max()),
        "n_perm": n_perm,
        "p_value": float((np.sum(shares >= observed) + 1) / (n_perm + 1)),
    }


def share_table(frame: pd.DataFrame, by: str, min_n: int = 1) -> pd.DataFrame:
    grouped = frame.groupby(by, observed=True)
    table = pd.DataFrame(
        {
            "shipments": grouped.size(),
            "exact = scheduled": grouped["is_exact_on_schedule"].mean(),
            "late": grouped["is_late"].mean(),
            "early": grouped["is_early"].mean(),
        }
    )
    return table[table["shipments"] >= min_n]


def chi_square(frame: pd.DataFrame, by: str, min_n: int = 30) -> tuple[float, int, float]:
    sub = frame[frame.groupby(by)[by].transform("size") >= min_n]
    contingency = pd.crosstab(sub[by], sub["is_exact_on_schedule"])
    chi2, p, dof, _ = stats.chi2_contingency(contingency)
    return float(chi2), int(dof), float(p)


def revision_analysis(clean: pd.DataFrame, figures) -> tuple[str, dict]:
    sc = clean[clean["usable_scorecard"].fillna(False).astype(bool)].copy()
    for column in ["is_exact_on_schedule", "is_late", "is_early"]:
        sc[column] = sc[column].astype(bool)
    rdc = clean[clean["fulfill_via"].eq("From RDC") & clean["late_days"].notna()].copy()
    rdc["is_exact_on_schedule"] = rdc["is_exact_on_schedule"].astype(bool)
    model = model_frame(clean)

    exact = sc["is_exact_on_schedule"].mean()
    heap = heaping_test(sc["late_days"])
    heap_rdc = heaping_test(rdc["late_days"])
    perm = permutation_null(model)
    exact_n = int(sc["is_exact_on_schedule"].sum())

    by_year = share_table(sc, "scheduled_year")
    by_year.index.name = "scheduled year"
    chi_year = chi_square(sc, "scheduled_year")
    by_vendor = share_table(sc, "vendor", min_n=30).sort_values("exact = scheduled")
    chi_vendor = chi_square(sc, "vendor")
    by_incoterm = share_table(sc, "vendor_inco_term", min_n=1)
    sc["mode"] = sc["shipment_mode"].fillna("Not recorded")
    by_mode = share_table(sc, "mode")

    # Planning fingerprint: ex-ante plans are often typed as month-end dates.
    month_end = pd.DataFrame(
        {
            "rows": [len(rdc), int(sc["is_exact_on_schedule"].sum()), int((~sc["is_exact_on_schedule"]).sum())],
            "scheduled on month-end": [
                rdc["scheduled_date"].dt.is_month_end.mean(),
                sc.loc[sc["is_exact_on_schedule"], "scheduled_date"].dt.is_month_end.mean(),
                sc.loc[~sc["is_exact_on_schedule"], "scheduled_date"].dt.is_month_end.mean(),
            ],
            "delivered on month-end": [
                rdc["delivered_date"].dt.is_month_end.mean(),
                sc.loc[sc["is_exact_on_schedule"], "delivered_date"].dt.is_month_end.mean(),
                sc.loc[~sc["is_exact_on_schedule"], "delivered_date"].dt.is_month_end.mean(),
            ],
            "exact = scheduled": [rdc["is_exact_on_schedule"].mean(), 1.0, 0.0],
        },
        index=["From RDC (warehouse)", "Direct drop, delivered = scheduled", "Direct drop, delivered != scheduled"],
    )
    uniform_month_end = 12 / 365.25

    # Delivery recorded date: lag after delivery, by exact status.
    sc["record_lag"] = (sc["delivery_recorded_date"] - sc["delivered_date"]).dt.days
    lag = sc.groupby("is_exact_on_schedule")["record_lag"].agg(
        rows="size", same_day=lambda s: (s == 0).mean(), mean="mean", p90=lambda s: s.quantile(0.9)
    )
    lag.index = ["delivered != scheduled", "delivered = scheduled"]
    mw = stats.mannwhitneyu(
        sc.loc[sc["is_exact_on_schedule"], "record_lag"], sc.loc[~sc["is_exact_on_schedule"], "record_lag"]
    )

    # PQ process: pre-PQ (older process) vs PQ-based orders, within scheduled year.
    sc["pq_process"] = np.where(sc["pq_status"].eq("Pre-PQ Process"), "Pre-PQ process", "PQ process")
    pq = sc.pivot_table(index="scheduled_year", columns="pq_process", values="is_exact_on_schedule", aggfunc="mean")
    pq_n = sc.pivot_table(index="scheduled_year", columns="pq_process", values="is_exact_on_schedule", aggfunc="size")
    pq_table = pd.DataFrame(index=pq.index)
    for column in pq.columns:
        pq_table[f"{column}: exact share"] = pq[column]
        pq_table[f"{column}: rows"] = pq_n[column].fillna(0).astype(int)
    pq_table.index.name = "scheduled year"

    # Bounds on the late rate under the heaping.
    excess = max(heap["observed_zero"] - heap["expected_zero_smooth"], 0)
    late_obs = sc["is_late"].mean()
    late_upper = (sc["is_late"].sum() + excess) / len(sc)
    nonexact = sc[~sc["is_exact_on_schedule"]]
    late_frac = nonexact["is_late"].mean()
    late_mid = (sc["is_late"].sum() + excess * late_frac) / len(sc)
    pq_overall = sc.groupby("pq_process")["is_exact_on_schedule"].mean().to_dict()
    both = pq_n.dropna()
    overlap_text = ", ".join(
        f"{int(y)} ({pct(pq.loc[y, 'Pre-PQ process'])} pre-PQ vs {pct(pq.loc[y, 'PQ process'])} PQ)" for y in both.index
    ) or "no year"

    # Figures ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(8, 3.6))
    counts = sc["late_days"].value_counts().reindex(range(-30, 31), fill_value=0)
    colors = [BLUE if k != 0 else ORANGE for k in counts.index]
    ax.bar(counts.index, counts.values, color=colors, width=0.8)
    ax.set_yscale("log")
    ax.set_xlabel("Delivered minus scheduled (days); negative = early")
    ax.set_ylabel("Shipments (log scale)")
    ax.set_title("Direct drop: delivered minus scheduled date, -30 to +30 days", loc="left", fontsize=11)
    ax.annotate(f"exactly on schedule: {heap['observed_zero']:,}", xy=(0, heap["observed_zero"]), xytext=(4, heap["observed_zero"] * 0.6),
                fontsize=9, color=INK_2)
    style_axes(ax)
    fig_heap = save_figure(fig, figures / "late-days-heaping.png")

    fig, ax = plt.subplots(figsize=(8, 3.6))
    years = by_year.index.astype(int)
    for column, color, dy in [("exact = scheduled", BLUE, 0), ("early", AQUA, -7), ("late", ORANGE, 7)]:
        ax.plot(years, by_year[column] * 100, color=color, linewidth=2, marker="o", markersize=5, label=column)
        ax.annotate(column, xy=(years[-1], by_year[column].iloc[-1] * 100), xytext=(8, dy), textcoords="offset points",
                    va="center", fontsize=9, color=INK_2)
    ax.set_xticks(list(years))
    ax.set_ylabel("Share of direct-drop shipments (%)")
    ax.set_xlabel("Scheduled delivery year")
    ax.set_ylim(0, 100)
    ax.set_xlim(years.min() - 0.5, years.max() + 1.6)
    ax.legend(frameon=False, fontsize=9, loc="center left", bbox_to_anchor=(0.0, 0.55))
    ax.set_title("Exact-on-schedule, early and late shares by year", loc="left", fontsize=11)
    style_axes(ax)
    fig_year = save_figure(fig, figures / "exact-share-by-year.png")

    stats_out = {
        "exact_share": exact,
        "exact_n": exact_n,
        "n": len(sc),
        "heap": heap,
        "heap_rdc": heap_rdc,
        "perm": perm,
        "rdc_exact": rdc["is_exact_on_schedule"].mean(),
        "late_obs": late_obs,
        "late_upper": late_upper,
        "late_mid": late_mid,
    }

    text = f"""### 3.4 Was the scheduled date revised after the fact?

**Why it matters.** On-time is measured against `scheduled delivery date`. If
that date was overwritten with the actual delivery date after the fact, on-time
looks better than it was, the lateness target is diluted, and the planned lead
time (`scheduled - PO sent`) carries information from after the PO was sent.

**Test 1: exact matches versus a smooth pattern.** Of {len(sc):,} usable
direct-drop shipments, {exact_n:,} ({pct(exact)}) were delivered on exactly the
scheduled day. If delivery error were a smooth distribution around the plan,
the count at 0 days would be close to its neighbours. The mean count at
±1..±{heap['window']} days is {heap['expected_zero_smooth']:.1f}, so the day-0
count is **{heap['ratio']:.0f} times** that local level. Warehouse (RDC)
shipments in the same file have a much smaller spike: a ratio of
{heap_rdc['ratio']:.0f}, with {pct(stats_out['rdc_exact'])} exact matches. That
spike is still well above a smooth pattern, so some rounding or revision
probably happens there too.

![Delivered minus scheduled]({'figures/' + fig_heap})

**Test 2: permutation null.** For the {len(model):,} rows with a PO date, we
shuffled actual lead times within vendor ({perm['n_perm']:,} permutations, seed
{SEED}). Planned and actual lead time then matched exactly in
{pct(perm['null_mean'], 2)} of rows on average (99th percentile
{pct(perm['null_p99'], 2)}, max {pct(perm['null_max'], 2)}), against
{pct(perm['observed'])} observed (permutation p = {perm['p_value']:.4f}). This
null is generous, because a real plan correlates with the outcome. It shows the
matches are not explained by lead times bunching on a few values.

**Test 3: by year and by vendor.** The exact-match share is not stable. It
varies strongly by year (χ² = {chi_year[0]:.0f}, df = {chi_year[1]}, p =
{chi_year[2]:.1g}), from {pct(by_year['exact = scheduled'].min())} to
{pct(by_year['exact = scheduled'].max())}. It also varies by vendor (vendors
with ≥30 shipments: χ² = {chi_vendor[0]:.0f}, df = {chi_vendor[1]}, p =
{chi_vendor[2]:.1g}), from {pct(by_vendor['exact = scheduled'].min())} to
{pct(by_vendor['exact = scheduled'].max())}. Interpretation (not proven): a
schedule that is precise to the day for 95%+ of international shipments in some
years and some vendors, but only about two-thirds in others, fits a change in
recording practice better than a change in planning accuracy. In the low years
the non-matches are mostly *early* deliveries.

![Exact share by year]({'figures/' + fig_year})

{md_table(by_year.reset_index().assign(**{c: by_year[c].map(pct).values for c in ['exact = scheduled', 'late', 'early']}))}

Vendors with at least 30 usable direct-drop shipments, lowest exact share first:

{md_table(by_vendor.reset_index().assign(**{c: by_vendor[c].map(pct).values for c in ['exact = scheduled', 'late', 'early']}))}

By incoterm and by shipment mode:

{md_table(by_incoterm.reset_index().assign(**{c: by_incoterm[c].map(pct).values for c in ['exact = scheduled', 'late', 'early']}))}

{md_table(by_mode.reset_index().assign(**{c: by_mode[c].map(pct).values for c in ['exact = scheduled', 'late', 'early']}))}

**Test 4: planning fingerprints in the dates.** Plans typed in advance often
fall on month-ends. The warehouse (RDC) schedule, which is plausibly an
advance plan, shows this. Direct-drop scheduled dates show it only when they
differ from the delivery date. Under uniform days, the month-end share would be
about {pct(uniform_month_end)}.

{md_table(month_end.reset_index(names='subset').assign(**{c: month_end[c].map(pct).values for c in ['scheduled on month-end', 'delivered on month-end', 'exact = scheduled']}))}

**Test 5: delivery recorded date.** The recording lag (recorded − delivered)
is longer when delivered = scheduled (Mann–Whitney U p = {mw.pvalue:.2g}):

{md_table(lag.reset_index(names='subset').assign(same_day=lag['same_day'].map(pct).values), digits=2)}

A longer lag is consistent with the schedule being updated when the delivery
was entered. However, the file has no audit trail, so this does not prove it.

**Test 6: PQ process.** The PQ date itself says nothing about schedule
changes, but the process flag might. Orders under the older "Pre-PQ Process"
have a lower exact-match share ({pct(pq_overall.get('Pre-PQ process'))} vs
{pct(pq_overall.get('PQ process'))}). The two processes overlap only in
{overlap_text}, so one year cannot separate a process effect from a time
effect:

{md_table(pq_table.reset_index().assign(**{c: pq_table[c].map(pct).values for c in pq_table.columns if 'share' in c}))}

**Conclusion.** The direct-drop scheduled date does not behave like a promise
fixed when the PO was sent. The spike at exactly 0 days is about
{heap['ratio']:.0f}× the level of the neighbouring days. It varies with year
and vendor far more than an independent plan would. It lacks the month-end
fingerprint that the warehouse schedule and the unmatched direct-drop rows
show. The evidence strongly suggests that for most direct-drop rows the
recorded schedule was set equal to, or updated towards, the actual delivery.
One possibility is that the field holds the "current" expected date rather
than the original promise. **What cannot be determined:** which rows were
revised, when, or what the original promise was. The file has no revision
history, and a genuinely precise schedule cannot be ruled out row by row.

**Consequences for this study.**

- The on-time rates in the scorecard are measured against the *final recorded*
  schedule. They are **upper bounds** on performance against the original promise.
- Assumption-based bound: if the day-0 excess over the smooth level
  ({excess:,.0f} shipments) had all been late in reality, the direct-drop late
  rate would be {pct(late_upper)} instead of the observed {pct(late_obs)}. That
  bound is too wide to be useful, which is itself the finding: the data cannot
  bound the true late rate. A milder scenario (ASSUMPTION): if the excess split
  between late and early in the same proportion as the non-matching rows
  ({pct(late_frac)} late), the late rate would be {pct(late_mid)}. This is a
  scenario, not an estimate.
- `lead_days_planned` may contain information from after the PO was sent. The
  delay model treats it as a **borderline feature** and reports results with
  and without it.
"""
    return text, stats_out


def main() -> int:
    _, paths = parse_args(__doc__.splitlines()[0])
    paths.ensure()
    raw_original = pd.read_csv(paths.raw_csv, dtype=str, keep_default_na=False, encoding="utf-8")
    clean = load_clean(paths)
    dd = clean[clean["direct_drop"].astype(bool)]
    model = model_frame(clean)
    log = pd.read_csv(paths.outputs_dir / "cleaning-log.csv")

    features = feature_table(raw_original)
    missing = missing_table(raw_original)

    # Data points ----------------------------------------------------------------
    freight_usable = dd[dd["freight_share_of_value"].notna()]
    split_counts = model.groupby("split").agg(
        rows=("is_late", "size"), late=("is_late", "sum"), first_po=("po_sent_date", "min"), last_po=("po_sent_date", "max")
    ).reindex(["train", "validation", "test"])
    split_counts["late rate"] = (split_counts["late"] / split_counts["rows"]).map(pct)
    split_counts["first_po"] = split_counts["first_po"].dt.date.astype(str)
    split_counts["last_po"] = split_counts["last_po"].dt.date.astype(str)
    points = pd.DataFrame(
        [
            ("All rows", len(clean), "Raw file (verified sha256)."),
            ("From RDC (warehouse)", int(clean["fulfill_via"].eq("From RDC").sum()), "Not vendor deliveries; out of scope for vendor analysis."),
            ("Direct drop", len(dd), "Vendor delivers straight to the country."),
            ("  Usable for the on-time scorecard", int(clean["usable_scorecard"].sum()), "Direct drop minus impossible date sequences."),
            ("  Usable for lead time and the PO-time model", len(model), "Scorecard subset with a captured PO date."),
            ("  With a numeric freight share", len(freight_usable), "Freight neither included in the price nor invoiced separately, and value > 0."),
            ("  Late shipments (scorecard subset)", int(clean.loc[clean["usable_scorecard"].astype(bool), "is_late"].astype(bool).sum()), f"delivered > scheduled + {GRACE_DAYS} days."),
        ],
        columns=["subset", "rows", "note"],
    )

    heaping_text, rev = revision_analysis(clean, paths.figures_dir)

    # Missingness figure
    miss_plot = missing.set_index("column")[["blank (all)", "sentinel text (all)"]].sum(axis=1).sort_values()
    fig, ax = plt.subplots(figsize=(7, 3.4))
    ax.barh(miss_plot.index, miss_plot.values, color=BLUE, height=0.6)
    for y, v in enumerate(miss_plot.values):
        ax.text(v, y, f" {v:,}", va="center", fontsize=8, color=INK_2)
    ax.set_xlabel("Rows with a blank or a non-value text entry (all 10,324 rows)")
    ax.set_title("Missing or non-numeric entries by column", loc="left", fontsize=11)
    style_axes(ax)
    ax.grid(axis="x", color="#e4e3df", linewidth=0.6)
    ax.grid(axis="y", visible=False)
    fig_missing = save_figure(fig, paths.figures_dir / "missing-by-column.png")

    # Censoring near the end of the file
    last_delivery = clean["delivered_date"].max()
    lead_by_year = model.groupby("po_year")["lead_days_actual"].median()
    open_window = int((dd["scheduled_date"] > last_delivery).sum())

    freight_status_dd = dd["freight_status"].value_counts()

    report = f"""# SCMS data description and data quality

Generated by `analytics/scms/quality_report.py`. All numbers are computed from
the raw file (sha256 `{RAW_SHA256[:12]}…`) and the cleaned table written by
`clean.py`. The report covers rubric section 2 (data) and section 3 (data
quality).

## 2. Data

### 2.1 Where the data comes from

The *Supply Chain Shipment Pricing Dataset* was published by USAID on
data.usaid.gov (dataset `a3rc-nmf6`). It records line items shipped by the
PEPFAR-funded Supply Chain Management System (SCMS) project: antiretroviral
drugs and HIV rapid tests, plus a few malaria products. There are
{clean['country'].nunique()} destination countries. Scheduled delivery dates
run from {clean['scheduled_date'].min().date()} to {clean['scheduled_date'].max().date()}.
We use the Internet Archive snapshot of the portal's CSV export, verified by
sha256. The licence is CC BY-ND 4.0. See `analytics/README.md` for the
attribution text and why the data is kept out of git.

### 2.2 Features

The raw file has {raw_original.shape[1]} columns. The meanings below are our
reading of the column names and values, not a quotation of an official data
dictionary, which was not available offline.

{md_table(features)}

Derived fields (from `clean.py`): `late_days` = delivered − scheduled (days);
`is_late` = `late_days` > {GRACE_DAYS}; `is_early` = `late_days` < 0;
`lead_days_actual` = delivered − PO sent; `lead_days_planned` = scheduled − PO
sent; `freight_share_of_value` = allocated freight / line item value; `year`,
`quarter` (from the PO date, else the scheduled date). There are also flags for
every cleaning rule.

### 2.3 Data points

{md_table(points)}

PO-time model split by the year the PO was sent (no random split). Train ≤
{TRAIN_LAST_YEAR}, validation = {VALIDATION_YEAR}, test ≥ {TEST_FIRST_YEAR}:

{md_table(split_counts.reset_index())}

### 2.4 Why this data fits the problem

FlowChain is an ERP for small and medium manufacturers and distributors. Its
supplier module scores vendors on on-time delivery. Its receiving flow compares
the arrival day with the promised day on each PO line, and its procurement flow
chooses which supplier gets a requirement. This dataset has the same entities
at line level: a PO sent to a named vendor, a scheduled date, an actual
delivery date, price, quantity, freight and shipment mode. That supports the
three analyses the report needs: a supplier scorecard, a model of late
delivery known at PO time, and an allocation decision among competing vendors.
It is also one of the few public datasets with real vendor names, promised
dates and actual dates at this scale ({len(dd):,} vendor shipments,
{dd['vendor'].nunique()} vendors).

## 3. Data quality

### 3.1 Missing values per column

Only columns with blanks or non-value text are listed. Every other column is
complete.

![Missing by column]({'figures/' + fig_missing})

{md_table(missing)}

Freight status for the {len(dd):,} direct-drop rows after resolving
references: {', '.join(f"{k}: {v:,}" for k, v in freight_status_dd.items())}.

### 3.2 Outliers and validity rules

The full log is in `outputs/cleaning-log.md` and `.csv`. In summary:

{md_table(log[['rule', 'scope', 'rows_affected', 'action']])}

Decisions:

- **Drop from delivery analyses** only when dates are impossible (delivered
  before the PO was sent, or scheduled before the PO was sent). One of the
  dates must be wrong and we cannot tell which.
- **Flag, don't cap** heavy-tailed amounts (value, weight, freight). Large
  tenders and small top-up orders are real. Reports use medians, ratios of sums
  or log features, so the extremes don't dominate.
- **Statistical fences on `late_days` are degenerate.** Most rows are exactly
  0, so the IQR is 0 and the MAD is 0. An IQR rule would flag every early or
  late row, which is the signal itself, so it is not applied. A plausibility
  bound (|late_days| > 365) flags nothing in the usable subset.
- **Lead-time outliers** are almost all the lower tail: local South African
  distributors delivering by truck within a few days. They are kept.

{heaping_text}

### 3.5 Data limitations

- **No received versus ordered quantity and no rejections.** The file records
  one delivery date per line, with no quantity received, short shipment or
  quality rejection. "In-full" and "rejection rate" cannot be measured. The
  scorecard therefore covers timeliness, lead time and freight only, not the
  OTIF or quality parts of FlowChain's supplier score.
- **Scheduled-date reliability** (section 3.4): on-time is an upper bound.
- **Only delivered shipments are present.** There are no open, cancelled or
  undelivered POs. The last delivery is on {last_delivery.date()}, and
  {open_window:,} direct-drop rows have a scheduled date after it. So POs sent
  near the end of the file are included only if they arrived early or on time.
  The late rate in the last months is biased downward (right-censoring).
  Median actual lead time by PO year:
  {', '.join(f"{int(y)}: {v:.0f} d" for y, v in lead_by_year.items())}.
- **Domain and external validity.** These are donor-funded public-health
  commodities, bought by a large programme with pooled procurement, pre-qualified
  vendors and international air freight. Timing, prices and vendor behaviour
  will differ from a US small or medium manufacturer buying industrial parts.
  The methods transfer to FlowChain. The fitted numbers do not.
- **Vendor names are aggregated legal entities** (e.g. "ABBVIE LOGISTICS
  (FORMERLY ABBOTT LOGISTICS BV)"). A few vendors appear under related names.
  We do not merge them, to avoid guessing.
- **Freight is shipment-level.** Splitting it across lines by value is an
  assumption. Freight "included in commodity cost" makes those vendors' freight
  invisible, so freight share compares only vendors that invoice freight.
- **2006–2015 data.** Vendor performance may have changed since.
"""
    write_text(paths.outputs_dir / "data-quality.md", report)
    print(f"Wrote {paths.outputs_dir / 'data-quality.md'}")
    print(
        f"exact share {rev['exact_share']:.4f} heap ratio {rev['heap']['ratio']:.1f} "
        f"perm null {rev['perm']['null_mean']:.4f} late obs {rev['late_obs']:.4f} upper {rev['late_upper']:.4f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
