"""Predict late delivery at the time the PO is sent (rubric section 4).

Target: ``is_late`` (delivered > scheduled + 0 days) for direct-drop shipments.
Split by the year the PO was sent: train <= 2012, validation 2013, test >= 2014,
plus a rolling-origin check. Models, in order: (0) vendor historical late
rate, (1) logistic regression, (2) depth-limited CART, (3) histogram gradient
boosting.

Writes ``outputs/delay-model.md``, ``outputs/delay-model-metrics.csv`` and
figures. Every number in the report is computed here.

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
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    precision_recall_curve,
    roc_auc_score,
    roc_curve,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler
from sklearn.tree import DecisionTreeClassifier, export_text

from .dataset import TEST_FIRST_YEAR, TRAIN_LAST_YEAR, VALIDATION_YEAR, load_clean, model_frame
from .paths import GRACE_DAYS, SEED, parse_args
from .report import AQUA, BLUE, INK_2, ORANGE, md_table, pct, save_figure, style_axes, write_text

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
    ("sub classification / item description / molecule / brand / dosage / dosage form / unit of measure / manufacturing site / first line designation", "yes", "not used", "Known at PO time. Left out to keep the specified, interpretable feature set."),
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

    counts = data.groupby("split").agg(rows=("is_late", "size"), late=("is_late", "sum")).reindex(["train", "validation", "test"])
    counts["late rate"] = (counts["late"] / counts["rows"]).map(pct)

    results = {fs: run_feature_set(fs, X, y, split, args.bootstrap) for fs in FEATURE_SETS}
    main_fs = "as specified"
    strict_fs = "strict PO-time"
    metrics = pd.concat([results[fs]["metrics"] for fs in FEATURE_SETS], ignore_index=True)
    metrics.to_csv(paths.outputs_dir / "delay-model-metrics.csv", index=False, float_format="%.6g")

    # Leakage demonstration: add lead_days_actual, then post-shipment freight fields.
    train, val, test = split.eq("train"), split.eq("validation"), split.eq("test")
    leak_rows = []
    base_numeric = FEATURE_SETS[main_fs]["numeric"]
    C_main = float(results[main_fs]["chosen"]["logistic"].split("=")[1])
    for label, extra_cols in [
        ("as specified (no leak)", []),
        ("+ lead_days_actual (outcome leak)", ["lead_days_actual"]),
        ("+ freight amount and shipping-document flags (post-shipment)", ["log_freight", "freight_status_number", "resolved_from_reference"]),
        ("+ lead-time slip = actual − planned lead (a delivered-date derivative)", ["lead_slip_days"]),
    ]:
        numeric = base_numeric + extra_cols
        model = logistic_pipeline(numeric, C_main).fit(X.loc[train, CATEGORICAL + numeric], y[train])
        p = proba(model, X.loc[test, CATEGORICAL + numeric])
        leak_rows.append({"logistic regression features": label, "test ROC AUC": roc_auc_score(y[test], p), "test PR AUC": average_precision_score(y[test], p),
                          "test Brier": brier_score_loss(y[test], p)})
    hgb_params = dict(part.split("=") for part in results[main_fs]["chosen"]["hgb"].replace(" ", "").split(","))
    for label, extra_cols in [("as specified (no leak)", []), ("+ lead_days_actual (outcome leak)", ["lead_days_actual"])]:
        numeric = base_numeric + extra_cols
        model = hgb_pipeline(numeric, float(hgb_params["lr"]), int(hgb_params["iter"]), int(hgb_params["depth"]))
        model.fit(X.loc[train, CATEGORICAL + numeric], y[train])
        p = proba(model, X.loc[test, CATEGORICAL + numeric])
        leak_rows.append({"model": "gradient boosting", "features": label, "test ROC AUC": roc_auc_score(y[test], p),
                          "test PR AUC": average_precision_score(y[test], p), "test Brier": brier_score_loss(y[test], p)})
    leak = pd.DataFrame(leak_rows)
    leak["model"] = leak["model"].fillna("logistic regression")
    leak["features"] = leak["features"].fillna(leak["logistic regression features"])
    leak = leak[["model", "features", "test ROC AUC", "test PR AUC", "test Brier"]]
    leak_lr_clean, leak_lr_leak, leak_lr_freight, leak_lr_slip, leak_hgb_clean, leak_hgb_leak = (leak.iloc[i] for i in range(6))

    # Class weights versus threshold tuning (logistic, as specified).
    cw_rows = []
    for cw in (None, "balanced"):
        model = logistic_pipeline(base_numeric, C_main, class_weight=cw).fit(X.loc[train, CATEGORICAL + base_numeric], y[train])
        p_val = proba(model, X.loc[val, CATEGORICAL + base_numeric])
        thr = f1_threshold(y[val].to_numpy(), p_val)
        p = proba(model, X.loc[test, CATEGORICAL + base_numeric])
        ev = evaluate(y[test].to_numpy(), p, thr, float(y[train].mean()))
        cw_rows.append({"class_weight": str(cw), "test ROC AUC": ev["ROC AUC"], "test PR AUC": ev["PR AUC"], "Brier": ev["Brier"],
                        "mean predicted (test)": pct(p.mean()), "observed (test)": pct(y[test].mean()), "precision": ev["precision"], "recall": ev["recall"]})
    class_weights = pd.DataFrame(cw_rows)

    # Rolling origin.
    rolling = {fs: rolling_origin(X, y, data["po_year"], fs, results[fs]["chosen"]) for fs in FEATURE_SETS}

    # Interpretation.
    main_res = results[main_fs]
    strict_res = results[strict_fs]
    lr_model = main_res["models"]["logistic"]
    ors = odds_ratios(lr_model, X.loc[train, main_res["cols"]], y[train])
    ors["abs"] = ors["coef"].abs()
    numeric_or = ors[ors["feature"].isin(main_res["numeric"])].drop(columns="abs")
    sd = X.loc[train, main_res["numeric"]].std()
    numeric_or["1 SD in natural units"] = numeric_or["feature"].map(
        {
            "log_value": f"{sd['log_value']:.2f} log-USD (×{np.exp(sd['log_value']):.1f} value)",
            "log_weight": f"{sd['log_weight']:.2f} log-kg (×{np.exp(sd['log_weight']):.1f} weight)",
            "weight_missing": f"{sd['weight_missing']:.2f}",
            "lead_days_planned": f"{sd['lead_days_planned']:.0f} days",
            "po_year": f"{sd['po_year']:.1f} years",
        }
    )
    top_cat = ors[~ors["feature"].isin(main_res["numeric"])].sort_values("abs", ascending=False).head(12).drop(columns="abs")
    mode_pg_or = ors[ors["feature"].str.startswith(("shipment_mode_", "product_group_"))].drop(columns="abs")
    or_lookup = ors.set_index("feature")["odds ratio"]
    strict_lr = strict_res["models"]["logistic"]
    ors_strict = odds_ratios(strict_lr, X.loc[train, strict_res["cols"]], y[train], n_boot=100)
    ors_strict["abs"] = ors_strict["coef"].abs()
    top_strict = ors_strict.sort_values("abs", ascending=False).head(8).drop(columns="abs")

    tree = main_res["models"]["tree"]
    tree_rules = export_text(tree.named_steps["model"], feature_names=list(tree.named_steps["pre"].get_feature_names_out()), show_weights=True, decimals=1)
    tree_strict = strict_res["models"]["tree"]
    tree_rules_strict = export_text(tree_strict.named_steps["model"], feature_names=list(tree_strict.named_steps["pre"].get_feature_names_out()), show_weights=True, decimals=1)

    perm = permutation_importance(main_res["models"]["hgb"], X.loc[test, main_res["cols"]], y[test], scoring="roc_auc", n_repeats=20, random_state=SEED)
    importance = pd.DataFrame({"feature": main_res["cols"], "mean ROC AUC drop": perm.importances_mean, "sd": perm.importances_std}).sort_values("mean ROC AUC drop", ascending=False)
    perm_lr = permutation_importance(lr_model, X.loc[test, main_res["cols"]], y[test], scoring="roc_auc", n_repeats=20, random_state=SEED)
    importance["logistic: mean ROC AUC drop"] = pd.Series(perm_lr.importances_mean, index=main_res["cols"]).reindex(importance["feature"]).values

    # Calibration tables and failure analysis (logistic, as specified).
    cal = {key: calibration_table(main_res["y_test"], p) for key, p in main_res["preds_test"].items()}
    test_frame = data[test].copy()
    test_frame["p_lr"] = main_res["preds_test"]["logistic"]
    thr_lr = main_res["thresholds"]["logistic"]
    test_frame["flag"] = test_frame["p_lr"] >= thr_lr
    missed = test_frame[test_frame["is_late"] & ~test_frame["flag"]]
    false_alarm = test_frame[~test_frame["is_late"] & test_frame["flag"]]
    by_vendor_test = test_frame.groupby("vendor").agg(test_rows=("is_late", "size"), late=("is_late", "sum"), mean_p=("p_lr", "mean")).sort_values("late", ascending=False)
    by_vendor_test = by_vendor_test[by_vendor_test["late"] > 0]
    by_vendor_test["mean_p"] = by_vendor_test["mean_p"].map(pct)
    train_vendors = set(data.loc[train, "vendor"])
    unseen_test = int((~test_frame["vendor"].isin(train_vendors)).sum())
    unseen_late = int((~test_frame["vendor"].isin(train_vendors) & test_frame["is_late"]).sum())

    # Planned lead time: how different is it between late and not-late rows?
    lead_compare = data.groupby(["split", "is_late"])["lead_days_planned"].median().unstack()

    fig_curves = curves_figure(main_res, paths.figures_dir / "delay-model-curves.png")
    fig_cal = calibration_figure(main_res, paths.figures_dir / "delay-model-calibration.png")
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

    m_main = results[main_fs]["metrics"].set_index("model")
    m_strict = results[strict_fs]["metrics"].set_index("model")
    lr_label, hgb_label, base_label, tree_label = MODEL_LABELS["logistic"], MODEL_LABELS["hgb"], MODEL_LABELS["baseline"], MODEL_LABELS["tree"]

    def ci_excludes_zero(row, prefix):
        return row[f"{prefix}_lo"] > 0 or row[f"{prefix}_hi"] < 0

    beats = {fs: [k for k in (lr_label, tree_label, hgb_label) if results[fs]["metrics"].set_index("model").loc[k, "droc_lo"] > 0] for fs in FEATURE_SETS}

    roll_view = {}
    for fs, table in rolling.items():
        view = table.copy()
        for c in view.columns:
            if c.endswith("ROC") or c.endswith("PR"):
                view[c] = view[c].map(lambda v: f"{v:.3f}")
        roll_view[fs] = view
    roll_mean = {fs: rolling[fs][[c for c in rolling[fs].columns if c.endswith(" ROC")]].mean() for fs in FEATURE_SETS}

    report = f"""# Late-delivery model at PO time

