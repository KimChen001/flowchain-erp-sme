"""Forecasting models for the weekly SKU panel.

Every model forecasts from an *origin* o (index of the last observed week) for
horizons h = 1..H, using only weeks 0..o. Series are trimmed to start at the SKU's
first sale, and negative forecasts are clipped to 0.

Per-SKU models: naive, 4-week mean, seasonal naive, ETS, ARIMA, SBA, and the
seasonally adjusted variants ETS-SA and ARIMA-SA. SA divides the series by a pooled
weekly seasonal index (from total demand of all product SKUs over the 52 weeks up to
the origin), fits the model, and multiplies the forecast back.
Global model: one HistGradientBoostingRegressor for all SKUs and horizons ("direct"
strategy). Each training row is (SKU, origin o', horizon h) with features known at o'
and a target at o'+h <= o, so no row uses information after the forecast origin.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

SEASON = 52
INDEX_FLOOR = 0.2
ARIMA_P = (0, 1, 2)
ARIMA_Q = (0, 1, 2)
SBA_ALPHA = 0.1
# A fitted candidate whose forecast leaves [0, SANITY_MULT x historical maximum] is
# treated as a failed fit (e.g. a degenerate ARMA optimum); the next-best candidate
# by information criterion is used instead. Fallbacks are counted in the report.
SANITY_MULT = 3.0


# ----------------------------------------------------------------------------- helpers
def first_sale(y: np.ndarray) -> int:
    nz = np.flatnonzero(y > 0)
    return int(nz[0]) if len(nz) else 0


def seasonal_index(total: np.ndarray, o: int, horizon: int) -> np.ndarray:
    """Multiplicative weekly index for weeks 0..o+horizon, periodic with period 52.

    Estimated from the 52 weeks ending at the origin: week / mean of the window,
    lightly smoothed (weights 1/4, 1/2, 1/4, circular) and floored at INDEX_FLOOR.
    Weeks older than a year reuse the same position in the cycle.
    """
    win = np.asarray(total[o - SEASON + 1:o + 1], dtype=float)
    idx = win / win.mean()
    idx = 0.25 * np.roll(idx, 1) + 0.5 * idx + 0.25 * np.roll(idx, -1)
    idx = np.maximum(idx, INDEX_FLOOR)
    t = np.arange(o + horizon + 1)
    return idx[(t - (o - SEASON + 1)) % SEASON]


# ----------------------------------------------------------------------------- simple
def naive(y: np.ndarray, o: int, H: int) -> np.ndarray:
    return np.repeat(float(y[o]), H)


def moving_average(y: np.ndarray, o: int, H: int, k: int = 4) -> np.ndarray:
    return np.repeat(float(np.mean(y[o - k + 1:o + 1])), H)


def seasonal_naive(y: np.ndarray, o: int, H: int) -> np.ndarray:
    t = o + 1 + np.arange(H) - SEASON
    out = np.full(H, np.nan)
    ok = t >= 0
    out[ok] = y[t[ok]]
    return out


def sba(y: np.ndarray, o: int, H: int, alpha: float = SBA_ALPHA) -> np.ndarray:
    """Syntetos-Boylan approximation to Croston's method (flat forecast)."""
    s = y[first_sale(y[:o + 1]):o + 1]
    nz = np.flatnonzero(s > 0)
    if len(nz) == 0:
        return np.zeros(H)
    z, p = float(s[nz[0]]), float(nz[0] + 1)
    last = nz[0]
    for i in nz[1:]:
        z += alpha * (s[i] - z)
        p += alpha * ((i - last) - p)
        last = i
    return np.repeat((1 - alpha / 2) * z / p, H)


# ----------------------------------------------------------------------------- statsmodels
def _sane(fc: np.ndarray, x: np.ndarray) -> bool:
    return bool(np.all(np.isfinite(fc)) and fc.max() <= SANITY_MULT * max(x.max(), 1.0) and fc.min() >= -max(x.max(), 1.0))


def _pick(cands: list, x: np.ndarray):
    """Lowest-criterion candidate with a sane forecast; returns (forecast, label, rejected_count)."""
    cands = sorted(cands, key=lambda c: c[0])
    for k, (_, label, fc) in enumerate(cands):
        if _sane(fc, x):
            return fc, label, k
    return None, None, len(cands)


