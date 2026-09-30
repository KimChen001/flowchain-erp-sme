"""Small helpers for writing Markdown reports and figures."""

from __future__ import annotations

import math
from pathlib import Path

import pandas as pd

# Reference categorical palette (dataviz skill, light mode) and ink colours.
BLUE = "#2a78d6"
ORANGE = "#eb6834"
AQUA = "#1baf7a"
VIOLET = "#4a3aa7"
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"
SURFACE = "#fcfcfb"


def fmt(value, digits: int = 1) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)) or value is pd.NA:
        return "–"
    if isinstance(value, (bool,)):
        return "yes" if value else "no"
    if isinstance(value, int) or (isinstance(value, float) and float(value).is_integer() and abs(value) >= 1000):
        return f"{int(value):,}"
    if isinstance(value, float):
        return f"{value:,.{digits}f}"
    return str(value)


def pct(value, digits: int = 1) -> str:
    if value is None or pd.isna(value):
        return "–"
    return f"{100 * value:.{digits}f}%"


def md_table(frame: pd.DataFrame, digits: int = 1, index: bool = False) -> str:
    """Render a DataFrame as a GitHub Markdown table without extra dependencies."""
    data = frame.reset_index() if index else frame
    header = "| " + " | ".join(str(c) for c in data.columns) + " |"
    align = "|" + "|".join(
        "---:" if pd.api.types.is_numeric_dtype(data[c]) and not pd.api.types.is_bool_dtype(data[c]) else "---"
        for c in data.columns
    ) + "|"
    rows = []
    plain = {c for c in data.columns if "year" in str(c).lower()}
    for _, row in data.iterrows():
        cells = []
        for column, value in row.items():
            if column in plain and not isinstance(value, str) and pd.notna(value):
                text = str(int(value))
            else:
                text = value if isinstance(value, str) else fmt(value, digits)
            cells.append(str(text).replace("|", "\\|").replace("\n", " "))
        rows.append("| " + " | ".join(cells) + " |")
    return "\n".join([header, align, *rows])


def style_axes(ax) -> None:
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(INK_2)
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=INK_2, labelsize=9)
    ax.yaxis.label.set_color(INK_2)
    ax.xaxis.label.set_color(INK_2)
    ax.title.set_color(INK)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def save_figure(fig, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.patch.set_facecolor(SURFACE)
    fig.savefig(path, dpi=150, bbox_inches="tight")
    import matplotlib.pyplot as plt

    plt.close(fig)
    return path.name


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def write_json(path: Path, payload) -> None:
    """Write aggregate key numbers (never row-level data) for report_outline.py."""
    import json

    import numpy as np

    def default(value):
        if isinstance(value, (np.integer,)):
            return int(value)
        if isinstance(value, (np.floating,)):
            return float(value)
        if isinstance(value, (np.ndarray,)):
            return value.tolist()
        if isinstance(value, (pd.Timestamp,)):
            return value.isoformat()
        return str(value)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=default, ensure_ascii=False), encoding="utf-8")
