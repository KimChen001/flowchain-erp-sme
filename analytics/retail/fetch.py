"""Download Online Retail II from UCI, verify it and convert both sheets to CSV.

    python -m retail.fetch                 # download (if missing), verify, extract, convert
    python -m retail.fetch --verify-only   # no network: check the zip hash and the CSV shape
    python -m retail.fetch --out FILE      # convert to FILE instead of derived/transactions.csv

The two worksheets are stacked in workbook order, with the original eight columns
and no extra column. ``clean.py`` recovers the sheet of each row from the known
sheet row counts in ``paths.SHEETS``.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

from .paths import (
    COLUMNS, SHEETS, SOURCE_URL, XLSX_FILENAME, ZIP_SHA256, DataPaths,
    add_data_dir_arg, data_paths_from_args,
)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(paths: DataPaths) -> None:
    tmp = paths.zip_path.with_suffix(".part")
    print(f"Downloading {SOURCE_URL}")
    with urllib.request.urlopen(SOURCE_URL, timeout=120) as response, tmp.open("wb") as out:
        shutil.copyfileobj(response, out)
    tmp.replace(paths.zip_path)


def verify_zip(paths: DataPaths) -> None:
    actual = sha256_of(paths.zip_path)
    if actual != ZIP_SHA256:
        raise SystemExit(f"sha256 mismatch for {paths.zip_path}: {actual} != {ZIP_SHA256}")
    print(f"OK  {paths.zip_path.name} sha256 {actual}")


def extract(paths: DataPaths) -> None:
    with zipfile.ZipFile(paths.zip_path) as archive:
        info = archive.getinfo(XLSX_FILENAME)
        if paths.xlsx_path.exists() and paths.xlsx_path.stat().st_size == info.file_size:
            print(f"OK  {paths.xlsx_path.name} already extracted")
            return
        archive.extract(info, paths.raw_dir)
    print(f"Extracted {paths.xlsx_path}")


def convert(paths: DataPaths, out: Path) -> None:
    frames = []
    for sheet, expected_rows in SHEETS:
        print(f"Reading sheet {sheet!r} (slow: openpyxl)")
        frame = pd.read_excel(paths.xlsx_path, sheet_name=sheet, dtype={"Invoice": str, "StockCode": str})
        if list(frame.columns) != list(COLUMNS):
            raise SystemExit(f"Unexpected columns in {sheet!r}: {list(frame.columns)}")
        if len(frame) != expected_rows:
            raise SystemExit(f"Sheet {sheet!r} has {len(frame)} rows, expected {expected_rows}")
        frames.append(frame)
    combined = pd.concat(frames, ignore_index=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    combined.to_csv(out, index=False)
    print(f"Wrote {out} ({len(combined):,} rows)")


def verify_csv(path: Path) -> None:
    frame = pd.read_csv(path, usecols=["Invoice"], dtype=str)
    expected = sum(rows for _, rows in SHEETS)
    header = list(pd.read_csv(path, nrows=0).columns)
    if header != list(COLUMNS) or len(frame) != expected:
        raise SystemExit(f"{path}: columns {header}, {len(frame)} rows; expected {expected} rows")
    print(f"OK  {path.name} {len(frame):,} rows, columns {header}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_data_dir_arg(parser)
    parser.add_argument("--verify-only", action="store_true", help="no network; verify existing files")
    parser.add_argument("--out", type=Path, default=None, help="CSV output path")
    parser.add_argument("--force", action="store_true", help="re-convert even if the CSV exists")
    args = parser.parse_args(argv)
    paths = data_paths_from_args(args).ensure()
    out = args.out or paths.transactions_csv

    if args.verify_only:
        verify_zip(paths)
        verify_csv(out)
        return 0
    if not paths.zip_path.exists():
        download(paths)
    verify_zip(paths)
    extract(paths)
    if out.exists() and not args.force:
        print(f"OK  {out} exists (use --force to rebuild)")
    else:
        convert(paths, out)
    verify_csv(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