def fit_ets(x: np.ndarray, H: int):
    """Additive-error ETS: no trend vs additive damped trend, chosen by AICc."""
    from statsmodels.tsa.exponential_smoothing.ets import ETSModel
    cands = []
    for trend in (None, "add"):
        try:
            res = ETSModel(x, error="add", trend=trend, damped_trend=trend is not None).fit(disp=False)
        except Exception:  # noqa: BLE001 - a failed candidate is skipped
            continue
        if np.isfinite(res.aicc):
            cands.append((res.aicc, "damped" if trend else "level", np.asarray(res.forecast(H))))
    fc, label, rejected = _pick(cands, x)
    if fc is None:
        return np.repeat(x[-4:].mean(), H), "fallback"
    return fc, label + ("*" if rejected else "")


def fit_arima(x: np.ndarray, H: int):
    """ARIMA(p,d,q): d from a KPSS test (5%), then p, q in {0,1,2} by AIC.

    d = 0 fits a constant (mean); d = 1 fits no drift, so forecasts do not extrapolate
    a trend indefinitely.
    """
    from statsmodels.tsa.arima.model import ARIMA
    from statsmodels.tsa.stattools import kpss
    try:
        pval = kpss(x, regression="c", nlags="auto")[1]
    except Exception:  # noqa: BLE001
        pval = 1.0
    d = int(pval < 0.05)
    cands = []
    for p in ARIMA_P:
        for q in ARIMA_Q:
            try:
                res = ARIMA(x, order=(p, d, q), trend="c" if d == 0 else "n").fit()
            except Exception:  # noqa: BLE001
                continue
            if np.isfinite(res.aic):
                cands.append((res.aic, (p, d, q), np.asarray(res.forecast(H))))
    fc, order, rejected = _pick(cands, x)
    if fc is None:
        return np.repeat(x[-4:].mean(), H), (-1, d, -1, "fallback")
    return fc, order if not rejected else (*order, "rejected_best")


# ----------------------------------------------------------------------------- worker
_RUN_INDEX: dict = {}


def init_worker(run_index: dict) -> None:
    """Pool initializer: seasonal indices per run, one BLAS/OpenMP thread, quiet warnings."""
    global _RUN_INDEX
    _RUN_INDEX = run_index
    warnings.filterwarnings("ignore")
    # statsmodels re-enables some warnings internally; silence the worker's stderr.
    # Exceptions still reach the parent through the pool.
    import os
    import sys
    sys.stderr = open(os.devnull, "w")
    try:
        from threadpoolctl import threadpool_limits
        threadpool_limits(1)
    except Exception:  # noqa: BLE001
        pass


def stat_task(task: tuple) -> list[dict]:
    """Fit ETS, ETS-SA, ARIMA and ARIMA-SA for one SKU at every origin of its runs."""
    sku, variant, y, runs = task
    warnings.filterwarnings("ignore")
    out = []
    for run_key, o, H in runs:
        f = first_sale(y[:o + 1])
        x = y[f:o + 1].astype(float)
        idx = _RUN_INDEX[(run_key, variant)]
        xs = x / idx[f:o + 1]
        fut = idx[o + 1:o + 1 + H]
        ets, ets_cfg = fit_ets(x, H)
        ets_sa, ets_sa_cfg = fit_ets(xs, H)
        ar, ar_cfg = fit_arima(x, H)
        ar_sa, ar_sa_cfg = fit_arima(xs, H)
        out.append({"run": run_key, "variant": variant, "sku": sku,
                    "ets": np.maximum(ets, 0), "ets_sa": np.maximum(ets_sa * fut, 0),
                    "arima": np.maximum(ar, 0), "arima_sa": np.maximum(ar_sa * fut, 0),
                    "ets_cfg": ets_cfg, "ets_sa_cfg": ets_sa_cfg,
                    "arima_order": ar_cfg, "arima_sa_order": ar_sa_cfg})
    return out


# ----------------------------------------------------------------------------- GBM
GBM_FEATURES = [
    "h", "log_ma4", "log_ma13", "log_ma26", "log_ma52", "lag1_rel", "lag2_rel", "lag3_rel", "lag4_rel",
    "zero13", "cv13", "ly_rel", "ly3_rel", "ly_ramp", "agg_ramp", "woy", "q4", "month",
    "log_price", "price_rel", "age",
]


