"""Proposal for the decision problem (rubric section 5): supplier allocation.

This script does not solve the optimisation. It measures whether an allocation
decision exists in the data (requirements with two or more comparable vendors),
how many shipments it affects, and which parameters the data can support. It
then writes ``outputs/decision-proposal.md``. Every number is computed here.

Usage (from ``analytics/``)::

    python -m scms.decision_proposal [--data-dir DIR]
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .dataset import TEST_FIRST_YEAR, load_clean
from .paths import parse_args
from .report import md_table, pct, write_text

LOOKBACK_DAYS = 730  # candidate vendors: supplied the same item in the two years before the PO


def substitutability(frame: pd.DataFrame) -> pd.DataFrame:
    rows = []
    total_value = frame["line_item_value"].sum()
    for level, label in [("product_group", "product group"), ("molecule_test_type", "molecule / test type"), ("item_description", "item (exact product and pack)")]:
        vendors = frame.groupby(level)["vendor"].nunique()
        multi = vendors[vendors >= 2].index
        in_multi = frame[level].isin(multi)
        rows.append(
            {
                "level": label,
                "groups": int(vendors.size),
                "groups with ≥2 vendors": int(len(multi)),
                "shipments in those groups": int(in_multi.sum()),
                "share of shipments": pct(in_multi.mean()),
                "share of value": pct(frame.loc[in_multi, "line_item_value"].sum() / total_value),
            }
        )
    return pd.DataFrame(rows)


def candidate_sets(history: pd.DataFrame, targets: pd.DataFrame) -> pd.DataFrame:
    """For each target line, the vendors that shipped the same item in the lookback window."""
    history = history.sort_values("po_sent_date")
    by_item = {item: g for item, g in history.groupby("item_description")}
    records = []
    for idx, row in targets.iterrows():
        h = by_item.get(row["item_description"])
        if h is None:
            records.append((idx, 0, None, None, np.nan, row["vendor"]))
            continue
        window = h[(h["po_sent_date"] < row["po_sent_date"]) & (h["po_sent_date"] >= row["po_sent_date"] - pd.Timedelta(days=LOOKBACK_DAYS))]
        if window.empty:
            records.append((idx, 0, None, None, np.nan, row["vendor"]))
            continue
        counts = window["vendor"].value_counts()
        price = window.groupby("vendor")["pack_price"].median()
        price = price[price > 0]
        spread = price.max() / price.min() if len(price) >= 2 else np.nan
        records.append((idx, int(counts.size), counts.index[0], price.idxmin() if len(price) else None, spread, row["vendor"]))
    out = pd.DataFrame(records, columns=["idx", "candidates", "incumbent", "cheapest", "price_spread", "actual"]).set_index("idx")
    return out


def main() -> int:
    _, paths = parse_args(__doc__.splitlines()[0])
    paths.ensure()
    clean = load_clean(paths)
    dd = clean[clean["usable_scorecard"].fillna(False).astype(bool)].copy()
    with_po = dd[dd["po_sent_date"].notna()].copy()

    sub = substitutability(dd)
    pg = dd.groupby("product_group").agg(vendors=("vendor", "nunique"), shipments=("vendor", "size"), value_usd=("line_item_value", "sum"))
    pg["value_usd"] = pg["value_usd"].map(lambda v: f"{v / 1e6:,.1f} M")
    pg = pg.sort_values("shipments", ascending=False)

    mol = dd.groupby("molecule_test_type").agg(vendors=("vendor", "nunique"), manufacturing_sites=("manufacturing_site", "nunique"),
                                               items=("item_description", "nunique"), shipments=("vendor", "size"),
                                               value=("line_item_value", "sum"))
    mol = mol[mol["vendors"] >= 2].sort_values("shipments", ascending=False)
    mol_top = mol.head(15).copy()
    mol_top["value (USD M)"] = (mol_top.pop("value") / 1e6).round(1)

    test = with_po[with_po["po_sent_date"].dt.year >= TEST_FIRST_YEAR]
    cands = candidate_sets(with_po, test)
    test = test.join(cands[["candidates", "incumbent", "cheapest", "price_spread"]])
    decision = test[test["candidates"] >= 2]
    cand_dist = test["candidates"].clip(upper=5).value_counts().sort_index()
    cand_dist.index = [f"{i}" if i < 5 else "5+" for i in cand_dist.index]
    cand_table = cand_dist.rename("test-period lines").reset_index().rename(columns={"index": "candidate vendors"})

    incumbent_share = (decision["vendor"] == decision["incumbent"]).mean()
    cheapest_share = (decision["vendor"] == decision["cheapest"]).mean()
    spread = decision["price_spread"].dropna()
    freight_numeric = decision["freight_share_of_value"].notna().mean()
    freight_included = decision["freight_included"].astype(bool).mean()
    late_in_decision = int(decision["is_late"].astype(bool).sum())
    per_quarter = with_po.groupby(["vendor", with_po["po_sent_date"].dt.to_period("Q")]).size()
    vendor_quarter_max = per_quarter.groupby("vendor").max()
    decision_vendors = pd.unique(pd.concat([decision["vendor"], decision["incumbent"].dropna(), decision["cheapest"].dropna()]))
    n_decision_vendors = len(decision_vendors)
    decision_pg = decision.groupby("product_group").size().rename("lines").reset_index()
    rdc_share = clean["fulfill_via"].eq("From RDC").mean()

    report = f"""# Decision problem proposal: supplier allocation (rubric section 5)

