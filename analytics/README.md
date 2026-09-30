# FlowChain supplier analytics (SCMS study)

This folder holds the analysis code for the course final report. The study uses
a public shipment dataset to measure supplier delivery performance, predict late
deliveries at the time a purchase order is sent, and frame a supplier allocation
decision. The code is here. The data and every generated output live outside the
repository.

## Source and licence

- **Dataset:** *Supply Chain Shipment Pricing Dataset*, published by USAID on
  data.usaid.gov (dataset id `a3rc-nmf6`). It holds PEPFAR-funded HIV/AIDS
  commodity shipments (ARVs and HIV test kits, with a few malaria and
  anti-malarial lines) handled by the Supply Chain Management System (SCMS)
  project, to about 40 countries, 2006–2015.
- **Copy used:** the Internet Archive snapshot of the portal's CSV download,
  <http://web.archive.org/web/20250129185137id_/https://data.usaid.gov/api/views/a3rc-nmf6/rows.csv?accessType=DOWNLOAD>
  (sha256 `c9ca9530539e7dbf37b377f3fcd383e1faa81c8e41c707e280b20a485508a537`,
  10,324 rows, 33 columns).
- **Licence:** Creative Commons Attribution-NoDerivatives 4.0 International
  (CC BY-ND 4.0), <https://creativecommons.org/licenses/by-nd/4.0/>.

Attribution text to use in the report and on any slide that shows results:

> Data: "Supply Chain Shipment Pricing Dataset", United States Agency for
> International Development (USAID), data.usaid.gov, dataset a3rc-nmf6,
> accessed through the Internet Archive snapshot of 29 January 2025. Licensed
> under CC BY-ND 4.0 (https://creativecommons.org/licenses/by-nd/4.0/). The
> analysis, aggregates and figures are the authors' own work and are not
> endorsed by USAID.

## Why the data is not in git

The repository `KimChen001/flowchain-erp-sme` is public. Under CC BY-ND 4.0 the
dataset may be shared only unmodified and with attribution, and adapted
material, such as a cleaned copy or a row-level extract, may not be shared. We
therefore commit only code. The raw file, the cleaned file and any row-level
extract stay in a local data folder. Reports and figures there contain
aggregates only.

Safeguards:

- `analytics/.gitignore` ignores data folders (`raw/`, `derived/`, `outputs/`,
  `data/`) and data file types (`*.csv`, `*.parquet`, `*.pkl`, `*.json`, figures).
- Every script refuses to run if its data directory is inside this repository.

## Data directory

Scripts take the data directory from `--data-dir DIR`, else the `SCMS_DATA_DIR`
environment variable, else the default
`~/flowchain-data/scms`.
The layout is:

```
<data dir>/
  raw/Supply_Chain_Shipment_Pricing_Dataset.csv   # downloaded, never edited
  derived/                                        # cleaned data (local only)
  outputs/                                        # reports, tables, figures
```

## Requirements

Python 3.13 with pandas 3.0, numpy, scikit-learn 1.9, scipy 1.18, statsmodels
0.15 and matplotlib. There are no other dependencies and no network access,
apart from `fetch.py`. Random seeds are fixed in `scms/paths.py`.

## Reproducing every output, in order

Run from the `analytics/` folder:

```sh
python -m scms.fetch            # 1. download and verify the raw file (skips if already verified)
python -m scms.fetch --verify-only   #    or verify an existing copy without network access
python -m unittest              # 2a. parser tests (plain unittest, pytest-compatible)
python -m scms.clean            # 2b. derived/scms_clean.csv + outputs/cleaning-log.{md,csv}
python -m scms.quality_report   # 3. outputs/data-quality.md + figures (rubric sections 2 and 3)
python -m scms.supplier_scorecard   # 4. outputs/supplier-scorecard.md + aggregate CSVs (--grace-days N)
python -m scms.delay_model      # 5. outputs/delay-model.md + metrics CSV + figures (~2 min; --bootstrap N)
```