def _roll_mean(Y: np.ndarray, o: int, k: int) -> np.ndarray:
    if o - k + 1 < 0:
        return np.full(Y.shape[0], np.nan)
    return Y[:, o - k + 1:o + 1].mean(axis=1)


def gbm_features(Y: np.ndarray, price_ff: np.ndarray, price_med: np.ndarray, total: np.ndarray,
                 first: np.ndarray, weeks: pd.DatetimeIndex, o: int, h: int) -> np.ndarray:
    """Feature matrix (n_sku x F) for target week t = o + h using data up to week o only.

    price_ff[:, o] is the last observed average price at or before o; price_med[:, o]
    the median of observed weekly prices up to o. ``weeks`` must extend to t.
    """
    n = Y.shape[0]
    t = o + h
    ma4, ma13, ma26 = _roll_mean(Y, o, 4), _roll_mean(Y, o, 13), _roll_mean(Y, o, 26)
    ma52 = _roll_mean(Y, o, 52)
    den = ma13 + 1.0
    lags = [Y[:, o - k] / den if o - k >= 0 else np.full(n, np.nan) for k in range(4)]
    last13 = Y[:, max(o - 12, 0):o + 1]
    zero13 = (last13 == 0).mean(axis=1)
    cv13 = last13.std(axis=1) / (last13.mean(axis=1) + 1e-9)
    nanv = np.full(n, np.nan)
    ly = Y[:, t - SEASON] / den if t - SEASON >= 0 else nanv
    if t - SEASON - 1 >= 0 and t - SEASON + 1 <= o:
        ly3_raw = Y[:, t - SEASON - 1:t - SEASON + 2].mean(axis=1)
    else:
        ly3_raw = nanv
    ly3 = ly3_raw / den
    if o - SEASON - 3 >= 0:
        base = Y[:, o - SEASON - 3:o - SEASON + 1].mean(axis=1)
        ramp = (ly3_raw + 1.0) / (base + 1.0)
        abase = total[o - SEASON - 3:o - SEASON + 1].mean()
        aramp = np.full(n, total[t - SEASON] / abase if abase > 0 else np.nan)
    else:
        ramp, aramp = nanv, nanv
    wk = weeks[t]
    woy = np.full(n, float(wk.isocalendar().week))
    q4 = np.full(n, float(wk.month >= 10))
    month = np.full(n, float(wk.month))
    lp = np.log(price_ff[:, o])
    prel = price_ff[:, o] / price_med[:, o]
    age = (o - first).astype(float)
    cols = [np.full(n, float(h)), np.log1p(ma4), np.log1p(ma13), np.log1p(ma26), np.log1p(ma52),
            *lags, zero13, cv13, ly, ly3, ramp, aramp, woy, q4, month, lp, prel, age]
    return np.column_stack(cols)


def price_arrays(P: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Forward-filled weekly average price and its expanding median (NaN before first sale)."""
    ff = pd.DataFrame(P).T.ffill().T.to_numpy()
    med = pd.DataFrame(P).T.expanding().median().T.to_numpy()
    return ff, med


def gbm_training_set(Y, price_ff, price_med, total, first, weeks, o: int, H: int, min_age: int = 13,
                     target: np.ndarray | None = None):
    """Stack rows for all origins o' < o and horizons with o' + h <= o (no leakage)."""
    target = Y if target is None else target
    Xs, ys, scales = [], [], []
    for op in range(min_age, o):
        for h in range(1, H + 1):
            if op + h > o:
                break
            X = gbm_features(Y, price_ff, price_med, total, first, weeks, op, h)
            keep = (op - first) >= min_age
            Xs.append(X[keep])
            ys.append(target[keep, op + h])
            scales.append(np.maximum(_roll_mean(Y, op, 13)[keep], 1.0))
    return np.vstack(Xs), np.concatenate(ys), np.concatenate(scales)


def gbm_params(seed: int, loss: str, quantile: float | None = None) -> dict:
    p = dict(loss=loss, learning_rate=0.05, max_iter=400, max_leaf_nodes=31, min_samples_leaf=100,
             l2_regularization=1.0, early_stopping=False, random_state=seed)
    if quantile is not None:
        p["quantile"] = quantile
    return p
