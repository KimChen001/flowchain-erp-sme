"""Shared locations for the SCMS analytics scripts.

Data never lives in the repository. Every script resolves the data directory in
this order: the ``--data-dir`` CLI flag, then the ``SCMS_DATA_DIR`` environment
variable, then ``DEFAULT_DATA_DIR``.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / "flowchain-data" / "scms"
ENV_VAR = "SCMS_DATA_DIR"

RAW_FILENAME = "Supply_Chain_Shipment_Pricing_Dataset.csv"
RAW_SHA256 = "c9ca9530539e7dbf37b377f3fcd383e1faa81c8e41c707e280b20a485508a537"
RAW_ROWS = 10_324
RAW_COLUMNS = 33

CLEAN_FILENAME = "scms_clean.csv"

# FlowChain business rule: a delivery is on time when it arrives on or before the
# promised (scheduled) day plus a grace period. The default grace is 0 days, the
# same rule FlowChain's receiving walkthrough uses (arrived <= promised day).
GRACE_DAYS = 0

SEED = 20260930


@dataclass(frozen=True)
class DataPaths:
    root: Path

    @property
    def raw_dir(self) -> Path:
        return self.root / "raw"

    @property
    def raw_csv(self) -> Path:
        return self.raw_dir / RAW_FILENAME

    @property
    def derived_dir(self) -> Path:
        return self.root / "derived"

    @property
    def clean_csv(self) -> Path:
        return self.derived_dir / CLEAN_FILENAME

    @property
    def outputs_dir(self) -> Path:
        return self.root / "outputs"

    @property
    def figures_dir(self) -> Path:
        return self.outputs_dir / "figures"

    def ensure(self) -> "DataPaths":
        for folder in (self.derived_dir, self.outputs_dir, self.figures_dir):
            folder.mkdir(parents=True, exist_ok=True)
        return self


def resolve_data_dir(cli_value: str | None = None) -> Path:
    if cli_value:
        return Path(cli_value).expanduser().resolve()
    env_value = os.environ.get(ENV_VAR)
    if env_value:
        return Path(env_value).expanduser().resolve()
    return DEFAULT_DATA_DIR


def _refuse_repository_location(root: Path) -> None:
    """Refuse a data dir inside this git repository: the repo is public."""
    repo_root = Path(__file__).resolve().parents[2]
    try:
        root.resolve().relative_to(repo_root)
    except ValueError:
        return
    raise SystemExit(
        f"Refusing to use data dir {root}: it is inside the repository {repo_root}. "
        "The dataset licence (CC BY-ND 4.0) and the public repo mean data must live outside git."
    )


def parse_args(description: str, extra=None) -> tuple[argparse.Namespace, DataPaths]:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--data-dir",
        default=None,
        help=f"Data directory (default: ${ENV_VAR} or {DEFAULT_DATA_DIR})",
    )
    if extra is not None:
        extra(parser)
    args = parser.parse_args()
    root = resolve_data_dir(args.data_dir)
    _refuse_repository_location(root)
    return args, DataPaths(root)
