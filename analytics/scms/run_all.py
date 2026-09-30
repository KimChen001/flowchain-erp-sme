"""Run the whole SCMS pipeline in order: verify, test, clean, then every report.

Usage (from ``analytics/``)::

    python -m scms.run_all [--data-dir DIR]

It does not download anything. Run ``python -m scms.fetch`` first if the raw
file is missing.
"""

from __future__ import annotations

import subprocess
import sys

from .paths import parse_args

STEPS = [
    ["-m", "scms.fetch", "--verify-only"],
    ["-m", "unittest", "-q"],
    ["-m", "scms.clean"],
    ["-m", "scms.quality_report"],
    ["-m", "scms.supplier_scorecard"],
    ["-m", "scms.delay_model"],
    ["-m", "scms.decision_proposal"],
    ["-m", "scms.decision_results"],
    ["-m", "scms.report_outline"],
]


def main() -> int:
    args, paths = parse_args(__doc__.splitlines()[0])
    for step in STEPS:
        command = [sys.executable, *step]
        if step[1].startswith("scms."):
            command += ["--data-dir", str(paths.root)]
        print("==>", " ".join(step), flush=True)
        result = subprocess.run(command)
        if result.returncode != 0:
            print(f"Step failed: {' '.join(step)}")
            return result.returncode
    print(f"All outputs are in {paths.outputs_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
