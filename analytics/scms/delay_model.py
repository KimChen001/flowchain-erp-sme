"""Predict late delivery at the time the PO is sent (rubric section 4).

Target: ``is_late`` (delivered > scheduled + 0 days) for direct-drop shipments.
Split by the year the PO was sent: train <= 2012, validation 2013, test >= 2014,
plus a rolling-origin check. Models, in order: (0) vendor historical late
rate, (1) logistic regression, (2) depth-limited CART, (3) histogram gradient
boosting.

Writes ``outputs/delay-model.md``, ``outputs/delay-model-metrics.csv`` and
figures. Every number in the report is computed here.

The primary specification uses the strict PO-time features. The originally
specified set (with planned lead time and weight) is a sensitivity result.
Section 6 selects the calibrated late-risk predictor used by
``decision_results.py``.

Usage (from ``analytics/``)::

    python -m scms.delay_model [--data-dir DIR] [--bootstrap N]
"""

from __future__ import annotations

import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.base import clone as sk_clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    precision_recall_curve,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler
from sklearn.tree import DecisionTreeClassifier, export_text

from .dataset import TEST_FIRST_YEAR, TRAIN_LAST_YEAR, VALIDATION_YEAR, load_clean, model_frame
from .paths import GRACE_DAYS, SEED, parse_args
from .report import AQUA, BLUE, INK_2, ORANGE, md_table, pct, save_figure, style_axes, write_json, write_text

YELLOW = "#eda100"
CATEGORICAL = ["vendor", "shipment_mode", "country", "product_group"]
MIN_VENDOR_HISTORY = 30  # same threshold as the scorecard's "insufficient sample"
MIN_CATEGORY_FREQUENCY = 10

FEATURE_SETS = {
    # The feature list as specified: planned lead time and weight included.
    "as specified": {"numeric": ["log_value", "log_weight", "weight_missing", "lead_days_planned", "po_year"]},
    # Strict PO-time: drops the two borderline features (see leakage audit).
    "strict PO-time": {"numeric": ["log_value", "po_year"]},
}

# ---------------------------------------------------------------------------
# Leakage audit: every raw column plus the derived fields.
# (column, known when the PO is sent?, decision, justification)
LEAKAGE_AUDIT = [
    ("id", "yes (row number)", "exclude", "Identifier with no causal meaning. Ids may follow entry order, so they could encode time or outcome."),
    ("project code", "yes", "not used", "Known at PO time. Nearly one code per country and funding stream, so redundant with country."),
    ("pq #", "yes", "not used", "Price quote precedes the PO. High-cardinality identifier."),
    ("po / so #", "yes", "not used", "Identifier. Lines of one PO share outcomes, so it would memorise POs rather than generalise."),
    ("asn/dn #", "**no**", "exclude", "Assigned when the goods are shipped (advance shipping notice). It also defines the shipment grouping."),
    ("country", "yes", "use", "Destination is fixed on the PO."),
    ("managed by", "yes", "not used", "Almost constant (PMO - US)."),
    ("fulfill via", "yes", "scope", "Constant (Direct Drop) within the modelling scope."),
    ("vendor inco term", "yes", "not used", "Known at PO time. A candidate feature, but outside the specified set."),
    ("shipment mode", "mostly", "use (borderline)", "Normally planned on the PO. It can change when the goods are booked, which we cannot see."),
    ("pq first sent to client date", "yes", "not used", "Precedes the PO. Descriptive only."),
    ("po sent to vendor date", "yes", "use (as year)", "The prediction time itself. Used as po_year and for the split."),
    ("scheduled delivery date", "nominally yes", "**borderline**", "Should be the promise made at PO time, used as lead_days_planned = scheduled − PO. data-quality.md §3.4 shows it was probably revised towards the actual date, so it may carry post-PO information. Models are run with and without it."),
    ("delivered to client date", "**no**", "exclude", "The outcome."),
    ("delivery recorded date", "**no**", "exclude", "Recorded at or after delivery."),
    ("product group", "yes", "use", "Product is fixed on the PO."),
    ("sub classification / item description / molecule / brand / dosage / dosage form / unit of measure / manufacturing site", "yes", "not used", "Known at PO time. Left out to keep the feature set small and interpretable."),
    ("first line designation", "**no**", "exclude", "Per the data dictionary it marks the line that carries the ASN/DN's aggregated freight and weight, so it is a shipping-document artefact."),
    ("line item quantity, pack price, unit price", "yes", "not used", "Known at PO time. Line value summarises them."),
    ("line item value", "yes", "use (log)", "Quantity × agreed pack price is fixed on the PO."),
    ("weight (kilograms)", "partly", "**borderline**", "Recorded from shipping documents after dispatch. A buyer can estimate it from quantity at PO time. 'Captured separately' and 'See ASN' references depend on how lines were consolidated for shipping, which is post-PO. Models are run with and without it; only the value and a missing flag are used, never the reference flags."),
    ("freight cost (usd)", "**no**", "exclude", "Invoiced after shipping. The amount depends on the actual mode and consolidation."),
    ("line item insurance (usd)", "no / derived", "exclude", "Charged with the shipment; about 0.15% of value, so no extra information."),
    ("late_days, is_early, is_exact_on_schedule", "**no**", "exclude", "Functions of the delivered date (the target)."),
    ("lead_days_actual", "**no**", "exclude", "Delivered − PO. It fully determines the target together with lead_days_planned. Used below only to demonstrate leakage."),
    ("lead_days_planned", "nominally yes", "**borderline**", "See scheduled delivery date."),
    ("freight_share_of_value, freight/weight flags, resolved_from_reference", "**no**", "exclude", "Derived from post-shipment freight and shipping documents."),
]


def build_features(frame: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=frame.index)
    for column in CATEGORICAL:
        out[column] = frame[column].fillna("Not recorded").astype(str)
    out["log_value"] = np.log1p(frame["line_item_value"].clip(lower=0))
    out["log_weight_raw"] = np.log1p(frame["weight_kg"])
    out["weight_missing"] = frame["weight_kg"].isna().astype(float)
    out["lead_days_planned"] = frame["lead_days_planned"].astype(float)
    out["lead_days_actual"] = frame["lead_days_actual"].astype(float)
    out["lead_slip_days"] = (frame["lead_days_actual"] - frame["lead_days_planned"]).astype(float)
    out["po_year"] = frame["po_year"].astype(float)
    # Leaky extras for the demonstration only.
    out["freight_status_number"] = frame["freight_status"].eq("number").astype(float)
    out["resolved_from_reference"] = frame["resolved_from_reference"].astype(bool).astype(float)
    out["log_freight"] = np.log1p(frame["freight_usd"]).fillna(0.0)
    return out


def fill_weight(features: pd.DataFrame, train_index) -> pd.DataFrame:
    features = features.copy()
    median = features.loc[train_index, "log_weight_raw"].median()
    features["log_weight"] = features["log_weight_raw"].fillna(median)
    return features


# ---------------------------------------------------------------------------
# Models


class VendorRateBaseline:
    """Vendor's historical late rate in the training data; global rate fallback."""

    name = "(0) vendor late-rate baseline"

    def fit(self, X: pd.DataFrame, y: pd.Series):
        stats = pd.DataFrame({"vendor": X["vendor"], "y": y}).groupby("vendor")["y"].agg(["mean", "size"])
        self.global_rate_ = float(y.mean())
        self.rates_ = stats.loc[stats["size"] >= MIN_VENDOR_HISTORY, "mean"].to_dict()
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        p = X["vendor"].map(self.rates_).fillna(self.global_rate_).to_numpy(dtype=float)
        return np.column_stack([1 - p, p])


