# Retail demand forecasting (Online Retail II study, part 1)

This is part 1 of the course analytics study. It forecasts weekly SKU demand for a UK
gift-ware wholesaler and exports demand distributions (P50/P90) that the decision model
combines with supplier lead-time distributions from part 2 (`analytics/scms/`).

## Source and licence

- **Dataset:** Online Retail II, UCI Machine Learning Repository, dataset 502:
  <https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip>
  (sha256 `572e36277c2390fbfde10664750731e0a86f55e33470d91919085f0408e67bfb`).
  The data holds all invoice lines of a UK online retailer, 2009-12-01 to 2011-12-09,
  in two worksheets.
- **Licence:** CC BY 4.0. **Citation:** Chen, D. (2012). Online Retail II [Dataset].
  UCI Machine Learning Repository. https://doi.org/10.24432/C5CG6D.

## Data stays outside git

The repository is public, so only code is committed. The raw files, derived tables and
all outputs live in a local data folder. Scripts refuse a data folder inside the repo.
`analytics/.gitignore` is a second line of defence.

The data folder comes from `--data-dir DIR`, else `$FLOWCHAIN_DATA_DIR/online-retail-ii`
(the variable names the shared `flowchain-data` folder, as in the SCMS analysis), else
`~/flowchain-data/online-retail-ii`. For example:

```sh
export FLOWCHAIN_DATA_DIR=/path/to/flowchain-data    # PowerShell: $env:FLOWCHAIN_DATA_DIR = "..."
```

The folder layout is:

```
<data dir>/
  raw/online_retail_ii.zip, raw/online_retail_II.xlsx   # downloaded, never edited
  derived/transactions.csv                               # both sheets stacked (fetch.py)
  derived/*.csv                                          # cleaned lines and weekly panel
  outputs/                                               # reports, tables, figures
```

## Requirements

Python 3.13, pandas 3.0, numpy, scikit-learn 1.9, scipy 1.18, statsmodels 0.15,
matplotlib and openpyxl. Nothing else is needed. Only `fetch.py` uses the network.
Random seeds are fixed in `retail/paths.py`.

## Reproducing the outputs

Run these from `analytics/`, in order:

```sh
python -m retail.fetch --verify-only   # check the zip hash and CSV shape (no network)
python -m retail.fetch                 # or: download, verify, extract and convert
python -m retail.clean                 # cleaning rules, weekly panel, outputs/cleaning-log.*
python -m retail.quality_report        # outputs/data-quality.md and figures
python -m retail.forecast              # outputs/demand-forecast.md, metrics and figures
python -m retail.decision_inputs       # outputs/demand-distribution.csv, decision-inputs.md
```