Generated by `analytics/scms/delay_model.py` (seed {SEED}, {results[main_fs]['n_boot']:,}+
bootstrap resamples). Rubric section 4.

## Problem

- **Target:** `is_late` = delivered > scheduled + {GRACE_DAYS} days, for
  direct-drop shipments. This is the same rule as the scorecard.
- **Prediction time:** the day the PO is sent to the vendor. Only information
  available then may be used.
- **Use:** flag risky POs for expediting, and feed an expected-lateness cost into
  the allocation model (`decision-proposal.md`).
- **Rows:** {len(data):,} direct-drop shipments with a PO date and valid
  dates. **Split by PO year, not at random:** train ≤ {TRAIN_LAST_YEAR},
  validation {VALIDATION_YEAR} (hyper-parameters and threshold), test ≥
  {TEST_FIRST_YEAR} (the last ~20 months of POs, used once).

{md_table(counts.reset_index())}

The positive class is rare and gets rarer over time: {pct(counts.loc['train', 'late'] / counts.loc['train', 'rows'])} in train and
{pct(counts.loc['test', 'late'] / counts.loc['test', 'rows'])} in test. With only {int(counts.loc['test', 'late'])} late test shipments, every
test metric has a wide interval. Read the CIs, not the point estimates.

## 1. Leakage audit (done before modelling)