def logistic_pipeline(numeric: list[str], C: float, class_weight=None) -> Pipeline:
    pre = ColumnTransformer(
        [
            ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=MIN_CATEGORY_FREQUENCY, sparse_output=False), CATEGORICAL),
            ("num", StandardScaler(), numeric),
        ]
    )
    model = LogisticRegression(C=C, l1_ratio=0.0, max_iter=5000, class_weight=class_weight, random_state=SEED)
    return Pipeline([("pre", pre), ("model", model)])


def tree_pipeline(numeric: list[str], depth: int) -> Pipeline:
    pre = ColumnTransformer(
        [
            ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=MIN_CATEGORY_FREQUENCY, sparse_output=False), CATEGORICAL),
            ("num", "passthrough", numeric),
        ],
        verbose_feature_names_out=False,
    )
    model = DecisionTreeClassifier(max_depth=depth, min_samples_leaf=20, random_state=SEED)
    return Pipeline([("pre", pre), ("model", model)])


def hgb_pipeline(numeric: list[str], learning_rate: float, max_iter: int, max_depth: int) -> Pipeline:
    pre = ColumnTransformer(
        [
            ("cat", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1, encoded_missing_value=-1,
                                   min_frequency=MIN_CATEGORY_FREQUENCY), CATEGORICAL),
            ("num", "passthrough", numeric),
        ],
        verbose_feature_names_out=False,
    )
    model = HistGradientBoostingClassifier(
        learning_rate=learning_rate,
        max_iter=max_iter,
        max_depth=max_depth,
        min_samples_leaf=20,
        l2_regularization=1.0,
        categorical_features=list(range(len(CATEGORICAL))),
        early_stopping=False,
        random_state=SEED,
    )
    return Pipeline([("pre", pre), ("model", model)])


def proba(model, X) -> np.ndarray:
    return model.predict_proba(X)[:, 1]


def select(candidates: dict, X_train, y_train, X_val, y_val) -> tuple[str, object, pd.DataFrame]:
    """Fit each candidate on train and pick the lowest validation log loss."""
    rows = []
    fitted = {}
    for label, model in candidates.items():
        model.fit(X_train, y_train)
        p = np.clip(proba(model, X_val), 1e-6, 1 - 1e-6)
        rows.append({"candidate": label, "val log loss": log_loss(y_val, p), "val ROC AUC": roc_auc_score(y_val, p),
                     "val PR AUC": average_precision_score(y_val, p)})
        fitted[label] = model
    table = pd.DataFrame(rows)
    best = table.sort_values("val log loss").iloc[0]["candidate"]
    return best, fitted[best], table


def f1_threshold(y: np.ndarray, p: np.ndarray) -> float:
    precision, recall, thresholds = precision_recall_curve(y, p)
    f1 = np.where(precision + recall > 0, 2 * precision * recall / np.maximum(precision + recall, 1e-12), 0)
    best = int(np.argmax(f1[:-1])) if len(thresholds) else 0
    return float(thresholds[best]) if len(thresholds) else 0.5


# ---------------------------------------------------------------------------
# Evaluation


def bootstrap_metrics(y: np.ndarray, preds: dict[str, np.ndarray], baseline: str, n_boot: int) -> pd.DataFrame:
    """Row bootstrap of ROC AUC and PR AUC with paired differences vs the baseline."""
    rng = np.random.default_rng(SEED)
    n = len(y)
    draws = {name: {"roc": [], "pr": [], "droc": [], "dpr": [], "droc_lr": [], "dpr_lr": []} for name in preds}
    for _ in range(n_boot):
        idx = rng.integers(0, n, n)
        yb = y[idx]
        if yb.sum() == 0 or yb.sum() == n:
            continue
        base_roc = roc_auc_score(yb, preds[baseline][idx])
        base_pr = average_precision_score(yb, preds[baseline][idx])
        lr_roc = roc_auc_score(yb, preds["logistic"][idx])
        lr_pr = average_precision_score(yb, preds["logistic"][idx])
        for name, p in preds.items():
            roc = roc_auc_score(yb, p[idx])
            pr = average_precision_score(yb, p[idx])
            draws[name]["roc"].append(roc)
            draws[name]["pr"].append(pr)
            draws[name]["droc"].append(roc - base_roc)
            draws[name]["dpr"].append(pr - base_pr)
            draws[name]["droc_lr"].append(roc - lr_roc)
            draws[name]["dpr_lr"].append(pr - lr_pr)
    rows = []
    for name, d in draws.items():
        q = lambda values: np.quantile(values, [0.025, 0.975])
        rows.append(
            {
                "model": name,
                "roc_ci": q(d["roc"]),
                "pr_ci": q(d["pr"]),
                "droc_ci": q(d["droc"]),
                "dpr_ci": q(d["dpr"]),
                "droc_lr_ci": q(d["droc_lr"]),
                "dpr_lr_ci": q(d["dpr_lr"]),
                "n_boot": len(d["roc"]),
            }
        )
    return pd.DataFrame(rows).set_index("model")


def calibration_table(y: np.ndarray, p: np.ndarray, bins: int = 10) -> pd.DataFrame:
    ranks = pd.Series(p).rank(method="first")
    decile = pd.qcut(ranks, bins, labels=False) + 1
    frame = pd.DataFrame({"decile": decile, "p": p, "y": y})
    table = frame.groupby("decile").agg(rows=("y", "size"), mean_predicted=("p", "mean"), observed_rate=("y", "mean"), late=("y", "sum"))
    table = table.reset_index()
    for column in ("decile", "rows", "late"):
        table[column] = table[column].astype(int).astype(str)
    return table


def evaluate(y: np.ndarray, p: np.ndarray, threshold: float, prevalence_train: float) -> dict:
    flagged = p >= threshold
    tp = int((flagged & (y == 1)).sum())
    brier = brier_score_loss(y, p)
    brier_ref = brier_score_loss(y, np.full_like(p, prevalence_train))
    return {
        "ROC AUC": roc_auc_score(y, p),
        "PR AUC": average_precision_score(y, p),
        "Brier": brier,
        "Brier skill vs train rate": 1 - brier / brier_ref,
        "threshold (from validation)": threshold,
        "flagged": int(flagged.sum()),
        "precision": tp / flagged.sum() if flagged.sum() else np.nan,
        "recall": tp / (y == 1).sum() if (y == 1).sum() else np.nan,
    }


# ---------------------------------------------------------------------------


def fit_all(feature_set: str, X: pd.DataFrame, y: pd.Series, train, val) -> tuple[dict, dict, dict]:
    numeric = FEATURE_SETS[feature_set]["numeric"]
    cols = CATEGORICAL + numeric
    Xtr, ytr, Xva, yva = X.loc[train, cols], y[train], X.loc[val, cols], y[val]
    models, selection, chosen = {}, {}, {}

    models["baseline"] = VendorRateBaseline().fit(Xtr, ytr)

    lr_candidates = {f"C={C:g}": logistic_pipeline(numeric, C) for C in (0.01, 0.1, 1.0, 10.0)}
    chosen["logistic"], models["logistic"], selection["logistic"] = select(lr_candidates, Xtr, ytr, Xva, yva)

    tree_candidates = {f"max_depth={d}": tree_pipeline(numeric, d) for d in (2, 3, 4, 5)}
    chosen["tree"], models["tree"], selection["tree"] = select(tree_candidates, Xtr, ytr, Xva, yva)

    hgb_candidates = {
        f"lr={lr:g}, iter={it}, depth={d}": hgb_pipeline(numeric, lr, it, d)
        for lr, it, d in [(0.05, 100, 3), (0.05, 300, 3), (0.1, 100, 3), (0.05, 200, 5)]
    }
    chosen["hgb"], models["hgb"], selection["hgb"] = select(hgb_candidates, Xtr, ytr, Xva, yva)
    return models, selection, chosen


