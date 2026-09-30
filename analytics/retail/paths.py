"""Shared locations and constants for the Online Retail II demand scripts.

Data never lives in the repository. Every script resolves the data directory in
this order (the same convention as the SCMS analysis):

1. the ``--data-dir DIR`` CLI flag (the ``online-retail-ii`` folder itself);
2. ``$FLOWCHAIN_DATA_DIR/online-retail-ii`` when the ``FLOWCHAIN_DATA_DIR``
   environment variable is set (it names the shared ``flowchain-data`` folder);
3. ``~/flowchain-data/online-retail-ii``.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path

ENV_VAR = "FLOWCHAIN_DATA_DIR"
SUBFOLDER = "online-retail-ii"


def default_data_dir() -> Path:
    return Path.home() / "flowchain-data" / SUBFOLDER


SOURCE_URL = "https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip"
ZIP_FILENAME = "online_retail_ii.zip"
ZIP_SHA256 = "572e36277c2390fbfde10664750731e0a86f55e33470d91919085f0408e67bfb"
XLSX_FILENAME = "online_retail_II.xlsx"
TRANSACTIONS_FILENAME = "transactions.csv"

# The workbook has two sheets that are stacked, in this order, in transactions.csv.
SHEETS = (("Year 2009-2010", 525_461), ("Year 2010-2011", 541_910))
COLUMNS = (
    "Invoice", "StockCode", "Description", "Quantity",
    "InvoiceDate", "Price", "Customer ID", "Country",
)

CITATION = (
    "Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository. "
    "https://doi.org/10.24432/C5CG6D. Licensed under CC BY 4.0."
)

SEED = 20260930

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class DataPaths:
    root: Path

    @property
    def raw_dir(self) -> Path:
        return self.root / "raw"

    @property
    def zip_path(self) -> Path:
        return self.raw_dir / ZIP_FILENAME

    @property
    def xlsx_path(self) -> Path:
        return self.raw_dir / XLSX_FILENAME

    @property
    def derived_dir(self) -> Path:
        return self.root / "derived"

    @property
    def transactions_csv(self) -> Path:
        return self.derived_dir / TRANSACTIONS_FILENAME

    @property
    def lines_csv(self) -> Path:
        """Cleaned, flagged sale lines (row level, local only)."""
        return self.derived_dir / "sale_lines.csv"

    @property
    def weekly_csv(self) -> Path:
        """Zero-filled weekly demand per SKU for the forecasting panel."""
        return self.derived_dir / "weekly_panel.csv"

    @property
    def sku_csv(self) -> Path:
        """One row per panel SKU: segment, ABC class, price and pack statistics."""
        return self.derived_dir / "panel_skus.csv"

    @property
    def outputs_dir(self) -> Path:
        return self.root / "outputs"

    @property
    def figures_dir(self) -> Path:
        return self.outputs_dir / "figures"

    def ensure(self) -> "DataPaths":
        for folder in (self.raw_dir, self.derived_dir, self.outputs_dir, self.figures_dir):
            folder.mkdir(parents=True, exist_ok=True)
        return self


def resolve_data_dir(cli_value: str | None = None) -> Path:
    if cli_value:
        return Path(cli_value).expanduser().resolve()
    env_value = os.environ.get(ENV_VAR)
    if env_value:
        return (Path(env_value).expanduser() / SUBFOLDER).resolve()
    return default_data_dir()


def guard_outside_repo(path: Path) -> None:
    """Refuse to work on a data folder inside this public repository."""
    resolved = path.resolve()
    if resolved == REPO_ROOT or REPO_ROOT in resolved.parents:
        raise SystemExit(
            f"Refusing to use data dir {resolved}: it is inside the public repository "
            f"{REPO_ROOT}. Keep data outside git (see analytics/retail/README.md)."
        )


def add_data_dir_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--data-dir",
        default=None,
        help=f"data directory (default: ${ENV_VAR}/{SUBFOLDER}, else ~/flowchain-data/{SUBFOLDER})",
    )


def data_paths_from_args(args: argparse.Namespace) -> DataPaths:
    root = resolve_data_dir(args.data_dir)
    guard_outside_repo(root)
    return DataPaths(root)