{md_table(pd.DataFrame(LEAKAGE_AUDIT, columns=['column', 'known when PO is sent?', 'decision', 'justification']))}

Two feature sets follow from the audit:

- **as specified**: vendor, shipment mode, country and product group
  (one-hot), plus log line value, log weight with a missing flag, planned
  lead time and PO year.
- **strict PO-time**: the same without the two borderline features (planned
  lead time and weight). Only this set is safe if the scheduled date was
  revised after the PO (data-quality.md §3.4).

### What a leaky feature does

Logistic regression (same split, C = {C_main:g}) and gradient boosting (same
hyper-parameters), with extra columns that are not known at PO time:

{md_table(leak.assign(**{c: leak[c].map(lambda v: f'{v:.3f}') for c in ['test ROC AUC', 'test PR AUC', 'test Brier']}))}

`lead_days_actual` and the planned lead time together determine the target
exactly (late ⇔ actual > planned). Adding `lead_days_actual` raises test PR
AUC from {leak_lr_clean['test PR AUC']:.3f} to **{leak_lr_leak['test PR AUC']:.3f}** for logistic regression and from
{leak_hgb_clean['test PR AUC']:.3f} to **{leak_hgb_leak['test PR AUC']:.3f}** for gradient boosting. ROC AUC rises from
{leak_lr_clean['test ROC AUC']:.3f} to {leak_lr_leak['test ROC AUC']:.3f} and from {leak_hgb_clean['test ROC AUC']:.3f} to {leak_hgb_leak['test ROC AUC']:.3f}. Neither model
fully learns the diagonal rule from {int(y[train].sum())} training positives. Once
the slip itself (actual − planned lead time, which is `late_days`) is
engineered as a feature, logistic regression reaches ROC AUC
**{leak_lr_slip['test ROC AUC']:.3f}** and PR AUC **{leak_lr_slip['test PR AUC']:.3f}**. Such a model looks excellent and
is useless at PO time, because the delivery date does not exist yet.
Post-shipment freight fields give logistic ROC AUC
{leak_lr_freight['test ROC AUC']:.3f} against {leak_lr_clean['test ROC AUC']:.3f} without them. A leak does not always
inflate a metric, so the absence of inflation is not evidence that a feature is
safe. The audit decides, not the metric.