MODEL_LABELS = {
    "baseline": "(0) vendor late-rate baseline",
    "logistic": "(1) logistic regression",
    "tree": "(2) CART decision tree",
    "hgb": "(3) gradient boosting (HGB)",
}


def run_feature_set(feature_set, X, y, split, n_boot) -> dict:
    train, val, test = (split == "train"), (split == "validation"), (split == "test")
    numeric = FEATURE_SETS[feature_set]["numeric"]
    cols = CATEGORICAL + numeric
    models, selection, chosen = fit_all(feature_set, X, y, train, val)
    prevalence = float(y[train].mean())
    yte = y[test].to_numpy().astype(int)
    yva = y[val].to_numpy().astype(int)
    preds_test, rows = {}, []
    thresholds = {}
    for key, model in models.items():
        p_val = proba(model, X.loc[val, cols])
        thresholds[key] = f1_threshold(yva, p_val)
        preds_test[key] = proba(model, X.loc[test, cols])
    boot = bootstrap_metrics(yte, preds_test, "baseline", n_boot)
    for key in models:
        metrics = evaluate(yte, preds_test[key], thresholds[key], prevalence)
        b = boot.loc[key]
        metrics.update(
            {
                "model": MODEL_LABELS[key],
                "feature set": feature_set,
                "ROC AUC 95% CI": f"{b.roc_ci[0]:.3f}–{b.roc_ci[1]:.3f}",
                "PR AUC 95% CI": f"{b.pr_ci[0]:.3f}–{b.pr_ci[1]:.3f}",
                "ΔROC vs baseline 95% CI": "–" if key == "baseline" else f"{b.droc_ci[0]:+.3f} to {b.droc_ci[1]:+.3f}",
                "ΔPR vs baseline 95% CI": "–" if key == "baseline" else f"{b.dpr_ci[0]:+.3f} to {b.dpr_ci[1]:+.3f}",
                "roc_lo": b.roc_ci[0], "roc_hi": b.roc_ci[1], "pr_lo": b.pr_ci[0], "pr_hi": b.pr_ci[1],
                "droc_lo": b.droc_ci[0], "droc_hi": b.droc_ci[1], "dpr_lo": b.dpr_ci[0], "dpr_hi": b.dpr_ci[1],
                "droc_lr_lo": b.droc_lr_ci[0], "droc_lr_hi": b.droc_lr_ci[1], "dpr_lr_lo": b.dpr_lr_ci[0], "dpr_lr_hi": b.dpr_lr_ci[1],
                "hyper-parameters": chosen.get(key, f"vendors with >= {MIN_VENDOR_HISTORY} train rows"),
            }
        )
        rows.append(metrics)
    return {
        "metrics": pd.DataFrame(rows),
        "models": models,
        "selection": selection,
        "chosen": chosen,
        "preds_test": preds_test,
        "y_test": yte,
        "thresholds": thresholds,
        "cols": cols,
        "numeric": numeric,
        "n_boot": int(boot["n_boot"].min()),
    }


def rolling_origin(X, y, years, feature_set, chosen) -> pd.DataFrame:
    numeric = FEATURE_SETS[feature_set]["numeric"]
    cols = CATEGORICAL + numeric
    C = float(chosen["logistic"].split("=")[1])
    depth = int(chosen["tree"].split("=")[1])
    hgb_params = dict(part.split("=") for part in chosen["hgb"].replace(" ", "").split(","))
    rows = []
    for year in range(2010, 2016):
        tr, te = years < year, years == year
        if y[te].sum() < 5:
            continue
        models = {
            "baseline": VendorRateBaseline(),
            "logistic": logistic_pipeline(numeric, C),
            "tree": tree_pipeline(numeric, depth),
            "hgb": hgb_pipeline(numeric, float(hgb_params["lr"]), int(hgb_params["iter"]), int(hgb_params["depth"])),
        }
        row = {"test year": year, "train rows": int(tr.sum()), "test rows": int(te.sum()), "test late": int(y[te].sum())}
        for key, model in models.items():
            model.fit(X.loc[tr, cols], y[tr])
            p = proba(model, X.loc[te, cols])
            row[f"{key} ROC"] = roc_auc_score(y[te], p)
            row[f"{key} PR"] = average_precision_score(y[te], p)
        rows.append(row)
    return pd.DataFrame(rows)


def odds_ratios(model: Pipeline, X_train: pd.DataFrame, y_train: pd.Series, n_boot: int = 200) -> pd.DataFrame:
    pre = model.named_steps["pre"]
    names = pre.get_feature_names_out()
    coef = model.named_steps["model"].coef_[0]
    rng = np.random.default_rng(SEED)
    draws = []
    for _ in range(n_boot):
        idx = rng.integers(0, len(X_train), len(X_train))
        yb = y_train.iloc[idx]
        if yb.nunique() < 2:
            continue
        clone = sk_clone(model)
        clone.fit(X_train.iloc[idx], yb)
        b_names = clone.named_steps["pre"].get_feature_names_out()
        draws.append(pd.Series(clone.named_steps["model"].coef_[0], index=b_names))
    boot = pd.DataFrame(draws)
    table = pd.DataFrame({"feature": names, "coef": coef, "odds ratio": np.exp(coef)})
    lo = boot.quantile(0.025).reindex(names)
    hi = boot.quantile(0.975).reindex(names)
    table["OR 95% bootstrap CI"] = [
        f"{np.exp(a):.2f}–{np.exp(b):.2f}" if pd.notna(a) else "–" for a, b in zip(lo.values, hi.values)
    ]
    table["feature"] = (
        table["feature"].str.replace("cat__", "", regex=False).str.replace("num__", "", regex=False)
    )
    return table


def curves_figure(result: dict, path) -> str:
    y = result["y_test"]
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    colors = {"baseline": INK_2, "logistic": BLUE, "tree": AQUA, "hgb": ORANGE}
    for key, p in result["preds_test"].items():
        fpr, tpr, _ = roc_curve(y, p)
        axes[0].plot(fpr, tpr, color=colors[key], linewidth=2, label=MODEL_LABELS[key])
        precision, recall, _ = precision_recall_curve(y, p)
        axes[1].plot(recall, precision, color=colors[key], linewidth=2, label=MODEL_LABELS[key])
    axes[0].plot([0, 1], [0, 1], color="#c3c2b7", linewidth=1, linestyle=":")
    axes[1].axhline(y.mean(), color="#c3c2b7", linewidth=1, linestyle=":")
    axes[0].set_xlabel("False positive rate")
    axes[0].set_ylabel("True positive rate")
    axes[0].set_title("ROC, test (PO 2014–2015)", loc="left", fontsize=11)
    axes[1].set_xlabel("Recall")
    axes[1].set_ylabel("Precision")
    axes[1].set_title("Precision–recall, test", loc="left", fontsize=11)
    for ax in axes:
        style_axes(ax)
    axes[1].legend(frameon=False, fontsize=8, loc="upper right")
    return save_figure(fig, path)


