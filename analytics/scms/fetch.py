"""Download the SCMS Supply Chain Shipment Pricing Dataset and verify it.

The file comes from the Internet Archive snapshot of the USAID open data portal
(data.usaid.gov is no longer online). The download is written to a temporary
file and only moved into ``raw/`` after the sha256, row count and column count
all match. ``--verify-only`` checks an existing file without any network call.

Usage (from ``analytics/``)::

    python -m scms.fetch [--data-dir DIR] [--verify-only] [--force]
"""

from __future__ import annotations

import csv
import hashlib
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

from .paths import RAW_COLUMNS, RAW_ROWS, RAW_SHA256, parse_args

SOURCE_URL = (
    "http://web.archive.org/web/20250129185137id_/"
    "https://data.usaid.gov/api/views/a3rc-nmf6/rows.csv?accessType=DOWNLOAD"
)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shape_of(path: Path) -> tuple[int, int]:
    """Row count (excluding header) and column count, parsed as CSV."""
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        rows = sum(1 for _ in reader)
    return rows, len(header)


def verify(path: Path) -> list[str]:
    problems = []
    actual_hash = sha256_of(path)
    if actual_hash != RAW_SHA256:
        problems.append(f"sha256 {actual_hash} != expected {RAW_SHA256}")
    rows, cols = shape_of(path)
    if rows != RAW_ROWS:
        problems.append(f"{rows} rows != expected {RAW_ROWS}")
    if cols != RAW_COLUMNS:
        problems.append(f"{cols} columns != expected {RAW_COLUMNS}")
    return problems


def download(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False, dir=target.parent, suffix=".part") as tmp:
        tmp_path = Path(tmp.name)
    try:
        print(f"Downloading {SOURCE_URL}")
        request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "flowchain-analytics/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response, tmp_path.open("wb") as out:
            shutil.copyfileobj(response, out)
        problems = verify(tmp_path)
        if problems:
            raise SystemExit("Downloaded file failed verification: " + "; ".join(problems))
        tmp_path.replace(target)
        print(f"Saved and verified {target}")
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def main() -> int:
    def extra(parser):
        parser.add_argument("--verify-only", action="store_true", help="Verify the existing file; no download")
        parser.add_argument("--force", action="store_true", help="Download even if a verified file exists")

    args, paths = parse_args(__doc__.splitlines()[0], extra)
    target = paths.raw_csv
    if args.verify_only:
        if not target.exists():
            print(f"Missing {target}")
            return 1
        problems = verify(target)
        print("OK: " + str(target) if not problems else "FAILED: " + "; ".join(problems))
        return 1 if problems else 0
    if target.exists() and not args.force and not verify(target):
        print(f"Already present and verified: {target}")
        return 0
    download(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