## 2. Models and selection

Fitted in this order, all on the training years only:

0. **Baseline:** the vendor's late rate in the training data. Vendors with
   fewer than {MIN_VENDOR_HISTORY} training shipments get the global training
   rate ({pct(y[train].mean())}).
1. **Logistic regression** (L2). Categories with fewer than
   {MIN_CATEGORY_FREQUENCY} training rows are pooled as "infrequent". Numeric
   features are standardised.
2. **CART** decision tree, depth-limited, min 20 rows per leaf.
3. **HistGradientBoostingClassifier** with native categorical splits, fixed iterations (no early stopping).

**Class imbalance.** The models are fitted without class weights, and the
alert threshold is tuned on validation (the F1-maximising threshold on 2013).
We chose this because the allocation model needs *calibrated* probabilities.
In the comparison below, `class_weight="balanced"` raised the mean predicted
probability on test to {class_weights.iloc[1]['mean predicted (test)']} (observed
{class_weights.iloc[1]['observed (test)']}). It also changed test ROC AUC from
{class_weights.iloc[0]['test ROC AUC']:.3f} to {class_weights.iloc[1]['test ROC AUC']:.3f}.
Hyper-parameters were chosen by validation log loss:

{md_table(selection_view(main_res), digits=3)}

## 3. Test results (PO 2014–2015), against the baseline

**Feature set: as specified**

{md_table(metric_view(results[main_fs]['metrics']))}

**Feature set: strict PO-time**

{md_table(metric_view(results[strict_fs]['metrics']))}

Δ columns are paired bootstrap differences against the baseline on the same
resamples. An interval that excludes 0 means a reliable difference. Models
whose ROC AUC reliably beats the baseline: as specified:
{', '.join(beats[main_fs]) or 'none'}; strict: {', '.join(beats[strict_fs]) or 'none'}.

![ROC and PR curves]({'figures/' + fig_curves})

### Calibration (decile reliability, test, as specified)

![Calibration]({'figures/' + fig_cal})

Logistic regression:

{md_table(cal['logistic'], digits=3)}

Gradient boosting:

{md_table(cal['hgb'], digits=3)}

Baseline:

{md_table(cal['baseline'], digits=3)}

### Class weights versus threshold tuning (logistic, as specified)

{md_table(class_weights.assign(**{c: class_weights[c].map(lambda v: f'{v:.3f}' if pd.notna(v) else '–') for c in ['test ROC AUC', 'test PR AUC', 'Brier', 'precision', 'recall']}))}

