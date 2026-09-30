"""Forecast accuracy metrics with SKU-level bootstrap confidence intervals.

Conventions
- error e = forecast - actual, so a positive bias means over-forecasting.
- WAPE = sum|e| / sum(actual) over all SKU-weeks in the group.
- MASE = mean over SKUs of MAE_sku / scale_sku, where scale_sku is the in-sample MAE
  of the one-step naive forecast on that SKU's training weeks.
- Bias = sum(e) / sum(actual) (mean error over mean actual).
- Weighted pinball loss at level q = sum pinball_q / sum(actual) (scale-free).
Confidence intervals resample SKUs with replacement (percentile bootstrap), so they
reflect which SKUs happen to be in the panel. Weeks within a SKU stay together.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .paths import SEED

N_BOOT = 2000


def naive_scale(y_train: np.ndarray) -> float:
    """In-sample MAE of the one-step naive forecast (from the first sale onwards)."""
    y = np.asarray(y_train, dtype=float)
    nz = np.flatnonzero(y > 0)
    y = y[nz[0]:] if len(nz) else y
    d = np.abs(np.diff(y))
    s = d.mean() if len(d) else np.nan
    return float(s) if s > 0 else np.nan


def per_sku(frame: pd.DataFrame, pred: str, actual: str = "y") -> pd.DataFrame:
    e = frame[pred] - frame[actual]
    g = pd.DataFrame({"sku": frame.sku, "abs_e": e.abs(), "e": e, "y": frame[actual], "scale": frame.scale})
    out = g.groupby("sku").agg(abs_e=("abs_e", "sum"), e=("e", "sum"), y=("y", "sum"),
                               n=("y", "size"), scale=("scale", "first"))
    out["mase"] = out.abs_e / out.n / out.scale
    return out


def point_metrics(s: pd.DataFrame) -> dict:
    return {"WAPE": s.abs_e.sum() / s.y.sum(), "MASE": s.mase.mean(), "Bias": s.e.sum() / s.y.sum()}


def boot_weights(n: int, n_boot: int = N_BOOT, seed: int = SEED) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.multinomial(n, np.full(n, 1.0 / n), size=n_boot).astype(float)


def boot_metrics(s: pd.DataFrame, w: np.ndarray) -> dict[str, np.ndarray]:
    """Bootstrap replicates of WAPE, MASE and bias; w is (n_boot, n_sku) resample counts."""
    return {
        "WAPE": w @ s.abs_e.to_numpy() / (w @ s.y.to_numpy()),
        "MASE": w @ s.mase.to_numpy() / w.sum(axis=1),
        "Bias": w @ s.e.to_numpy() / (w @ s.y.to_numpy()),
    }


def summarise(frame: pd.DataFrame, preds: list[str], actual: str = "y", group: str | None = None,
              ref: str | None = None) -> pd.DataFrame:
    """Metrics with 95% bootstrap CIs per prediction column (and optional group column).

    If ``ref`` is given, also report the WAPE difference to ``ref`` with a paired CI
    (same bootstrap resamples for both models).
    """
    rows = []
    groups = [("all", frame)] if group is None else list(frame.groupby(group, sort=True))
    for gname, gframe in groups:
        skus = np.sort(gframe.sku.unique())
        w = boot_weights(len(skus))
        ref_boot = None
        if ref is not None:
            ref_boot = boot_metrics(per_sku(gframe, ref, actual).reindex(skus), w)["WAPE"]
        for p in preds:
            s = per_sku(gframe, p, actual).reindex(skus)
            pm, bm = point_metrics(s), boot_metrics(s, w)
            row = {"group": gname, "model": p, "n_skus": len(skus)}
            for k in ("WAPE", "MASE", "Bias"):
                lo, hi = np.percentile(bm[k], [2.5, 97.5])
                row.update({k: pm[k], f"{k}_lo": lo, f"{k}_hi": hi})
            if ref_boot is not None:
                d = bm["WAPE"] - ref_boot
                row.update({"dWAPE_vs_ref": pm["WAPE"] - point_metrics(per_sku(gframe, ref, actual).reindex(skus))["WAPE"],
                            "dWAPE_lo": np.percentile(d, 2.5), "dWAPE_hi": np.percentile(d, 97.5)})
            rows.append(row)
    return pd.DataFrame(rows)


def pinball(y: np.ndarray, q_pred: np.ndarray, q: float) -> np.ndarray:
    d = np.asarray(y, float) - np.asarray(q_pred, float)
    return np.maximum(q * d, (q - 1) * d)


def quantile_summary(frame: pd.DataFrame, cols: dict[str, tuple[str, str]], actual: str = "y") -> pd.DataFrame:
    """cols maps method name -> (P50 column, P90 column). Coverage CIs by SKU bootstrap."""
    skus = np.sort(frame.sku.unique())
    w = boot_weights(len(skus))
    rows = []
    for name, (c50, c90) in cols.items():
        g = pd.DataFrame({"sku": frame.sku, "y": frame[actual],
                          "pb50": pinball(frame[actual], frame[c50], 0.5),
                          "pb90": pinball(frame[actual], frame[c90], 0.9),
                          "cov90": (frame[actual] <= frame[c90]).astype(float),
                          "cov50": (frame[actual] <= frame[c50]).astype(float)})
        s = g.groupby("sku").agg(y=("y", "sum"), pb50=("pb50", "sum"), pb90=("pb90", "sum"),
                                 cov90=("cov90", "sum"), cov50=("cov50", "sum"), n=("y", "size")).reindex(skus)
        cov_b = w @ s.cov90.to_numpy() / (w @ s.n.to_numpy())
        pb_b = w @ s.pb90.to_numpy() / (w @ s.y.to_numpy())
        rows.append({"method": name,
                     "pinball50_w": s.pb50.sum() / s.y.sum(), "pinball90_w": s.pb90.sum() / s.y.sum(),
                     "pinball90_lo": np.percentile(pb_b, 2.5), "pinball90_hi": np.percentile(pb_b, 97.5),
                     "coverage50": s.cov50.sum() / s.n.sum(),
                     "coverage90": s.cov90.sum() / s.n.sum(),
                     "coverage90_lo": np.percentile(cov_b, 2.5), "coverage90_hi": np.percentile(cov_b, 97.5)})
    return pd.DataFrame(rows)


def fmt_ci(v: float, lo: float, hi: float, pct: bool = True) -> str:
    if pct:
        return f"{v:.1%} [{lo:.1%}, {hi:.1%}]"
    return f"{v:.3f} [{lo:.3f}, {hi:.3f}]"
