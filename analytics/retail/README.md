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
python -m retail.decision              # replenishment backtest: outputs/replenishment-results.md, demand paths
python -m retail.report_outline        # outputs/report-outline-retail.md (rubric 1a-6b -> evidence)
```

`forecast.py` fits ETS and ARIMA per SKU in a process pool (`--workers`, default CPU count − 2)
and takes about 20 minutes on 16 cores. `--limit N` runs on N SKUs for development, and
`--reuse-stat` reuses the saved statsmodels forecasts.

`decision.py` also reads the SCMS cleaned file (`$FLOWCHAIN_DATA_DIR/scms/derived/scms_clean.csv`, or
`--scms-csv FILE`) for the lead-time coefficient of variation. It takes about 5 minutes; `--reuse-gbm` reuses
its saved GBM forecasts.

## Outputs (in `<data dir>/outputs/`)

| File | Content |
|---|---|
| `cleaning-log.md/.csv` | each cleaning rule, rows and units affected, action |
| `data-quality.md` | dataset, missing values, duplicates, cancellations, outliers, panel, intermittency |
| `demand-forecast.md` | setup, models, test and rolling-origin metrics with CIs, ARIMA notes, P50/P90 |
| `forecast-*.csv`, `arima-orders.csv` | the metric tables behind the report |
| `demand-distribution.csv` | per SKU per week: point, P50, P90 (+ actual in the test); aggregates only |
| `sku-parameters.csv`, `decision-inputs.md` | cost, holding, stockout and pack proxies; assumptions marked |
| `replenishment-results.md`, `replenishment-*.csv` | policy backtest (rule of thumb, FlowChain rule, service level, budgeted MILP) |
| `demand-paths-test.csv.gz`, `demand-paths-forward.csv.gz` | 500 simulated 26-week demand paths per SKU (GBM + block-bootstrapped residuals) |
| `report-outline-retail.md` | rubric questions 1a–6b mapped to the retail evidence (same format as the SCMS outline) |

## Key design decisions

- **Target:** gross shipped units per SKU and Monday-start week. Voided orders (a cancellation that exactly
  reverses a sale within 24 h) are removed; other cancellations are returns, reported separately.
- **Sheet overlap:** the sheet-1 copy of 2010-12-01..09 is dropped after checking it is identical to sheet 2.
- **Panel:** SKUs sold in ≥ 70 of the 91 training weeks, chosen without looking at the test weeks.
- **Test:** the last 13 full weeks (2011-09-05 to 2011-11-28), plus six refitted rolling origins.
- **Bulk lines:** flagged with a log-scale modified z-score per SKU; the capped history is used only if it
  wins on the validation origins before the test.