### Rolling-origin check (train on all earlier PO years, test on one year)

Hyper-parameters are fixed at the values chosen above. Years with fewer than 5
late shipments are skipped.

As specified:

{md_table(roll_view[main_fs])}

Strict PO-time:

{md_table(roll_view[strict_fs])}

Mean ROC AUC across folds, as specified: {', '.join(f"{k.split()[0]} {v:.3f}" for k, v in roll_mean[main_fs].items())};
strict: {', '.join(f"{k.split()[0]} {v:.3f}" for k, v in roll_mean[strict_fs].items())}.

## 4. Interpretation

### Logistic regression odds ratios (as specified)

Odds ratios are per 1 standard deviation for numeric features. Categories are
one-hot without a reference level, so each category's OR is relative to the
L2-shrunk average, not to a named reference. The 95% intervals come from 200
bootstrap refits on the training data. Shrinkage pulls every OR towards 1.

{md_table(numeric_or, digits=3)}

Shipment mode and product group (all levels):

{md_table(mode_pg_or, digits=3)}

Largest category effects overall:

{md_table(top_cat, digits=3)}

Strict PO-time model, largest effects:

{md_table(top_strict, digits=3)}

Median planned lead time (days) for late and not-late shipments, by split:

{md_table(lead_compare.rename(columns={False: 'not late', True: 'late'}).reset_index(), digits=0)}

### Decision tree rules (as specified, {main_res['chosen']['tree']})

`weights` are [not late, late] training counts in each leaf.

```
{tree_rules}
```

Strict PO-time tree ({strict_res['chosen']['tree']}):

```
{tree_rules_strict}
```

### Permutation importance on test (drop in ROC AUC when a feature is shuffled, 20 repeats)

{md_table(importance, digits=3)}

### Where the model fails

- Late test shipments by vendor, with the logistic model's mean predicted
  probability for that vendor's test POs:

{md_table(by_vendor_test.reset_index())}

- At the validation-chosen threshold ({thr_lr:.3f}), the logistic model misses
  {len(missed)} of {int(test_frame['is_late'].sum())} late test shipments and
  raises {len(false_alarm)} false alarms.
- {unseen_test} test rows ({unseen_late} late) come from vendors never seen in
  training. For those, the vendor effect falls back to "infrequent" or the
  global rate.

## 5. Discussion

- **Headline.** On the pre-registered test (trained on POs 2006–2012, tested
  on POs 2014–2015), no model reliably beats the vendor baseline on ROC AUC.
  The baseline scores {m_main.loc[base_label, 'ROC AUC']:.3f} (95% CI {m_main.loc[base_label, 'ROC AUC 95% CI']}),
  logistic regression {m_main.loc[lr_label, 'ROC AUC']:.3f} (Δ {m_main.loc[lr_label, 'ΔROC vs baseline 95% CI']}) and HGB
  {m_main.loc[hgb_label, 'ROC AUC']:.3f} (Δ {m_main.loc[hgb_label, 'ΔROC vs baseline 95% CI']}). PR AUC rewards
  putting the few late shipments at the top of the ranking. On PR AUC,
  {', '.join(k for k in (lr_label, tree_label, hgb_label) if m_main.loc[k, 'dpr_lo'] > 0) or 'no model'}
  reliably beat the baseline's {m_main.loc[base_label, 'PR AUC']:.3f}. Models reliably *worse* than
  the baseline on ROC AUC: {', '.join(k for k in (lr_label, tree_label, hgb_label) if m_main.loc[k, 'droc_hi'] < 0) or 'none'}. With only {int(counts.loc['test', 'late'])} late test
  shipments, the models' ranking is not stable.
- **Rolling origin is more favourable.** When each year is predicted from
  *all* earlier years, logistic regression beats the baseline's ROC AUC in
  {int((rolling[main_fs]['logistic ROC'] > rolling[main_fs]['baseline ROC']).sum())} of {len(rolling[main_fs])} folds, and HGB in
  {int((rolling[main_fs]['hgb ROC'] > rolling[main_fs]['baseline ROC']).sum())} of {len(rolling[main_fs])}. The main test trains only up to
  2012, so it loses the most relevant year (2013) and feels the drift in full.
  Refitting on train + validation before testing is the usual deployment
  choice. We did not switch the primary protocol after seeing test results.