Generated by `analytics/scms/decision_proposal.py`. This was the proposal.
**The implemented version is `decision-results.md`.** It differs in two
agreed ways: candidates are vendors that supplied the *molecule/test type* in
POs up to 2013 (not the item in a rolling two-year lookback), and the share cap
counts lines per molecule and quarter. All counts here are computed from the
cleaned data. Anything not measured is marked as an assumption.

## 1. Does an allocation decision exist in the data?

A decision exists only where the same need could have gone to two or more
vendors. Substitutability by level, for the {len(dd):,} usable direct-drop
shipments:

{md_table(sub)}

By product group:

{md_table(pg.reset_index())}

Product group is too coarse: an ARV and a test kit are not substitutes. The
defensible unit is the **item** (same molecule, strength, form and pack), or at
least the molecule / test type. Molecules with ≥2 vendors, largest first
({len(mol)} in total):

{md_table(mol_top.reset_index())}

**Decision set for the backtest.** We define a *requirement* as a test-period
direct-drop line (PO sent in {TEST_FIRST_YEAR} or later). Its *candidates* are
the vendors that shipped the same item in the {LOOKBACK_DAYS} days before the
PO date. Only information available at decision time is used.

{md_table(cand_table)}

- **{len(decision):,} of {len(test):,} test-period lines ({pct(len(decision) / len(test))})
  have ≥2 candidates.** They involve {n_decision_vendors} vendors
  and {late_in_decision} late shipments.
- By product group: {', '.join(f"{r.product_group} {r.lines:,}" for r in decision_pg.itertuples())}.
- In those lines, the vendor actually chosen was the historical incumbent
  (most shipments of that item in the lookback) {pct(incumbent_share)} of the
  time. It was the cheapest candidate (lowest trailing median pack price)
  {pct(cheapest_share)} of the time.
- The price spread between the dearest and cheapest candidate's trailing median
  pack price has a median of ×{spread.median():.2f} (P90 ×{spread.quantile(0.9):.2f}) over
  {len(spread):,} lines with ≥2 priced candidates. The spread is large. It
  probably mixes real price differences with distributor mark-ups, different
  incoterms and tender timing, so it must be checked before any saving the
  optimisation reports is trusted.
- Vendors are not always manufacturers. {int((mol['vendors'] > mol['manufacturing_sites']).sum())} of the {len(mol)} multi-vendor
  molecules have more vendors than manufacturing sites. For example, the
  largest ({mol.index[0]}) has {int(mol.iloc[0]['vendors'])} vendors but {int(mol.iloc[0]['manufacturing_sites'])} manufacturing
  site(s). Some "choices" are between resellers of the same product.

## 2. Proposed model: supplier allocation MILP

For a set of requirements R, each with candidate vendors V(r), in one planning
period (backtest: one quarter at a time):

**Decision variables**

- x[r,v] ∈ {{0,1}}: 1 if requirement r is allocated to vendor v ∈ V(r).

**Objective**: minimise

  Σ_r Σ_v x[r,v] · ( q_r · p[r,v] + f[r,v] + λ · π[r,v] · c_r )

**Constraints**

1. Σ_v∈V(r) x[r,v] = 1 for every r (each requirement is sourced once, with no split orders).
2. Share cap: Σ_r∈G q_r·p[r,v]·x[r,v] ≤ s_max · Σ_r∈G q_r·p̄_r for each vendor v and
   product group G, to keep at least two sources active.
3. Capacity proxy: Σ_r x[r,v] ≤ κ_v per quarter, and optionally Σ_r q_r·x[r,v] ≤ K_v.
4. Optional: x[r,v] = 0 when a vendor has no eligible history for the item
   (this is already implied by V(r)).

Solved with `scipy.optimize.milp` (HiGHS). Equality and inequality constraints
become sparse `LinearConstraint` objects, and the variables are binary through
`integrality=1` with bounds [0, 1]. The size is about
{len(decision):,} requirements × ≤{int(test['candidates'].max())} candidates, well within HiGHS's reach.

**Parameters and where each comes from**