def calibration_figure(result: dict, path) -> str:
    y = result["y_test"]
    fig, ax = plt.subplots(figsize=(5, 4))
    colors = {"baseline": INK_2, "logistic": BLUE, "tree": AQUA, "hgb": ORANGE}
    top = 0
    for key, p in result["preds_test"].items():
        table = calibration_table(y, p)
        ax.plot(table["mean_predicted"] * 100, table["observed_rate"] * 100, "o-", color=colors[key], linewidth=1.5, markersize=5, label=MODEL_LABELS[key])
        top = max(top, table["mean_predicted"].max() * 100, table["observed_rate"].max() * 100)
    ax.plot([0, top], [0, top], color="#c3c2b7", linewidth=1, linestyle=":")
    ax.set_xlabel("Mean predicted late probability (%)")
    ax.set_ylabel("Observed late rate (%)")
    ax.set_title("Decile reliability, test", loc="left", fontsize=11)
    ax.legend(frameon=False, fontsize=8)
    style_axes(ax)
    return save_figure(fig, path)


def quantile_section(clean_model: pd.DataFrame, X: pd.DataFrame, split: pd.Series) -> tuple[str, pd.DataFrame]:
    """Secondary: P50 / P90 of actual lead time with strict PO-time features."""
    numeric = FEATURE_SETS["strict PO-time"]["numeric"]
    cols = CATEGORICAL + numeric
    target = clean_model["lead_days_actual"].astype(float)
    train = split.isin(["train", "validation"])
    test = split.eq("test")
    rows = []
    for alpha in (0.5, 0.9):
        pre = ColumnTransformer(
            [("cat", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1, min_frequency=MIN_CATEGORY_FREQUENCY), CATEGORICAL),
             ("num", "passthrough", numeric)],
        )
        model = Pipeline([
            ("pre", pre),
            ("model", HistGradientBoostingRegressor(loss="quantile", quantile=alpha, learning_rate=0.05, max_iter=200, max_depth=3,
                                                    min_samples_leaf=20, categorical_features=list(range(len(CATEGORICAL))),
                                                    early_stopping=False, random_state=SEED)),
        ])
        model.fit(X.loc[train, cols], target[train])
        pred = model.predict(X.loc[test, cols])
        vendor_q = target[train].groupby(X.loc[train, "vendor"]).quantile(alpha)
        vendor_n = target[train].groupby(X.loc[train, "vendor"]).size()
        vendor_q = vendor_q[vendor_n >= MIN_VENDOR_HISTORY]
        base = X.loc[test, "vendor"].map(vendor_q).fillna(target[train].quantile(alpha)).to_numpy()
        actual = target[test].to_numpy()

        def pinball(pred_values):
            diff = actual - pred_values
            return float(np.mean(np.maximum(alpha * diff, (alpha - 1) * diff)))

        rows.append({
            "quantile": f"P{int(alpha * 100)}",
            "model pinball loss (days)": pinball(pred),
            "vendor-quantile baseline pinball loss (days)": pinball(base),
            "model coverage (share actual <= predicted)": pct(np.mean(actual <= pred)),
            "baseline coverage": pct(np.mean(actual <= base)),
        })
    table = pd.DataFrame(rows)
    wins = [r["quantile"] for r in rows if r["model pinball loss (days)"] < r["vendor-quantile baseline pinball loss (days)"]]
    verdict = (
        f"The quantile model beats the vendor-quantile baseline for: {', '.join(wins)}."
        if wins else
        "The quantile model does **not** beat the simple vendor-quantile baseline at either quantile. "
        "For lead-time planning, the vendor's historical P50/P90 is as good as the model here."
    )
    text = f"""## Secondary: lead-time quantiles (P50 and P90)

Gradient boosting with quantile loss for `lead_days_actual`, using only the
strict PO-time features (no scheduled date, no weight). It is trained on
2006–2013 and tested on POs from 2014 onwards. The baseline is the vendor's
historical quantile (vendors with at least {MIN_VENDOR_HISTORY} rows), with the global quantile as fallback.
Lower pinball loss is better. Coverage should be close to 50% and 90%.

{md_table(table, digits=2)}

{verdict}

Lead-time quantiles do not depend on the scheduled date, so they avoid the
revision problem. A P90 lead time is a usable input for safety lead time or for
the expected-lateness term in the allocation model, as an alternative to
`is_late`. Test POs sent late in 2015 are included only if they had already
arrived by the end of the file, so the test P90 is biased low (censoring; see
data-quality.md §3.5).
"""
    return text, table


# ---------------------------------------------------------------------------
# Calibrated risk for the decision model


class CalibratedRisk:
    """A fitted base model plus an optional calibrator fitted on validation."""

    def __init__(self, name: str, base, cols: list[str], method: str | None):
        self.name, self.base, self.cols, self.method = name, base, cols, method
        self.calibrator = None

    @staticmethod
    def _logit(p: np.ndarray) -> np.ndarray:
        p = np.clip(p, 1e-4, 1 - 1e-4)
        return np.log(p / (1 - p)).reshape(-1, 1)

    def _fit_calibrator(self, p: np.ndarray, y: np.ndarray):
        if self.method == "Platt":
            return LogisticRegression(C=1e6, max_iter=1000).fit(self._logit(p), y)
        if self.method == "isotonic":
            return IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(p, y)
        return None

    def _apply(self, calibrator, p: np.ndarray) -> np.ndarray:
        if calibrator is None:
            return p
        if self.method == "Platt":
            return calibrator.predict_proba(self._logit(p))[:, 1]
        return calibrator.predict(p)

    def cv_brier(self, X_val: pd.DataFrame, y_val: np.ndarray, folds: int = 5) -> float:
        """Brier on validation with the calibrator fitted out-of-fold (honest)."""
        p = proba(self.base, X_val[self.cols])
        if self.method is None:
            return float(brier_score_loss(y_val, p))
        out = np.empty_like(p)
        for fit_idx, pred_idx in StratifiedKFold(folds, shuffle=True, random_state=SEED).split(p.reshape(-1, 1), y_val):
            calibrator = self._fit_calibrator(p[fit_idx], y_val[fit_idx])
            out[pred_idx] = self._apply(calibrator, p[pred_idx])
        return float(brier_score_loss(y_val, out))

    def fit_calibration(self, X_val: pd.DataFrame, y_val: np.ndarray) -> "CalibratedRisk":
        self.calibrator = self._fit_calibrator(proba(self.base, X_val[self.cols]), y_val)
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self._apply(self.calibrator, proba(self.base, X[self.cols]))


def select_risk_model(X: pd.DataFrame, y: pd.Series, split: pd.Series, primary: dict) -> tuple[CalibratedRisk, pd.DataFrame]:
    """Pick the best-calibrated late-risk predictor by out-of-fold validation Brier.

    Candidates: the vendor-rate baseline and the primary (strict) logistic
    regression, each raw, Platt-scaled or isotonic-calibrated on 2013. The base
    models are the ones fitted on training years only.
    """
    val, test = split.eq("validation"), split.eq("test")
    yv, yt = y[val].to_numpy(), y[test].to_numpy()
    cols = primary["cols"]
    candidates = []
    for base_key, base_label in (("baseline", "vendor-rate baseline"), ("logistic", "strict logistic regression")):
        for method in (None, "Platt", "isotonic"):
            label = f"{base_label} ({method or 'raw'})"
            candidates.append(CalibratedRisk(label, primary["models"][base_key], cols, method))
    rows = []
    for model in candidates:
        cv = model.cv_brier(X[val], yv)
        model.fit_calibration(X[val], yv)
        p_test = model.predict(X[test])
        cal = calibration_table(yt, p_test)
        ece = float(np.sum(cal["rows"].astype(int) * (cal["mean_predicted"] - cal["observed_rate"]).abs()) / len(yt))
        rows.append({
            "candidate": model.name,
            "validation Brier (out-of-fold)": cv,
            "test Brier": brier_score_loss(yt, p_test),
            "test ECE (deciles)": ece,
            "test mean predicted": pct(p_test.mean()),
            "test observed": pct(yt.mean()),
            "test ROC AUC": roc_auc_score(yt, p_test),
        })
    table = pd.DataFrame(rows)
    best = int(table["validation Brier (out-of-fold)"].idxmin())
    table["chosen"] = ["✓" if i == best else "" for i in range(len(table))]
    return candidates[best], table