- **Which features matter.** Vendor and destination dominate. In permutation
  importance, shuffling vendor costs the most ROC AUC. The largest training
  odds ratios are for South Africa (OR
  {or_lookup.get('country_South Africa', float('nan')):.1f}) and Nigeria ({or_lookup.get('country_Nigeria', float('nan')):.1f}),
  and for Aurobindo ({or_lookup.get('vendor_Aurobindo Pharma Limited', float('nan')):.1f}), Cipla
  ({or_lookup.get('vendor_CIPLA LIMITED', float('nan')):.1f}) and Orgenics ({or_lookup.get('vendor_Orgenics, Ltd', float('nan')):.1f}), the three
  lowest-on-time vendors in the scorecard. Larger lines are late more often (OR
  {or_lookup.get('log_value', float('nan')):.2f} per SD of log value). The mode ORs are in the table
  above (ocean {or_lookup.get('shipment_mode_Ocean', float('nan')):.2f}), and they partly overlap with country.
- **The borderline features did not help.** In training, planned lead time has
  an OR of {or_lookup.get('lead_days_planned', float('nan')):.2f} per SD: longer plans are late less often, which
  fits schedules that were padded or revised outward. On test, HGB's
  permutation importance for it is
  {importance.set_index('feature').loc['lead_days_planned', 'mean ROC AUC drop']:+.3f}, so a negative value means
  shuffling it *improves* ROC AUC. The strict PO-time set, without planned lead
  time and weight, performs about the same (logistic ROC AUC
  {m_strict.loc[lr_label, 'ROC AUC']:.3f} against {m_main.loc[lr_label, 'ROC AUC']:.3f}). That is the set to use.
- **Do the results make sense?** The vendor and country effects point the same
  way as the scorecard. Calibration-in-the-large is poor: logistic regression
  predicts {pct(main_res['preds_test']['logistic'].mean())} late on average in test, against
  {pct(main_res['y_test'].mean())} observed. The late rate fell after 2013, and a model trained
  earlier cannot know that. The fall coincides with more exact-on-schedule
  matches (data-quality.md §3.4), so part of the "improvement" may be recording
  practice.
- **Where it fails.** One vendor accounts for most late test shipments
  ({by_vendor_test.index[0]}: {int(by_vendor_test.iloc[0]['late'])} of {int(test_frame['is_late'].sum())}). The rest are
  spread over vendors the models consider safe. {unseen_test} test rows come from
  vendors with no training history ({unseen_late} of them late). They got the
  global rate or the pooled "infrequent" vendor effect. 2015 POs are censored: only arrivals before the end of the file are
  present.
- **Is the complex model worth it?** The paired bootstrap difference HGB −
  logistic is {m_main.loc[hgb_label, 'droc_lr_lo']:+.3f} to {m_main.loc[hgb_label, 'droc_lr_hi']:+.3f} for ROC AUC and
  {m_main.loc[hgb_label, 'dpr_lr_lo']:+.3f} to {m_main.loc[hgb_label, 'dpr_lr_hi']:+.3f} for PR AUC, so the two cannot be
  reliably separated. Logistic regression is interpretable, gives odds ratios,
  and is cheap to recalibrate, for example by refitting the intercept on recent
  months. We recommend it with the strict PO-time features and periodic
  recalibration. The vendor baseline is a strong, honest fallback and should
  always be reported alongside.
- **Honesty about the target.** Because the schedule was probably revised,
  `is_late` means "delivered after the last recorded schedule", not "delivered
  after the original promise", and the model predicts the former. FlowChain
  avoids this if it stores the original promised date on each PO line and never
  overwrites it.

{quant_text}
"""
    write_text(paths.outputs_dir / "delay-model.md", report)
    print(f"Wrote {paths.outputs_dir / 'delay-model.md'}")
    cols = ["feature set", "model", "ROC AUC", "ROC AUC 95% CI", "ΔROC vs baseline 95% CI", "PR AUC", "PR AUC 95% CI", "ΔPR vs baseline 95% CI", "Brier", "precision", "recall", "hyper-parameters"]
    with pd.option_context("display.width", 250, "display.max_columns", 20):
        print(metrics[cols].to_string(index=False))
        print(leak.to_string(index=False))
        print(class_weights.to_string(index=False))
        for fs in FEATURE_SETS:
            print(fs); print(rolling[fs].round(3).to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