| symbol | meaning | source in the data | status |
|---|---|---|---|
| q_r | packs required | `line item quantity` of the test-period line | measured |
| p[r,v] | pack price if v supplies r | v's median `pack price` for the same item in the {LOOKBACK_DAYS}-day lookback | estimated; only the chosen vendor's price is observed |
| f[r,v] | freight cost | historical freight share (Σ freight / Σ value) for v × mode × country, falling back to v × mode, then mode, times q_r·p[r,v]. Only {pct(freight_numeric)} of decision lines have numeric freight; {pct(freight_included)} have freight included in the price | estimated, weak |
| π[r,v] | probability that v delivers r late | strict PO-time logistic regression from `delay-model.md`, scored with vendor = v and every other feature from r | model output; calibration must be fixed first |
| c_r | cost of one late delivery | ASSUMPTION: a fraction of line value (e.g. the value at risk of a stock-out). Not in the data | assumption, set by λ |
| λ | weight on expected lateness | swept in the sensitivity analysis | policy choice |
| s_max | maximum vendor share per product group | ASSUMPTION: 0.6 (dual sourcing); swept 0.4–1.0 | policy choice |
| κ_v | vendor capacity proxy | v's maximum shipments in any past quarter (observed maximum over vendors in the decision set: median {vendor_quarter_max.reindex(decision_vendors).median():.0f}, max {vendor_quarter_max.reindex(decision_vendors).max():.0f} lines), times a slack factor, e.g. 1.2 | proxy; true capacity is unknown |

**Baselines**

1. **Cheapest vendor:** argmin_v of q_r·p[r,v] + f[r,v], ignoring lateness, share and capacity.
2. **Historical incumbent:** the vendor with the most shipments of that item in the lookback.
3. **Actual choice:** what SCMS did (the vendor in the data).

## 3. Backtest design (test period, PO {TEST_FIRST_YEAR}–2015)

1. Freeze all parameters at each quarter's start using only earlier data:
   prices and freight from the lookback, and π from the delay model trained on
   earlier POs (refit per quarter, or once on ≤2013).
2. For each quarter, solve the MILP and the baselines on that quarter's decision lines.
3. Report for each policy: total price + freight (estimated), expected late
   shipments Σ π, share of spend per vendor, number of active vendors, and
   distance from the actual choice (share of lines reallocated).
4. **Realised lateness, where observable:** only the chosen vendor's outcome is
   observed. Realised on-time can be compared only on lines where a policy
   agrees with the actual vendor. Report that subset separately and say that
   counterfactual lateness is model-based.
5. Uncertainty: bootstrap requirements within a quarter, and propagate π's
   uncertainty with the bootstrap models from the delay study.

## 4. Sensitivity on λ

- Sweep λ over a grid (for example 0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, as a
  multiple of line value), with s_max ∈ {{0.4, 0.6, 0.8, 1.0}}.
- Plot the frontier of estimated cost against expected late shipments. λ = 0
  reproduces "cheapest subject to caps". Large λ gives "most reliable subject
  to caps".
- Report the λ at which each vendor enters or leaves the solution, and the
  implied price of reliability: extra cost per expected late shipment avoided.

## 5. Data obstacles (honest list)

- **Lateness target reliability.** The scheduled date was probably revised
  after the fact (data-quality.md §3.4), so π measures lateness against the
  final recorded schedule. Differences between vendors may reflect recording
  practice as much as delivery.
- **Model quality.** In the pre-registered test, no PO-time model reliably
  beats the vendor-rate baseline on ROC AUC, and the probabilities are
  miscalibrated in the large (delay-model.md). π should be the vendor baseline
  or a recalibrated logistic model. The optimisation result will be driven
  mostly by vendor identity.
- **Counterfactual prices.** Only the chosen vendor's price is observed.
  p[r,v] for the other candidates is their recent price for the same item,
  which ignores quantity discounts, tender timing and contract terms.
- **Freight is often missing or embedded in the price** ({pct(freight_included)} of decision
  lines include freight in the price). Comparing a delivered price with an ex-works price plus
  freight needs care; incoterms differ by vendor.
- **No capacity or eligibility data.** Pre-qualification, registration in the
  destination country, and framework contracts decide eligibility in reality,
  and none of them is in the file. The lookback rule is a proxy and may
  overstate the choice.
- **Warehouse channel excluded.** {pct(rdc_share)} of all rows come from regional
  distribution centres. Their original vendor is not recorded, so they are
  outside the decision.
- **External validity.** These are donor-funded health commodities, not a US
  small or medium manufacturer's purchases. The MILP transfers to FlowChain; the
  parameters do not.
"""
    write_text(paths.outputs_dir / "decision-proposal.md", report)
    print(f"Wrote {paths.outputs_dir / 'decision-proposal.md'}")
    print(f"decision lines {len(decision)} of {len(test)}; incumbent {incumbent_share:.3f} cheapest {cheapest_share:.3f} spread median {spread.median():.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