MIN_LATE_FOR_VENDOR_DAYS = 5


def days_late_given_late(history: pd.DataFrame) -> tuple[dict, float, pd.DataFrame]:
    """E[days late | late] per vendor from history; global mean for vendors with < 5 late shipments."""
    late = history[history["is_late"].astype(bool)]
    global_mean = float(late["late_days"].mean())
    stats = late.groupby("vendor")["late_days"].agg(["mean", "size"])
    per_vendor = stats.loc[stats["size"] >= MIN_LATE_FOR_VENDOR_DAYS, "mean"].to_dict()
    table = stats.rename(columns={"mean": "mean days late", "size": "late shipments"}).sort_values("late shipments", ascending=False)
    table["used"] = np.where(table["late shipments"] >= MIN_LATE_FOR_VENDOR_DAYS, "vendor mean", "global mean")
    return per_vendor, global_mean, table


PRIMARY_FS = "strict PO-time"
SENSITIVITY_FS = "as specified"


def main() -> int:
    def extra(parser):
        parser.add_argument("--bootstrap", type=int, default=2000, help="Bootstrap resamples for test CIs (default 2000)")

    args, paths = parse_args(__doc__.splitlines()[0], extra)
    paths.ensure()
    warnings.filterwarnings("ignore", category=UserWarning, message=".*unknown categories.*")
    clean = load_clean(paths)
    data = model_frame(clean)
    y = data["is_late"].astype(int)
    split = data["split"]
    X = fill_weight(build_features(data), split.eq("train"))
    train, val, test = split.eq("train"), split.eq("validation"), split.eq("test")

    counts = data.groupby("split").agg(rows=("is_late", "size"), late=("is_late", "sum")).reindex(["train", "validation", "test"])
    counts["late rate"] = (counts["late"] / counts["rows"]).map(pct)

    results = {fs: run_feature_set(fs, X, y, split, args.bootstrap) for fs in (PRIMARY_FS, SENSITIVITY_FS)}
    metrics = pd.concat([results[fs]["metrics"] for fs in (PRIMARY_FS, SENSITIVITY_FS)], ignore_index=True)
    metrics.to_csv(paths.outputs_dir / "delay-model-metrics.csv", index=False, float_format="%.6g")
    prim, sens = results[PRIMARY_FS], results[SENSITIVITY_FS]

    # Leakage demonstration on top of the primary (strict) features.
    leak_rows = []
    base_numeric = FEATURE_SETS[PRIMARY_FS]["numeric"]
    C_main = float(prim["chosen"]["logistic"].split("=")[1])
    for label, extra_cols in [
        ("strict PO-time (no leak)", []),
        ("+ lead_days_actual (outcome leak)", ["lead_days_actual"]),
        ("+ freight amount and shipping-document flags (post-shipment)", ["log_freight", "freight_status_number", "resolved_from_reference"]),
        ("+ lead-time slip = actual − planned lead (a delivered-date derivative)", ["lead_slip_days"]),
    ]:
        numeric = base_numeric + extra_cols
        model = logistic_pipeline(numeric, C_main).fit(X.loc[train, CATEGORICAL + numeric], y[train])
        p = proba(model, X.loc[test, CATEGORICAL + numeric])
        leak_rows.append({"model": "logistic regression", "features": label, "test ROC AUC": roc_auc_score(y[test], p),
                          "test PR AUC": average_precision_score(y[test], p), "test Brier": brier_score_loss(y[test], p)})
    hgb_params = dict(part.split("=") for part in prim["chosen"]["hgb"].replace(" ", "").split(","))
    for label, extra_cols in [("strict PO-time (no leak)", []), ("+ lead_days_actual (outcome leak)", ["lead_days_actual"])]:
        numeric = base_numeric + extra_cols
        model = hgb_pipeline(numeric, float(hgb_params["lr"]), int(hgb_params["iter"]), int(hgb_params["depth"]))
        model.fit(X.loc[train, CATEGORICAL + numeric], y[train])
        p = proba(model, X.loc[test, CATEGORICAL + numeric])
        leak_rows.append({"model": "gradient boosting", "features": label, "test ROC AUC": roc_auc_score(y[test], p),
                          "test PR AUC": average_precision_score(y[test], p), "test Brier": brier_score_loss(y[test], p)})
    leak = pd.DataFrame(leak_rows)
    leak_lr_clean, leak_lr_leak, leak_lr_freight, leak_lr_slip, leak_hgb_clean, leak_hgb_leak = (leak.iloc[i] for i in range(6))

    # Class weights versus threshold tuning (logistic, primary features).
    cw_rows = []
    for cw in (None, "balanced"):
        model = logistic_pipeline(base_numeric, C_main, class_weight=cw).fit(X.loc[train, CATEGORICAL + base_numeric], y[train])
        thr = f1_threshold(y[val].to_numpy(), proba(model, X.loc[val, CATEGORICAL + base_numeric]))
        p = proba(model, X.loc[test, CATEGORICAL + base_numeric])
        ev = evaluate(y[test].to_numpy(), p, thr, float(y[train].mean()))
        cw_rows.append({"class_weight": str(cw), "test ROC AUC": ev["ROC AUC"], "test PR AUC": ev["PR AUC"], "Brier": ev["Brier"],
                        "mean predicted (test)": pct(p.mean()), "observed (test)": pct(y[test].mean()), "precision": ev["precision"], "recall": ev["recall"]})
    class_weights = pd.DataFrame(cw_rows)

    rolling = {fs: rolling_origin(X, y, data["po_year"], fs, results[fs]["chosen"]) for fs in (PRIMARY_FS, SENSITIVITY_FS)}

    # Interpretation (primary).
    lr_model = prim["models"]["logistic"]
    ors = odds_ratios(lr_model, X.loc[train, prim["cols"]], y[train])
    ors["abs"] = ors["coef"].abs()
    sd = X.loc[train, sens["numeric"]].std()
    units = {
        "log_value": f"{sd['log_value']:.2f} log-USD (×{np.exp(sd['log_value']):.1f} value)",
        "log_weight": f"{sd['log_weight']:.2f} log-kg (×{np.exp(sd['log_weight']):.1f} weight)",
        "weight_missing": f"{sd['weight_missing']:.2f}",
        "lead_days_planned": f"{sd['lead_days_planned']:.0f} days",
        "po_year": f"{sd['po_year']:.1f} years",
    }
    numeric_or = ors[ors["feature"].isin(prim["numeric"])].drop(columns="abs")
    numeric_or["1 SD in natural units"] = numeric_or["feature"].map(units)
    top_cat = ors[~ors["feature"].isin(prim["numeric"])].sort_values("abs", ascending=False).head(12).drop(columns="abs")
    mode_pg_or = ors[ors["feature"].str.startswith(("shipment_mode_", "product_group_"))].drop(columns="abs")
    or_lookup = ors.set_index("feature")["odds ratio"]
    # Sensitivity model: the two borderline features.
    ors_sens = odds_ratios(sens["models"]["logistic"], X.loc[train, sens["cols"]], y[train], n_boot=100)
    sens_numeric_or = ors_sens[ors_sens["feature"].isin(sens["numeric"])].copy()
    sens_numeric_or["1 SD in natural units"] = sens_numeric_or["feature"].map(units)
    sens_or = ors_sens.set_index("feature")["odds ratio"]

    tree = prim["models"]["tree"]
    tree_rules = export_text(tree.named_steps["model"], feature_names=list(tree.named_steps["pre"].get_feature_names_out()), show_weights=True, decimals=1)

    perm = permutation_importance(prim["models"]["hgb"], X.loc[test, prim["cols"]], y[test], scoring="roc_auc", n_repeats=20, random_state=SEED)
    importance = pd.DataFrame({"feature": prim["cols"], "HGB: mean ROC AUC drop": perm.importances_mean, "HGB sd": perm.importances_std})
    perm_lr = permutation_importance(lr_model, X.loc[test, prim["cols"]], y[test], scoring="roc_auc", n_repeats=20, random_state=SEED)
    importance["logistic: mean ROC AUC drop"] = perm_lr.importances_mean
    importance = importance.sort_values("logistic: mean ROC AUC drop", ascending=False)
    perm_sens = permutation_importance(sens["models"]["hgb"], X.loc[test, sens["cols"]], y[test], scoring="roc_auc", n_repeats=20, random_state=SEED)
    sens_importance = pd.Series(perm_sens.importances_mean, index=sens["cols"])

    # Calibration tables and failure analysis (primary).
    cal = {key: calibration_table(prim["y_test"], p) for key, p in prim["preds_test"].items()}
    test_frame = data[test].copy()
    test_frame["p_lr"] = prim["preds_test"]["logistic"]
    thr_lr = prim["thresholds"]["logistic"]
    test_frame["flag"] = test_frame["p_lr"] >= thr_lr
    missed = test_frame[test_frame["is_late"] & ~test_frame["flag"]]
    false_alarm = test_frame[~test_frame["is_late"] & test_frame["flag"]]
    by_vendor_test = test_frame.groupby("vendor").agg(test_rows=("is_late", "size"), late=("is_late", "sum"), mean_p=("p_lr", "mean")).sort_values("late", ascending=False)
    by_vendor_test = by_vendor_test[by_vendor_test["late"] > 0]
    by_vendor_test["mean_p"] = by_vendor_test["mean_p"].map(pct)
    train_vendors = set(data.loc[train, "vendor"])
    unseen_test = int((~test_frame["vendor"].isin(train_vendors)).sum())
    unseen_late = int((~test_frame["vendor"].isin(train_vendors) & test_frame["is_late"]).sum())
    lead_compare = data.groupby(["split", "is_late"])["lead_days_planned"].median().unstack()

    # Calibrated risk for the decision model.
    risk_model, risk_table = select_risk_model(X, y, split, prim)
    history = data[data["po_year"] <= VALIDATION_YEAR]
    vendor_days, global_days, days_table = days_late_given_late(history)
    p_risk_test = risk_model.predict(X[test])
    risk_cal = calibration_table(prim["y_test"], p_risk_test)

    fig_curves = curves_figure(prim, paths.figures_dir / "delay-model-curves.png")
    fig_cal = calibration_figure(prim, paths.figures_dir / "delay-model-calibration.png")
    quant_text, _ = quantile_section(data, X, split)

    def metric_view(frame: pd.DataFrame) -> pd.DataFrame:
        view = frame[["model", "ROC AUC", "ROC AUC 95% CI", "ΔROC vs baseline 95% CI", "PR AUC", "PR AUC 95% CI", "ΔPR vs baseline 95% CI",
                      "Brier", "Brier skill vs train rate", "threshold (from validation)", "flagged", "precision", "recall"]].copy()
        for c in ["ROC AUC", "PR AUC", "threshold (from validation)", "precision", "recall", "Brier skill vs train rate"]:
            view[c] = view[c].map(lambda v: f"{v:.3f}" if pd.notna(v) else "–")
        view["Brier"] = view["Brier"].map(lambda v: f"{v:.4f}")
        return view

    def selection_view(res):
        parts = []
        for key in ("logistic", "tree", "hgb"):
            t = res["selection"][key].copy()
            t.insert(0, "model", MODEL_LABELS[key])
            t["chosen"] = np.where(t["candidate"] == res["chosen"][key], "✓", "")
            parts.append(t)
        return pd.concat(parts, ignore_index=True)

    def fmt3(frame, columns):
        return frame.assign(**{c: frame[c].map(lambda v: f"{v:.3f}" if pd.notna(v) else "–") for c in columns})

    m_p = prim["metrics"].set_index("model")
    m_s = sens["metrics"].set_index("model")
    lr_label, hgb_label, base_label, tree_label = MODEL_LABELS["logistic"], MODEL_LABELS["hgb"], MODEL_LABELS["baseline"], MODEL_LABELS["tree"]
    challengers = (lr_label, tree_label, hgb_label)
    beats_roc = {fs: [k for k in challengers if results[fs]["metrics"].set_index("model").loc[k, "droc_lo"] > 0] for fs in results}
    beats_pr = {fs: [k for k in challengers if results[fs]["metrics"].set_index("model").loc[k, "dpr_lo"] > 0] for fs in results}
    worse_roc = {fs: [k for k in challengers if results[fs]["metrics"].set_index("model").loc[k, "droc_hi"] < 0] for fs in results}

    roll_view, roll_mean, roll_wins = {}, {}, {}
    for fs, table in rolling.items():
        view = table.copy()
        for c in view.columns:
            if c.endswith("ROC") or c.endswith("PR"):
                view[c] = view[c].map(lambda v: f"{v:.3f}")
        roll_view[fs] = view
        roll_mean[fs] = table[[c for c in table.columns if c.endswith(" ROC")]].mean()
        roll_wins[fs] = {k: int((table[f"{k} ROC"] > table["baseline ROC"]).sum()) for k in ("logistic", "tree", "hgb")}
    n_folds = len(rolling[PRIMARY_FS])

    report = f"""# Late-delivery model at PO time

Generated by `analytics/scms/delay_model.py` (seed {SEED}, {prim['n_boot']:,}+
bootstrap resamples). Rubric section 4.

**Primary specification: the strict PO-time feature set.** Planned lead time
(scheduled − PO) is contaminated by the scheduled-date revision finding
(data-quality.md §3.4). The data dictionary calls the field the "current
anticipated delivery date". Weight comes from shipping documents. Both are
therefore dropped from the primary model. The originally specified set, with
both features, is kept as a sensitivity result. The split and protocol are the
pre-registered ones and were not changed after seeing results.

## Problem

- **Target:** `is_late` = delivered > scheduled + {GRACE_DAYS} days, for
  direct-drop shipments (the same rule as the scorecard).
- **Prediction time:** the day the PO is sent to the vendor.
- **Use:** flag risky POs, and supply calibrated late-risk to the allocation
  model (`decision-results.md`).
- **Rows:** {len(data):,} direct-drop shipments with a PO date and valid dates.
  **Split by PO year:** train ≤ {TRAIN_LAST_YEAR}, validation {VALIDATION_YEAR}
  (hyper-parameters, threshold, calibration), test ≥ {TEST_FIRST_YEAR} (the
  last ~20 months of POs).

{md_table(counts.reset_index())}

Late shipments are rare and get rarer: {pct(counts.loc['train', 'late'] / counts.loc['train', 'rows'])} in train,
{pct(counts.loc['test', 'late'] / counts.loc['test', 'rows'])} in test. With {int(counts.loc['test', 'late'])} late test shipments, every test metric has a
wide interval. Read the CIs, not the point estimates.

## 1. Leakage audit (done before modelling)

{md_table(pd.DataFrame(LEAKAGE_AUDIT, columns=['column', 'known when PO is sent?', 'decision', 'justification']))}

Feature sets:

- **strict PO-time (primary):** vendor, shipment mode, country and product
  group (one-hot), log line value and PO year.
- **as specified (sensitivity):** the same plus the two borderline features
  (log weight with a missing flag, and planned lead time).

### What a leaky feature does

Logistic regression (same split, C = {C_main:g}) and gradient boosting (same
hyper-parameters), with extra columns that are not known at PO time:

{md_table(fmt3(leak, ['test ROC AUC', 'test PR AUC', 'test Brier']))}

`lead_days_actual` exists only after delivery. On its own, without the planned
lead time, it does not determine the target. Adding it changes logistic test
PR AUC from {leak_lr_clean['test PR AUC']:.3f} to {leak_lr_leak['test PR AUC']:.3f} and ROC AUC from {leak_lr_clean['test ROC AUC']:.3f} to
{leak_lr_leak['test ROC AUC']:.3f}. For gradient boosting the change is PR AUC {leak_hgb_clean['test PR AUC']:.3f} → {leak_hgb_leak['test PR AUC']:.3f} and ROC
AUC {leak_hgb_clean['test ROC AUC']:.3f} → {leak_hgb_leak['test ROC AUC']:.3f}. The clear demonstration is the engineered slip
(actual − planned lead time, i.e. `late_days`). It gives ROC AUC
**{leak_lr_slip['test ROC AUC']:.3f}** and PR AUC **{leak_lr_slip['test PR AUC']:.3f}**, against {leak_lr_clean['test ROC AUC']:.3f} and
{leak_lr_clean['test PR AUC']:.3f} without it. That model looks excellent and is useless at PO time. Post-shipment
freight fields give ROC AUC {leak_lr_freight['test ROC AUC']:.3f} against {leak_lr_clean['test ROC AUC']:.3f}. A leak does not always
inflate a metric, so the absence of inflation is not evidence that a feature is
safe. The audit decides.

## 2. Models and selection

Fitted in this order, on the training years only:

0. **Baseline:** vendor's training late rate. Vendors with fewer than
   {MIN_VENDOR_HISTORY} training shipments get the global rate ({pct(y[train].mean())}).
1. **Logistic regression** (L2). Categories with fewer than
   {MIN_CATEGORY_FREQUENCY} training rows are pooled. Numeric features are standardised.
2. **CART**, depth-limited, min 20 rows per leaf.
3. **HistGradientBoostingClassifier**, native categorical splits, fixed iterations.

**Class imbalance.** No class weights; the alert threshold is the
F1-maximising threshold on validation. The decision model needs calibrated
probabilities. `class_weight="balanced"` raised the mean predicted test
probability to {class_weights.iloc[1]['mean predicted (test)']} (observed {class_weights.iloc[1]['observed (test)']}) and moved test ROC AUC from
{class_weights.iloc[0]['test ROC AUC']:.3f} to {class_weights.iloc[1]['test ROC AUC']:.3f}. Hyper-parameters were chosen by validation log loss
(primary set):

{md_table(selection_view(prim), digits=3)}

## 3. Test results (PO 2014–2015), against the baseline

**Primary: strict PO-time**

{md_table(metric_view(prim['metrics']))}

**Sensitivity: as specified (with planned lead time and weight)**

{md_table(metric_view(sens['metrics']))}

Δ columns are paired bootstrap differences against the baseline on the same
resamples. An interval excluding 0 is a reliable difference.

- Reliably better ROC AUC than the baseline: primary {', '.join(beats_roc[PRIMARY_FS]) or 'none'}; sensitivity {', '.join(beats_roc[SENSITIVITY_FS]) or 'none'}.
- Reliably better PR AUC: primary {', '.join(beats_pr[PRIMARY_FS]) or 'none'}; sensitivity {', '.join(beats_pr[SENSITIVITY_FS]) or 'none'}.
- Reliably *worse* ROC AUC: primary {', '.join(worse_roc[PRIMARY_FS]) or 'none'}; sensitivity {', '.join(worse_roc[SENSITIVITY_FS]) or 'none'}.

![ROC and PR curves]({'figures/' + fig_curves})

### Calibration (decile reliability, test, primary)

![Calibration]({'figures/' + fig_cal})

Logistic regression:

{md_table(cal['logistic'], digits=3)}

Gradient boosting:

{md_table(cal['hgb'], digits=3)}

Baseline:

{md_table(cal['baseline'], digits=3)}

### Class weights versus threshold tuning (logistic, primary)

{md_table(fmt3(class_weights, ['test ROC AUC', 'test PR AUC', 'Brier', 'precision', 'recall']))}

### Rolling-origin check (train on all earlier PO years, test on one year)

Reported alongside the pre-registered split, not instead of it.
Hyper-parameters are fixed at the values chosen above. Years with fewer than 5
late shipments are skipped.

Primary (strict PO-time):

{md_table(roll_view[PRIMARY_FS])}

Sensitivity (as specified):

{md_table(roll_view[SENSITIVITY_FS])}

Mean ROC AUC across folds, primary: {', '.join(f"{k.split()[0]} {v:.3f}" for k, v in roll_mean[PRIMARY_FS].items())};
sensitivity: {', '.join(f"{k.split()[0]} {v:.3f}" for k, v in roll_mean[SENSITIVITY_FS].items())}.
Folds where each model beats the baseline's ROC AUC (primary, of {n_folds}):
logistic {roll_wins[PRIMARY_FS]['logistic']}, tree {roll_wins[PRIMARY_FS]['tree']}, HGB {roll_wins[PRIMARY_FS]['hgb']}.

## 4. Interpretation (primary model)

### Logistic regression odds ratios

ORs are per 1 SD for numeric features. Categories are one-hot without a
reference level, so each category's OR is relative to the L2-shrunk average.
95% intervals come from 200 bootstrap refits on training data, and shrinkage
pulls every OR towards 1.

{md_table(numeric_or, digits=3)}

Shipment mode and product group (all levels):

{md_table(mode_pg_or, digits=3)}

Largest category effects:

{md_table(top_cat, digits=3)}

Sensitivity model, the borderline numeric features (100 bootstrap refits):

{md_table(sens_numeric_or, digits=3)}

Median planned lead time (days) of late and not-late shipments, by split:

{md_table(lead_compare.rename(columns={False: 'not late', True: 'late'}).reset_index(), digits=0)}

### Decision tree rules ({prim['chosen']['tree']})

`weights` are [not late, late] training counts in each leaf.

```
{tree_rules}
```

### Permutation importance on test (drop in ROC AUC when a feature is shuffled, 20 repeats)

{md_table(importance, digits=3)}

### Where the model fails

- Late test shipments by vendor, with the logistic model's mean predicted
  probability for that vendor's test POs:

{md_table(by_vendor_test.reset_index())}

- At the validation threshold ({thr_lr:.3f}), logistic regression misses
  {len(missed)} of {int(test_frame['is_late'].sum())} late test shipments and raises {len(false_alarm)} false alarms.
- {unseen_test} test rows ({unseen_late} late) come from vendors with no training history.

## 5. Discussion

- **Headline.** On the pre-registered test, no primary model reliably beats
  the vendor baseline on ROC AUC. Baseline {m_p.loc[base_label, 'ROC AUC']:.3f} (95% CI {m_p.loc[base_label, 'ROC AUC 95% CI']}),
  logistic {m_p.loc[lr_label, 'ROC AUC']:.3f} (Δ {m_p.loc[lr_label, 'ΔROC vs baseline 95% CI']}), HGB {m_p.loc[hgb_label, 'ROC AUC']:.3f} (Δ {m_p.loc[hgb_label, 'ΔROC vs baseline 95% CI']}).
  On PR AUC, which rewards putting the few late shipments first,
  {', '.join(beats_pr[PRIMARY_FS]) or 'no model'} reliably beat the baseline's {m_p.loc[base_label, 'PR AUC']:.3f}
  (logistic {m_p.loc[lr_label, 'PR AUC']:.3f}, Δ {m_p.loc[lr_label, 'ΔPR vs baseline 95% CI']}; HGB {m_p.loc[hgb_label, 'PR AUC']:.3f}, Δ {m_p.loc[hgb_label, 'ΔPR vs baseline 95% CI']}).
  With {int(counts.loc['test', 'late'])} late test shipments the ranking is not stable.
- **Rolling origin (alongside, not instead).** Predicting each year from all
  earlier years, logistic regression beats the baseline in
  {roll_wins[PRIMARY_FS]['logistic']} of {n_folds} folds (mean ROC AUC {roll_mean[PRIMARY_FS]['logistic ROC']:.3f} vs {roll_mean[PRIMARY_FS]['baseline ROC']:.3f}). The pre-registered test trains only to
  2012, so it misses the most recent year before the test window.
- **Which features matter.** Vendor and destination dominate. Largest ORs:
  South Africa {or_lookup.get('country_South Africa', float('nan')):.1f}, Nigeria {or_lookup.get('country_Nigeria', float('nan')):.1f}; vendors Aurobindo
  {or_lookup.get('vendor_Aurobindo Pharma Limited', float('nan')):.1f}, Cipla {or_lookup.get('vendor_CIPLA LIMITED', float('nan')):.1f}, Orgenics {or_lookup.get('vendor_Orgenics, Ltd', float('nan')):.1f}, the three lowest
  on-time vendors in the scorecard. Larger lines are late more often (OR
  {or_lookup.get('log_value', float('nan')):.2f} per SD of log value). Ocean OR {or_lookup.get('shipment_mode_Ocean', float('nan')):.2f}.
- **Why the borderline features were dropped.** In the sensitivity model,
  planned lead time has OR {sens_or.get('lead_days_planned', float('nan')):.2f} per SD (longer plans late less often, consistent
  with schedules revised outward), and its HGB permutation importance on test is
  {sens_importance.get('lead_days_planned', float('nan')):+.3f}. The sensitivity set does not beat the primary:
  logistic ROC AUC {m_s.loc[lr_label, 'ROC AUC']:.3f} vs {m_p.loc[lr_label, 'ROC AUC']:.3f}, HGB {m_s.loc[hgb_label, 'ROC AUC']:.3f} vs {m_p.loc[hgb_label, 'ROC AUC']:.3f}.
- **Do the results make sense?** The directions match the scorecard. Raw
  calibration is poor: logistic regression predicts {pct(prim['preds_test']['logistic'].mean())} late in test against
  {pct(prim['y_test'].mean())} observed, because the late rate fell after 2013. That fall coincides
  with more exact-on-schedule matches, so part of it may be recording practice.
- **Where it fails.** {by_vendor_test.index[0]} accounts for {int(by_vendor_test.iloc[0]['late'])} of {int(test_frame['is_late'].sum())}
  late test shipments; the rest are spread over vendors the models consider
  safe. 2015 POs are censored (only arrivals before the end of the file).
- **Is the complex model worth it?** Paired bootstrap HGB − logistic: ROC AUC
  {m_p.loc[hgb_label, 'droc_lr_lo']:+.3f} to {m_p.loc[hgb_label, 'droc_lr_hi']:+.3f} ({'reliably different' if m_p.loc[hgb_label, 'droc_lr_lo'] > 0 or m_p.loc[hgb_label, 'droc_lr_hi'] < 0 else 'not reliably different'}), PR AUC
  {m_p.loc[hgb_label, 'dpr_lr_lo']:+.3f} to {m_p.loc[hgb_label, 'dpr_lr_hi']:+.3f} ({'HGB reliably higher' if m_p.loc[hgb_label, 'dpr_lr_lo'] > 0 else ('HGB reliably lower' if m_p.loc[hgb_label, 'dpr_lr_hi'] < 0 else 'not reliably different')}). Brier: HGB
  {m_p.loc[hgb_label, 'Brier']:.4f}, logistic {m_p.loc[lr_label, 'Brier']:.4f}. So HGB puts a few very risky POs at the top
  of the list better than logistic regression does. It does not rank the
  whole population better, and {int(counts.loc['test', 'late'])} positives make this fragile. For an
  expediting shortlist, HGB is worth trialling. For scoring every candidate
  vendor in the allocation model, and for explaining the result, logistic
  regression (or the vendor baseline) is the simpler and more defensible choice.
- **Honesty about the target.** `is_late` means "after the last recorded
  (current anticipated) date", not "after the original promise".

## 6. Calibrated risk for the decision model

The allocation model needs P(late) for vendors that were *not* chosen, and the
same predictor must score every policy. Candidates: the vendor-rate baseline
and the primary logistic regression (both fitted on ≤{TRAIN_LAST_YEAR}), each
raw, Platt-scaled or isotonic-calibrated on {VALIDATION_YEAR}. The choice is by
**out-of-fold validation Brier** (5-fold within {VALIDATION_YEAR}, so the calibrator never
scores the rows it was fitted on). Test columns are shown for information and
were not used to choose.

{md_table(fmt3(risk_table, ['validation Brier (out-of-fold)', 'test Brier', 'test ECE (deciles)', 'test ROC AUC']))}

**Chosen: {risk_model.name}.** Test decile reliability of the chosen predictor:

{md_table(risk_cal, digits=3)}

**Expected days late given late** (ASSUMPTION: vendor mean of `late_days`
among late POs sent ≤{VALIDATION_YEAR}, if the vendor has ≥{MIN_LATE_FOR_VENDOR_DAYS} late shipments; otherwise
the global mean of {global_days:.1f} days). Expected days late = P(late) ×
E[days late | late].

{md_table(days_table.reset_index().head(15), digits=1)}

{quant_text}
"""
    write_text(paths.outputs_dir / "delay-model.md", report)

    key = {
        "primary_feature_set": PRIMARY_FS,
        "counts": {s: {"rows": int(counts.loc[s, "rows"]), "late": int(counts.loc[s, "late"])} for s in counts.index},
        "test": {fs: {r["model"]: {k: r[k] for k in ("ROC AUC", "ROC AUC 95% CI", "ΔROC vs baseline 95% CI", "PR AUC", "PR AUC 95% CI",
                                                  "ΔPR vs baseline 95% CI", "Brier", "precision", "recall")}
                      for _, r in results[fs]["metrics"].iterrows()} for fs in results},
        "rolling_mean_roc": {fs: {k: float(v) for k, v in roll_mean[fs].items()} for fs in results},
        "rolling_wins": roll_wins,
        "n_folds": n_folds,
        "leak": {r["model"] + " | " + r["features"]: {"ROC AUC": r["test ROC AUC"], "PR AUC": r["test PR AUC"]} for _, r in leak.iterrows()},
        "risk_model": risk_model.name,
        "risk_table": risk_table.to_dict(orient="records"),
        "global_days_late": global_days,
    }
    write_json(paths.outputs_dir / "key-numbers-delay.json", key)
    print(f"Wrote {paths.outputs_dir / 'delay-model.md'}")
    cols = ["feature set", "model", "ROC AUC", "ROC AUC 95% CI", "ΔROC vs baseline 95% CI", "PR AUC", "PR AUC 95% CI", "ΔPR vs baseline 95% CI", "Brier"]
    with pd.option_context("display.width", 250, "display.max_columns", 20):
        print(metrics[cols].to_string(index=False))
        print(leak.to_string(index=False))
        print(risk_table.to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
